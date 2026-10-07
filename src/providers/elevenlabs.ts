import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import type { ElevenLabs } from '@elevenlabs/elevenlabs-js';
import type { DeepReadonly, GenerationRequest, JsonObject } from '../contracts.js';
import {
  BaseModelProvider,
  ProviderError,
  createSdkFetch,
  streamBytes,
  type GenerationOutput,
  type ModelProviderManifest,
  type ProviderRunContext,
} from '../generation.js';
import {
  modelRegistry,
  musicGenerationParamsSchema,
  soundEffectGenerationParamsSchema,
  speechGenerationParamsSchema,
} from '../models.js';

export interface ElevenLabsProviderOptions {
  /** 仅由后端配置注入；不得保存进项目或 provider manifest。 */
  apiKey: string;
  /** 自定义 client 的 fetch 生命周期与日志设置由注入方负责。 */
  client?: ElevenLabsClient;
  timeoutMs?: number;
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
      const body: ElevenLabs.BodyTextToSpeechFull = {
        text: params.text,
        modelId: 'eleven_v4',
        outputFormat: params.outputFormat,
      };
      if (params.languageCode != null) body.languageCode = params.languageCode;
      if (params.seed != null) body.seed = params.seed;
      if (params.voiceSettings != null) body.voiceSettings = params.voiceSettings;
      const result = await this.client.textToSpeech.convert(params.voiceId, body, requestOptions).withRawResponse();
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
