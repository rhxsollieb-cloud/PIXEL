import type { OpenRouter } from '@openrouter/sdk';
import type { ImageGenerationRequest, VideoGenerationRequest, VideoGenerationResponse } from '@openrouter/sdk/models';
import type { RequestOptions } from '@openrouter/sdk/lib/sdks.js';
import type { DeepReadonly, GenerationRequest, JsonObject } from '../contracts.js';
import {
  BaseModelProvider,
  ProviderError,
  referenceDataUrl,
  streamBytes,
  waitForProvider,
  type GenerationOutput,
  type ProviderRunContext,
} from '../generation.js';
import {
  grokImageParamsSchema,
  grokImageSettingsSchema,
  modelRegistry,
  wanParamsSchema,
  wanSettingsSchema,
} from '../models.js';

export interface OpenRouterProviderOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxArtifactBytes?: number;
}

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const WAN_MODEL = 'alibaba/wan-3.0';
const GROK_IMAGE_MODEL = 'x-ai/grok-imagine-image-2.0';

/** 使用官方 SDK 的媒体端点；远程任务与项目编辑由宿主管理。 */
export class OpenRouterModelProvider extends BaseModelProvider {
  readonly manifest = {
    providerId: 'openrouter',
    providerVersion: '1',
    modelIds: [WAN_MODEL, GROK_IMAGE_MODEL],
    supportsCancellation: false,
    supportsResume: true,
  } as const;

  private readonly pollIntervalMs: number;
  private readonly maxArtifactBytes: number;

  constructor(private readonly client: OpenRouter, options: OpenRouterProviderOptions = {}) {
    super({
      timeoutMs: options.timeoutMs ?? 30 * 60_000,
      prepareRequest: (request) => modelRegistry.prepareRequest(request),
    });
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.maxArtifactBytes = options.maxArtifactBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1
      || !Number.isSafeInteger(this.maxArtifactBytes) || this.maxArtifactBytes < 1) {
      throw new ProviderError('INVALID_INPUT', 'OpenRouter polling interval and artifact limit must be positive integers');
    }
  }

  protected async performGeneration(
    request: DeepReadonly<GenerationRequest>,
    context: ProviderRunContext,
  ): Promise<GenerationOutput> {
    if (request.modelId === WAN_MODEL) return this.generateVideo(request, context);
    if (context.providerTaskId !== undefined) {
      throw new ProviderError('UNSUPPORTED_RESUME', 'Image generation has no recoverable remote task');
    }
    return this.generateImage(request, context);
  }

  private requestOptions(context: ProviderRunContext): RequestOptions {
    return {
      signal: context.signal,
      retries: { strategy: 'none' },
      redirect: 'error',
      serverURL: OPENROUTER_API,
    };
  }

  private async generateVideo(
    request: DeepReadonly<GenerationRequest>,
    context: ProviderRunContext,
  ): Promise<GenerationOutput> {
    const params = wanParamsSchema.parse(request.params);
    const settings = wanSettingsSchema.parse(request.settings ?? {});
    let taskId = context.providerTaskId;
    let response: VideoGenerationResponse;
    if (taskId === undefined) {
      const references = await Promise.all(request.references.map(async (asset) => ({
        type: 'image_url' as const,
        imageUrl: { url: await referenceDataUrl(asset, context) },
      })));
      const input: VideoGenerationRequest = {
        model: WAN_MODEL,
        prompt: params.prompt,
        duration: params.durationSeconds,
        resolution: settings.resolution,
        aspectRatio: settings.aspectRatio,
        generateAudio: params.generateAudio,
        ...(params.seed === null ? {} : { seed: params.seed }),
        ...(references.length === 0 ? {} : params.referenceMode === 'firstFrame'
          ? { frameImages: references.map((reference) => ({ ...reference, frameType: 'first_frame' as const })) }
          : { inputReferences: references }),
      };
      response = await this.client.videoGeneration.generate(
        { videoGenerationRequest: input }, this.requestOptions(context),
      );
      taskId = checkedTaskId(response.id);
      // 先持久化远程 ID，再开始轮询。取消刚好发生时也不能遗失已收费的任务。
      await context.checkpointProviderTask(taskId);
    } else {
      taskId = checkedTaskId(taskId);
      response = await this.client.videoGeneration.getGeneration({ jobId: taskId }, this.requestOptions(context));
    }
    while (true) {
      context.signal.throwIfAborted();
      if (response.id !== taskId) throw new ProviderError('INVALID_OUTPUT', 'OpenRouter returned a different video task');
      if (response.status === 'completed') break;
      if (response.status === 'failed' || response.status === 'cancelled' || response.status === 'expired') {
        throw new ProviderError('REMOTE_FAILED', `OpenRouter video task ended with status ${response.status}`);
      }
      if (response.status !== 'pending' && response.status !== 'in_progress') {
        throw new ProviderError('INVALID_OUTPUT', 'OpenRouter returned an unknown video task status');
      }
      context.reportProgress({
        attemptToken: context.attemptToken,
        fraction: response.status === 'pending' ? 0.05 : 0.1,
        stage: response.status,
        providerTaskId: taskId,
      });
      await waitForProvider(this.pollIntervalMs, context.signal);
      response = await this.client.videoGeneration.getGeneration({ jobId: taskId }, this.requestOptions(context));
    }
    // 只使用固定的 SDK content 端点，绝不将 bearer 凭证发送到响应中的任意 URL。
    const outputCount = response.unsignedUrls?.length ?? 1;
    if (outputCount < 1 || outputCount > 4) {
      throw new ProviderError('INVALID_OUTPUT', 'OpenRouter returned an invalid number of video outputs');
    }
    const artifactIds: string[] = [];
    for (let index = 0; index < outputCount; index += 1) {
      context.signal.throwIfAborted();
      context.reportProgress({ attemptToken: context.attemptToken, fraction: 0.9, stage: 'download', providerTaskId: taskId });
      const stream = await this.client.videoGeneration.getVideoContent(
        { jobId: taskId, index }, this.requestOptions(context),
      );
      const artifact = await context.artifacts.write({
        attemptToken: context.attemptToken,
        kind: 'video',
        bytes: limitedVideoBytes(streamBytes(stream, context.signal), this.maxArtifactBytes),
        metadata: {
          providerId: this.manifest.providerId,
          modelId: WAN_MODEL,
          providerTaskId: taskId,
          mimeType: 'video/mp4',
          durationMs: params.durationSeconds * 1000,
          resolution: settings.resolution,
          aspectRatio: settings.aspectRatio,
          outputIndex: index,
        },
      });
      context.signal.throwIfAborted();
      artifactIds.push(artifact.id);
    }
    return { artifactIds };
  }

  private async generateImage(
    request: DeepReadonly<GenerationRequest>,
    context: ProviderRunContext,
  ): Promise<GenerationOutput> {
    const params = grokImageParamsSchema.parse(request.params);
    const settings = grokImageSettingsSchema.parse(request.settings ?? {});
    const references = await Promise.all(request.references.map(async (asset) => ({
      type: 'image_url' as const,
      imageUrl: { url: await referenceDataUrl(asset, context) },
    })));
    const input: ImageGenerationRequest & { stream: false } = {
      model: GROK_IMAGE_MODEL,
      prompt: params.prompt,
      resolution: settings.resolution,
      aspectRatio: settings.aspectRatio,
      quality: settings.quality,
      n: 1,
      stream: false,
      ...(references.length === 0 ? {} : { inputReferences: references }),
    };
    context.reportProgress({ attemptToken: context.attemptToken, fraction: 0.05, stage: 'generate' });
    const response = await this.client.images.generate(
      { imageGenerationRequest: input }, this.requestOptions(context),
    );
    context.signal.throwIfAborted();
    if (!('data' in response) || !Array.isArray(response.data) || response.data.length !== 1) {
      throw new ProviderError('INVALID_OUTPUT', 'OpenRouter did not return one image');
    }
    const image = response.data[0]!;
    const bytes = decodeImage(image.b64Json, this.maxArtifactBytes);
    const mimeType = imageMimeType(bytes);
    if (image.mediaType !== undefined && image.mediaType !== mimeType) {
      throw new ProviderError('INVALID_OUTPUT', 'OpenRouter image media type does not match its bytes');
    }
    const metadata: JsonObject = {
      providerId: this.manifest.providerId,
      modelId: GROK_IMAGE_MODEL,
      mimeType,
      resolution: settings.resolution,
      aspectRatio: settings.aspectRatio,
      quality: settings.quality,
    };
    const artifact = await context.artifacts.write({
      attemptToken: context.attemptToken, kind: 'image', bytes, metadata,
    });
    context.signal.throwIfAborted();
    return { artifactIds: [artifact.id] };
  }
}

