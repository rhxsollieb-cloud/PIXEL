import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import type { ElevenLabs } from '@elevenlabs/elevenlabs-js';
import type { DeepReadonly, GenerationRequest, JsonObject } from '../contracts.js';
import {
  BaseModelProvider,
  ProviderError,
  createSdkFetch,
  streamBytes,
  type GenerationOutput,
  type AudioPostProcessor,
  type ModelProviderManifest,
  type ProviderRunContext,
} from '../generation.js';
import {
  modelRegistry,
  musicGenerationParamsSchema,
  soundEffectGenerationParamsSchema,
  speechGenerationParamsSchema,
} from '../models.js';
import { FfmpegAudioPostProcessor } from '../audio-processing.js';

export interface ElevenLabsProviderOptions {
  /** 仅由后端配置注入；不得保存进项目或 provider manifest。 */
  apiKey: string;
  /** 自定义 client 的 fetch 生命周期与日志设置由注入方负责。 */
  client?: ElevenLabsClient;
  timeoutMs?: number;
  /** 可替换的宿主音频编解码器；所有后处理仍继承当前任务的 signal。 */
  audioProcessor?: AudioPostProcessor;
}

/** 原始字符对齐严格对应本次正文；额外后文的起点用于限制 padding。 */
export function speechTailBoundary(text: string, alignment: ElevenLabs.CharacterAlignmentResponseModel | undefined): {
  speechEndSeconds: number; nextSpeechStartSeconds?: number;
} {
  if (!alignment || alignment.characters.length === 0 || alignment.characters.length > 50_000
    || alignment.characters.length !== alignment.characterStartTimesSeconds.length
    || alignment.characters.length !== alignment.characterEndTimesSeconds.length) {
    throw new ProviderError('INVALID_OUTPUT', '缺少可靠的正文时间戳，无法自动处理尾音');
  }
  let previousStart = 0;
  let previousEnd = 0;
  const characterIndexes: number[] = [];
  alignment.characters.forEach((character, index) => {
    const start = alignment.characterStartTimesSeconds[index]!;
    const end = alignment.characterEndTimesSeconds[index]!;
    if (typeof character !== 'string' || character.length === 0 || character.length > 20
      || !Number.isFinite(start) || !Number.isFinite(end) || start < previousStart || end < previousEnd || end < start) {
      throw new ProviderError('INVALID_OUTPUT', '正文时间戳格式或顺序无效');
    }
    previousStart = start;
    previousEnd = end;
    for (let unit = 0; unit < character.length; unit++) characterIndexes.push(index);
  });
  const joined = alignment.characters.join('');
  // v4 音频标签控制表演而不属于发音；兼容供应商保留或省略标签的字符对齐。
  const tagPattern = /\[[^\]\r\n]{1,100}\]/g;
  const excluded = new Set<number>();
  for (const match of joined.matchAll(tagPattern)) {
    for (let unit = match.index; unit < match.index + match[0].length; unit++) excluded.add(unit);
  }
  let plain = '';
  const plainIndexes: number[] = [];
  for (let unit = 0; unit < joined.length; unit++) {
    if (!excluded.has(unit)) { plain += joined[unit]; plainIndexes.push(characterIndexes[unit]!); }
  }
  const leading = plain.length - plain.trimStart().length;
  plain = plain.slice(leading);
  plainIndexes.splice(0, leading);
  const expected = text.replace(tagPattern, '').trim();
  if (!expected || !plain.startsWith(expected)) throw new ProviderError('INVALID_OUTPUT', '时间戳文本与当前正文不匹配，无法自动处理尾音');
  let speechEndSeconds = 0;
  let unit = 0;
  for (const character of expected) {
    if (/[\p{L}\p{N}]/u.test(character)) {
      speechEndSeconds = Math.max(speechEndSeconds, alignment.characterEndTimesSeconds[plainIndexes[unit]!]!);
    }
    unit += character.length;
  }
  if (!(speechEndSeconds > 0)) throw new ProviderError('INVALID_OUTPUT', '没有可识别的正文发音边界，无法自动处理尾音');
  let nextSpeechStartSeconds: number | undefined;
  unit = expected.length;
  for (const character of plain.slice(expected.length)) {
    if (/[\p{L}\p{N}]/u.test(character)) {
      nextSpeechStartSeconds = alignment.characterStartTimesSeconds[plainIndexes[unit]!]!;
      break;
    }
    unit += character.length;
  }
  if (nextSpeechStartSeconds !== undefined && nextSpeechStartSeconds < speechEndSeconds) {
    throw new ProviderError('INVALID_OUTPUT', '正文与额外发音的时间戳发生重叠');
  }
  return { speechEndSeconds, ...(nextSpeechStartSeconds === undefined ? {} : { nextSpeechStartSeconds }) };
}

