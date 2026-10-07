import { z } from 'zod';
import {
  actionEnvelopeSchema,
  type ActionEnvelope, type ActionReceipt, type ActionResult, type CallerContext,
  type DeepReadonly, type ErrorCode, type JsonObject, type ProjectChanged,
  type ProjectDocument, type ProjectSnapshot,
} from './contracts.js';

export class DomainError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}

export interface ActionMutation {
  undoable: boolean;
  outcome: JsonObject;
}

export interface ActionHandler {
  readonly type: string;
  authorize(caller: CallerContext): void;
  apply(document: ProjectDocument, payload: unknown, caller: CallerContext): ActionMutation;
}

/** 校验与权限在宿主执行；子类只写同步业务规则，不调用网络或文件系统。 */
export abstract class BaseActionHandler<T> implements ActionHandler {
  abstract readonly type: string;
  abstract readonly payloadSchema: z.ZodType<T>;
  abstract readonly permission: 'project.edit' | 'generation.submit' | 'generation.apply';
  readonly history: 'record' | 'skip' = 'record';

  authorize(caller: CallerContext): void {
    if (!caller.permissions.has(this.permission)) {
      throw new DomainError('FORBIDDEN', `缺少权限：${this.permission}`);
    }
  }

  apply(document: ProjectDocument, raw: unknown, caller: CallerContext): ActionMutation {
    this.authorize(caller);
    const parsed = this.payloadSchema.safeParse(raw);
    if (!parsed.success) throw new DomainError('INVALID_INPUT', parsed.error.message);
    return { undoable: this.history === 'record', outcome: this.mutate(document, parsed.data, caller) };
  }

  protected abstract mutate(document: ProjectDocument, payload: T, caller: CallerContext): JsonObject;
}

export class ActionRegistry {
  private readonly handlers = new Map<string, ActionHandler>();

  register(handler: ActionHandler): void {
    if (this.handlers.has(handler.type)) throw new Error(`动作已注册：${handler.type}`);
    this.handlers.set(handler.type, handler);
  }

  get(type: string): ActionHandler {
    const handler = this.handlers.get(type);
    if (!handler) throw new DomainError('NOT_FOUND', `未知动作：${type}`);
    return handler;
  }
}

export interface CommitResult { receipt: ActionReceipt; replayed: boolean }

/** 生产实现必须在同一事务中保存 document/revision/幂等记录/history。 */
export interface ProjectRepository {
  read(projectId: string): Promise<ProjectSnapshot>;
  commit(
    envelope: ActionEnvelope,
    caller: CallerContext,
    mutate: (draft: ProjectDocument) => ActionMutation,
  ): Promise<CommitResult>;
}

export interface HistoryEntry {
  requestId: string;
  before: ProjectDocument;
  after: ProjectDocument;
}

/** undo/redo 也由动作适配进入内核；新提交使用新的 revision 和 requestId。 */
export interface HistoryService {
  undo(envelope: ActionEnvelope, caller: CallerContext): Promise<ActionResult>;
  redo(envelope: ActionEnvelope, caller: CallerContext): Promise<ActionResult>;
}

interface MemoryProject {
  snapshot: ProjectSnapshot;
  requests: Map<string, { signature: string; receipt: ActionReceipt }>;
  history: HistoryEntry[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError('INVALID_INPUT', message);
}

/** 检查公共不变量；插件参数和重叠规则仍由对应 handler/plugin 校验。 */
export function assertProjectInvariants(document: ProjectDocument): void {
  assert(document.schemaVersion === 1 && document.id.length > 0, '项目版本或 ID 无效');
  const memberships = new Set<string>();
  for (const [id, timeline] of Object.entries(document.timelines)) {
    assert(timeline.id === id, '时间线 ID 与索引不一致');
    assert(Number.isSafeInteger(timeline.ticksPerSecond) && timeline.ticksPerSecond > 0, '时间基准必须为正整数');
    for (const itemId of timeline.itemIds) {
      const item = document.items[itemId];
      assert(item && item.timelineId === id, 'Item 所属时间线不一致');
      assert(!memberships.has(itemId), 'Item 不能重复属于多条时间线');
      memberships.add(itemId);
    }
  }
  for (const [id, item] of Object.entries(document.items)) {
    assert(item.id === id && memberships.has(id), 'Item ID 无效或未收录在时间线中');
    assert(Number.isSafeInteger(item.startTick) && item.startTick >= 0, '起点必须为非负整数 tick');
    assert(Number.isSafeInteger(item.durationTicks) && item.durationTicks > 0, '时长必须为正整数 tick');
    assert(Number.isSafeInteger(item.startTick + item.durationTicks), '时间范围超出安全整数');
    assert(Number.isSafeInteger(item.sourceOffsetTicks) && item.sourceOffsetTicks >= 0, '媒体偏移无效');
    assert(item.generationToken.length > 0, '生成 token 不能为空');
    assert(item.referenceAssetIds.every(assetId => Object.hasOwn(document.assets, assetId)), '引用的资产不存在');
    assert(!item.outputAssetId || Object.hasOwn(document.assets, item.outputAssetId), '输出资产不存在');
  }
  for (const [id, asset] of Object.entries(document.assets)) assert(asset.id === id, '资产 ID 与索引不一致');
  assert(z.json().safeParse(document).success, '项目数据必须可序列化为 JSON');
}

/** 内存原型供例子和验证使用：同步回调保证单进程提交不可交错，不具备磁盘耐久性。 */
export class MemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, MemoryProject>();

