import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  ActionExecutor, ActionRegistry, BaseActionHandler, DomainError, MoveItemHandler,
  assertProjectInvariants,
  type ActionMutation, type CommitResult, type ProjectRepository,
} from './backend.js';
import type {
  ActionEnvelope, ActionReceipt, ActionResult, AssetData, CallerContext, GenerationJob,
  GenerationRequest, JsonObject, ProjectChanged, ProjectDocument, ProjectSnapshot, TimelineItemData,
} from './contracts.js';
import { assetGroupTitleSchema, orderedTimelineIds } from './contracts.js';
import { modelRegistry, modelQuerySchema } from './models.js';
import { referenceLimit, timelineRegistry, timelineTypeQuerySchema } from './timeline-catalog.js';
import { referenceExceedsByteLimit } from './reference-policy.js';
import { probeMediaDuration } from './media-metadata.js';
import { ProviderError, transitionJob, type GenerationProgress } from './generation.js';
import type { GenerationRunner } from './runtime.js';
import { generationInputFingerprint } from './generation-fingerprint.js';
import { FileArtifactStore } from './storage.js';
import type { VoiceService } from './voices.js';
import type { VoiceCloneInput, VoiceCloneResult, VoiceQuery, VoicePage } from './voice-contracts.js';
import { readWorkbenchProjectFile, validateWorkbenchProjectFile, workbenchOutboxSchema, type WorkbenchOutboxEntry as OutboxEntry, type WorkbenchProjectFile as WorkbenchFile } from './project-files.js';

export const WORKBENCH_PROJECT_ID = 'pixel-project';
const idSchema = z.string().min(1).max(200);
const tickSchema = z.number().int().nonnegative().safe();
const durationSchema = z.number().int().positive().safe();
const jsonSchema = z.record(z.string(), z.json());
const assetSchema = z.strictObject({ id: z.uuid(), kind: z.enum(['image', 'audio', 'video']), fileRef: z.string().max(500), metadata: jsonSchema });
const jobStates = ['queued', 'running', 'cancelRequested', 'succeeded', 'failed', 'canceled', 'interrupted'] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
async function atomicFile(path: string, value: unknown, createOnly = false): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    // Publishing a new project never overwrites a file that appeared during preparation.
    if (createOnly) await link(temporary, path);
    else await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** 单进程宿主：项目、幂等记录、历史和生成 outbox 在同一个文件提交。 */
export class FileWorkbenchRepository implements ProjectRepository {
  private serial: Promise<unknown> = Promise.resolve();
  private constructor(private readonly path: string, private state: WorkbenchFile) {}
  get projectId(): string { return this.state.snapshot.document.id; }

