import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from './backend.js';
import type { DeepReadonly, GenerationJob, ProjectSnapshot } from './contracts.js';
import { assertJobTransition, type JobRepository, type JobUpdateGuard } from './generation.js';
import { jobSchema } from './storage.js';
import { DurableWorkbenchRepository, createInitialWorkbenchProject } from './workbench.js';
import { validateWorkbenchProjectFile, type WorkbenchProjectFile } from './project-files.js';

export interface SharedDocumentStore {
  documentEntries(path: string): Promise<Array<{ type: string; name: string }>>;
  readDocument(path: string): Promise<unknown | undefined>;
  /** Atomic create-only publication. A renamed collision must report REVISION_CONFLICT. */
  createDocument(path: string, value: unknown): Promise<void>;
}
const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
const versionSchema = z.strictObject({ version: z.literal(1), publicationId: z.uuid(), sequence: z.number().int().nonnegative().safe(), parent: z.string().regex(/^[a-f0-9]{64}$/).nullable(), value: z.json() });
const slot = (sequence: number) => `${String(sequence).padStart(12, '0')}.json`;
const shardSize = 1000;
const shard = (sequence: number) => `part-${String(Math.floor(sequence / shardSize)).padStart(9, '0')}`;
const keyOf = (id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new DomainError('INVALID_INPUT', '共享对象 ID 无效');
  return id;
};

/** Immutable slots use Seafile replace=0, whose server retries concurrent uploads with unique filenames.
 * Exact slot names alone form the ledger; renamed contenders never become authoritative versions. */
export class SharedVersionedDocument<T> {
  constructor(private readonly store: SharedDocumentStore, readonly path: string, private readonly validate: (value: unknown) => T, private readonly authorizePublication: () => Promise<void> = async () => {}) {}
  private recordPath(sequence: number) { return `${this.path}/${shard(sequence)}/${slot(sequence)}`; }
  async read(): Promise<{ sequence: number; value: T } | undefined> {
    const entries = await this.store.documentEntries(this.path);
    const parts = entries.filter(entry => entry.type === 'dir' && /^part-\d{9}$/.test(entry.name)).map(entry => entry.name).sort();
    if (parts.some((name, index) => name !== shard(index * shardSize))) throw new DomainError('INVALID_INPUT', '共享记录版本链不完整，请保留记录后修复');
    let latestPart = parts.at(-1);
    let partEntries = latestPart ? await this.store.documentEntries(`${this.path}/${latestPart}`) : [];
    // Creating a directory and publishing its first record are separate remote requests.
    if (latestPart && !partEntries.some(entry => entry.type === 'file' && /^\d{12}\.json$/.test(entry.name))) {
      latestPart = parts.at(-2);
      partEntries = latestPart ? await this.store.documentEntries(`${this.path}/${latestPart}`) : [];
    }
    const start = latestPart ? Number(latestPart.slice(5)) * shardSize : 0;
    const directory = latestPart ? `${this.path}/${latestPart}` : this.path;
    const names = partEntries.filter(entry => entry.type === 'file' && /^\d{12}\.json$/.test(entry.name)).map(entry => entry.name).sort();
    if (!names.length) return undefined;
    if (names.length > shardSize || names.some((name, index) => name !== slot(start + index))) throw new DomainError('INVALID_INPUT', '共享记录版本链不完整，请保留记录后修复');
    const sequence = start + names.length - 1;
    const record = versionSchema.parse(await this.store.readDocument(`${directory}/${slot(sequence)}`));
    if (record.sequence !== sequence) throw new DomainError('INVALID_INPUT', '共享记录版本不一致');
    if (sequence === 0 && record.parent !== null) throw new DomainError('INVALID_INPUT', '共享记录起始版本无效');
    if (sequence > 0) {
      const previousPath = this.recordPath(sequence - 1);
      const previous = versionSchema.parse(await this.store.readDocument(previousPath));
      if (previous.sequence !== sequence - 1 || record.parent !== checksum(previous.value)) throw new DomainError('INVALID_INPUT', '共享记录前后版本不一致');
    }
    return { sequence, value: this.validate(record.value) };
  }
  async publish(expected: { sequence: number; value: T } | undefined, value: T): Promise<void> {
    const checked = this.validate(value);
    const current = await this.read();
    if (current?.sequence !== expected?.sequence || checksum(current?.value) !== checksum(expected?.value)) throw new DomainError('REVISION_CONFLICT', '共享记录已更新，请重新读取后重试');
    const sequence = (current?.sequence ?? -1) + 1;
    const path = this.recordPath(sequence);
    const record = { version: 1, publicationId: randomUUID(), sequence, parent: current ? checksum(current.value) : null, value: checked };
    await this.authorizePublication();
    try { await this.store.createDocument(path, record); }
    catch (error) {
      // A lost upload response is safe to retry only when the exact published slot matches.
      const saved = await this.store.readDocument(path).catch(() => undefined);
      if (saved && checksum(saved) === checksum(record)) return;
      if (saved) throw new DomainError('REVISION_CONFLICT', '共享记录已被其他窗口更新，请重新读取后重试');
      throw error;
    }
  }
}

