import { generationRequestSchema } from './contracts.js';
import { z } from 'zod';
import type {
  AssetData,
  DeepReadonly,
  GenerationArtifact,
  GenerationJob,
  GenerationRequest,
  JobState,
  JsonObject,
  MediaKind,
  ProjectSnapshot,
  Unsubscribe,
} from './contracts.js';

export interface ModelProviderManifest {
  providerId: string;
  providerVersion: string;
  modelIds: readonly string[];
  /** signal 总会提供；远程服务能否真正终止请求由 provider 声明。 */
  supportsCancellation: boolean;
  /** 仅表示已持久化远端任务的恢复能力，不保证所有模型都可恢复。 */
  supportsResume?: boolean;
}

/** 每个回调、产物写入和 ledger 更新均携带此 token；恢复执行时递增 attempt。 */
export interface GenerationAttemptToken {
  readonly jobId: string;
  readonly attempt: number;
}

export interface GenerationProgress {
  attemptToken: GenerationAttemptToken;
  fraction: number;
  stage?: string;
  providerTaskId?: string;
}

export interface ArtifactWriteRequest {
  attemptToken: GenerationAttemptToken;
  kind: MediaKind;
  bytes: Uint8Array | AsyncIterable<Uint8Array>;
  metadata: JsonObject;
}

/** 宿主产生资源 ID 和 fileRef，provider 无法选择任意文件系统路径。 */
export interface ArtifactWriter {
  write(request: ArtifactWriteRequest): Promise<GenerationArtifact>;
}

/** 产物独立持久化。撤销挂载不删除文件，清理必须考虑文档和历史中的引用。 */
export interface ArtifactStore extends ArtifactWriter {
  get(artifactId: string): Promise<DeepReadonly<GenerationArtifact> | undefined>;
  listByJob(jobId: string): Promise<readonly DeepReadonly<GenerationArtifact>[]>;
}

export interface ProviderRunContext {
  signal: AbortSignal;
  attemptToken: GenerationAttemptToken;
  /** 宿主先核对 attempt 和 running 状态，再接受进度或 providerTaskId。 */
  reportProgress(progress: GenerationProgress): void;
  artifacts: ArtifactWriter;
  /** 从 ledger 读入。已有任务时继续查询/下载，不重新提交生成。 */
  providerTaskId?: string;
  /** 远端任务创建后先等待宿主持久化，再开始轮询。 */
  checkpointProviderTask(taskId: string): Promise<void>;
  media?: MediaReader;
}

export interface MediaReader {
  read(asset: DeepReadonly<AssetData>, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

/** 已解析的正文边界；供应商时间戳适配与真实音频编解码是两个可替换边界。 */
export interface AudioTailProcessingRequest {
  bytes: Uint8Array;
  mimeType: string;
  speechEndSeconds: number;
  /** 若时间戳含额外发音，padding 不得延伸到它的起点。 */
  nextSpeechStartSeconds?: number;
  paddingMs: number;
  fadeMs: number;
  outputFormat: string;
}

export interface AudioTailProcessingResult {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
  sourceDurationSeconds: number;
  durationSeconds: number;
}

/** 在同一任务 signal 下解码、裁切和重编码；不能裁切压缩音频的裸字节。 */
export interface AudioPostProcessor {
  trimTail(request: AudioTailProcessingRequest, signal: AbortSignal): Promise<AudioTailProcessingResult>;
}

export type ProviderErrorCode =
  | 'INVALID_INPUT' | 'UNSUPPORTED_MODEL' | 'UNSUPPORTED_REFERENCE' | 'UNSUPPORTED_RESUME'
  | 'AUTHENTICATION' | 'RATE_LIMITED' | 'UPSTREAM' | 'REMOTE_FAILED' | 'TIMEOUT' | 'CANCELED' | 'INVALID_OUTPUT';

export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, message: string, readonly retryable = false) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ModelProviderOptions {
  timeoutMs?: number;
  prepareRequest?: (request: DeepReadonly<GenerationRequest>) => GenerationRequest;
}

/** 兼容 ElevenLabs SDK：fetch 拒绝时其 HTTP timer 未清理，转为无内容的本地错误响应。 */
export function createSdkFetch(fetchImplementation: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    try { return await fetchImplementation(input, init); }
    catch { return new Response(null, { status: 599, statusText: 'Local transport failure' }); }
  };
}

