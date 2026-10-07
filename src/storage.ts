import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { generationRequestSchema, type AssetData, type DeepReadonly, type GenerationArtifact, type GenerationJob } from './contracts.js';
import { assertJobTransition, ProviderError, type ArtifactStore, type ArtifactWriteRequest, type JobRepository, type JobUpdateGuard, type MediaReader } from './generation.js';

const jobSchema = z.strictObject({
  id: z.string().min(1), request: generationRequestSchema,
  state: z.enum(['queued', 'running', 'cancelRequested', 'succeeded', 'failed', 'canceled', 'interrupted']),
  attempt: z.number().int().positive().safe(), progress: z.number().min(0).max(1),
  providerTaskId: z.string().min(1).max(500).optional(), artifactIds: z.array(z.string().min(1)),
  error: z.strictObject({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});

const artifactSchema = z.strictObject({
  id: z.string().uuid(), jobId: z.string().min(1),
  asset: z.strictObject({
    id: z.string().uuid(), kind: z.enum(['audio', 'image', 'video']), fileRef: z.string(),
    metadata: z.record(z.string(), z.json()),
  }),
});

function checkedJobId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new ProviderError('INVALID_INPUT', '任务 ID 无效');
  return id;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** 单后端进程使用的文件 ledger；多进程/数据库事务需要替换此适配器。 */
export class FileJobRepository implements JobRepository {
  private readonly directory: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(directory: string) { this.directory = resolve(directory); }

  private path(id: string): string { return join(this.directory, `${checkedJobId(id)}.json`); }
  private async locked<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.locks.set(id, next);
    try { return await next; }
    finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }

  async create(job: GenerationJob): Promise<void> {
    const parsed = jobSchema.parse(job);
    await this.locked(job.id, async () => {
      await mkdir(this.directory, { recursive: true });
      // 任务先完整写入临时文件，再发布；存在的 ID 不会被覆盖。
      if (await this.load(job.id)) throw new ProviderError('INVALID_INPUT', '任务 ID 已存在');
      await atomicJson(this.path(job.id), parsed);
    });
  }

  async get(jobId: string): Promise<GenerationJob | undefined> {
    checkedJobId(jobId);
    await this.locks.get(jobId)?.catch(() => {});
    return this.load(jobId);
  }

  private async load(jobId: string): Promise<GenerationJob | undefined> {
    try { return jobSchema.parse(JSON.parse(await readFile(this.path(jobId), 'utf8'))) as GenerationJob; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  async list(states: readonly GenerationJob['state'][]): Promise<GenerationJob[]> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const jobs: GenerationJob[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const job = await this.get(file.slice(0, -5));
      if (job && states.includes(job.state)) jobs.push(job);
    }
    return jobs;
  }

  async update(guard: JobUpdateGuard, mutate: (current: DeepReadonly<GenerationJob>) => GenerationJob): Promise<GenerationJob | undefined> {
    return this.locked(guard.attemptToken.jobId, async () => {
      const current = await this.load(guard.attemptToken.jobId);
      if (!current || current.attempt !== guard.attemptToken.attempt || !guard.states.includes(current.state)) return undefined;
      if (['succeeded', 'failed', 'canceled'].includes(current.state)) return undefined;
      const draft = mutate(structuredClone(current));
      const next = jobSchema.parse(draft) as GenerationJob;
      if (next.id !== current.id || JSON.stringify(next.request) !== JSON.stringify(current.request)) {
        throw new ProviderError('INVALID_INPUT', '任务更新不能修改身份或请求快照');
      }
      if (next.state !== current.state) assertJobTransition(current.state, next.state);
      const expectedAttempt = current.state === 'interrupted' && next.state === 'queued' ? current.attempt + 1 : current.attempt;
      if (next.attempt !== expectedAttempt) throw new ProviderError('INVALID_INPUT', '任务 attempt 更新无效');
      await atomicJson(this.path(next.id), next);
      return next;
    });
  }
}

const formats: Readonly<Record<string, { extension: string; kind: AssetData['kind'] }>> = {
  'audio/mpeg': { extension: 'mp3', kind: 'audio' },
  'audio/wav': { extension: 'wav', kind: 'audio' },
  'image/png': { extension: 'png', kind: 'image' },
  'image/jpeg': { extension: 'jpg', kind: 'image' },
  'image/webp': { extension: 'webp', kind: 'image' },
  'video/mp4': { extension: 'mp4', kind: 'video' },
};

/** 媒体和 metadata 先保存后返回 fileRef，失败只清理本次未发布文件。 */
export class FileArtifactStore implements ArtifactStore, MediaReader {
  private readonly directory: string;
  constructor(directory: string, private readonly maxBytes = 512 * 1024 * 1024) {
    this.directory = resolve(directory);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new ProviderError('INVALID_INPUT', '产物大小上限无效');
  }

  async write(input: ArtifactWriteRequest): Promise<GenerationArtifact> {
    const mimeType = input.metadata.mimeType;
    const format = typeof mimeType === 'string' && Object.hasOwn(formats, mimeType) ? formats[mimeType] : undefined;
    if (!format || format.kind !== input.kind) throw new ProviderError('INVALID_OUTPUT', '产物 MIME 类型与媒体种类不一致');
    const assetId = randomUUID();
    const artifactId = assetId;
    const mediaPath = join(this.directory, `${assetId}.${format.extension}`);
    const temporary = `${mediaPath}.tmp`;
    const metadataPath = join(this.directory, `${artifactId}.json`);
    await mkdir(this.directory, { recursive: true });
    let published = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      let size = 0;
      try {
        const chunks = input.bytes instanceof Uint8Array ? [input.bytes] : input.bytes;
        for await (const chunk of chunks) {
          if (!(chunk instanceof Uint8Array)) throw new ProviderError('INVALID_OUTPUT', '产物流必须返回字节');
          size += chunk.byteLength;
          if (size > this.maxBytes) throw new ProviderError('INVALID_OUTPUT', '产物超过宿主大小上限');
          let offset = 0;
          while (offset < chunk.length) {
            const written = await handle.write(chunk, offset, chunk.length - offset);
            if (!written.bytesWritten) throw new ProviderError('INVALID_OUTPUT', '媒体文件写入失败');
            offset += written.bytesWritten;
          }
        }
        if (!size) throw new ProviderError('INVALID_OUTPUT', '产物内容为空');
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, mediaPath);
      const artifact: GenerationArtifact = {
        id: artifactId, jobId: input.attemptToken.jobId,
        asset: {
          id: assetId, kind: input.kind, fileRef: `pixel-asset:${assetId}`,
          metadata: { ...input.metadata, extension: format.extension, byteLength: size, attempt: input.attemptToken.attempt },
        },
      };
      artifactSchema.parse(artifact);
      await atomicJson(metadataPath, artifact);
      published = true;
      return artifact;
    } finally {
      await unlink(temporary).catch(() => {});
      if (!published) await unlink(mediaPath).catch(() => {});
    }
  }

  async get(artifactId: string): Promise<GenerationArtifact | undefined> {
    if (!z.uuid().safeParse(artifactId).success) throw new ProviderError('INVALID_INPUT', '产物 ID 无效');
    try {
      const artifact = artifactSchema.parse(JSON.parse(await readFile(join(this.directory, `${artifactId}.json`), 'utf8'))) as GenerationArtifact;
      if (artifact.id !== artifactId || artifact.asset.id !== artifactId || artifact.asset.fileRef !== `pixel-asset:${artifactId}`) {
        throw new ProviderError('INVALID_OUTPUT', '产物索引与文件句柄不一致');
      }
      return artifact;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  async listByJob(jobId: string): Promise<GenerationArtifact[]> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const artifacts: GenerationArtifact[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const artifact = await this.get(file.slice(0, -5));
      if (artifact?.jobId === jobId) artifacts.push(artifact);
    }
    return artifacts;
  }

  async resolvePath(asset: DeepReadonly<AssetData>): Promise<string> {
    const id = asset.fileRef.startsWith('pixel-asset:') ? asset.fileRef.slice('pixel-asset:'.length) : '';
    const artifact = await this.get(id);
    if (!artifact || artifact.asset.id !== asset.id || artifact.asset.kind !== asset.kind) {
      throw new ProviderError('UNSUPPORTED_REFERENCE', '宿主资产句柄不存在或归属无效');
    }
    const mimeType = String(artifact.asset.metadata.mimeType);
    const format = Object.hasOwn(formats, mimeType) ? formats[mimeType] : undefined;
    if (!format || format.kind !== artifact.asset.kind || artifact.asset.metadata.extension !== format.extension) {
      throw new ProviderError('INVALID_OUTPUT', '已保存的产物格式无效');
    }
    return join(this.directory, `${id}.${format.extension}`);
  }

  async read(asset: DeepReadonly<AssetData>, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> {
    signal.throwIfAborted();
    const path = await this.resolvePath(asset);
    const bytes = await readFile(path, { signal });
    signal.throwIfAborted();
    const artifact = await this.get(asset.id);
    return { bytes, mimeType: String(artifact!.asset.metadata.mimeType) };
  }
}
