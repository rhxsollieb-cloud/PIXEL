import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AssetData, DeepReadonly, GenerationArtifact, JsonObject, MediaKind } from './contracts.js';
import type { SeafileConfiguration } from './backend-configuration.js';
import { ProviderError, type ArtifactStore, type ArtifactWriteRequest, type MediaReader } from './generation.js';
import { DomainError } from './backend.js';
import { SharedVersionedDocument } from './shared-projects.js';

const formats: Readonly<Record<string, { extension: string; kind: MediaKind }>> = {
  'audio/mpeg': { extension: 'mp3', kind: 'audio' }, 'audio/wav': { extension: 'wav', kind: 'audio' },
  'image/png': { extension: 'png', kind: 'image' }, 'image/jpeg': { extension: 'jpg', kind: 'image' },
  'image/webp': { extension: 'webp', kind: 'image' }, 'video/mp4': { extension: 'mp4', kind: 'video' },
};
const artifactSchema = z.strictObject({
  id: z.uuid(), jobId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  asset: z.strictObject({ id: z.uuid(), kind: z.enum(['audio', 'image', 'video']), fileRef: z.string(), metadata: z.record(z.string(), z.json()) }),
});
const objectIdSchema = z.string().regex(/^[a-f0-9]{40}$/i);
const fileDetailSchema = z.object({ name: z.string(), id: objectIdSchema, size: z.number().int().nonnegative().safe(), type: z.literal('file') });
const repositorySchema = z.object({ id: z.uuid(), name: z.string(), permission: z.string(), encrypted: z.union([z.boolean(), z.number(), z.string()]).optional() });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const invalid = (message = 'Seafile 资源记录无效') => new ProviderError('INVALID_OUTPUT', message);
class MissingFile extends ProviderError { constructor() { super('INVALID_OUTPUT', 'Seafile 资源不存在'); } }
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProviderError('CANCELED', 'Seafile 传输已取消');
}
function waitWithSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  checkSignal(signal);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new ProviderError('CANCELED', 'Seafile 传输已取消'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export interface SeafileStoreOptions { fetch?: typeof fetch }
export interface MediaRange { start: number; end: number }
const locationSchema = z.strictObject({ path: z.string(), objectId: objectIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().positive().safe() });
export interface MediaRecoveryReport { scanned: number; repaired: string[]; missing: string[] }

/**
 * Seafile owns media and the artifact index. The index is published only after media upload succeeds.
 * API specification: https://cloud.seafile.com/published/web-api/v2.1/file-upload.md
 * The archived official JS client lacks this host's cancellation and bounded-read contracts.
 */
export class SeafileArtifactStore implements ArtifactStore, MediaReader {
  private readonly transport: typeof fetch;
  private readonly base: URL;
  private readonly trustedOrigins: ReadonlySet<string>;
  private authPromise: Promise<string> | undefined;
  private repoPromise: Promise<string> | undefined;
  private directoryPromise: Promise<void> | undefined;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly mediaDirectory: string;
  private readonly indexDirectory: string;

  constructor(private readonly configuration: SeafileConfiguration, options: SeafileStoreOptions = {}) {
    this.transport = options.fetch ?? fetch;
    try {
      this.base = new URL(configuration.serverUrl);
      if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash) throw new Error();
      this.base.pathname = `${this.base.pathname.replace(/\/+$/, '')}/`;
      if (!configuration.token && (!configuration.username || !configuration.password)) throw new Error();
      if (!Number.isSafeInteger(configuration.maxBytes) || configuration.maxBytes <= 0 || configuration.maxBytes > 1024 * 1024 * 1024) throw new Error();
      if (!Number.isSafeInteger(configuration.timeoutMs) || configuration.timeoutMs <= 0 || configuration.timeoutMs > 300_000) throw new Error();
      const root = configuration.rootPath;
      if (!root.startsWith('/') || /[\\\x00-\x1f]/.test(root) || root.split('/').some(part => part === '.' || part === '..')) throw new Error();
      this.mediaDirectory = `${root === '/' ? '' : root.replace(/\/+$/, '')}/media`;
      this.indexDirectory = `${root === '/' ? '' : root.replace(/\/+$/, '')}/artifacts`;
      this.trustedOrigins = new Set([this.base.origin, ...configuration.allowedFileOrigins.map(value => {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (this.base.protocol === 'https:' && url.protocol !== 'https:')) throw new Error();
        return url.origin;
      })]);
    } catch { throw new ProviderError('INVALID_INPUT', 'Seafile 存储配置无效'); }
  }

  static async open(configuration: SeafileConfiguration, options: SeafileStoreOptions = {}): Promise<SeafileArtifactStore> {
    const store = new SeafileArtifactStore(configuration, options);
    await store.ensureDirectories();
    return store;
  }

  private url(path: string, query: Record<string, string> = {}): URL {
    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  private fileUrl(value: unknown, operation: 'upload' | 'download'): URL {
    try {
      if (typeof value !== 'string') throw new Error();
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
      if (this.configuration.fileServerUrl) {
        // Only rewrite links from a configured authority or the configured API hostname.
        if (!this.trustedOrigins.has(url.origin) && url.hostname !== this.base.hostname) throw new Error();
        const external = new URL(this.configuration.fileServerUrl);
        if (!this.trustedOrigins.has(external.origin) || external.username || external.password || external.hash || external.search) throw new Error();
        url.protocol = external.protocol; url.hostname = external.hostname; url.port = external.port;
      }
      if (!this.trustedOrigins.has(url.origin)) throw new Error();
      // Signed Seafile links stay in the backend; arbitrary links in project metadata are never used.
      if (operation === 'upload' && !url.pathname.includes('/upload-api/')) throw new Error();
      return url;
    } catch { throw invalid('Seafile 返回了未经配置允许的文件服务地址'); }
  }

  private async request<T>(url: URL, init: RequestInit, signal: AbortSignal | undefined, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = AbortSignal.timeout(this.configuration.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      combined.throwIfAborted();
      const response = await this.transport(url, { ...init, signal: combined, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 404) throw new MissingFile();
        if ([401, 403].includes(response.status)) throw new ProviderError('AUTHENTICATION', 'Seafile 身份验证或资料库权限失败');
        if (response.status === 429) throw new ProviderError('RATE_LIMITED', 'Seafile 请求频率受限', true);
        throw new ProviderError('UPSTREAM', 'Seafile 服务请求失败', response.status >= 500);
      }
      try { const value = await consume(response, combined); combined.throwIfAborted(); return value; }
      finally { await response.body?.cancel().catch(() => {}); }
    } catch (error) {
      if (signal?.aborted) throw new ProviderError('CANCELED', 'Seafile 传输已取消');
      if (timeout.aborted) throw new ProviderError('TIMEOUT', 'Seafile 传输超时', true);
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('UPSTREAM', 'Seafile 连接或响应无效', true);
    }
  }

  private async boundedBytes(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
      await response.body?.cancel().catch(() => {}); throw invalid('Seafile 返回内容超过宿主大小上限');
    }
    if (!response.body) return new Uint8Array();
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maximum) throw invalid('Seafile 返回内容超过宿主大小上限');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  private async json(url: URL, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    return this.request(url, init, signal, async (response, combined) => {
      const bytes = await this.boundedBytes(response, 16 * 1024 * 1024, combined);
      try { return JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw invalid('Seafile 返回了无效 JSON'); }
    });
  }

  private async token(): Promise<string> {
    if (this.configuration.token) return this.configuration.token;
    const pending = this.authPromise ??= this.json(this.url('api2/auth-token/'), {
      method: 'POST', body: new URLSearchParams({ username: this.configuration.username!, password: this.configuration.password! }),
    }).then(value => {
      const result = z.object({ token: z.string().min(1).max(500).regex(/^[\w-]+$/) }).safeParse(value);
      if (!result.success) throw new ProviderError('AUTHENTICATION', 'Seafile 登录未返回有效身份凭证');
      return result.data.token;
    });
    try { return await pending; }
    catch (error) { if (this.authPromise === pending) this.authPromise = undefined; throw error; }
  }

  private async api(path: string, query: Record<string, string> = {}, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    checkSignal(signal);
    const token = await waitWithSignal(this.token(), signal);
    checkSignal(signal);
    const headers = new Headers(init.headers); headers.set('Authorization', `Token ${token}`); headers.set('Accept', 'application/json');
    return this.json(this.url(path, query), { ...init, headers }, signal);
  }

  private async repository(): Promise<string> {
    const pending = this.repoPromise ??= (async () => {
      if (this.configuration.repoId) {
        const parsed = repositorySchema.safeParse(await this.api(`api2/repos/${this.configuration.repoId}/`));
        if (!parsed.success || parsed.data.id !== this.configuration.repoId || parsed.data.permission !== 'rw' || parsed.data.encrypted) throw new ProviderError('AUTHENTICATION', 'Seafile 资料库必须存在、未加密且允许读写');
        return parsed.data.id;
      }
      const parsed = z.array(repositorySchema).max(50_000).safeParse(await this.api('api2/repos/'));
      if (!parsed.success) throw invalid('Seafile 资料库目录无效');
      const matches = parsed.data.filter(repo => repo.name === this.configuration.libraryName);
      if (matches.length > 1) throw new ProviderError('INVALID_INPUT', 'Seafile 存在多个同名资料库，请配置 SEAFILE_REPO_ID');
      if (matches[0]) {
        if (matches[0].permission !== 'rw' || matches[0].encrypted) throw new ProviderError('AUTHENTICATION', 'Seafile 目标资料库必须未加密且允许读写');
        return matches[0].id;
      }
      const created = z.object({ repo_id: z.uuid() }).safeParse(await this.api('api2/repos/', {}, { method: 'POST', body: new URLSearchParams({ name: this.configuration.libraryName, from: 'web' }) }));
      if (!created.success) throw invalid('Seafile 未返回新资料库身份');
      return created.data.repo_id;
    })();
    try { return await pending; }
    catch (error) { if (this.repoPromise === pending) this.repoPromise = undefined; throw error; }
  }

  private async entries(path: string, signal?: AbortSignal): Promise<Array<{ type: string; name: string }>> {
    const parsed = z.array(z.object({ type: z.string(), name: z.string() })).max(50_000).safeParse(await this.api(`api2/repos/${await this.repository()}/dir/`, { p: path }, {}, signal));
    if (!parsed.success) throw invalid('Seafile 资源目录无效');
    return parsed.data;
  }

  private async ensureDirectories(signal?: AbortSignal): Promise<void> {
    checkSignal(signal);
    const pending = this.directoryPromise ??= (async () => {
      const repoId = await this.repository();
      for (const path of [this.mediaDirectory, this.indexDirectory]) {
        try { await this.entries(path); }
        catch (error) {
          if (!(error instanceof MissingFile)) throw error;
          await this.api(`api2/repos/${repoId}/dir/`, { p: path }, { method: 'POST', body: new URLSearchParams({ operation: 'mkdir', create_parents: 'true' }) });
          await this.entries(path);
        }
      }
    })();
    void pending.catch(() => { if (this.directoryPromise === pending) this.directoryPromise = undefined; });
    await waitWithSignal(pending, signal); checkSignal(signal);
  }

  private async upload(directory: string, name: string, bytes: Uint8Array, mimeType: string, signal?: AbortSignal, exclusive = false): Promise<{ id: string }> {
    checkSignal(signal);
    const repoId = await waitWithSignal(this.repository(), signal);
    const url = this.fileUrl(await this.api(`api2/repos/${repoId}/upload-link/`, { p: directory }, {}, signal), 'upload');
    checkSignal(signal);
    url.searchParams.set('ret-json', '1');
    const body = new FormData();
    body.set('parent_dir', directory); body.set('replace', '0');
    body.set('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), name);
    // The link itself authorizes file-server access. Do not forward the account token to another origin.
    const parsed = z.array(z.object({ name: z.string(), id: objectIdSchema, size: z.number().int().nonnegative().safe() })).safeParse(await this.json(url, { method: 'POST', body }, signal));
    checkSignal(signal);
    if (exclusive && parsed.success && parsed.data.length === 1 && parsed.data[0]!.name !== name) throw new DomainError('REVISION_CONFLICT', '共享项目已被其他窗口更新，请重新读取后重试');
    if (!parsed.success || parsed.data.length !== 1 || parsed.data[0]!.name !== name || parsed.data[0]!.size !== bytes.byteLength) throw invalid('Seafile 上传确认与资源不一致');
    return { id: parsed.data[0]!.id };
  }

  private async download(path: string, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
    const url = this.fileUrl(await this.api(`api2/repos/${await this.repository()}/file/`, { p: path }, {}, signal), 'download');
    return this.request(url, {}, signal, (response, combined) => this.boundedBytes(response, maximum, combined));
  }

  /** Backend-only document transport, always confined to the configured Pixel root. */
  private documentPath(relative: string): string {
    if (!/^(projects|operations|locations)(\/[a-zA-Z0-9_.-]+)*$/.test(relative) || relative.split('/').some(part => part === '.' || part === '..')) throw invalid('共享文档位置无效');
    return `${this.configuration.rootPath === '/' ? '' : this.configuration.rootPath.replace(/\/+$/, '')}/${relative}`;
  }
  async documentEntries(relative: string): Promise<Array<{ type: string; name: string }>> {
    try { return await this.entries(this.documentPath(relative)); }
    catch (error) { if (error instanceof MissingFile) return []; throw error; }
  }
  async readDocument(relative: string): Promise<unknown | undefined> {
    try { return JSON.parse(new TextDecoder().decode(await this.download(this.documentPath(relative), 16 * 1024 * 1024))); }
    catch (error) { if (error instanceof MissingFile) return undefined; if (error instanceof SyntaxError) throw invalid('共享项目文档无效'); throw error; }
  }
  async createDocument(relative: string, value: unknown): Promise<void> {
    const path = this.documentPath(relative); const boundary = path.lastIndexOf('/'); const directory = path.slice(0, boundary);
    try { await this.entries(directory); }
    catch (error) {
      if (!(error instanceof MissingFile)) throw error;
      try { await this.api(`api2/repos/${await this.repository()}/dir/`, { p: directory }, { method: 'POST', body: new URLSearchParams({ operation: 'mkdir', create_parents: 'true' }) }); }
      catch (creationError) { await this.entries(directory).catch(() => { throw creationError; }); }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.length > 16 * 1024 * 1024) throw invalid('共享项目文档超过 16 MB 上限');
    await this.upload(directory, path.slice(boundary + 1), bytes, 'application/json', undefined, true);
  }

  private format(kind: MediaKind, metadata: DeepReadonly<JsonObject>) {
    const mimeType = metadata.mimeType;
    const format = typeof mimeType === 'string' && Object.hasOwn(formats, mimeType) ? formats[mimeType] : undefined;
    if (!format || format.kind !== kind) throw invalid('产物 MIME 类型与媒体种类不一致');
    return { ...format, mimeType: mimeType as string };
  }

  private checkedId(value: string): string {
    if (!z.uuid().safeParse(value).success) throw new ProviderError('INVALID_INPUT', '产物 ID 无效');
    return value;
  }

  private async collect(input: ArtifactWriteRequest['bytes'], signal?: AbortSignal): Promise<Uint8Array> {
    checkSignal(signal);
    const chunks: Uint8Array[] = []; let length = 0;
    const iterator = input instanceof Uint8Array ? (async function* () { yield input; })()[Symbol.asyncIterator]() : input[Symbol.asyncIterator]();
    let complete = false;
    try {
      for (;;) {
        checkSignal(signal);
        const next = await waitWithSignal(iterator.next(), signal);
        checkSignal(signal);
        if (next.done) { complete = true; break; }
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array)) throw invalid('产物流必须返回字节');
        length += chunk.byteLength;
        if (length > this.configuration.maxBytes) throw invalid('产物超过宿主大小上限');
        chunks.push(new Uint8Array(chunk));
      }
    } finally {
      // A source iterator can be blocked forever. Cancellation must not wait for its return().
      if (!complete) void iterator.return?.().catch(() => {});
    }
    if (!length) throw invalid('产物内容为空');
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  async write(input: ArtifactWriteRequest): Promise<GenerationArtifact> {
    checkSignal(input.signal);
    this.format(input.kind, input.metadata);
    if (!Number.isSafeInteger(input.attemptToken.attempt) || input.attemptToken.attempt <= 0 || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.attemptToken.jobId)) throw new ProviderError('INVALID_INPUT', '产物任务身份无效');
    const id = randomUUID();
    return this.importArtifact({ id, jobId: input.attemptToken.jobId, asset: { id, kind: input.kind, fileRef: `pixel-asset:${id}`, metadata: { ...input.metadata, attempt: input.attemptToken.attempt } } }, await this.collect(input.bytes, input.signal), input.signal);
  }

  /** Migration preserves handles and user metadata. A reused UUID must identify exactly the same bytes. */
  async importArtifact(existing: DeepReadonly<GenerationArtifact>, input: Uint8Array, signal?: AbortSignal): Promise<GenerationArtifact> {
    checkSignal(signal);
    const parsed = artifactSchema.safeParse(existing);
    if (!parsed.success || existing.id !== existing.asset.id || existing.asset.fileRef !== `pixel-asset:${existing.id}`) throw invalid('迁移产物身份无效');
    const format = this.format(existing.asset.kind, existing.asset.metadata);
    const bytes = await this.collect(input, signal); const sha256 = digest(bytes);
    const previous = this.locks.get(existing.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      checkSignal(signal);
      await this.ensureDirectories(signal);
      const current = await this.get(existing.id, signal);
      if (current) {
        if (current.jobId !== existing.jobId || current.asset.kind !== existing.asset.kind || current.asset.metadata.sha256 !== sha256) throw invalid('Seafile 已有同 ID 但内容不同的资源，迁移未覆盖');
        const verified = await this.read(current.asset, signal ?? new AbortController().signal);
        if (digest(verified.bytes) !== sha256) throw invalid('Seafile 已有资源校验失败');
        return structuredClone(current);
      }
      const path = `${this.mediaDirectory}/${existing.id}.${format.extension}`;
      // An interrupted publication can leave this UUID's media without an index. Reuse only the
      // exact verified bytes; replace=0 would otherwise produce a renamed duplicate on every retry.
      let uploaded: { id: string } | undefined;
      try {
        const detail = fileDetailSchema.safeParse(await this.api(`api2/repos/${await this.repository()}/file/detail/`, { p: path }, {}, signal));
        if (!detail.success || detail.data.name !== `${existing.id}.${format.extension}` || detail.data.size !== bytes.byteLength) throw invalid('Seafile 已有同 ID 但内容不同的资源，迁移未覆盖');
        const orphan = await this.download(path, bytes.byteLength, signal);
        if (orphan.byteLength !== bytes.byteLength || digest(orphan) !== sha256) throw invalid('Seafile 已有同 ID 但内容不同的资源，迁移未覆盖');
        uploaded = { id: detail.data.id };
      } catch (error) { if (!(error instanceof MissingFile)) throw error; }
      uploaded ??= await this.upload(this.mediaDirectory, `${existing.id}.${format.extension}`, bytes, format.mimeType, signal);
      checkSignal(signal);
      const artifact: GenerationArtifact = { id: existing.id, jobId: existing.jobId, asset: {
        id: existing.asset.id, kind: existing.asset.kind, fileRef: existing.asset.fileRef,
        metadata: { ...structuredClone(existing.asset.metadata), mimeType: format.mimeType, extension: format.extension, byteLength: bytes.byteLength, sha256,
          storage: { provider: 'seafile', repoId: await this.repository(), path, objectId: uploaded.id } },
      } };
      const index = new TextEncoder().encode(JSON.stringify(artifact));
      if (index.length > 2 * 1024 * 1024) throw invalid('产物索引超过宿主大小上限');
      // Failed or uncertain publication can leave an unreferenced blob, never a forged project asset.
      checkSignal(signal);
      await this.upload(this.indexDirectory, `${artifact.id}.json`, index, 'application/json', signal);
      checkSignal(signal);
      return artifact;
    });
    this.locks.set(existing.id, next);
    void next.then(() => {}, () => {}).finally(() => { if (this.locks.get(existing.id) === next) this.locks.delete(existing.id); });
    return waitWithSignal(next, signal);
  }

  async get(artifactId: string, signal?: AbortSignal): Promise<GenerationArtifact | undefined> {
    this.checkedId(artifactId);
    let bytes: Uint8Array;
    try { bytes = await this.download(`${this.indexDirectory}/${artifactId}.json`, 2 * 1024 * 1024, signal); }
    catch (error) { if (error instanceof MissingFile) return undefined; throw error; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw invalid(); }
    const parsed = artifactSchema.safeParse(value);
    if (!parsed.success) throw invalid();
    const artifact = parsed.data as GenerationArtifact;
    const format = this.format(artifact.asset.kind, artifact.asset.metadata);
    const storage = z.object({ provider: z.literal('seafile'), repoId: z.uuid(), path: z.string(), objectId: objectIdSchema }).safeParse(artifact.asset.metadata.storage);
    if (artifact.id !== artifactId || artifact.asset.id !== artifactId || artifact.asset.fileRef !== `pixel-asset:${artifactId}` || artifact.asset.metadata.extension !== format.extension ||
      !storage.success || storage.data.repoId !== await this.repository() || storage.data.path !== `${this.mediaDirectory}/${artifactId}.${format.extension}` ||
      !Number.isSafeInteger(artifact.asset.metadata.byteLength) || Number(artifact.asset.metadata.byteLength) <= 0 || Number(artifact.asset.metadata.byteLength) > this.configuration.maxBytes ||
      typeof artifact.asset.metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.asset.metadata.sha256)) throw invalid('Seafile 索引与资源句柄不一致');
    const location = await new SharedVersionedDocument(this, `locations/${artifactId}`, value => locationSchema.parse(value)).read();
    if (location) {
      if (!this.safeMediaPath(location.value.path) || location.value.sha256 !== artifact.asset.metadata.sha256 || location.value.byteLength !== artifact.asset.metadata.byteLength) throw invalid('恢复位置与媒体内容身份不一致');
      artifact.asset.metadata.storage = { ...storage.data, path: location.value.path, objectId: location.value.objectId };
    }
    return artifact;
  }

  private safeMediaPath(path: string): boolean {
    return path.startsWith('/') && !/[\\\x00-\x1f]/.test(path) && !path.split('/').some(part => part === '.' || part === '..') && !path.endsWith('/') && !path.includes('//');
  }

  /** Search only this configured repository. Size narrows candidates; SHA-256 proves identity. */
  async recoverMedia(assets: readonly DeepReadonly<AssetData>[], signal: AbortSignal): Promise<MediaRecoveryReport> {
    const report: MediaRecoveryReport = { scanned: 0, repaired: [], missing: [] };
    const missing: Array<{ asset: DeepReadonly<AssetData>; artifact: GenerationArtifact }> = [];
    for (const asset of assets) {
      checkSignal(signal);
      const artifact = await this.get(asset.id, signal);
      if (!artifact || asset.fileRef !== `pixel-asset:${asset.id}` || artifact.asset.kind !== asset.kind || (asset.metadata.sha256 && asset.metadata.sha256 !== artifact.asset.metadata.sha256)) throw invalid('项目媒体身份与共享索引不一致');
      try { await this.stat(asset, signal); }
      catch (error) {
        if (!(error instanceof MissingFile) && !(error instanceof ProviderError && error.code === 'INVALID_OUTPUT')) throw error;
        missing.push({ asset, artifact });
      }
    }
    if (!missing.length) return report;
    const paths = ['/']; const candidates: Array<{ path: string; size: number; objectId: string }> = [];
    const sizes = new Set(missing.map(entry => Number(entry.artifact.asset.metadata.byteLength)));
    for (let index = 0; index < paths.length; index++) {
      checkSignal(signal);
      if (paths.length > 10_000 || report.scanned > 50_000) throw invalid('扫描范围超过上限，请在 Seafile 整理目录后重试');
      const directory = paths[index]!;
      for (const entry of await this.entries(directory, signal)) {
        if (entry.name.includes('/') || !entry.name || entry.name === '.' || entry.name === '..') throw invalid('Seafile 扫描目录包含无效名称');
        const path = `${directory === '/' ? '' : directory}/${entry.name}`;
        if (!this.safeMediaPath(path)) throw invalid('Seafile 扫描位置无效');
        if (entry.type === 'dir') { paths.push(path); continue; }
        if (entry.type !== 'file') continue;
        report.scanned++;
        if (report.scanned > 50_000) throw invalid('扫描文件数超过上限');
        const detail = fileDetailSchema.parse(await this.api(`api2/repos/${await this.repository()}/file/detail/`, { p: path }, {}, signal));
        if (sizes.has(detail.size)) candidates.push({ path, size: detail.size, objectId: detail.id });
      }
    }
    const matched = new Map<string, { path: string; size: number; objectId: string }>();
    const wanted = new Set(missing.map(entry => String(entry.artifact.asset.metadata.sha256)));
    for (const candidate of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
      checkSignal(signal);
      const bytes = await this.download(candidate.path, candidate.size, signal);
      if (bytes.length !== candidate.size) continue;
      const hash = digest(bytes);
      if (wanted.has(hash) && !matched.has(hash)) matched.set(hash, candidate);
      if (matched.size === wanted.size) break;
    }
    for (const entry of missing) {
      checkSignal(signal);
      const sha256 = String(entry.artifact.asset.metadata.sha256); const found = matched.get(sha256);
      if (!found) { report.missing.push(entry.asset.id); continue; }
      const file = new SharedVersionedDocument(this, `locations/${entry.asset.id}`, value => locationSchema.parse(value));
      await file.publish(await file.read(), { path: found.path, objectId: found.objectId, sha256, byteLength: found.size });
      await this.read(entry.asset, signal);
      report.repaired.push(entry.asset.id);
    }
    return report;
  }

  async listByJob(jobId: string): Promise<GenerationArtifact[]> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(jobId)) throw new ProviderError('INVALID_INPUT', '任务 ID 无效');
    const artifacts: GenerationArtifact[] = [];
    let entries: Array<{ type: string; name: string }>;
    try { entries = await this.entries(this.indexDirectory); }
    catch (error) { if (error instanceof MissingFile) return []; throw error; }
    for (const entry of entries) {
      if (entry.type !== 'file' || !entry.name.endsWith('.json') || !z.uuid().safeParse(entry.name.slice(0, -5)).success) continue;
      const artifact = await this.get(entry.name.slice(0, -5));
      if (artifact?.jobId === jobId) artifacts.push(artifact);
    }
    return artifacts;
  }

  private async verified(asset: DeepReadonly<AssetData>, signal?: AbortSignal): Promise<GenerationArtifact> {
    if (signal?.aborted) throw new ProviderError('CANCELED', 'Seafile 传输已取消');
    const id = asset.fileRef.startsWith('pixel-asset:') ? asset.fileRef.slice('pixel-asset:'.length) : '';
    if (!z.uuid().safeParse(id).success) throw new ProviderError('UNSUPPORTED_REFERENCE', '宿主资产句柄无效');
    const artifact = await this.get(id, signal);
    if (!artifact || artifact.asset.id !== asset.id || artifact.asset.kind !== asset.kind || (asset.metadata.sha256 !== undefined && asset.metadata.sha256 !== artifact.asset.metadata.sha256)) throw new ProviderError('UNSUPPORTED_REFERENCE', '宿主资产句柄不存在或归属无效');
    const storage = artifact.asset.metadata.storage as { path: string; objectId: string };
    const detail = fileDetailSchema.safeParse(await this.api(`api2/repos/${await this.repository()}/file/detail/`, { p: storage.path }, {}, signal));
    if (!detail.success || detail.data.size !== artifact.asset.metadata.byteLength || detail.data.id !== storage.objectId || detail.data.name !== storage.path.split('/').at(-1)) throw invalid('Seafile 媒体已变更或与索引不一致');
    if (signal?.aborted) throw new ProviderError('CANCELED', 'Seafile 传输已取消');
    return artifact;
  }

  async stat(asset: DeepReadonly<AssetData>, signal?: AbortSignal): Promise<{ byteLength: number; mimeType: string }> {
    const artifact = await this.verified(asset, signal);
    return { byteLength: Number(artifact.asset.metadata.byteLength), mimeType: String(artifact.asset.metadata.mimeType) };
  }

  async read(asset: DeepReadonly<AssetData>, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const artifact = await this.verified(asset, signal);
    const bytes = await this.download((artifact.asset.metadata.storage as { path: string }).path, Number(artifact.asset.metadata.byteLength), signal);
    if (bytes.byteLength !== artifact.asset.metadata.byteLength || digest(bytes) !== artifact.asset.metadata.sha256) throw invalid('Seafile 媒体完整性校验失败');
    return { bytes, mimeType: String(artifact.asset.metadata.mimeType) };
  }

  async readRange(asset: DeepReadonly<AssetData>, range: MediaRange, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string; totalBytes: number }> {
    const artifact = await this.verified(asset, signal);
    const totalBytes = Number(artifact.asset.metadata.byteLength);
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= totalBytes) throw new ProviderError('INVALID_INPUT', '媒体读取范围无效');
    const url = this.fileUrl(await this.api(`api2/repos/${await this.repository()}/file/`, { p: (artifact.asset.metadata.storage as { path: string }).path }, {}, signal), 'download');
    const expectedLength = range.end - range.start + 1;
    const bytes = await this.request(url, { headers: { Range: `bytes=${range.start}-${range.end}` } }, signal, async (response, combined) => {
      if (response.status === 206) {
        if (response.headers.get('content-range') !== `bytes ${range.start}-${range.end}/${totalBytes}`) throw invalid('Seafile 媒体范围响应无效');
        const partial = await this.boundedBytes(response, expectedLength, combined);
        if (partial.byteLength !== expectedLength) throw invalid('Seafile 媒体范围内容不完整');
        return partial;
      }
      if (response.status !== 200) throw invalid('Seafile 媒体范围响应无效');
      const full = await this.boundedBytes(response, totalBytes, combined);
      if (full.byteLength !== totalBytes || digest(full) !== artifact.asset.metadata.sha256) throw invalid('Seafile 媒体完整性校验失败');
      return full.slice(range.start, range.end + 1);
    });
    return { bytes, mimeType: String(artifact.asset.metadata.mimeType), totalBytes };
  }
}