  static async open(directory: string, initial: ProjectSnapshot): Promise<FileWorkbenchRepository> {
    const root = resolve(directory);
    await mkdir(root, { recursive: true });
    const path = join(root, 'project.json');
    let state: WorkbenchFile;
    try {
      state = await readWorkbenchProjectFile(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof DomainError) throw error;
        throw new DomainError('INTERNAL', '项目存储无法读取，请保留文件后检查版本');
      }
      state = validateWorkbenchProjectFile({ version: 1, snapshot: structuredClone(initial), requests: {}, history: [], outbox: [] });
      try { await atomicFile(path, state, true); }
      catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        state = await readWorkbenchProjectFile(root);
      }
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
        const entry = workbenchOutboxSchema.parse(command) as OutboxEntry;
        if (entry.request && entry.request.projectId !== draft.id) throw new DomainError('INVALID_INPUT', '生成记录不属于当前项目');
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
  timelineRegistry.forTimeline(timeline);
  return timeline;
}
function timelineAction(document: ProjectDocument, timelineId: string, action: string) {
  const timeline = timelineOf(document, timelineId);
  const plugin = timelineRegistry.forTimeline(timeline);
  if (!plugin.manifest.supportedActions.includes(action)) throw new DomainError('NOT_APPLICABLE', '该时间线不支持此操作');
  return timeline;
}
function assetOf(document: ProjectDocument, id: string): AssetData {
  const asset = Object.hasOwn(document.assets, id) ? document.assets[id] : undefined;
  if (!asset) throw new DomainError('NOT_FOUND', '资产不存在');
  return asset;
}
function invalidate(document: ProjectDocument, item: TimelineItemData): void {
  item.generationToken = randomUUID();
  const output = item.outputAssetId === undefined ? undefined : document.assets[item.outputAssetId];
  // New records state provenance explicitly. Legacy imported media is safe to
  // retain; only an identifiable generation output is disconnected.
  if (item.outputOrigin === 'generated' || (item.outputOrigin === undefined && output?.metadata.imported !== true && typeof output?.metadata.providerId === 'string')) {
    delete item.outputAssetId;
    delete item.outputOrigin;
  }
}
function placement(document: ProjectDocument, timelineId: string, startTick: number, durationTicks: number, excludeId?: string): void {
  if (!Number.isSafeInteger(startTick + durationTicks)) throw new DomainError('INVALID_INPUT', '时间范围超出支持范围');
  const timeline = timelineOf(document, timelineId);
  if (timelineRegistry.forTimeline(timeline).manifest.overlapPolicy === 'allow') return;
  const conflict = timeline.itemIds.some(id => {
    const item = document.items[id]!;
    return id !== excludeId && startTick < item.startTick + item.durationTicks && item.startTick < startTick + durationTicks;
  });
  if (conflict) throw new DomainError('NOT_APPLICABLE', '当前位置与已有片段重叠');
}
/** A single pure capture path is used by submission and late-result checks. */
export function captureGenerationRequest(document: ProjectDocument, item: TimelineItemData): GenerationRequest {
  const timeline = timelineOf(document, item.timelineId);
  if (!timelineRegistry.forTimeline(timeline).manifest.capabilities.generation || timeline.modelId === undefined) throw new DomainError('NOT_APPLICABLE', '本地时间线不会启动模型生成');
  const descriptor = modelRegistry.resolve(timeline.modelId);
  const request: GenerationRequest = {
    projectId: document.id, targetItemId: item.id, generationToken: item.generationToken,
    inputFingerprint: 'pending', providerId: descriptor.providerId, providerVersion: descriptor.providerVersion,
    modelId: descriptor.modelId, params: structuredClone(item.params), settings: structuredClone(item.generationSettings ?? timeline.settings),
    references: item.referenceAssetIds.map(id => {
      const asset = structuredClone(assetOf(document, id));
      return descriptor.modelId === 'alibaba/wan-3.0' && item.params.referenceMode === 'firstFrame' ? { ...asset, role: 'first-frame' as const } : asset;
    }),
  };
  if (descriptor.modelId === 'eleven_v4') {
    const params = modelRegistry.createPlugin(timeline.modelId).validateItemParams(item.params);
    const context: NonNullable<GenerationRequest['context']> = {};
    if (params.contextMode === 'manual') {
      if (typeof params.previousText === 'string' && params.previousText.length > 0) context.previousText = params.previousText;
      if (typeof params.nextText === 'string' && params.nextText.length > 0) context.nextText = params.nextText;
    } else if (params.contextMode === 'neighbors' && typeof params.voiceId === 'string' && params.voiceId.trim().length > 0) {
      const speechItems = timeline.itemIds.map(id => itemOf(document, id))
        .filter(candidate => candidate.kind === descriptor.itemKind && typeof candidate.params.text === 'string' && candidate.params.text.trim().length > 0)
        .sort((left, right) => left.startTick - right.startTick || left.id.localeCompare(right.id));
      const index = speechItems.findIndex(candidate => candidate.id === item.id);
      const maximum = descriptor.contextMaxCharacters!;
      const previous = index > 0 ? speechItems[index - 1] : undefined;
      const next = index >= 0 ? speechItems[index + 1] : undefined;
      if (previous && previous.params.voiceId === params.voiceId) context.previousText = [...(previous.params.text as string)].slice(-maximum).join('');
      if (next && next.params.voiceId === params.voiceId) context.nextText = [...(next.params.text as string)].slice(0, maximum).join('');
    }
    if (Object.keys(context).length > 0) request.context = context;
  }
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
  voices?: VoiceService;
}

export class Workbench {
  readonly projectId: string;
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
  private readonly mediaReads = new Set<AbortController>();
  private readonly caller: CallerContext;
  private readonly internal: CallerContext;
  private voiceClosing: Promise<void> | undefined;
  private readonly voiceExecutions = new Set<Promise<VoiceCloneResult>>();