/** SDK HTTP 超时不一定涵盖响应体读取；所有流、轮询和写文件都使用同一 signal。 */
export function streamBytes(stream: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<Uint8Array> {
  return (async function* () {
    signal.throwIfAborted();
    const reader = stream.getReader();
    const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      let size = 0;
      while (true) {
        signal.throwIfAborted();
        const part = await abortable(reader.read(), signal);
        signal.throwIfAborted();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw new ProviderError('INVALID_OUTPUT', '媒体流格式无效');
        size += part.value.byteLength;
        if (part.value.byteLength) yield part.value;
      }
      if (!size) throw new ProviderError('INVALID_OUTPUT', '模型返回了空媒体流');
    } finally {
      signal.removeEventListener('abort', onAbort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  })();
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => { reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function waitForProvider(ms: number, signal: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) return Promise.reject(new ProviderError('INVALID_INPUT', '轮询间隔无效'));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function referenceDataUrl(asset: DeepReadonly<AssetData>, context: ProviderRunContext): Promise<string> {
  if (asset.kind !== 'image' || !context.media) throw new ProviderError('UNSUPPORTED_REFERENCE', '需要宿主提供受控图片读取器');
  const content = await context.media.read(asset, context.signal);
  context.signal.throwIfAborted();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(content.mimeType)
      || !content.bytes.byteLength || content.bytes.byteLength > 25 * 1024 * 1024) {
    throw new ProviderError('UNSUPPORTED_REFERENCE', '引用图片格式或大小不受支持');
  }
  // fileRef 只交给宿主读取，不能转换成任意远程 URL 或公开本地路径。
  return `data:${content.mimeType};base64,${Buffer.from(content.bytes).toString('base64')}`;
}

function sanitizeProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof z.ZodError) return new ProviderError('INVALID_INPUT', '模型参数不符合 schema');
  const status = error && typeof error === 'object'
    ? ('statusCode' in error ? error.statusCode : 'status' in error ? error.status : undefined)
    : undefined;
  if (status === 401 || status === 403) return new ProviderError('AUTHENTICATION', '供应商认证或访问权限失败');
  if (status === 429) return new ProviderError('RATE_LIMITED', '供应商请求受限，请检查任务状态后再决定重试');
  if (status === 400 || status === 422) return new ProviderError('INVALID_INPUT', '供应商拒绝了模型参数');
  // 原始 SDK 错误可能包含请求头、响应体或签名 URL，不转发它们。
  return new ProviderError('UPSTREAM', '供应商请求失败；未自动重新提交生成');
}

export interface GenerationOutput {
  /** 只能引用本次调用经 ArtifactWriter 产生、且属于当前 job 的产物。 */
  artifactIds: string[];
}

/** 扩展模型调用行为，不管理项目文档、历史、重试队列或任务状态。 */
export abstract class BaseModelProvider {
  abstract readonly manifest: ModelProviderManifest;

  constructor(private readonly options: ModelProviderOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new ProviderError('INVALID_INPUT', '模型执行超时必须是正整数毫秒');
    }
  }

  supports(request: DeepReadonly<GenerationRequest>): boolean {
    return request.providerId === this.manifest.providerId
      && request.providerVersion === this.manifest.providerVersion
      && this.manifest.modelIds.includes(request.modelId);
  }

  async generate(
    request: DeepReadonly<GenerationRequest>,
    context: ProviderRunContext,
  ): Promise<GenerationOutput> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new Error('provider deadline exceeded')), this.options.timeoutMs ?? 30 * 60_000);
    try {
      controller.signal.throwIfAborted();
      const parsed = generationRequestSchema.parse(request) as GenerationRequest;
      let normalized: GenerationRequest;
      try { normalized = this.options.prepareRequest?.(parsed) ?? parsed; }
      catch (error) {
        if (error instanceof ProviderError || error instanceof z.ZodError) throw error;
        throw new ProviderError('INVALID_INPUT', '模型输入与声明能力不兼容');
      }
      const validated = generationRequestSchema.parse(normalized) as GenerationRequest;
      if (!this.supports(validated)) throw new ProviderError('UNSUPPORTED_MODEL', '供应商不支持该模型或适配器版本');
      if (context.providerTaskId && !this.manifest.supportsResume) throw new ProviderError('UNSUPPORTED_RESUME', '该供应商不能恢复远端任务');
      const createdArtifacts = new Set<string>();
      const runContext: ProviderRunContext = {
        ...context,
        signal: controller.signal,
        artifacts: {
          async write(writeRequest) {
            controller.signal.throwIfAborted();
            if (writeRequest.attemptToken.jobId !== context.attemptToken.jobId
                || writeRequest.attemptToken.attempt !== context.attemptToken.attempt) {
              throw new ProviderError('INVALID_OUTPUT', '产物不属于当前执行 attempt');
            }
            const artifact = await context.artifacts.write(writeRequest);
            if (artifact.jobId !== context.attemptToken.jobId || !artifact.id) {
              throw new ProviderError('INVALID_OUTPUT', '宿主返回了错误的产物归属');
            }
            createdArtifacts.add(artifact.id);
            controller.signal.throwIfAborted();
            return artifact;
          },
        },
      };
      const output = await abortable(this.performGeneration(validated, runContext), controller.signal);
      controller.signal.throwIfAborted();
      if (!output.artifactIds.length || new Set(output.artifactIds).size !== output.artifactIds.length
          || output.artifactIds.some(id => typeof id !== 'string' || !id.length || !createdArtifacts.has(id))) {
        throw new ProviderError('INVALID_OUTPUT', '模型未返回有效的产物 ID');
      }
      return output;
    } catch (error) {
      if (context.signal.aborted) throw new ProviderError('CANCELED', '生成已在本地取消');
      if (controller.signal.aborted) throw new ProviderError('TIMEOUT', '模型生成超过执行时限；未自动重新提交');
      throw sanitizeProviderError(error);
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
    }
  }

  protected abstract performGeneration(
    request: DeepReadonly<GenerationRequest>,
    context: ProviderRunContext,
  ): Promise<GenerationOutput>;
}