function checkedTaskId(taskId: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(taskId)) {
    throw new ProviderError('INVALID_OUTPUT', 'OpenRouter returned an invalid video task identifier');
  }
  return taskId;
}

async function* limitedVideoBytes(bytes: AsyncIterable<Uint8Array>, limit: number): AsyncIterable<Uint8Array> {
  let length = 0;
  const prefix = new Uint8Array(8);
  const buffered: Uint8Array[] = [];
  let prefixLength = 0;
  let verified = false;
  for await (const chunk of bytes) {
    length += chunk.byteLength;
    if (length > limit) throw new ProviderError('INVALID_OUTPUT', 'OpenRouter video exceeds the artifact size limit');
    if (verified) { yield chunk; continue; }
    const count = Math.min(8 - prefixLength, chunk.byteLength);
    prefix.set(chunk.subarray(0, count), prefixLength);
    prefixLength += count;
    buffered.push(chunk);
    if (prefixLength < 8) continue;
    if (Buffer.from(prefix.subarray(4, 8)).toString('ascii') !== 'ftyp') {
      throw new ProviderError('INVALID_OUTPUT', 'OpenRouter content does not have an MP4 file header');
    }
    verified = true;
    for (const part of buffered) yield part;
    buffered.length = 0;
  }
  if (!verified) throw new ProviderError('INVALID_OUTPUT', 'OpenRouter returned empty or incomplete MP4 content');
}

function decodeImage(base64: string, limit: number): Uint8Array {
  if (base64.length === 0 || base64.length > Math.ceil(limit / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new ProviderError('INVALID_OUTPUT', 'OpenRouter returned invalid or oversized image bytes');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > limit) {
    throw new ProviderError('INVALID_OUTPUT', 'OpenRouter returned empty or oversized image bytes');
  }
  return bytes;
}

function imageMimeType(bytes: Uint8Array): string {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp';
  throw new ProviderError('INVALID_OUTPUT', 'OpenRouter returned an unsupported image format');
}
