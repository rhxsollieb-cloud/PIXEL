import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, link, rename, unlink, lstat, realpath } from 'node:fs/promises';
import { join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  voiceCloneInputSchema, voiceCloneResultSchema, voiceQuerySchema, voiceSummarySchema,
  type VoiceCloneInput, type VoiceCloneResult, type VoiceErrorCode, type VoicePage,
  type VoiceQuery, type VoiceSummary,
} from './voice-contracts.js';

export type ProviderVoiceQuery = { category: VoiceQuery['category']; limit: number; cursor?: string; search?: string };
export interface ProviderVoicePage { items: VoiceSummary[]; nextCursor?: string }
export type ProviderVoiceCloneInput = Pick<VoiceCloneInput, 'name' | 'bytes' | 'mimeType' | 'fileName'>;
export interface VoiceProvider {
  /** 后端的非秘密账号指纹，绑定分页缓存和 operation ledger；不返回前端。 */
  readonly accountScope: string;
  query(input: ProviderVoiceQuery, signal: AbortSignal): Promise<ProviderVoicePage>;
  clone(input: ProviderVoiceCloneInput, signal: AbortSignal): Promise<VoiceSummary>;
}
export class VoiceServiceError extends Error {
  constructor(readonly code: VoiceErrorCode, message: string) { super(message); this.name = 'VoiceServiceError'; }
}
const messages: Record<VoiceErrorCode, string> = {
  INVALID_INPUT: '声纹请求无效，请检查名称、音频和当前项目',
  AUTHENTICATION: 'ElevenLabs 密钥无效，请检查配置',
  FORBIDDEN: '当前账号或密钥没有声纹权限，请检查套餐和密钥权限',
  RATE_LIMITED: '声纹服务请求过多，请稍后再试',
  UPSTREAM: '声纹服务暂时不可用，请稍后再试',
  TIMEOUT: '读取声纹超时，请稍后重试',
  CANCELED: '声纹操作已取消',
  OUTCOME_UNKNOWN: '此次克隆可能已在 ElevenLabs 创建。请刷新自己的声纹或到 ElevenLabs 核对，本请求不会重复提交',
  REQUEST_ID_REUSED: '同一请求编号对应的克隆内容已改变，请重新发起操作',
  CLOSED: '声纹服务已关闭，请重新打开项目',
  INVALID_OUTPUT: '声纹服务返回了无法识别的结果',
};
export function voiceError(code: VoiceErrorCode): VoiceServiceError { return new VoiceServiceError(code, messages[code]); }
export function sanitizeVoiceError(error: unknown): VoiceServiceError {
  if (error instanceof VoiceServiceError) return voiceError(error.code);
  if (error instanceof Error && error.name === 'ElevenLabsTimeoutError') return voiceError('TIMEOUT');
  if (error instanceof Error && error.name === 'AbortError') return voiceError('CANCELED');
  const status = typeof error === 'object' && error !== null && 'statusCode' in error
    ? (error as { statusCode: unknown }).statusCode : undefined;
  if (status === 401) return voiceError('AUTHENTICATION');
  if (status === 403) return voiceError('FORBIDDEN');
  if (status === 429) return voiceError('RATE_LIMITED');
  if (status === 400 || status === 422) return voiceError('INVALID_INPUT');
  return voiceError('UPSTREAM');
}

const ledgerSchema = z.object({
  version: z.literal(1), command: z.literal('voice.clone'), requestId: z.string(),
  accountScope: z.string(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['attempted', 'succeeded', 'failed', 'unknown']),
  createdAt: z.number(), updatedAt: z.number(),
  result: voiceCloneResultSchema.optional(),
  errorCode: z.enum(['INVALID_INPUT', 'AUTHENTICATION', 'FORBIDDEN', 'RATE_LIMITED', 'OUTCOME_UNKNOWN']).optional(),
}).strict();
type VoiceOperation = z.infer<typeof ledgerSchema>;
type CachedPage = { accountScope: string; category: VoiceQuery['category']; search: string; items: VoiceSummary[];
  nextProviderCursor?: string; expiresAt: number };