export interface JobUpdateGuard {
  attemptToken: GenerationAttemptToken;
  states: readonly JobState[];
}

/** 独立 ledger，不进入 ProjectDocument 的 patches 或撤销历史。 */
export interface JobRepository {
  create(job: GenerationJob): Promise<void>;
  get(jobId: string): Promise<DeepReadonly<GenerationJob> | undefined>;
  list(states: readonly JobState[]): Promise<readonly DeepReadonly<GenerationJob>[]>;
  /**
   * 在原子锁/事务中读最新值、校验 guard，再同步运行 mutate 并保存。
   * guard 不匹配返回 undefined；不能接受异步 mutate，也不能改 job ID/request。
   * 终态记录不可再修改，其他状态变化须符合 assertJobTransition。
   */
  update(
    guard: JobUpdateGuard,
    mutate: (current: DeepReadonly<GenerationJob>) => GenerationJob,
  ): Promise<DeepReadonly<GenerationJob> | undefined>;
}

export type GenerationEvent =
  | { type: 'generation.changed'; job: DeepReadonly<GenerationJob> }
  | { type: 'generation.progress'; progress: GenerationProgress };

/**
 * 调度器契约；此骨架不实现 worker 或网络调用。
 * 完成只保存 Artifact 和 Job，通过独立、可撤销的 generation.applyResult Action 挂载产物。
 */
export interface GenerationCoordinator {
  submit(request: GenerationRequest): Promise<DeepReadonly<GenerationJob>>;
  /** queued/running -> cancelRequested；运行器结束后再转 canceled。 */
  cancel(jobId: string): Promise<DeepReadonly<GenerationJob>>;
  /** failed/canceled 后重试创建新 job ID 和新 attempt，不重新打开终态记录。 */
  retry(jobId: string): Promise<DeepReadonly<GenerationJob>>;
  subscribe(listener: (event: GenerationEvent) => void): Unsubscribe;
}

const allowedTransitions: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['running', 'cancelRequested', 'failed', 'interrupted'],
  running: ['succeeded', 'failed', 'cancelRequested', 'interrupted'],
  cancelRequested: ['canceled'],
  interrupted: ['queued', 'cancelRequested', 'failed'],
  succeeded: [],
  failed: [],
  canceled: [],
};

export function assertJobTransition(from: JobState, to: JobState): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new Error(`Invalid generation job transition: ${from} -> ${to}`);
  }
}

export interface JobTransitionChanges {
  progress?: number;
  providerTaskId?: string;
  artifactIds?: readonly string[];
  error?: NonNullable<GenerationJob['error']>;
}