export interface SharedProjectSummary { id: string; title: string; revision: number; timelineCount: number; assetCount: number }
export class SharedProjectCatalog {
  constructor(readonly store: SharedDocumentStore) {}
  private file(id: string) { return new SharedVersionedDocument(this.store, `projects/${keyOf(id)}/state`, validateWorkbenchProjectFile); }
  async state(id: string): Promise<WorkbenchProjectFile> {
    const record = await this.file(id).read();
    if (!record || record.value.snapshot.document.id !== id) throw new DomainError('NOT_FOUND', '共享项目不存在');
    return record.value;
  }
  async list(input: { limit?: number; cursor?: string } = {}): Promise<{ items: SharedProjectSummary[]; nextCursor?: string }> {
    const limit = z.number().int().min(1).max(50).parse(input.limit ?? 20);
    const ids = (await this.store.documentEntries('projects')).filter(entry => entry.type === 'dir' && /^[a-zA-Z0-9_-]{1,200}$/.test(entry.name)).map(entry => entry.name).sort();
    const offset = input.cursor ? ids.findIndex(id => id === input.cursor) + 1 : 0;
    if (input.cursor && offset === 0) throw new DomainError('INVALID_INPUT', '项目目录位置已失效，请刷新');
    const items: SharedProjectSummary[] = [];
    const page = ids.slice(offset, offset + limit);
    for (const id of page) {
      const state = await this.file(id).read(); if (!state) continue;
      const { document, revision } = state.value.snapshot;
      if (document.id !== id) throw new DomainError('INVALID_INPUT', '共享项目身份与目录不一致');
      items.push({ id, title: document.title, revision, timelineCount: Object.keys(document.timelines).length, assetCount: Object.keys(document.assets).length });
    }
    return { items, ...(offset + limit < ids.length && page.length ? { nextCursor: page.at(-1)! } : {}) };
  }
  async create(title: string, id: string = randomUUID(), initial?: WorkbenchProjectFile): Promise<string> {
    const name = z.string().trim().min(1).max(200).parse(title);
    const snapshot = createInitialWorkbenchProject(); snapshot.document.id = keyOf(id); snapshot.document.title = name;
    const value = validateWorkbenchProjectFile(initial ?? { version: 1, snapshot, history: [], requests: {}, outbox: [] });
    if (value.snapshot.document.id !== id) throw new DomainError('INVALID_INPUT', '导入项目身份不一致');
    await this.file(id).publish(undefined, value); return id;
  }
  async repository(id: string, assertWritable: () => Promise<void> = async () => {}): Promise<DurableWorkbenchRepository> {
    const file = new SharedVersionedDocument(this.store, `projects/${keyOf(id)}/state`, validateWorkbenchProjectFile, assertWritable);
    const state = await this.state(id);
    return new DurableWorkbenchRepository(state, {
      read: async () => (await file.read())!.value,
      publish: async (before, after) => {
        await assertWritable();
        const current = await file.read();
        if (!current || checksum(current.value) !== checksum(before)) throw new DomainError('REVISION_CONFLICT', '项目已更新，请重新读取后重试');
        await file.publish(current, after);
      },
    });
  }
}

