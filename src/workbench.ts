import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  ActionExecutor, ActionRegistry, BaseActionHandler, DomainError, MoveItemHandler,
  assertProjectInvariants,
  type ActionMutation, type CommitResult, type HistoryEntry, type ProjectRepository,
} from './backend.js';
import type {
  ActionEnvelope, ActionReceipt, ActionResult, AssetData, CallerContext, GenerationJob,
  GenerationRequest, JsonObject, ProjectChanged, ProjectDocument, ProjectSnapshot, TimelineItemData,
} from './contracts.js';
import { generationRequestSchema } from './contracts.js';
import { modelRegistry, modelQuerySchema } from './models.js';
import { ProviderError, transitionJob, type GenerationProgress } from './generation.js';
import type { GenerationRunner } from './runtime.js';
import { generationInputFingerprint } from './generation-fingerprint.js';
import { FileArtifactStore } from './storage.js';

export const WORKBENCH_PROJECT_ID = 'pixel-project';
const idSchema = z.string().min(1).max(200);
const tickSchema = z.number().int().nonnegative().safe();
const durationSchema = z.number().int().positive().safe();
const jsonSchema = z.record(z.string(), z.json());
const assetSchema = z.strictObject({ id: z.uuid(), kind: z.enum(['image', 'audio', 'video']), fileRef: z.string().max(500), metadata: jsonSchema });
const jobStates = ['queued', 'running', 'cancelRequested', 'succeeded', 'failed', 'canceled', 'interrupted'] as const;

interface OutboxEntry {
  id: string;
  operation: 'start' | 'resume' | 'cancel';
  jobId: string;
  itemId: string;
  request?: GenerationRequest;
  done: boolean;
}
interface WorkbenchFile {
  version: 1;
  snapshot: ProjectSnapshot;
  requests: Record<string, { signature: string; receipt: ActionReceipt }>;
  history: HistoryEntry[];
  outbox: OutboxEntry[];
}
const outboxSchema = z.strictObject({ id: z.uuid(), operation: z.enum(['start', 'resume', 'cancel']), jobId: z.uuid(), itemId: idSchema, request: generationRequestSchema.optional(), done: z.boolean() })
  .refine(entry => entry.operation !== 'start' || (entry.request !== undefined && entry.request.projectId === WORKBENCH_PROJECT_ID && entry.request.targetItemId === entry.itemId), 'Start outbox requires its matching captured request');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