  constructor(initial: readonly ProjectSnapshot[]) {
    for (const snapshot of initial) {
      assertProjectInvariants(snapshot.document);
      assert(Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0, 'revision 无效');
      if (this.projects.has(snapshot.document.id)) throw new Error('项目 ID 重复');
      this.projects.set(snapshot.document.id, { snapshot: structuredClone(snapshot), requests: new Map(), history: [] });
    }
  }

  private get(projectId: string): MemoryProject {
    const project = this.projects.get(projectId);
    if (!project) throw new DomainError('NOT_FOUND', `项目不存在：${projectId}`);
    return project;
  }

  async read(projectId: string): Promise<ProjectSnapshot> {
    return structuredClone(this.get(projectId).snapshot);
  }

  history(projectId: string): readonly HistoryEntry[] {
    return structuredClone(this.get(projectId).history);
  }

  async commit(envelope: ActionEnvelope, caller: CallerContext, mutate: (draft: ProjectDocument) => ActionMutation): Promise<CommitResult> {
    const project = this.get(envelope.projectId);
    const requestKey = JSON.stringify([caller.actorId, envelope.requestId]);
    const signature = canonical(envelope);
    const cached = project.requests.get(requestKey);
    if (cached) {
      if (cached.signature !== signature) throw new DomainError('REQUEST_ID_REUSED', '相同 requestId 不能用于不同请求');
      return { receipt: structuredClone(cached.receipt), replayed: true };
    }
    if (project.snapshot.revision !== envelope.expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', '项目已更新，请重新读取后决定是否重提动作');
    }
    const before = project.snapshot.document;
    const draft = structuredClone(before);
    const mutation = mutate(draft);
    assertProjectInvariants(draft);
    assert(draft.id === envelope.projectId, '动作不能修改项目 ID');
    assert(z.json().safeParse(mutation.outcome).success, '动作返回值必须为 JSON');
    const revision = project.snapshot.revision + 1;
    assert(Number.isSafeInteger(revision), 'revision 超出安全整数');
    const receipt: ActionReceipt = {
      ok: true, requestId: envelope.requestId, projectId: envelope.projectId,
      revision, undoable: mutation.undoable, outcome: structuredClone(mutation.outcome),
    };
    // 校验均通过后才更新；保存副本，避免 handler 保留 draft 引用并在提交后修改。
    project.snapshot = { revision, document: structuredClone(draft) };
    if (mutation.undoable) project.history.push({ requestId: envelope.requestId, before: structuredClone(before), after: structuredClone(draft) });
    project.requests.set(requestKey, { signature, receipt: structuredClone(receipt) });
    return { receipt, replayed: false };
  }
}

export class ActionExecutor {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly registry: ActionRegistry,
    private readonly publish: (event: ProjectChanged) => void = () => {},
    private readonly onNotificationError: (error: unknown) => void = () => {},
  ) {}

  async execute(raw: unknown, caller: CallerContext): Promise<ActionResult> {
    const parsed = actionEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_INPUT', message: parsed.error.message } };
    const envelope = parsed.data;
    try {
      if (!caller.projectIds.has(envelope.projectId)) throw new DomainError('FORBIDDEN', '无权访问该项目');
      const handler = this.registry.get(envelope.type);
      // 幂等重放也需重新校验当前权限。
      handler.authorize(caller);
      const commit = await this.repository.commit(envelope, caller, draft => handler.apply(draft, envelope.payload, caller));
      if (!commit.replayed) {
        try {
          this.publish({ type: 'project.changed', projectId: envelope.projectId, revision: commit.receipt.revision, requestId: envelope.requestId });
        } catch (error) {
          // 提交已经成功；投影通过 snapshot 恢复，不把通知失败伪装成提交失败。
          try { this.onNotificationError(error); } catch { /* 日志失败不改变提交结果。 */ }
        }
      }
      return commit.receipt;
    } catch (error) {
      return {
        ok: false, requestId: envelope.requestId,
        error: error instanceof DomainError
          ? { code: error.code, message: error.message }
          : { code: 'INTERNAL', message: '动作执行失败' },
      };
    }
  }
}

const moveItemSchema = z.strictObject({
  itemId: z.string().min(1),
  startTick: z.number().int().nonnegative().refine(Number.isSafeInteger, '超出安全整数'),
});

/** 一次示例扩展：在当前时间线内移动。插件限制通过注入策略执行。 */
export class MoveItemHandler extends BaseActionHandler<z.infer<typeof moveItemSchema>> {
  readonly type = 'item.move';
  readonly permission = 'project.edit';
  readonly payloadSchema = moveItemSchema;

  constructor(private readonly validatePlacement: (document: DeepReadonly<ProjectDocument>, itemId: string, startTick: number) => void = () => {}) { super(); }

  protected mutate(document: ProjectDocument, payload: z.infer<typeof moveItemSchema>): JsonObject {
    const item = Object.hasOwn(document.items, payload.itemId) ? document.items[payload.itemId] : undefined;
    if (!item) throw new DomainError('NOT_FOUND', 'Item 不存在');
    this.validatePlacement(document as unknown as DeepReadonly<ProjectDocument>, item.id, payload.startTick);
    item.startTick = payload.startTick;
    // 仅改变放置位置；若模型把位置作为生成输入，模型策略须更新 generationToken。
    return { itemId: item.id, startTick: item.startTick };
  }
}