export class SharedJobRepository implements JobRepository {
  constructor(private readonly store: SharedDocumentStore, private readonly projectId: string, private readonly assertWritable: () => Promise<void> = async () => {}) { keyOf(projectId); }
  private file(id: string) { return new SharedVersionedDocument(this.store, `projects/${this.projectId}/jobs/${keyOf(id)}`, value => {
    const job = jobSchema.parse(value) as GenerationJob;
    if (job.id !== id || job.request.projectId !== this.projectId) throw new DomainError('INVALID_INPUT', '任务不属于当前项目');
    return job;
  }, this.assertWritable); }
  async get(id: string): Promise<GenerationJob | undefined> { return (await this.file(id).read())?.value; }
  async create(job: GenerationJob): Promise<void> { await this.assertWritable(); await this.file(job.id).publish(undefined, job); }
  async list(states: readonly GenerationJob['state'][]): Promise<GenerationJob[]> {
    const jobs: GenerationJob[] = [];
    for (const entry of await this.store.documentEntries(`projects/${this.projectId}/jobs`)) {
      if (entry.type !== 'dir') continue;
      const job = await this.get(entry.name); if (job && states.includes(job.state)) jobs.push(job);
    }
    return jobs;
  }
  async update(guard: JobUpdateGuard, mutate: (job: DeepReadonly<GenerationJob>) => GenerationJob): Promise<GenerationJob | undefined> {
    await this.assertWritable();
    const file = this.file(guard.attemptToken.jobId); const current = await file.read(); const job = current?.value;
    if (!current || !job || job.attempt !== guard.attemptToken.attempt || !guard.states.includes(job.state) || ['succeeded', 'failed', 'canceled'].includes(job.state)) return undefined;
    const next = jobSchema.parse(mutate(structuredClone(job))) as GenerationJob;
    if (next.id !== job.id || checksum(next.request) !== checksum(job.request)) throw new DomainError('INVALID_INPUT', '不能改变任务身份或请求');
    if (next.state !== job.state) assertJobTransition(job.state, next.state);
    if (next.attempt !== (job.state === 'interrupted' && next.state === 'queued' ? job.attempt + 1 : job.attempt)) throw new DomainError('INVALID_INPUT', '任务 attempt 无效');
    try { await file.publish(current, next); return next; }
    catch (error) { if (error instanceof DomainError && error.code === 'REVISION_CONFLICT') return undefined; throw error; }
  }
}

const leaseSchema = z.strictObject({ owner: z.uuid().nullable(), expiresAt: z.number().int().nonnegative().safe() });
/** One active editing/generation host per project; parallel windows share its one session. */
export class SharedProjectLease {
  private readonly owner = randomUUID();
  private readonly file: SharedVersionedDocument<z.infer<typeof leaseSchema>>;
  private confirmedExpiry = 0;
  get expiresAt(): number { return this.confirmedExpiry; }
  private constructor(store: SharedDocumentStore, id: string, private readonly now: () => number) {
    this.file = new SharedVersionedDocument(store, `projects/${keyOf(id)}/lease`, value => leaseSchema.parse(value));
  }
  static async acquire(store: SharedDocumentStore, id: string, now: () => number = Date.now): Promise<SharedProjectLease> {
    const lease = new SharedProjectLease(store, id, now);
    const current = await lease.file.read();
    if (current?.value.owner && current.value.expiresAt > now()) throw new DomainError('NOT_APPLICABLE', '此项目正在其他 Pixel 会话中编辑；关闭该会话后再打开');
    const expiresAt = now() + 120_000;
    await lease.file.publish(current, { owner: lease.owner, expiresAt });
    lease.confirmedExpiry = expiresAt;
    return lease;
  }
  async assertWritable(): Promise<void> {
    if (this.confirmedExpiry <= this.now()) throw new DomainError('NOT_APPLICABLE', '共享项目会话已过期，请重新打开项目');
    const current = await this.file.read();
    if (current?.value.owner !== this.owner || current.value.expiresAt <= this.now()) throw new DomainError('NOT_APPLICABLE', '共享项目会话已过期，请重新打开项目');
    if (this.confirmedExpiry <= this.now()) throw new DomainError('NOT_APPLICABLE', '共享项目会话已过期，请重新打开项目');
  }
  async renew(): Promise<void> {
    const current = await this.file.read();
    if (current?.value.owner !== this.owner || current.value.expiresAt <= this.now()) throw new DomainError('NOT_APPLICABLE', '共享项目会话已失效');
    const expiresAt = this.now() + 120_000;
    await this.file.publish(current, { owner: this.owner, expiresAt });
    this.confirmedExpiry = expiresAt;
  }
  async release(): Promise<void> {
    this.confirmedExpiry = 0;
    const current = await this.file.read();
    if (current?.value.owner === this.owner) await this.file.publish(current, { owner: null, expiresAt: 0 });
  }
}