function decodeTimestampAudio(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length > 180 * 1024 * 1024
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ProviderError('INVALID_OUTPUT', '供应商返回了无效的音频编码');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > 128 * 1024 * 1024) throw new ProviderError('INVALID_OUTPUT', '供应商返回的音频为空或过大');
  return bytes;
}

/** SDK 只负责供应商协议；校验、取消、产物归属由核心执行模板与宿主负责。 */
export class ElevenLabsModelProvider extends BaseModelProvider {
  readonly manifest: ModelProviderManifest = {
    providerId: 'elevenlabs',
    providerVersion: '1',
    modelIds: ['eleven_v4', 'eleven_text_to_sound_v2', 'music_v2_5'],
    supportsCancellation: false,
    supportsResume: false,
  };

  private readonly client: ElevenLabsClient;
  private readonly requestTimeoutSeconds: number;
  private readonly audioProcessor: AudioPostProcessor | undefined;

  constructor(options: ElevenLabsProviderOptions) {
    const timeoutMs = options.timeoutMs ?? 600_000;
    super({ timeoutMs, prepareRequest: (request) => modelRegistry.prepareRequest(request) });
    if (options.apiKey.trim().length === 0) {
      throw new ProviderError('AUTHENTICATION', 'ElevenLabs API key is missing');
    }
    this.client = options.client ?? new ElevenLabsClient({
      apiKey: options.apiKey,
      maxRetries: 0,
      fetch: createSdkFetch(),
      logging: { silent: true },
    });
    this.requestTimeoutSeconds = timeoutMs / 1_000;
    this.audioProcessor = options.audioProcessor;
  }