const cursorSchema = z.object({ v: z.literal(1), id: z.string().uuid(), offset: z.number().int().nonnegative() }).strict();
const providerPageSchema = z.object({ items: z.array(voiceSummarySchema).max(1000), nextCursor: z.string().min(1).max(1000).optional() }).strict();
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function nodeCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}
function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    // 接住晚到的结果/拒绝；本地关闭不能保证供应商没有创建账号资源。
    Promise.resolve().then(() => { if (signal.aborted) throw signal.reason; return operation(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** 声纹查询及外部资源命令的唯一标准入口；不会修改项目、片段或默认音色。 */
export class VoiceService {
  private readonly timeoutMs: number;
  private readonly pages = new Map<string, CachedPage>();
  private readonly pending = new Map<string, { fingerprint: string; promise: Promise<VoiceCloneResult> }>();
  private readonly controllers = new Set<AbortController>();
  private readonly work = new Set<Promise<unknown>>();
  private closed = false;
  private shutdownPromise: Promise<void> | undefined;
  constructor(private readonly provider: VoiceProvider, private readonly ledgerDirectory: string,
    options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || !provider.accountScope || provider.accountScope.length > 200) {
      throw voiceError('INVALID_INPUT');
    }
  }
  query(input: VoiceQuery): Promise<VoicePage> {
    if (this.closed) return Promise.reject(voiceError('CLOSED'));
    const parsed = voiceQuerySchema.safeParse(input);
    if (!parsed.success) return Promise.reject(voiceError('INVALID_INPUT'));
    return this.track(this.withLifecycle(async signal => {
      const query = parsed.data;
      const search = query.search ?? '';
      let page: CachedPage;
      let id: string;
      let offset = 0;
      if (query.cursor) {
        let decoded: z.infer<typeof cursorSchema>;
        try { decoded = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))); }
        catch { throw voiceError('INVALID_INPUT'); }
        id = decoded.id; offset = decoded.offset;
        const cached = this.pages.get(id);
        if (!cached || cached.expiresAt < Date.now() || cached.accountScope !== this.provider.accountScope
          || cached.category !== query.category || cached.search !== search || offset > cached.items.length) {
          throw voiceError('INVALID_INPUT');
        }
        page = cached;
        if (offset === page.items.length && page.nextProviderCursor) {
          ({ id, page } = await this.fetchPage(query.category, search, signal, page.nextProviderCursor));
          offset = 0;
        }
      } else ({ id, page } = await this.fetchPage(query.category, search, signal));
      if (signal.aborted) throw signal.reason;
      const items = page.items.slice(offset, offset + query.limit).map(item => ({ ...item }));
      offset += items.length;
      const nextCursor = offset < page.items.length || page.nextProviderCursor
        ? Buffer.from(JSON.stringify({ v: 1, id, offset })).toString('base64url') : undefined;
      return { items, ...(nextCursor ? { nextCursor } : {}) };
    }));
  }
  clone(input: VoiceCloneInput): Promise<VoiceCloneResult> {
    if (this.closed) return Promise.reject(voiceError('CLOSED'));
    let frozen: VoiceCloneInput;
    let fingerprint: string;
    try { ({ input: frozen, fingerprint } = this.prepareClone(input)); }
    catch (error) { return Promise.reject(error); }
    const running = this.pending.get(frozen.requestId);
    if (running) return running.fingerprint === fingerprint ? running.promise : Promise.reject(voiceError('REQUEST_ID_REUSED'));
    const promise = this.track(this.withLifecycle(signal => this.performClone(frozen, fingerprint, signal)));
    this.pending.set(frozen.requestId, { fingerprint, promise });
    const clear = () => this.pending.delete(frozen.requestId);
    void promise.then(clear, clear);
    return promise;
  }
  /** 宿主先做当前项目/目标授权，再用原始命令查回执；不重复上传，也不依赖后续 revision。 */
  replay(input: VoiceCloneInput): Promise<VoiceCloneResult | undefined> {
    if (this.closed) return Promise.reject(voiceError('CLOSED'));
    let prepared: { input: VoiceCloneInput; fingerprint: string };
    try { prepared = this.prepareClone(input); }
    catch (error) { return Promise.reject(error); }
    return this.track(this.withLifecycle(async signal => {
      const previous = await this.readOperation(this.ledgerPath(prepared.input.requestId));
      if (signal.aborted) throw signal.reason;
      return previous ? this.replayOperation(previous, prepared.input.requestId, prepared.fingerprint) : undefined;
    }));
  }
  /** 同步先拒绝新操作并取消本地等待，再等待 unknown/result 持久化。 */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    for (const controller of this.controllers) controller.abort(voiceError('CANCELED'));
    this.pages.clear();
    this.shutdownPromise = Promise.allSettled([...this.work]).then(() => undefined);
    return this.shutdownPromise;
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.work.add(promise);
    const clear = () => this.work.delete(promise);
    void promise.then(clear, clear);
    return promise;
  }
  private prepareClone(input: VoiceCloneInput): { input: VoiceCloneInput; fingerprint: string } {
    const parsed = voiceCloneInputSchema.safeParse(input);
    if (!parsed.success) throw voiceError('INVALID_INPUT');
    // 在首个 await 前拷贝，调用方不能在 fingerprint 后改变上传内容。
    const frozen = { ...parsed.data, bytes: parsed.data.bytes.slice() };
    const fingerprint = hash(JSON.stringify({ command: 'voice.clone', accountScope: this.provider.accountScope,
      requestId: frozen.requestId, projectId: frozen.projectId, timelineId: frozen.timelineId,
      expectedRevision: frozen.expectedRevision, name: frozen.name, mimeType: frozen.mimeType,
      fileName: frozen.fileName, byteLength: frozen.bytes.byteLength, bytesHash: hash(frozen.bytes) }));
    return { input: frozen, fingerprint };
  }
  private async withLifecycle<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(voiceError('TIMEOUT')), this.timeoutMs);
    try { return await operation(controller.signal); }
    catch (error) { throw sanitizeVoiceError(error); }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  private async fetchPage(category: VoiceQuery['category'], search: string, signal: AbortSignal, cursor?: string): Promise<{ id: string; page: CachedPage }> {
    const raw = await abortable(() => this.provider.query({ category, limit: 100,
      ...(cursor ? { cursor } : {}), ...(search ? { search } : {}) }, signal), signal);
    const parsed = providerPageSchema.safeParse(raw);
    if (!parsed.success || (cursor && parsed.data.nextCursor === cursor)
      || parsed.data.items.some(item => item.category !== category)) throw voiceError('INVALID_OUTPUT');
    const page: CachedPage = { accountScope: this.provider.accountScope, category, search,
      items: parsed.data.items.map(item => ({ ...item })), expiresAt: Date.now() + 5 * 60_000,
      ...(parsed.data.nextCursor ? { nextProviderCursor: parsed.data.nextCursor } : {}) };
    if (signal.aborted) throw signal.reason;
    for (const [key, value] of this.pages) if (value.expiresAt < Date.now()) this.pages.delete(key);
    while (this.pages.size >= 128) this.pages.delete(this.pages.keys().next().value!);
    const id = randomUUID(); this.pages.set(id, page);
    return { id, page };
  }
  private ledgerPath(requestId: string): string { return join(resolve(this.ledgerDirectory), `${hash(this.provider.accountScope + '\0' + requestId)}.json`); }
  private async ensureDirectory(create: boolean): Promise<boolean> {
    const directory = resolve(this.ledgerDirectory);
    const root = parse(directory).root;
    const parts = relative(root, directory).split(sep).filter(Boolean);
    let current = root;
    let exists = true;
    // 创建前先检查所有已有祖先，不能通过 junction/symlink 在目录外创建文件。
    for (const part of parts) {
      current = join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw voiceError('UPSTREAM');
      } catch (error) {
        if (nodeCode(error) !== 'ENOENT') throw voiceError('UPSTREAM');
        exists = false; break;
      }
    }
    if (!exists && !create) return false;
    if (!exists) await mkdir(directory, { recursive: true });
    const actual = await realpath(directory);
    const comparable = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
    if (comparable(actual) !== comparable(directory) || (await lstat(directory)).isSymbolicLink()) throw voiceError('UPSTREAM');
    return true;
  }
  private async checkRecord(path: string): Promise<boolean> {
    if (relative(resolve(this.ledgerDirectory), path) !== path.split(sep).at(-1)) throw voiceError('UPSTREAM');
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw voiceError('UPSTREAM');
      return true;
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return false;
      throw voiceError('UPSTREAM');
    }
  }
  private async readOperation(path: string): Promise<VoiceOperation | undefined> {
    if (!await this.ensureDirectory(false) || !await this.checkRecord(path)) return undefined;
    let text: string;
    try {
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        // 检查已打开的目标后才读取内容，拒绝在检查间被换成外部链接的记录。
        await this.ensureDirectory(false);
        if (!await this.checkRecord(path)) throw voiceError('UPSTREAM');
        const file = await handle.stat();
        const named = await lstat(path);
        if (!file.isFile() || file.dev !== named.dev || file.ino !== named.ino || file.size > 16 * 1024) throw voiceError('UPSTREAM');
        text = await handle.readFile('utf8');
      } finally { await handle.close(); }
    }
    catch (error) { if (nodeCode(error) === 'ENOENT') return undefined; throw voiceError('UPSTREAM'); }
    try {
      if (Buffer.byteLength(text, 'utf8') > 16 * 1024) throw new Error('Invalid operation record');
      return ledgerSchema.parse(JSON.parse(text));
    }
    catch { throw voiceError('OUTCOME_UNKNOWN'); }
  }
  private replayOperation(operation: VoiceOperation, requestId: string, fingerprint: string): VoiceCloneResult {
    if (operation.accountScope !== this.provider.accountScope || operation.requestId !== requestId
      || operation.fingerprint !== fingerprint) throw voiceError('REQUEST_ID_REUSED');
    if (operation.state === 'succeeded' && operation.result?.requestId === requestId) {
      return { requestId, voice: { ...operation.result.voice } };
    }
    if (operation.state === 'failed' && operation.errorCode) throw voiceError(operation.errorCode);
    throw voiceError('OUTCOME_UNKNOWN');
  }
  /** 先写 fsync 的临时文件，再原子创建/替换；create-only claim 防止两个宿主同时 POST。 */
  private async saveOperation(path: string, operation: VoiceOperation, createOnly = false): Promise<boolean> {
    await this.ensureDirectory(true);
    await this.checkRecord(path);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(operation), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      if (createOnly) {
        try { await link(temporary, path); }
        catch (error) { if (nodeCode(error) === 'EEXIST') return false; throw error; }
      } else await rename(temporary, path);
      return true;
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  private async performClone(input: VoiceCloneInput, fingerprint: string, signal: AbortSignal): Promise<VoiceCloneResult> {
    const path = this.ledgerPath(input.requestId);
    const previous = await this.readOperation(path);
    if (signal.aborted) throw signal.reason;
    if (previous) return this.replayOperation(previous, input.requestId, fingerprint);
    const attempt: VoiceOperation = { version: 1, command: 'voice.clone', requestId: input.requestId,
      accountScope: this.provider.accountScope, fingerprint, state: 'attempted', createdAt: Date.now(), updatedAt: Date.now() };
    let claimed: boolean;
    try { claimed = await this.saveOperation(path, attempt, true); }
    catch { throw voiceError('UPSTREAM'); }
    if (!claimed) {
      const existing = await this.readOperation(path);
      if (signal.aborted) throw signal.reason;
      if (!existing) throw voiceError('OUTCOME_UNKNOWN');
      return this.replayOperation(existing, input.requestId, fingerprint);
    }
    try {
      if (signal.aborted) throw signal.reason;
      const response = await abortable(() => this.provider.clone({ name: input.name, bytes: input.bytes,
        mimeType: input.mimeType, fileName: input.fileName }, signal), signal);
      const parsed = voiceSummarySchema.safeParse(response);
      if (!parsed.success || parsed.data.category !== 'cloned') throw voiceError('INVALID_OUTPUT');
      if (signal.aborted) throw signal.reason;
      const result = { requestId: input.requestId, voice: parsed.data };
      await this.saveOperation(path, { ...attempt, state: 'succeeded', updatedAt: Date.now(), result });
      // shutdown 期间完成持久化也不让晚到的结果更新已经关闭的界面。
      if (signal.aborted) throw signal.reason;
      return { requestId: result.requestId, voice: { ...result.voice } };
    } catch (error) {
      const failure = sanitizeVoiceError(error);
      const definitive = !signal.aborted && ['INVALID_INPUT', 'AUTHENTICATION', 'FORBIDDEN', 'RATE_LIMITED'].includes(failure.code);
      const errorCode = definitive ? failure.code as 'INVALID_INPUT' | 'AUTHENTICATION' | 'FORBIDDEN' | 'RATE_LIMITED' : 'OUTCOME_UNKNOWN';
      // 已保存的成功不可被关闭阶段覆盖；目录刷新仍可找到该声纹。
      const saved = await this.readOperation(path).catch(() => undefined);
      if (saved?.state !== 'succeeded') {
        await this.saveOperation(path, { ...attempt, state: definitive ? 'failed' : 'unknown', updatedAt: Date.now(), errorCode }).catch(() => undefined);
      }
      throw voiceError(errorCode);
    }
  }
}
