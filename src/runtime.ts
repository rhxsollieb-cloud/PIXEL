import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OpenRouter } from '@openrouter/sdk';
import type { DeepReadonly, GenerationJob, GenerationRequest } from './contracts.js';
import { generationRequestSchema } from './contracts.js';
import { BaseModelProvider, ProviderError, transitionJob, type GenerationProgress, type MediaArtifactStore } from './generation.js';
import { modelRegistry } from './models.js';
import { ElevenLabsModelProvider } from './providers/elevenlabs.js';
import { OpenRouterModelProvider } from './providers/openrouter.js';
import { FileJobRepository } from './storage.js';
import type { BackendConfiguration } from './backend-configuration.js';
import { generationInputFingerprint } from './generation-fingerprint.js';
export { loadBackendConfiguration, type BackendConfiguration } from './backend-configuration.js';
export { generationInputFingerprint } from './generation-fingerprint.js';

export class ProviderRegistry {
  private readonly providers = new Map<string, BaseModelProvider>();
  register(provider: BaseModelProvider): void {
    if (this.providers.has(provider.manifest.providerId)) throw new ProviderError('INVALID_INPUT', '供应商已注册');
    this.providers.set(provider.manifest.providerId, provider);
  }
  get(providerId: string): BaseModelProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new ProviderError('UNSUPPORTED_MODEL', '供应商未注册');
    return provider;
  }
}

export interface RunGenerationOptions {
  signal?: AbortSignal;
  /** 可信宿主专用：此 reason 表示进程结束，保存为 interrupted 而不是用户取消。 */
  interruptionReason?: unknown;
  onProgress?: (progress: GenerationProgress) => void;
  onJob?: (job: DeepReadonly<GenerationJob>) => void;
}

/** 后端任务执行闭环；项目 Action 的 outbox 消费者复用它，UI 不直接持有 SDK。 */
export class GenerationRunner {
  constructor(
    readonly providers: ProviderRegistry,
    readonly jobs: FileJobRepository,
    readonly artifacts: MediaArtifactStore,
  ) {}

  async run(request: DeepReadonly<GenerationRequest>, options: RunGenerationOptions = {}): Promise<GenerationJob> {
    const job = await this.enqueue(request);
    try { options.onJob?.(structuredClone(job)); } catch { /* 展示错误不改变执行。 */ }
    return this.execute(job, options);
  }

  /** Outbox 先原子保存确定的 jobId，消费者只创建该任务，不产生新的身份。 */
  async enqueue(request: DeepReadonly<GenerationRequest>, jobId: string = randomUUID()): Promise<GenerationJob> {
    const prepared = modelRegistry.prepareRequest(generationRequestSchema.parse(request) as GenerationRequest);
    prepared.inputFingerprint = generationInputFingerprint(prepared);
    const provider = this.providers.get(prepared.providerId);
    if (!provider.supports(prepared)) throw new ProviderError('UNSUPPORTED_MODEL', '供应商模型或版本不匹配');
    const now = new Date().toISOString();
    const job: GenerationJob = {
      id: jobId, request: prepared, state: 'queued', attempt: 1,
      progress: 0, artifactIds: [], createdAt: now, updatedAt: now,
    };
    await this.jobs.create(job);
    return job;
  }

  /** 新任务只从已持久化 queued 状态启动；running 无远端 ID 不会自动重投。 */
  async runQueued(jobId: string, options: RunGenerationOptions = {}): Promise<GenerationJob> {
    const job = await this.jobs.get(jobId);
    if (!job || job.state !== 'queued') throw new ProviderError('INVALID_INPUT', '任务尚未排队或已执行');
    try { options.onJob?.(structuredClone(job)); } catch { /* 展示错误不改变执行。 */ }
    return this.execute(job, options);
  }

  async resume(jobId: string, options: RunGenerationOptions = {}): Promise<GenerationJob> {
    let job = await this.jobs.get(jobId);
    if (!job) throw new ProviderError('INVALID_INPUT', '恢复任务不存在');
    const provider = this.providers.get(job.request.providerId);
    if (!provider.manifest.supportsResume || !job.providerTaskId) {
      throw new ProviderError('UNSUPPORTED_RESUME', '没有可恢复的远端任务 ID；未重新提交生成');
    }
    // 本方法用于重启后的任务；同一进程仍在执行的任务不能二次 resume。
    if (this.active.has(job.id)) throw new ProviderError('INVALID_INPUT', '任务正在执行');
    if (job.state === 'queued') {
      try { options.onJob?.(structuredClone(job)); } catch { /* 展示错误不改变执行。 */ }
      return this.execute(job, options);
    }
    if (job.state === 'running') job = await this.change(job, 'interrupted');
    if (job.state !== 'interrupted') throw new ProviderError('UNSUPPORTED_RESUME', '仅能恢复中断的任务');
    job = await this.change(job, 'queued');
    try { options.onJob?.(structuredClone(job)); } catch { /* 展示错误不改变执行。 */ }
    return this.execute(job, options);
  }