  protected async performGeneration(
    request: DeepReadonly<GenerationRequest>,
    context: ProviderRunContext,
  ): Promise<GenerationOutput> {
    const requestOptions = {
      abortSignal: context.signal,
      timeoutInSeconds: this.requestTimeoutSeconds,
      // 生成 POST 未提供幂等保障，SDK 不得暗中重复计费请求。
      maxRetries: 0,
    };
    context.reportProgress({ attemptToken: context.attemptToken, fraction: 0, stage: 'requesting' });

    let response: ReadableStream<Uint8Array>;
    let headers: Headers;
    let outputFormat: string;

    if (request.modelId === 'eleven_v4') {
      const params = speechGenerationParamsSchema.parse(request.params);
      outputFormat = params.outputFormat;
      const body: ElevenLabs.BodyTextToDialogueFullWithTimestamps = {
        inputs: [{ text: params.text, voiceId: params.voiceId }],
        modelId: 'eleven_v4',
        outputFormat: params.outputFormat,
      };
      if (params.languageCode != null) body.languageCode = params.languageCode;
      if (params.seed != null) body.seed = params.seed;
      if (params.voiceSettings != null) body.settings = {
        stability: params.voiceSettings.stability, similarity: params.voiceSettings.similarityBoost,
      };
      const textContext = params.contextMode === 'manual'
        ? { previousText: params.previousText, nextText: params.nextText }
        : params.contextMode === 'neighbors' ? request.context : undefined;
      if (textContext?.previousText) body.previousText = textContext.previousText;
      if (textContext?.nextText) body.futureText = textContext.nextText;
      if (params.trimTail) {
        const result = await this.client.textToDialogue.convertWithTimestamps(body, requestOptions).withRawResponse();
        context.signal.throwIfAborted();
        const boundary = speechTailBoundary(params.text, result.data.alignment ?? result.data.normalizedAlignment);
        const bytes = decodeTimestampAudio(result.data.audioBase64);
        context.reportProgress({ attemptToken: context.attemptToken, fraction: 0.5, stage: 'processing-tail' });
        const processed = await (this.audioProcessor ?? new FfmpegAudioPostProcessor()).trimTail({
          bytes, mimeType: 'audio/mpeg', outputFormat, ...boundary,
          paddingMs: params.tailPaddingMs, fadeMs: params.tailFadeMs,
        }, context.signal);
        context.signal.throwIfAborted();
        if (processed.mimeType !== 'audio/mpeg' || processed.extension !== 'mp3'
          || !Number.isFinite(processed.durationSeconds) || processed.durationSeconds <= 0
          || processed.durationSeconds + 0.001 < boundary.speechEndSeconds
          || processed.durationSeconds > Math.min(boundary.speechEndSeconds + params.tailPaddingMs / 1_000,
            boundary.nextSpeechStartSeconds ?? Infinity) + 0.001
          || !Number.isFinite(processed.sourceDurationSeconds) || processed.sourceDurationSeconds < processed.durationSeconds
          || !(processed.bytes instanceof Uint8Array) || !processed.bytes.length) {
          throw new ProviderError('INVALID_OUTPUT', '音频处理器返回了无效的正文产物');
        }
        const artifact = await context.artifacts.write({
          attemptToken: context.attemptToken, kind: 'audio', bytes: processed.bytes,
          metadata: {
            mimeType: processed.mimeType, extension: processed.extension, outputFormat,
            providerId: this.manifest.providerId, modelId: request.modelId,
            durationMs: Math.round(processed.durationSeconds * 1_000), tailTrimmed: true,
            sourceDurationMs: Math.round(processed.sourceDurationSeconds * 1_000),
            speechEndMs: Math.round(boundary.speechEndSeconds * 1_000),
          },
        });
        context.reportProgress({ attemptToken: context.attemptToken, fraction: 1, stage: 'saved' });
        return { artifactIds: [artifact.id] };
      }
      const result = await this.client.textToDialogue.convert(body, requestOptions).withRawResponse();
      response = result.data;
      headers = result.rawResponse.headers;
    } else if (request.modelId === 'eleven_text_to_sound_v2') {
      const params = soundEffectGenerationParamsSchema.parse(request.params);
      outputFormat = params.outputFormat;
      const body: ElevenLabs.CreateSoundEffectRequest = {
        text: params.text,
        modelId: 'eleven_text_to_sound_v2',
        outputFormat: params.outputFormat,
        loop: params.loop,
        promptInfluence: params.promptInfluence,
      };
      if (params.durationSeconds != null) body.durationSeconds = params.durationSeconds;
      const result = await this.client.textToSoundEffects.convert(body, requestOptions).withRawResponse();
      response = result.data;
      headers = result.rawResponse.headers;
    } else if (request.modelId === 'music_v2_5') {
      const params = musicGenerationParamsSchema.parse(request.params);
      outputFormat = params.outputFormat;
      const body: ElevenLabs.BodyComposeMusicV1MusicPost = {
        modelId: 'music_v2_5',
        outputFormat: params.outputFormat,
      };
      if (params.compositionPlan != null) {
        body.compositionPlan = params.compositionPlan;
        if (params.seed != null) body.seed = params.seed;
      } else {
        body.prompt = params.prompt;
        body.forceInstrumental = params.forceInstrumental;
        if (params.musicLengthMs != null) body.musicLengthMs = params.musicLengthMs;
      }
      if (params.finetuneId != null) body.finetuneId = params.finetuneId;
      const result = await this.client.music.compose(body, requestOptions).withRawResponse();
      response = result.data;
      headers = result.rawResponse.headers;
    } else {
      throw new ProviderError('UNSUPPORTED_MODEL', 'Unsupported ElevenLabs model');
    }

    try {
      // 三个 schema 仅公开 MP3；HTTP 200 的 JSON/HTML 错误页不能成为媒体资产。
      const contentType = headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (contentType !== undefined && contentType !== 'audio/mpeg' && contentType !== 'audio/mp3'
        && contentType !== 'application/octet-stream') {
        throw new ProviderError('INVALID_OUTPUT', 'ElevenLabs returned an unexpected audio content type');
      }
      context.signal.throwIfAborted();
      const metadata: JsonObject = {
        mimeType: 'audio/mpeg', extension: 'mp3', outputFormat,
        providerId: this.manifest.providerId, modelId: request.modelId,
      };
      const songId = headers.get('song-id');
      if (songId !== null && songId.length > 0 && songId.length <= 200) metadata.songId = songId;
      context.reportProgress({ attemptToken: context.attemptToken, fraction: 0.5, stage: 'saving' });
      const artifact = await context.artifacts.write({
        attemptToken: context.attemptToken,
        kind: 'audio',
        bytes: streamBytes(response, context.signal),
        metadata,
      });
      context.signal.throwIfAborted();
      context.reportProgress({ attemptToken: context.attemptToken, fraction: 1, stage: 'saved' });
      return { artifactIds: [artifact.id] };
    } finally {
      // 也释放「收到 headers 后立即取消」或 writer 提前拒绝时尚未消费的流。
      if (!response.locked) await response.cancel().catch(() => undefined);
    }
  }
}