  constructor(readonly repository: FileWorkbenchRepository, readonly runner: GenerationRunner | undefined, directory: string, providers: { elevenlabs: boolean; openrouter: boolean }, readonly voices?: VoiceService) {
    this.projectId = repository.projectId;
    this.caller = { actorId: 'local-gui', source: 'gui', projectIds: new Set([this.projectId]), permissions: new Set(['project.edit', 'generation.submit']) };
    this.internal = { actorId: 'generation-host', source: 'internal', projectIds: new Set([this.projectId]), permissions: new Set(['generation.apply']) };
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
    if (this.closing) return { ok: false, error: { code: 'NOT_APPLICABLE', message: '项目会话已关闭，请在当前作品中重试' } };
    await this.jobs();
    if (this.closing) return { ok: false, error: { code: 'NOT_APPLICABLE', message: '项目会话已关闭，请在当前作品中重试' } };
    const result = await this.executor.execute(envelope, this.caller);
    if (result.ok) this.scheduleDrain();
    return result;
  }
  async initialize(): Promise<void> { await this.jobs(); await this.drain(); }
  close(): void { this.closing = true; for (const controller of [...this.active.values(), ...this.mediaReads]) if (!controller.signal.aborted) controller.abort(this.shutdownReason); this.voiceClosing ??= this.voices?.shutdown(); this.listeners.clear(); }
  async shutdown(): Promise<void> {
    this.close();
    await Promise.allSettled([...this.drains, ...this.executions, ...this.imports.values(), ...this.voiceExecutions, ...(this.voiceClosing ? [this.voiceClosing] : [])]);
    await this.repository.read(this.projectId);
  }
  timelineTypes(input: unknown = {}) {
    const parsed = timelineTypeQuerySchema.safeParse(input);
    if (!parsed.success) throw new DomainError('INVALID_INPUT', '时间线查询条件无效');
    return timelineRegistry.query(parsed.data);
  }
  async queryVoices(input: VoiceQuery): Promise<VoicePage> {
    if (this.closing) throw new DomainError('NOT_APPLICABLE', '项目会话已关闭');
    if (!this.voices) throw new DomainError('NOT_APPLICABLE', '请先配置 ElevenLabs 后端密钥以读取声音');
    return this.voices.query(input);
  }
  /** 账号资源命令不修改项目；选择结果另经原字段 Action，不能晚到覆盖默认。 */
  async cloneVoice(input: VoiceCloneInput): Promise<VoiceCloneResult> {
    if (input.projectId !== this.projectId) throw new DomainError('FORBIDDEN', '声音克隆不属于当前项目');
    // WAV MIME aliases describe the same sample; normalize before probing and receipt binding.
    if (input.mimeType === 'audio/x-wav' || input.mimeType === 'audio/wave') input = { ...input, mimeType: 'audio/wav' };
    if (this.closing) throw new DomainError('NOT_APPLICABLE', '项目会话已关闭');
    if (!this.voices) throw new DomainError('NOT_APPLICABLE', '请先配置 ElevenLabs 后端密钥以克隆声音');
    const operation = (async () => {
      const snapshot = await this.snapshot();
      const timeline = timelineOf(snapshot.document, input.timelineId);
      const declaration = timelineRegistry.describe(timeline.modelId ?? timeline.pluginId);
      if (!declaration.fields.some(field => field.choicesSource?.kind === 'providerVoice' && field.choicesSource.providerId === 'elevenlabs')) throw new DomainError('NOT_APPLICABLE', '此时间线不支持声音克隆');
      const replay = await this.voices!.replay(input);
      if (replay) return replay;
      if (snapshot.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', '项目已更新，请重新读取后重试');
      if (input.bytes.length > 25 * 1024 * 1024 || !['audio/wav', 'audio/mpeg'].includes(input.mimeType) || detectMedia(input.bytes, input.mimeType) !== 'audio') throw new DomainError('INVALID_INPUT', '请选择不超过 25 MiB 的 MP3 或 WAV 声音文件');
      const controller = new AbortController(); this.mediaReads.add(controller);
      try { await probeMediaDuration(input.bytes, 'audio', input.mimeType, controller.signal); }
      finally { this.mediaReads.delete(controller); }
      if (this.closing) throw new DomainError('NOT_APPLICABLE', '项目会话已关闭');
      const current = await this.snapshot();
      if (current.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', '项目已更新，声音尚未提交，请重试');
      return this.voices!.clone(input);
    })();
    this.voiceExecutions.add(operation);
    try { return await operation; } finally { this.voiceExecutions.delete(operation); }
  }
  private scheduleDrain(): void {
    const drain = this.drain().catch(() => {}).finally(() => this.drains.delete(drain));
    this.drains.add(drain);
  }

  private registerHandlers(): void {
    const add = <T>(type: string, schema: z.ZodType<T>, operation: (document: ProjectDocument, input: T, caller: CallerContext) => JsonObject, permission: 'project.edit' | 'generation.submit' | 'generation.apply' = 'project.edit', history: 'record' | 'skip' = 'record') => {
      this.registry.register(new WorkbenchHandler(type, schema, operation, permission, history));
    };
    add('project.title', z.strictObject({ title: z.string().trim().min(1).max(120) }), (document, { title }) => { document.title = title; return { title }; });
    add('assetGroup.create', z.strictObject({ title: assetGroupTitleSchema }), (document, { title }) => {
      const group = { id: randomUUID(), title, assetIds: [] as string[] };
      (document.assetGroups ??= {})[group.id] = group;
      return { groupId: group.id };
    });
    const groupOf = (document: ProjectDocument, groupId: string) => {
      if (!document.assetGroups || !Object.hasOwn(document.assetGroups, groupId)) throw new DomainError('NOT_FOUND', '素材分组不存在');
      return document.assetGroups[groupId]!;
    };
    add('assetGroup.rename', z.strictObject({ groupId: idSchema, title: assetGroupTitleSchema }), (document, { groupId, title }) => {
      groupOf(document, groupId).title = title; return { groupId };
    });
    add('assetGroup.remove', z.strictObject({ groupId: idSchema }), (document, { groupId }) => {
      groupOf(document, groupId); delete document.assetGroups![groupId]; return { groupId };
    });
    add('assetGroup.moveAsset', z.strictObject({ assetId: idSchema, groupId: idSchema.optional() }), (document, { assetId, groupId }) => {
      assetOf(document, assetId);
      const destination = groupId === undefined ? undefined : groupOf(document, groupId);
      for (const group of Object.values(document.assetGroups ?? {})) group.assetIds = group.assetIds.filter(id => id !== assetId);
      destination?.assetIds.push(assetId); return { assetId, groupId: groupId ?? null };
    });
    add('timeline.create', z.union([z.strictObject({ modelId: idSchema }), z.strictObject({ typeId: idSchema })]), (document, input) => {
      const typeId = 'typeId' in input ? input.typeId : input.modelId;
      const declaration = timelineRegistry.describe(typeId);
      if ('modelId' in input && declaration.mode !== 'generated') throw new DomainError('INVALID_INPUT', '本地时间线通过类型标识创建，不声明生成模型');
      const plugin = timelineRegistry.createPlugin(typeId);
      const timeline = plugin.createTimeline({ id: randomUUID(), ...(declaration.modelId === undefined ? {} : { modelId: declaration.modelId }), ticksPerSecond: 1000, settings: {} });
      document.timelines[timeline.id] = timeline;
      if (document.timelineOrder) document.timelineOrder.push(timeline.id);
      return { timelineId: timeline.id };
    });
    add('timeline.reorder', z.strictObject({ timelineId: idSchema, beforeTimelineId: idSchema.optional() }), (document, { timelineId, beforeTimelineId }) => {
      timelineOf(document, timelineId);
      if (beforeTimelineId !== undefined) timelineOf(document, beforeTimelineId);
      if (beforeTimelineId === timelineId) throw new DomainError('INVALID_INPUT', '时间线不能以自身作为移动目标');
      const order = orderedTimelineIds(document).filter(id => id !== timelineId);
      const index = beforeTimelineId === undefined ? order.length : order.indexOf(beforeTimelineId);
      order.splice(index, 0, timelineId); document.timelineOrder = order;
      return { timelineId, timelineOrder: order };
    });
    add('timeline.settings', z.strictObject({ timelineId: idSchema, settings: jsonSchema }), (document, { timelineId, settings }) => {
      const timeline = timelineAction(document, timelineId, 'timeline.settings');
      const validated = timelineRegistry.forTimeline(timeline).validateSettings(settings);
      if (canonical(timeline.settings) !== canonical(validated)) {
        // Capture legacy items before updating the defaults so their historical
        // generation inputs keep the same effective settings and output.
        for (const id of timeline.itemIds) {
          const item = itemOf(document, id);
          if (item.generationSettings === undefined) item.generationSettings = structuredClone(timeline.settings);
        }
        timeline.settings = validated;
      }
      return { timelineId };
    });
    add('timeline.defaults', z.strictObject({ timelineId: idSchema, itemDefaults: jsonSchema }), (document, { timelineId, itemDefaults }) => {
      const timeline = timelineAction(document, timelineId, 'timeline.defaults');
      timeline.itemDefaults = timelineRegistry.forTimeline(timeline).validateItemDefaults(itemDefaults);
      return { timelineId };
    });
    add('timeline.refreshDefaults', z.strictObject({ timelineId: idSchema }), (document, { timelineId }) => {
      const timeline = timelineAction(document, timelineId, 'timeline.refreshDefaults');
      const plugin = timelineRegistry.forTimeline(timeline);
      const defaults = plugin.resolveItemDefaults(timeline.itemDefaults ?? {});
      const settings = plugin.validateSettings(timeline.settings);
      const changedItemIds: string[] = [];
      // All merges are validated before the transaction can commit. A plan-mode
      // item therefore cannot be silently overwritten by incompatible defaults.
      for (const id of timeline.itemIds) {
        const item = itemOf(document, id);
        const currentParams = plugin.validateItemParams(item.params);
        const params = plugin.validateItemParams({ ...item.params, ...defaults });
        const settingsChanged = canonical(plugin.validateSettings(item.generationSettings ?? timeline.settings)) !== canonical(settings);
        if (canonical(currentParams) !== canonical(params) || settingsChanged) {
          item.params = params;
          item.generationSettings = structuredClone(settings);
          invalidate(document, item);
          changedItemIds.push(id);
        }
      }
      return { timelineId, changedItemIds };
    });
    add('timeline.delete', z.strictObject({ timelineId: idSchema }), (document, { timelineId }) => {
      const timeline = timelineAction(document, timelineId, 'timeline.delete');
      timeline.itemIds.forEach(id => { delete document.items[id]; });
      delete document.timelines[timelineId];
      if (document.timelineOrder) document.timelineOrder = document.timelineOrder.filter(id => id !== timelineId);
      return { timelineId };
    });
    const createItem = (document: ProjectDocument, input: { timelineId: string; startTick: number; durationTicks?: number | undefined; assetId?: string | undefined }): JsonObject => {
      const timeline = timelineOf(document, input.timelineId);
      const plugin = timelineRegistry.forTimeline(timeline);
      const descriptor = timelineRegistry.describe(timeline.modelId ?? timeline.pluginId);
      const asset = input.assetId ? assetOf(document, input.assetId) : undefined;
      if (asset && !plugin.manifest.supportedActions.includes('item.create')) throw new DomainError('NOT_APPLICABLE', '该时间线不支持放置素材');
      if (asset && (!descriptor.capabilities.mediaPlacement || asset.kind !== descriptor.outputKind)) throw new DomainError('NOT_APPLICABLE', '该时间线不能放置这种媒体');
      if (!asset && !plugin.manifest.supportedActions.includes('item.createDraft')) throw new DomainError('NOT_APPLICABLE', '普通媒体时间线需要拖入真实素材');
      const assetDuration = asset?.metadata.durationMs;
      const defaultDuration = typeof assetDuration === 'number' && assetDuration > 0 ? Math.round(assetDuration * timeline.ticksPerSecond / 1000) : descriptor.modelId === 'music_v2_5' ? 30000 : 5000;
      const durationTicks = input.durationTicks ?? defaultDuration;
      placement(document, timeline.id, input.startTick, durationTicks);
      const item = plugin.createItem({ timeline, id: randomUUID(), startTick: input.startTick, durationTicks, params: {}, generationToken: randomUUID() });
      if (asset) { item.outputAssetId = asset.id; item.outputOrigin = 'placement'; }
      document.items[item.id] = item;
      timeline.itemIds.push(item.id);
      return { itemId: item.id };
    };
    // An empty generation request and placement of existing media have different
    // preconditions and results, while sharing plugin validation and placement.
    add('item.createDraft', z.strictObject({ timelineId: idSchema, startTick: tickSchema }), createItem);
    add('item.create', z.strictObject({ timelineId: idSchema, startTick: tickSchema, durationTicks: durationSchema.optional(), assetId: idSchema }), createItem);
    add('media.placeExternal', z.strictObject({ asset: assetSchema, timelineId: idSchema.optional(), startTick: tickSchema }), (document, input, caller) => {
      if (caller.source !== 'internal') throw new DomainError('FORBIDDEN', '外部媒体必须先由宿主验证');
      let timeline = input.timelineId === undefined ? undefined : timelineOf(document, input.timelineId);
      if (timeline) {
        const declaration = timelineRegistry.describe(timeline.modelId ?? timeline.pluginId);
        if (declaration.mode !== 'local' || !declaration.capabilities.mediaPlacement || declaration.outputKind !== input.asset.kind) throw new DomainError('NOT_APPLICABLE', '外部媒体只能放入同类的普通媒体时间线');
      } else {
        const plugin = timelineRegistry.createPlugin(`pixel.${input.asset.kind}.local`);
        timeline = plugin.createTimeline({ id: randomUUID(), ticksPerSecond: 1000, settings: {} });
        document.timelines[timeline.id] = timeline;
        if (document.timelineOrder) document.timelineOrder.push(timeline.id);
      }
      document.assets[input.asset.id] = input.asset;
      const outcome = createItem(document, { timelineId: timeline.id, startTick: input.startTick, assetId: input.asset.id });
      return { ...outcome, timelineId: timeline.id, assetId: input.asset.id, importFingerprint: input.asset.metadata.importFingerprint ?? null };
    });
    this.registry.register(new MoveItemHandler((document, itemId, startTick) => {
      const current = document.items[itemId]!;
      const draft = structuredClone(document) as ProjectDocument;
      timelineAction(draft, current.timelineId, 'item.move');
      placement(draft, current.timelineId, startTick, current.durationTicks, itemId);
    }));
    add('item.params', z.strictObject({ itemId: idSchema, params: jsonSchema }), (document, { itemId, params }) => {
      const item = itemOf(document, itemId);
      const timeline = timelineAction(document, item.timelineId, 'item.params');
      const validated = timelineRegistry.forTimeline(timeline).validateItemParams(params);
      if (canonical(item.params) !== canonical(validated)) { item.params = validated; invalidate(document, item); }
      return { itemId };
    });
    add('item.resize', z.strictObject({ itemId: idSchema, startTick: tickSchema, durationTicks: durationSchema }), (document, { itemId, startTick, durationTicks }) => {
      const item = itemOf(document, itemId);
      timelineAction(document, item.timelineId, 'item.resize');
      placement(document, item.timelineId, startTick, durationTicks, itemId);
      item.startTick = startTick; item.durationTicks = durationTicks;
      return { itemId };
    });
    add('item.delete', z.strictObject({ itemId: idSchema }), (document, { itemId }) => {
      const item = itemOf(document, itemId);
      const timeline = timelineAction(document, item.timelineId, 'item.delete');
      timeline.itemIds = timeline.itemIds.filter(id => id !== itemId);
      delete document.items[itemId];
      return { itemId };
    });
    add('item.duplicate', z.strictObject({ itemId: idSchema }), (document, { itemId }) => {
      const original = itemOf(document, itemId);
      const timeline = timelineAction(document, original.timelineId, 'item.duplicate');
      const item = structuredClone(original);
      item.id = randomUUID(); item.generationToken = randomUUID(); item.startTick = original.startTick + original.durationTicks;
      for (const other of (timelineRegistry.forTimeline(timeline).manifest.overlapPolicy === 'allow' ? [] : timeline.itemIds.map(id => document.items[id]!).sort((left, right) => left.startTick - right.startTick))) {
        if (item.startTick < other.startTick + other.durationTicks && other.startTick < item.startTick + item.durationTicks) item.startTick = other.startTick + other.durationTicks;
      }
      placement(document, item.timelineId, item.startTick, item.durationTicks);
      document.items[item.id] = item; timeline.itemIds.push(item.id);
      return { itemId: item.id };
    });
    const addReference = (document: ProjectDocument, { itemId, assetId }: { itemId: string; assetId: string }): JsonObject => {
      const item = itemOf(document, itemId);
      const asset = assetOf(document, assetId);
      const timeline = timelineAction(document, item.timelineId, 'item.reference.add');
      const descriptor = timelineRegistry.describe(timeline.modelId ?? timeline.pluginId);
      if (!descriptor.capabilities.references) throw new DomainError('NOT_APPLICABLE', '该时间线不支持素材引用');
      if (!descriptor.referenceKinds.includes(asset.kind)) throw new DomainError('NOT_APPLICABLE', '该模型不支持这种引用媒体');
      if (referenceExceedsByteLimit(descriptor, asset.metadata.byteLength)) throw new DomainError('NOT_APPLICABLE', `参考文件超出模型声明的 ${descriptor.referenceMaxBytes! / 1024 / 1024} MiB 上限`);
      if (item.referenceAssetIds.includes(assetId)) throw new DomainError('NOT_APPLICABLE', '引用已存在');
      const maximum = referenceLimit(descriptor, item.params);
      if (item.referenceAssetIds.length >= maximum) throw new DomainError('NOT_APPLICABLE', '该模型的引用数量已达到上限');
      item.referenceAssetIds.push(assetId); invalidate(document, item);
      return { itemId, assetId };
    };
    add('item.reference.add', z.strictObject({ itemId: idSchema, assetId: idSchema }), addReference);
    add('media.referenceExternal', z.strictObject({ itemId: idSchema, asset: assetSchema }), (document, { itemId, asset }, caller) => {
      if (caller.source !== 'internal') throw new DomainError('FORBIDDEN', '参考文件必须先由宿主验证');
      document.assets[asset.id] = asset;
      return { ...addReference(document, { itemId, assetId: asset.id }), importFingerprint: asset.metadata.importFingerprint ?? null };
    });
    add('item.reference.remove', z.strictObject({ itemId: idSchema, assetId: idSchema }), (document, { itemId, assetId }) => {
      const item = itemOf(document, itemId);
      timelineAction(document, item.timelineId, 'item.reference.remove');
      if (!item.referenceAssetIds.includes(assetId)) throw new DomainError('NOT_FOUND', '引用不存在');
      item.referenceAssetIds = item.referenceAssetIds.filter(id => id !== assetId); invalidate(document, item);
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
      delete document.assets[assetId];
      for (const group of Object.values(document.assetGroups ?? {})) group.assetIds = group.assetIds.filter(id => id !== assetId);
      return { assetId };
    });
    add('asset.saveFromItem', z.strictObject({ itemId: idSchema }), (document, { itemId }) => {
      const item = itemOf(document, itemId);
      timelineAction(document, item.timelineId, 'asset.saveFromItem');
      if (!item.outputAssetId) throw new DomainError('NOT_APPLICABLE', '该片段还没有可保存的媒体输出');
      const asset = assetOf(document, item.outputAssetId);
      asset.metadata.librarySaved = true;
      return { assetId: asset.id };
    });
    add('generation.submit', z.strictObject({ itemId: idSchema }), (document, { itemId }) => {
      const item = itemOf(document, itemId);
      const timeline = timelineAction(document, item.timelineId, 'generation.submit');
      if (timeline.modelId === undefined) throw new DomainError('NOT_APPLICABLE', '本地时间线不会启动模型生成');
      const descriptor = modelRegistry.resolve(timeline.modelId);
      if (!this.runner || !this.providers[descriptor.providerId]) throw new DomainError('NOT_APPLICABLE', '该供应商尚未配置后端凭证');
      if ([...this.jobsCache.values()].some(job => job.request.targetItemId === itemId && ['queued', 'running', 'cancelRequested'].includes(job.state))) throw new DomainError('NOT_APPLICABLE', '该片段正在生成');
      item.generationToken = randomUUID();
      const request = captureGenerationRequest(document, item);
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
      if (item.generationToken !== input.generationToken || captureGenerationRequest(document, item).inputFingerprint !== input.inputFingerprint) throw new DomainError('STALE_RESULT', '片段已变更，保留产物但不覆盖当前输入');
      const timeline = timelineOf(document, item.timelineId);
      if (timeline.modelId === undefined || input.asset.kind !== modelRegistry.resolve(timeline.modelId).outputKind) throw new DomainError('INVALID_INPUT', '生成产物类型与时间线模型不一致');
      document.assets[input.asset.id] = input.asset;
      item.outputAssetId = input.asset.id;
      item.outputOrigin = 'generated';
      return { itemId: item.id, assetId: input.asset.id, jobId: input.jobId };
    }, 'generation.apply');
  }

  importMedia(input: { bytes: Uint8Array; mimeType: string; name: string; requestId: string; expectedRevision: number }): Promise<ActionResult> {
    return this.verifiedMediaTransaction(input, 'asset.import', {});
  }
  placeExternalMedia(input: { bytes: Uint8Array; mimeType: string; name: string; requestId: string; expectedRevision: number; startTick: number; timelineId?: string }): Promise<ActionResult> {
    return this.verifiedMediaTransaction(input, 'media.placeExternal', { startTick: input.startTick, ...(input.timelineId === undefined ? {} : { timelineId: input.timelineId }) });
  }
  importReferenceMedia(input: { bytes: Uint8Array; mimeType: string; name: string; requestId: string; expectedRevision: number; itemId: string }): Promise<ActionResult> {
    return this.verifiedMediaTransaction(input, 'media.referenceExternal', { itemId: input.itemId });
  }
  private async verifiedMediaTransaction(input: { bytes: Uint8Array; mimeType: string; name: string; requestId: string; expectedRevision: number }, actionType: 'asset.import' | 'media.placeExternal' | 'media.referenceExternal', destination: JsonObject): Promise<ActionResult> {
    if (this.closing) return { ok: false, requestId: input.requestId, error: { code: 'NOT_APPLICABLE', message: '项目会话已关闭，请在当前作品中重试' } };
    const fingerprint = createHash('sha256').update(canonical({ mimeType: input.mimeType, name: input.name, expectedRevision: input.expectedRevision, ...(actionType === 'asset.import' ? {} : { actionType, destination }) })).update(input.bytes).digest('hex');
    const previous = this.imports.get(input.requestId);
    if (previous) { await previous; return this.verifiedMediaTransaction(input, actionType, destination); }
    const operation = (async (): Promise<ActionResult> => {
      const replay = await this.repository.receipt(this.caller.actorId, input.requestId);
      if (replay) return replay.outcome.importFingerprint === fingerprint ? replay : { ok: false, requestId: input.requestId, error: { code: 'REQUEST_ID_REUSED', message: '相同请求 ID 不能导入不同内容' } };
      const snapshot = await this.snapshot();
      if (this.closing) return { ok: false, requestId: input.requestId, error: { code: 'NOT_APPLICABLE', message: '项目会话已关闭，请在当前作品中重试' } };
      if (snapshot.revision !== input.expectedRevision) return { ok: false, requestId: input.requestId, error: { code: 'REVISION_CONFLICT', message: '项目已更新，请重新读取后重试' } };
      const kind = detectMedia(input.bytes, input.mimeType);
      if (actionType === 'media.referenceExternal') {
        const item = itemOf(snapshot.document, String(destination.itemId));
        const timeline = timelineAction(snapshot.document, item.timelineId, 'item.reference.add');
        const declaration = timelineRegistry.describe(timeline.modelId ?? timeline.pluginId);
        if (!declaration.capabilities.references || !declaration.referenceKinds.includes(kind)) throw new DomainError('NOT_APPLICABLE', '此模型不支持这种参考文件');
        if (referenceExceedsByteLimit(declaration, input.bytes.byteLength)) throw new DomainError('INVALID_INPUT', `参考文件超出模型声明的 ${declaration.referenceMaxBytes! / 1024 / 1024} MiB 上限`);
        if (item.referenceAssetIds.length >= referenceLimit(declaration, item.params)) throw new DomainError('NOT_APPLICABLE', '参考文件数量已达上限');
      }
      let durationMs: number | undefined;
      // 库导入与直接放置共享同一个可信探测入口，后续 item.create 不猜测源媒体时长。
      if (kind !== 'image') {
        const controller = new AbortController(); this.mediaReads.add(controller);
        try { durationMs = await probeMediaDuration(input.bytes, kind, input.mimeType, controller.signal); }
        finally { this.mediaReads.delete(controller); }
      }
      const artifact = await this.artifacts.write({ attemptToken: { jobId: `import_${randomUUID()}`, attempt: 1 }, bytes: input.bytes, kind, metadata: { mimeType: input.mimeType, name: input.name.slice(0, 200), imported: true, librarySaved: true, importFingerprint: fingerprint, ...(durationMs === undefined ? {} : { durationMs }) } });
      if (this.closing) return { ok: false, requestId: input.requestId, error: { code: 'NOT_APPLICABLE', message: '项目会话已关闭，请在当前作品中重试' } };
      const caller: CallerContext = { actorId: this.caller.actorId, source: 'internal', projectIds: this.caller.projectIds, permissions: new Set(['project.edit']) };
      return this.executor.execute({ requestId: input.requestId, expectedRevision: input.expectedRevision, projectId: this.projectId, type: actionType, payload: { asset: artifact.asset, ...destination } }, caller);
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
  const workbench = new Workbench(repository, options.runner, directory, options.providers ?? { elevenlabs: Boolean(options.runner), openrouter: Boolean(options.runner) }, options.voices);
  await workbench.initialize();
  return workbench;
}