/** 纯函数：时间由调用方传入；从 interrupted 恢复会换 attempt 并清除旧运行结果。 */
export function transitionJob(
  job: DeepReadonly<GenerationJob>,
  state: JobState,
  updatedAt: string,
  changes: JobTransitionChanges = {},
): GenerationJob {
  assertJobTransition(job.state, state);
  if (!Number.isSafeInteger(job.attempt) || job.attempt < 1) {
    throw new Error('Job attempt must be a positive safe integer');
  }
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw new Error('updatedAt must be a valid timestamp');
  }
  // 克隆 JSON 记录，返回值的后续修改也不会污染原始 snapshot。
  const next = structuredClone(job as unknown) as GenerationJob;
  next.state = state;
  next.updatedAt = updatedAt;
  if (changes.progress !== undefined) next.progress = changes.progress;
  if (changes.providerTaskId !== undefined) next.providerTaskId = changes.providerTaskId;
  if (changes.artifactIds !== undefined) next.artifactIds = [...changes.artifactIds];
  if (changes.error !== undefined) next.error = { ...changes.error };

  if (job.state === 'interrupted' && state === 'queued') {
    if (!Number.isSafeInteger(job.attempt + 1)) throw new Error('Job attempt overflow');
    next.attempt = job.attempt + 1;
    next.progress = 0;
    next.artifactIds = [];
    // 恢复继续查询原远端任务；删除 ID 会将恢复误变成再次付费提交。
    delete next.error;
  }
  if (!Number.isFinite(next.progress) || next.progress < 0 || next.progress > 1) {
    throw new Error('Job progress must be between 0 and 1');
  }
  if (state === 'succeeded') {
    if (next.artifactIds.length === 0) throw new Error('A succeeded job must have artifacts');
    next.progress = 1;
    delete next.error;
  }
  if (state === 'failed' && next.error === undefined) {
    throw new Error('A failed job must have an error');
  }
  if (state === 'canceled') delete next.error;
  return next;
}

/** 用于进度和完成回调的首道过滤；原子更新仍必须再次检查同样的 guard。 */
export function isJobAttemptCurrent(
  job: DeepReadonly<GenerationJob>,
  attemptToken: GenerationAttemptToken,
  states: readonly JobState[] = ['running'],
): boolean {
  return job.id === attemptToken.jobId
    && job.attempt === attemptToken.attempt
    && states.includes(job.state);
}

export type GenerationResultStaleness =
  | 'OLD_ATTEMPT'
  | 'JOB_NOT_SUCCEEDED'
  | 'WRONG_PROJECT'
  | 'TARGET_DELETED'
  | 'REQUEST_REPLACED'
  | 'INPUT_CHANGED';

/**
 * currentInputFingerprint 必须由后端基于当前目标及相关设置计算，不能信任 renderer。
 * 不比较全局 revision：不相关的时间线编辑不会使结果过期。
 */
export function getGenerationResultStaleness(
  snapshot: DeepReadonly<ProjectSnapshot>,
  job: DeepReadonly<GenerationJob>,
  currentInputFingerprint: string,
  attemptToken?: GenerationAttemptToken,
): GenerationResultStaleness | undefined {
  if (attemptToken !== undefined
    && (job.id !== attemptToken.jobId || job.attempt !== attemptToken.attempt)) return 'OLD_ATTEMPT';
  if (job.state !== 'succeeded') return 'JOB_NOT_SUCCEEDED';
  if (snapshot.document.id !== job.request.projectId) return 'WRONG_PROJECT';
  if (!Object.hasOwn(snapshot.document.items, job.request.targetItemId)) return 'TARGET_DELETED';
  const item = snapshot.document.items[job.request.targetItemId];
  if (item === undefined) return 'TARGET_DELETED';
  if (item.generationToken !== job.request.generationToken) return 'REQUEST_REPLACED';
  if (currentInputFingerprint !== job.request.inputFingerprint) return 'INPUT_CHANGED';
  return undefined;
}

export function isGenerationResultCurrent(
  snapshot: DeepReadonly<ProjectSnapshot>,
  job: DeepReadonly<GenerationJob>,
  currentInputFingerprint: string,
  attemptToken?: GenerationAttemptToken,
): boolean {
  return getGenerationResultStaleness(snapshot, job, currentInputFingerprint, attemptToken) === undefined;
}

/** 挂载 Action 还要校验 ledger 成功产物列表，不能只凭任意 asset ID 挂载。 */
export function isArtifactOwnedByJob(
  job: DeepReadonly<GenerationJob>,
  artifact: DeepReadonly<GenerationArtifact>,
): boolean {
  return job.state === 'succeeded'
    && artifact.jobId === job.id
    && job.artifactIds.includes(artifact.id);
}