async function atomicFile(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** 单进程宿主：项目、幂等记录、历史和生成 outbox 在同一个文件提交。 */
export class FileWorkbenchRepository implements ProjectRepository {
  private serial: Promise<unknown> = Promise.resolve();
  private constructor(private readonly path: string, private state: WorkbenchFile) {}

  static async open(directory: string, initial: ProjectSnapshot): Promise<FileWorkbenchRepository> {
    const root = resolve(directory);
    await mkdir(root, { recursive: true });
    const path = join(root, 'project.json');
    let state: WorkbenchFile;
    try {
      state = JSON.parse(await readFile(path, 'utf8')) as WorkbenchFile;
      if (state.version !== 1 || state.snapshot.document.id !== WORKBENCH_PROJECT_ID
          || !Number.isSafeInteger(state.snapshot.revision) || state.snapshot.revision < 0
          || !Array.isArray(state.history) || !Array.isArray(state.outbox) || !state.requests) throw new Error('Invalid project storage');
      assertProjectInvariants(state.snapshot.document);
      state.outbox.forEach(entry => outboxSchema.parse(entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DomainError('INTERNAL', '项目存储无法读取，请保留文件后检查版本');
      assertProjectInvariants(initial.document);
      state = { version: 1, snapshot: structuredClone(initial), requests: {}, history: [], outbox: [] };
      await atomicFile(path, state);
    }
    return new FileWorkbenchRepository(path, state);
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.catch(() => {}).then(operation);
    this.serial = next;
    return next;
  }
  async read(projectId: string): Promise<ProjectSnapshot> {
    await this.serial.catch(() => {});
    if (projectId !== this.state.snapshot.document.id) throw new DomainError('NOT_FOUND', '项目不存在');
    return structuredClone(this.state.snapshot);
  }
  async outbox(): Promise<OutboxEntry[]> {
    await this.serial.catch(() => {});
    return structuredClone(this.state.outbox.filter(entry => !entry.done));
  }
  async receipt(actorId: string, requestId: string): Promise<ActionReceipt | undefined> {
    await this.serial.catch(() => {});
    return structuredClone(this.state.requests[JSON.stringify([actorId, requestId])]?.receipt);
  }
  async completeOutbox(id: string): Promise<void> {
    await this.locked(async () => {
      const next = structuredClone(this.state);
      const entry = next.outbox.find(candidate => candidate.id === id);
      if (!entry || entry.done) return;
      entry.done = true;
      await atomicFile(this.path, next);
      this.state = next;
    });
  }
  async commit(envelope: ActionEnvelope, caller: CallerContext, mutate: (draft: ProjectDocument) => ActionMutation): Promise<CommitResult> {
    return this.locked(async () => {
      if (envelope.projectId !== this.state.snapshot.document.id) throw new DomainError('NOT_FOUND', '项目不存在');
      const requestKey = JSON.stringify([caller.actorId, envelope.requestId]);
      const signature = canonical(envelope);
      const cached = this.state.requests[requestKey];
      if (cached) {
        if (cached.signature !== signature) throw new DomainError('REQUEST_ID_REUSED', '相同请求 ID 不能用于不同动作');
        return { receipt: structuredClone(cached.receipt), replayed: true };
      }
      if (this.state.snapshot.revision !== envelope.expectedRevision) throw new DomainError('REVISION_CONFLICT', '项目已更新，请重新读取后重试');
      const next = structuredClone(this.state);
      const before = next.snapshot.document;
      const draft = structuredClone(before);
      const mutation = mutate(draft);
      assertProjectInvariants(draft);
      if (draft.id !== envelope.projectId || !z.json().safeParse(mutation.outcome).success) throw new DomainError('INVALID_INPUT', '动作结果无效');
      const command = mutation.outcome.generationCommand;
      if (command !== undefined) {
        const entry = outboxSchema.parse(command) as OutboxEntry;
        if (entry.operation === 'start' && next.outbox.some(current => !current.done && current.operation === 'start' && current.itemId === entry.itemId)) {
          throw new DomainError('NOT_APPLICABLE', '该片段的生成任务尚未结束');
        }
        if (entry.operation !== 'cancel' && next.outbox.some(current => !current.done && current.jobId === entry.jobId)) throw new DomainError('NOT_APPLICABLE', '该任务已排队');
        next.outbox.push(entry);
      }
      const revision = next.snapshot.revision + 1;
      if (!Number.isSafeInteger(revision)) throw new DomainError('INTERNAL', '项目版本超出范围');
      const outcome = structuredClone(mutation.outcome);
      delete outcome.generationCommand;
      const receipt: ActionReceipt = { ok: true, requestId: envelope.requestId, projectId: envelope.projectId, revision, undoable: mutation.undoable, outcome };
      next.snapshot = { revision, document: structuredClone(draft) };
      if (mutation.undoable) next.history.push({ requestId: envelope.requestId, before: structuredClone(before), after: structuredClone(draft) });
      next.requests[requestKey] = { signature, receipt };
      await atomicFile(this.path, next);
      this.state = next;
      return { receipt: structuredClone(receipt), replayed: false };
    });
  }
}

class WorkbenchHandler<T> extends BaseActionHandler<T> {
  constructor(
    readonly type: string,
    readonly payloadSchema: z.ZodType<T>,
    private readonly operation: (document: ProjectDocument, input: T, caller: CallerContext) => JsonObject,
    readonly permission: 'project.edit' | 'generation.submit' | 'generation.apply' = 'project.edit',
    override readonly history: 'record' | 'skip' = 'record',
  ) { super(); }
  protected mutate(document: ProjectDocument, payload: T, caller: CallerContext): JsonObject {
    try { return this.operation(document, payload, caller); }
    catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof z.ZodError) throw new DomainError('INVALID_INPUT', `字段格式不正确：${error.issues.map(issue => issue.path.join('.')).filter(Boolean).slice(0, 3).join('、')}`);
      if (error instanceof ProviderError) throw new DomainError('INVALID_INPUT', error.message);
      throw error;
    }
  }
}
function itemOf(document: ProjectDocument, id: string): TimelineItemData {
  const item = Object.hasOwn(document.items, id) ? document.items[id] : undefined;
  if (!item) throw new DomainError('NOT_FOUND', '片段不存在');
  return item;
}
function timelineOf(document: ProjectDocument, id: string) {
  const timeline = Object.hasOwn(document.timelines, id) ? document.timelines[id] : undefined;
  if (!timeline) throw new DomainError('NOT_FOUND', '时间线不存在');
  const descriptor = modelRegistry.resolve(timeline.modelId);
  if (timeline.pluginId !== descriptor.pluginId || timeline.pluginVersion !== 1) throw new DomainError('NOT_APPLICABLE', '该时间线需要显式插件版本迁移后才能编辑');
  return timeline;
}
function assetOf(document: ProjectDocument, id: string): AssetData {
  const asset = Object.hasOwn(document.assets, id) ? document.assets[id] : undefined;
  if (!asset) throw new DomainError('NOT_FOUND', '资产不存在');
  return asset;
}
function invalidate(item: TimelineItemData): void { item.generationToken = randomUUID(); delete item.outputAssetId; }
function placement(document: ProjectDocument, timelineId: string, startTick: number, durationTicks: number, excludeId?: string): void {
  if (!Number.isSafeInteger(startTick + durationTicks)) throw new DomainError('INVALID_INPUT', '时间范围超出支持范围');
  const timeline = timelineOf(document, timelineId);
  const conflict = timeline.itemIds.some(id => {
    const item = document.items[id]!;
    return id !== excludeId && startTick < item.startTick + item.durationTicks && item.startTick < startTick + durationTicks;
  });
  if (conflict) throw new DomainError('NOT_APPLICABLE', '当前位置与已有片段重叠');
}
function captureRequest(document: ProjectDocument, item: TimelineItemData): GenerationRequest {
  const timeline = timelineOf(document, item.timelineId);
  const descriptor = modelRegistry.resolve(timeline.modelId);
  const request: GenerationRequest = {
    projectId: document.id, targetItemId: item.id, generationToken: item.generationToken,
    inputFingerprint: 'pending', providerId: descriptor.providerId, providerVersion: descriptor.providerVersion,
    modelId: descriptor.modelId, params: structuredClone(item.params), settings: structuredClone(timeline.settings),
    references: item.referenceAssetIds.map(id => {
      const asset = structuredClone(assetOf(document, id));
      return descriptor.modelId === 'alibaba/wan-3.0' && item.params.referenceMode === 'firstFrame' ? { ...asset, role: 'first-frame' as const } : asset;
    }),
  };
  const prepared = modelRegistry.prepareRequest(request);
  prepared.inputFingerprint = generationInputFingerprint(prepared);
  return prepared;
}

export function createInitialWorkbenchProject(): ProjectSnapshot {
  const document: ProjectDocument = { schemaVersion: 1, id: WORKBENCH_PROJECT_ID, title: '未命名作品', timelines: {}, items: {}, assets: {} };
  return { revision: 0, document };
}

export type WorkbenchEvent = ProjectChanged | { type: 'generation.changed'; job: GenerationJob } | { type: 'generation.progress'; progress: GenerationProgress };
export interface WorkbenchOptions {
  directory?: string;
  runner?: GenerationRunner;
  providers?: { elevenlabs: boolean; openrouter: boolean };
  initial?: ProjectSnapshot;
}

export class Workbench {
  readonly projectId = WORKBENCH_PROJECT_ID;
  readonly artifacts: FileArtifactStore;
  readonly registry = new ActionRegistry();
  readonly executor: ActionExecutor;
  readonly providers: { elevenlabs: boolean; openrouter: boolean };
  private readonly listeners = new Set<(event: WorkbenchEvent) => void>();
  private readonly jobsCache = new Map<string, GenerationJob>();
  private readonly ephemeralProgress = new Map<string, { attempt: number; fraction: number }>();
  private readonly active = new Map<string, AbortController>();
  private readonly shutdownReason = new Error('Pixel host shutdown');
  private readonly consuming = new Set<string>();
  private readonly executions = new Set<Promise<void>>();
  private readonly drains = new Set<Promise<void>>();
  private closing = false;
  private readonly imports = new Map<string, Promise<ActionResult>>();
  private readonly caller: CallerContext = { actorId: 'local-gui', source: 'gui', projectIds: new Set([WORKBENCH_PROJECT_ID]), permissions: new Set(['project.edit', 'generation.submit']) };
  private readonly internal: CallerContext = { actorId: 'generation-host', source: 'internal', projectIds: new Set([WORKBENCH_PROJECT_ID]), permissions: new Set(['generation.apply']) };

  constructor(readonly repository: FileWorkbenchRepository, readonly runner: GenerationRunner | undefined, directory: string, providers: { elevenlabs: boolean; openrouter: boolean }) {
    this.providers = providers;
    this.artifacts = runner?.artifacts ?? new FileArtifactStore(join(directory, 'artifacts'));
    this.executor = new ActionExecutor(repository, this.registry, event => this.publish(event));
    this.registerHandlers();
  }
  subscribe(listener: (event: WorkbenchEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private publish(event: WorkbenchEvent): void { for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { /* 一个订阅者不影响其他订阅者。 */ } } }
  snapshot(): Promise<ProjectSnapshot> { return this.repository.read(this.projectId); }
  models(input: unknown = {}) {
    const parsed = modelQuerySchema.safeParse(input);
    if (!parsed.success) throw new DomainError('INVALID_INPUT', '模型查询条件无效');
    const page = modelRegistry.query(parsed.data);
    return { ...page, items: page.items.map(model => ({ ...model, settingsDefaults: modelRegistry.resolve(model.modelId).settingsSchema.parse({}), paramsDefaults: modelRegistry.resolve(model.modelId).paramsSchema.parse({}) })) };
  }
  async jobs(): Promise<{ items: GenerationJob[] }> {
    if (this.runner) {
      for (const job of await this.runner.jobs.list(jobStates)) if (job.request.projectId === this.projectId) this.jobsCache.set(job.id, job);
    }
    return { items: [...this.jobsCache.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 100).map(job => {
      const copy = structuredClone(job);
      const progress = this.ephemeralProgress.get(job.id);
      if (progress && progress.attempt === job.attempt && ['queued', 'running'].includes(job.state)) copy.progress = Math.max(copy.progress, progress.fraction);
      else this.ephemeralProgress.delete(job.id);
      return copy;
    }) };
  }
  async execute(envelope: unknown): Promise<ActionResult> {
    await this.jobs();
    const result = await this.executor.execute(envelope, this.caller);
    if (result.ok) this.scheduleDrain();
    return result;
  }
  async initialize(): Promise<void> { await this.jobs(); await this.drain(); }
  close(): void { this.closing = true; for (const controller of this.active.values()) if (!controller.signal.aborted) controller.abort(this.shutdownReason); this.listeners.clear(); }
  async shutdown(): Promise<void> { this.close(); await Promise.allSettled([...this.drains, ...this.executions]); }
  private scheduleDrain(): void {
    const drain = this.drain().catch(() => {}).finally(() => this.drains.delete(drain));
    this.drains.add(drain);
  }

  private registerHandlers(): void {
    const add = <T>(type: string, schema: z.ZodType<T>, operation: (document: ProjectDocument, input: T, caller: CallerContext) => JsonObject, permission: 'project.edit' | 'generation.submit' | 'generation.apply' = 'project.edit', history: 'record' | 'skip' = 'record') => {
      this.registry.register(new WorkbenchHandler(type, schema, operation, permission, history));
    };
    add('project.title', z.strictObject({ title: z.string().trim().min(1).max(120) }), (document, { title }) => { document.title = title; return { title }; });
    add('timeline.create', z.strictObject({ modelId: idSchema }), (document, { modelId }) => {
      const plugin = modelRegistry.createPlugin(modelId);
      const timeline = plugin.createTimeline({ id: randomUUID(), modelId, ticksPerSecond: 1000, settings: {} });
      document.timelines[timeline.id] = timeline;
      return { timelineId: timeline.id };
    });
    add('timeline.settings', z.strictObject({ timelineId: idSchema, settings: jsonSchema }), (document, { timelineId, settings }) => {
      const timeline = timelineOf(document, timelineId);
      const validated = modelRegistry.createPlugin(timeline.modelId).validateSettings(settings);
      if (canonical(timeline.settings) !== canonical(validated)) { timeline.settings = validated; timeline.itemIds.forEach(id => invalidate(document.items[id]!)); }
      return { timelineId };
    });
    add('timeline.delete', z.strictObject({ timelineId: idSchema }), (document, { timelineId }) => {
      const timeline = timelineOf(document, timelineId);
      timeline.itemIds.forEach(id => { delete document.items[id]; });
      delete document.timelines[timelineId];
      return { timelineId };
    });
    const createItem = (document: ProjectDocument, input: { timelineId: string; startTick: number; durationTicks?: number | undefined; assetId?: string | undefined }): JsonObject => {
      const timeline = timelineOf(document, input.timelineId);
      const descriptor = modelRegistry.resolve(timeline.modelId);
      const asset = input.assetId ? assetOf(document, input.assetId) : undefined;
      if (asset && asset.kind !== descriptor.outputKind) throw new DomainError('NOT_APPLICABLE', '该时间线不能放置这种媒体；引用请拖入片段引用区域');
      const assetDuration = asset?.metadata.durationMs;
      const defaultDuration = typeof assetDuration === 'number' && assetDuration > 0 ? Math.round(assetDuration * timeline.ticksPerSecond / 1000) : descriptor.modelId === 'music_v2_5' ? 30000 : 5000;
      const durationTicks = input.durationTicks ?? defaultDuration;
      placement(document, timeline.id, input.startTick, durationTicks);
      const item = modelRegistry.createPlugin(timeline.modelId).createItem({ timeline, id: randomUUID(), startTick: input.startTick, durationTicks, params: {}, generationToken: randomUUID() });
      if (asset) item.outputAssetId = asset.id;
      document.items[item.id] = item;
      timeline.itemIds.push(item.id);
      return { itemId: item.id };
    };
    // An empty generation request and placement of existing media have different
    // preconditions and results, while sharing plugin validation and placement.
    add('item.createDraft', z.strictObject({ timelineId: idSchema, startTick: tickSchema }), createItem);
    add('item.create', z.strictObject({ timelineId: idSchema, startTick: tickSchema, durationTicks: durationSchema.optional(), assetId: idSchema }), createItem);
    this.registry.register(new MoveItemHandler((document, itemId, startTick) => {
      const current = document.items[itemId]!;
      placement(structuredClone(document) as ProjectDocument, current.timelineId, startTick, current.durationTicks, itemId);
    }));
    add('item.params', z.strictObject({ itemId: idSchema, params: jsonSchema }), (document, { itemId, params }) => {
      const item = itemOf(document, itemId);
      const timeline = timelineOf(document, item.timelineId);
      const validated = modelRegistry.createPlugin(timeline.modelId).validateItemParams(params);
      if (canonical(item.params) !== canonical(validated)) { item.params = validated; invalidate(item); }
      return { itemId };
    });
    add('item.resize', z.strictObject({ itemId: idSchema, startTick: tickSchema, durationTicks: durationSchema }), (document, { itemId, startTick, durationTicks }) => {
      const item = itemOf(document, itemId);
      placement(document, item.timelineId, startTick, durationTicks, itemId);
      item.startTick = startTick; item.durationTicks = durationTicks;
      return { itemId };
    });
    add('item.delete', z.strictObject({ itemId: idSchema }), (document, { itemId }) => {
      const item = itemOf(document, itemId);
      const timeline = timelineOf(document, item.timelineId);
      timeline.itemIds = timeline.itemIds.filter(id => id !== itemId);
      delete document.items[itemId];
      return { itemId };
    });
    add('item.duplicate', z.strictObject({ itemId: idSchema }), (document, { itemId }) => {
      const original = itemOf(document, itemId);
      const timeline = timelineOf(document, original.timelineId);
      const item = structuredClone(original);
      item.id = randomUUID(); item.generationToken = randomUUID(); item.startTick = original.startTick + original.durationTicks;
      for (const other of timeline.itemIds.map(id => document.items[id]!).sort((left, right) => left.startTick - right.startTick)) {
        if (item.startTick < other.startTick + other.durationTicks && other.startTick < item.startTick + item.durationTicks) item.startTick = other.startTick + other.durationTicks;
      }
      placement(document, item.timelineId, item.startTick, item.durationTicks);
      document.items[item.id] = item; timeline.itemIds.push(item.id);
      return { itemId: item.id };
    });
    add('item.reference.add', z.strictObject({ itemId: idSchema, assetId: idSchema }), (document, { itemId, assetId }) => {
      const item = itemOf(document, itemId);
      const asset = assetOf(document, assetId);
      const descriptor = modelRegistry.resolve(timelineOf(document, item.timelineId).modelId);
      if (!descriptor.referenceKinds.includes(asset.kind)) throw new DomainError('NOT_APPLICABLE', '该模型不支持这种引用媒体');
      if (item.referenceAssetIds.includes(assetId)) throw new DomainError('NOT_APPLICABLE', '引用已存在');
      const maximum = item.params.referenceMode === 'firstFrame' ? 1 : descriptor.maxReferences;
      if (item.referenceAssetIds.length >= maximum) throw new DomainError('NOT_APPLICABLE', '该模型的引用数量已达到上限');
      item.referenceAssetIds.push(assetId); invalidate(item);
      return { itemId, assetId };
    });
    add('item.reference.remove', z.strictObject({ itemId: idSchema, assetId: idSchema }), (document, { itemId, assetId }) => {
      const item = itemOf(document, itemId);
      if (!item.referenceAssetIds.includes(assetId)) throw new DomainError('NOT_FOUND', '引用不存在');
      item.referenceAssetIds = item.referenceAssetIds.filter(id => id !== assetId); invalidate(item);
      return { itemId, assetId };
    });
    add('asset.import', z.strictObject({ asset: assetSchema }), (document, { asset }, caller) => {
      if (caller.source !== 'internal') throw new DomainError('FORBIDDEN', '资产只能由宿主验证并导入');
      document.assets[asset.id] = asset;
      return { assetId: asset.id, importFingerprint: asset.metadata.importFingerprint ?? null };
    });
    add('asset.remove', z.strictObject({ assetId: idSchema }), (document, { assetId }) => {
      assetOf(document, assetId);
      if (Object.values(document.items).some(item => item.outputAssetId === assetId || item.referenceAssetIds.includes(assetId))) throw new DomainError('NOT_APPLICABLE', '资产仍被片段使用，请先删除片段或解除引用');
      delete document.assets[assetId]; return { assetId };
    });
    add('asset.saveFromItem', z.strictObject({ itemId: idSchema }), (document, { itemId }) => {
      const item = itemOf(document, itemId);
      if (!item.outputAssetId) throw new DomainError('NOT_APPLICABLE', '该片段还没有可保存的媒体输出');
      const asset = assetOf(document, item.outputAssetId);
      asset.metadata.librarySaved = true;
      return { assetId: asset.id };
    });
    add('generation.submit', z.strictObject({ itemId: idSchema }), (document, { itemId }) => {
      const item = itemOf(document, itemId);
      const descriptor = modelRegistry.resolve(timelineOf(document, item.timelineId).modelId);
      if (!this.runner || !this.providers[descriptor.providerId]) throw new DomainError('NOT_APPLICABLE', '该供应商尚未配置后端凭证');
      if ([...this.jobsCache.values()].some(job => job.request.targetItemId === itemId && ['queued', 'running', 'cancelRequested'].includes(job.state))) throw new DomainError('NOT_APPLICABLE', '该片段正在生成');
      item.generationToken = randomUUID();
      const request = captureRequest(document, item);
      const jobId = randomUUID();
      const command: OutboxEntry = { id: randomUUID(), operation: 'start', jobId, itemId, request, done: false };
      return { jobId, itemId, generationCommand: command as unknown as JsonObject };
    }, 'generation.submit', 'skip');
    add('generation.cancel', z.strictObject({ jobId: z.uuid() }), (document, { jobId }) => {
      const job = this.jobsCache.get(jobId);
      if (!job || !['queued', 'running', 'cancelRequested', 'interrupted'].includes(job.state)) throw new DomainError('NOT_APPLICABLE', '该任务无法取消');
      const item = document.items[job.request.targetItemId];
      if (item?.generationToken === job.request.generationToken) item.generationToken = randomUUID();
      const command: OutboxEntry = { id: randomUUID(), operation: 'cancel', jobId, itemId: job.request.targetItemId, done: false };
      return { jobId, generationCommand: command as unknown as JsonObject };
    }, 'generation.submit', 'skip');
    add('generation.resume', z.strictObject({ jobId: z.uuid() }), (document, { jobId }) => {
      const job = this.jobsCache.get(jobId);
      if (!job || this.active.has(jobId) || job.state !== 'interrupted' || !job.providerTaskId || !this.runner?.providers.get(job.request.providerId).manifest.supportsResume) throw new DomainError('NOT_APPLICABLE', '该任务没有可恢复的远端任务');
      if (itemOf(document, job.request.targetItemId).generationToken !== job.request.generationToken) throw new DomainError('NOT_APPLICABLE', '片段输入已变更，原任务不能继续挂载');
      const command: OutboxEntry = { id: randomUUID(), operation: 'resume', jobId, itemId: job.request.targetItemId, done: false };
      return { jobId, generationCommand: command as unknown as JsonObject };
    }, 'generation.submit', 'skip');
    add('generation.apply', z.strictObject({ jobId: z.uuid(), itemId: idSchema, generationToken: idSchema, inputFingerprint: idSchema, asset: assetSchema }), (document, input, caller) => {
      if (caller.source !== 'internal') throw new DomainError('FORBIDDEN', '生成结果只由宿主挂载');
      const item = itemOf(document, input.itemId);
      if (item.generationToken !== input.generationToken || captureRequest(document, item).inputFingerprint !== input.inputFingerprint) throw new DomainError('STALE_RESULT', '片段已变更，保留产物但不覆盖当前输入');
      if (input.asset.kind !== modelRegistry.resolve(timelineOf(document, item.timelineId).modelId).outputKind) throw new DomainError('INVALID_INPUT', '生成产物类型与时间线模型不一致');
      document.assets[input.asset.id] = input.asset;
      item.outputAssetId = input.asset.id;
      return { itemId: item.id, assetId: input.asset.id, jobId: input.jobId };
    }, 'generation.apply');
  }

  async importMedia(input: { bytes: Uint8Array; mimeType: string; name: string; requestId: string; expectedRevision: number }): Promise<ActionResult> {
    const fingerprint = createHash('sha256').update(canonical({ mimeType: input.mimeType, name: input.name, expectedRevision: input.expectedRevision })).update(input.bytes).digest('hex');
    const previous = this.imports.get(input.requestId);
    if (previous) { await previous; return this.importMedia(input); }
    const operation = (async (): Promise<ActionResult> => {
      const replay = await this.repository.receipt(this.caller.actorId, input.requestId);
      if (replay) return replay.outcome.importFingerprint === fingerprint ? replay : { ok: false, requestId: input.requestId, error: { code: 'REQUEST_ID_REUSED', message: '相同请求 ID 不能导入不同内容' } };
      const snapshot = await this.snapshot();
      if (snapshot.revision !== input.expectedRevision) return { ok: false, requestId: input.requestId, error: { code: 'REVISION_CONFLICT', message: '项目已更新，请重新读取后重试' } };
      const kind = detectMedia(input.bytes, input.mimeType);
      const artifact = await this.artifacts.write({ attemptToken: { jobId: `import_${randomUUID()}`, attempt: 1 }, bytes: input.bytes, kind, metadata: { mimeType: input.mimeType, name: input.name.slice(0, 200), imported: true, librarySaved: true, importFingerprint: fingerprint } });
      const caller: CallerContext = { actorId: this.caller.actorId, source: 'internal', projectIds: this.caller.projectIds, permissions: new Set(['project.edit']) };
      return this.executor.execute({ requestId: input.requestId, expectedRevision: input.expectedRevision, projectId: this.projectId, type: 'asset.import', payload: { asset: artifact.asset } }, caller);
    })();
    this.imports.set(input.requestId, operation);
    try { return await operation; }
    finally { if (this.imports.get(input.requestId) === operation) this.imports.delete(input.requestId); }
  }
  async mediaAsset(id: string): Promise<AssetData> { return assetOf((await this.snapshot()).document, id); }

  private async applyJob(job: GenerationJob): Promise<void> {
    if (job.state !== 'succeeded' || !job.artifactIds[0] || !this.runner) return;
    const artifact = await this.artifacts.get(job.artifactIds[0]);
    if (!artifact || artifact.jobId !== job.id || artifact.asset.metadata.attempt !== job.attempt) throw new DomainError('INVALID_INPUT', '生成产物归属不匹配');
    for (let retry = 0; retry < 3; retry++) {
      const snapshot = await this.snapshot();
      const target = snapshot.document.items[job.request.targetItemId];
      if (!target || target.generationToken !== job.request.generationToken || target.outputAssetId === artifact.asset.id) return;
      const result = await this.executor.execute({ requestId: `apply_${job.id}_${retry}`, projectId: this.projectId, expectedRevision: snapshot.revision, type: 'generation.apply', payload: { jobId: job.id, itemId: job.request.targetItemId, generationToken: job.request.generationToken, inputFingerprint: job.request.inputFingerprint, asset: artifact.asset } }, this.internal);
      if (result.ok || result.error.code !== 'REVISION_CONFLICT') return;
    }
  }
  private async drain(): Promise<void> {
    if (!this.runner || this.closing) return;
    const entries = await this.repository.outbox();
    for (const entry of entries) {
      if (this.closing) break;
      if (this.consuming.has(entry.id)) continue;
      this.consuming.add(entry.id);
      if (entry.operation === 'cancel') {
        try {
          this.active.get(entry.jobId)?.abort();
          const job = await this.runner.jobs.get(entry.jobId);
          if (job && !this.active.has(entry.jobId) && !['succeeded', 'failed', 'canceled'].includes(job.state)) {
            const canceled = await this.runner.jobs.update({ attemptToken: { jobId: job.id, attempt: job.attempt }, states: [job.state] }, current => transitionJob(current.state === 'cancelRequested' ? current : transitionJob(current, 'cancelRequested', new Date().toISOString()), 'canceled', new Date().toISOString()));
            if (canceled) { this.jobsCache.set(canceled.id, canceled); this.publish({ type: 'generation.changed', job: canceled }); }
          }
          await this.repository.completeOutbox(entry.id);
        } finally { this.consuming.delete(entry.id); }
      } else {
        const execution = this.consumeGeneration(entry).catch(() => {}).finally(() => { this.consuming.delete(entry.id); this.executions.delete(execution); });
        this.executions.add(execution);
      }
    }
  }
  private async consumeGeneration(entry: OutboxEntry): Promise<void> {
    const runner = this.runner!;
    let job = await runner.jobs.get(entry.jobId);
    if (!job) {
      if (entry.operation !== 'start' || !entry.request) throw new DomainError('INVALID_INPUT', '恢复任务记录不存在');
      job = await runner.enqueue(entry.request, entry.jobId);
    }
    this.jobsCache.set(job.id, job);
    this.publish({ type: 'generation.changed', job });
    if (job.state === 'cancelRequested' && !this.active.has(job.id)) {
      job = (await runner.jobs.update({ attemptToken: { jobId: job.id, attempt: job.attempt }, states: ['cancelRequested'] }, current => transitionJob(current, 'canceled', new Date().toISOString()))) ?? job;
      this.jobsCache.set(job.id, job); this.publish({ type: 'generation.changed', job });
    }
    if (job.state === 'running' && !this.active.has(job.id)) {
      job = (await runner.jobs.update({ attemptToken: { jobId: job.id, attempt: job.attempt }, states: ['running'] }, current => transitionJob(current, 'interrupted', new Date().toISOString(), { error: { code: 'PROCESS_INTERRUPTED', message: job!.providerTaskId ? '宿主重启，右键恢复原远端任务' : '执行中断且没有远端任务 ID；未自动重新提交', retryable: false } }))) ?? job;
      this.jobsCache.set(job.id, job); this.publish({ type: 'generation.changed', job });
    }
    if (this.active.has(job.id) || this.closing) return;
    if (job.state === 'queued' || (entry.operation === 'resume' && job.state === 'interrupted')) {
      const controller = new AbortController();
      this.active.set(job.id, controller);
      const options = {
        signal: controller.signal, interruptionReason: this.shutdownReason,
        onJob: (current: import('./contracts.js').DeepReadonly<GenerationJob>) => {
          const copy = structuredClone(current) as GenerationJob;
          const previous = this.ephemeralProgress.get(copy.id);
          if (previous && previous.attempt !== copy.attempt) this.ephemeralProgress.delete(copy.id);
          this.jobsCache.set(copy.id, copy); this.publish({ type: 'generation.changed', job: copy });
        },
        onProgress: (progress: GenerationProgress) => {
          const current = this.jobsCache.get(progress.attemptToken.jobId);
          if (!current || current.attempt !== progress.attemptToken.attempt || !['queued', 'running'].includes(current.state)) return;
          const previous = this.ephemeralProgress.get(current.id);
          this.ephemeralProgress.set(current.id, { attempt: current.attempt, fraction: Math.max(previous?.attempt === current.attempt ? previous.fraction : 0, progress.fraction) });
          this.publish({ type: 'generation.progress', progress });
        },
      };
      try {
        job = entry.operation === 'resume' ? await runner.resume(job.id, options) : await runner.runQueued(job.id, options);
        this.ephemeralProgress.delete(job.id);
        this.jobsCache.set(job.id, job);
        this.publish({ type: 'generation.changed', job });
      } catch (error) {
        const saved = await runner.jobs.get(job.id);
        if (saved && ['succeeded', 'failed', 'canceled', 'interrupted'].includes(saved.state)) job = saved;
        else throw error;
      } finally { this.active.delete(job.id); }
    }
    await this.applyJob(job);
    await this.repository.completeOutbox(entry.id);
  }
}

export function detectMedia(bytes: Uint8Array, mimeType: string): AssetData['kind'] {
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString('ascii');
  const matches = mimeType === 'image/png' ? bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mimeType === 'image/webp' ? ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
    : mimeType === 'audio/wav' ? ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE'
    : mimeType === 'audio/mpeg' ? ascii(0, 3) === 'ID3' || (bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224)
    : mimeType === 'video/mp4' ? ascii(4, 8) === 'ftyp' : false;
  if (!matches || !bytes.length) throw new DomainError('INVALID_INPUT', '文件内容与支持的媒体格式不一致（PNG/JPEG/WebP/MP3/WAV/MP4）');
  return mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('audio/') ? 'audio' : 'video';
}

export async function createWorkbench(options: WorkbenchOptions = {}): Promise<Workbench> {
  const directory = resolve(options.directory ?? '.pixel');
  const repository = await FileWorkbenchRepository.open(directory, options.initial ?? createInitialWorkbenchProject());
  const workbench = new Workbench(repository, options.runner, directory, options.providers ?? { elevenlabs: Boolean(options.runner), openrouter: Boolean(options.runner) });
  await workbench.initialize();
  return workbench;
}