  private readonly active = new Set<string>();
  private async change(job: GenerationJob, state: GenerationJob['state'], error?: GenerationJob['error'], artifactIds?: string[]): Promise<GenerationJob> {
    const changed = await this.jobs.update(
      { attemptToken: { jobId: job.id, attempt: job.attempt }, states: [job.state] },
      current => transitionJob(current, state, new Date().toISOString(), {
        ...(error ? { error } : {}), ...(artifactIds ? { artifactIds } : {}),
      }),
    );
    if (!changed) throw new ProviderError('UPSTREAM', '任务状态已变更，拒绝覆盖');
    return changed;
  }

  private async execute(queued: GenerationJob, options: RunGenerationOptions): Promise<GenerationJob> {
    if (this.active.has(queued.id)) throw new ProviderError('INVALID_INPUT', '任务正在执行');
    this.active.add(queued.id);
    let job = queued;
    const signal = options.signal ?? new AbortController().signal;
    try {
      job = await this.change(job, 'running');
      const provider = this.providers.get(job.request.providerId);
      let progress = 0;
      const output = await provider.generate(job.request, {
        signal, attemptToken: { jobId: job.id, attempt: job.attempt },
        ...(job.providerTaskId ? { providerTaskId: job.providerTaskId } : {}),
        artifacts: this.artifacts, media: this.artifacts,
        reportProgress: event => {
          if (job.state !== 'running' || signal.aborted
              || event.attemptToken.jobId !== job.id || event.attemptToken.attempt !== job.attempt
              || !Number.isFinite(event.fraction) || event.fraction < 0 || event.fraction > 1) return;
          progress = Math.max(progress, event.fraction);
          try { options.onProgress?.(event); } catch { /* 展示错误不改变任务结果。 */ }
        },
        checkpointProviderTask: async taskId => {
          if (!taskId || taskId.length > 500) throw new ProviderError('INVALID_OUTPUT', '远端任务 ID 无效');
          const changed = await this.jobs.update(
            { attemptToken: { jobId: job.id, attempt: job.attempt }, states: ['running'] },
            current => {
              if (current.providerTaskId && current.providerTaskId !== taskId) {
                throw new ProviderError('INVALID_OUTPUT', '任务不能替换已保存的远端 ID');
              }
              return { ...structuredClone(current) as GenerationJob, providerTaskId: taskId, progress, updatedAt: new Date().toISOString() };
            },
          );
          if (!changed) throw new ProviderError('UPSTREAM', '远端任务 ID 未能持久化；未开始轮询');
          job = changed;
        },
      });
      signal.throwIfAborted();
      job = await this.change(job, 'succeeded', undefined, output.artifactIds);
    } catch (error) {
      // 等待尚在保存的 checkpoint，避免超时与任务 ID 保存竞争时误丢恢复信息。
      const saved = await this.jobs.get(job.id);
      if (saved) job = saved;
      const providerError = error instanceof ProviderError ? error : new ProviderError('UPSTREAM', '后端任务执行失败');
      if (signal.aborted && options.interruptionReason !== undefined && signal.reason === options.interruptionReason) {
        job = await this.change(job, 'interrupted', { code: 'PROCESS_INTERRUPTED', message: job.providerTaskId ? '宿主中断，原远端任务可以恢复' : '执行中断且没有远端任务 ID；未自动重新提交', retryable: false });
      } else if (signal.aborted || providerError.code === 'CANCELED') {
        job = await this.change(job, 'cancelRequested');
        job = await this.change(job, 'canceled');
      } else if (job.providerTaskId && this.providers.get(job.request.providerId).manifest.supportsResume
          && ['TIMEOUT', 'UPSTREAM', 'RATE_LIMITED', 'AUTHENTICATION'].includes(providerError.code)) {
        job = await this.change(job, 'interrupted', { code: providerError.code, message: providerError.message, retryable: false });
      } else {
        job = await this.change(job, 'failed', { code: providerError.code, message: providerError.message, retryable: providerError.retryable });
      }
    } finally { this.active.delete(queued.id); }
    return job;
  }
}

export function createModelBackend(configuration: BackendConfiguration, artifacts: MediaArtifactStore): GenerationRunner {
  const providers = new ProviderRegistry();
  providers.register(new ElevenLabsModelProvider({ apiKey: configuration.elevenlabsApiKey }));
  providers.register(new OpenRouterModelProvider(new OpenRouter({ apiKey: configuration.openrouterApiKey })));
  return new GenerationRunner(providers,
    new FileJobRepository(join(configuration.storageDirectory, 'jobs')),
    artifacts,
  );
}
