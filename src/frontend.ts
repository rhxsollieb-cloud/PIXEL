import { actionEnvelopeSchema } from './contracts.js';
import type {
  ActionAvailability, ActionEnvelope, ActionResult, ContextAction, DeepReadonly,
  JsonObject, ObjectRef, ProjectChanged, ProjectSnapshot, Unsubscribe,
} from './contracts.js';

/** preload 只暴露这三个能力；renderer 不接触数据库、文件系统或权限声明。 */
export interface DesktopBridge {
  readProject(projectId: string): Promise<ProjectSnapshot>;
  dispatch(action: ActionEnvelope): Promise<ActionResult>;
  subscribeProject(projectId: string, listener: (event: DeepReadonly<ProjectChanged>) => void): Unsubscribe;
}

export interface FrontendCommand {
  type: string;
  payload: JsonObject;
}

/** 请求身份和版本必须由调用点明确提供，不能从选择状态中推断对象。 */
export interface ActionRequest extends FrontendCommand {
  requestId: string;
  projectId: string;
  expectedRevision: number;
}

function freezeTree<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function frozenCopy<T>(value: T): DeepReadonly<T> {
  return freezeTree(structuredClone(value));
}

function assertName(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw new Error(`${label} 必须是长度 1–200 的非空字符串`);
  }
}

function checkedPayload(payload: JsonObject): JsonObject {
  const parsed = actionEnvelopeSchema.shape.payload.parse(payload);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('动作 payload 必须是 JSON 对象');
  }
  return structuredClone(parsed) as JsonObject;
}

function command(type: string, payload: JsonObject): DeepReadonly<FrontendCommand> {
  assertName(type, '动作类型');
  return frozenCopy({ type, payload: checkedPayload(payload) });
}

export class ActionClient {
  constructor(private readonly bridge: DesktopBridge) {}

  async execute(request: DeepReadonly<ActionRequest>): Promise<DeepReadonly<ActionResult>> {
    const envelope = actionEnvelopeSchema.parse(structuredClone(request));
    checkedPayload(envelope.payload as JsonObject);
    // 冲突、超时与失败原样返回；重发必须保留同一请求身份并由调用者明确决定。
    return frozenCopy(await this.bridge.dispatch(envelope));
  }
}

export interface ProjectProjectionOptions {
  projectId: string;
  bridge: DesktopBridge;
  onError?: (error: unknown) => void;
}

/** 权威项目的只读镜像；适配 Zustand/useSyncExternalStore 时不提供 set/update。 */
export class ProjectProjectionStore {
  private snapshot: DeepReadonly<ProjectSnapshot> | undefined;
  private observedRevision = 0;
  private lastError: unknown;
  private readonly listeners = new Set<() => void>();
  private unsubscribeBridge: Unsubscribe | undefined;
  private startPromise: Promise<DeepReadonly<ProjectSnapshot> | undefined> | undefined;
  private disposed = false;

  constructor(private readonly options: ProjectProjectionOptions) {
    assertName(options.projectId, '项目 ID');
  }

  getSnapshot(): DeepReadonly<ProjectSnapshot> | undefined {
    return this.snapshot;
  }

  getError(): unknown {
    return this.lastError;
  }

  subscribe(listener: () => void): Unsubscribe {
    this.assertLive();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(): Promise<DeepReadonly<ProjectSnapshot> | undefined> {
    this.assertLive();
    if (this.startPromise) return this.startPromise;
    // 先订阅再读，避免初始化窗口内丢失提交事件。
    this.unsubscribeBridge = this.options.bridge.subscribeProject(this.options.projectId, event => {
      if (this.disposed || event.projectId !== this.options.projectId) return;
      if (!Number.isSafeInteger(event.revision) || event.revision < 0) {
        this.recordError(new Error('项目事件 revision 无效'));
        return;
      }
      if (event.revision <= Math.max(this.observedRevision, this.snapshot?.revision ?? -1)) return;
      this.observedRevision = event.revision;
      void this.refresh().catch(error => this.recordError(error));
    });
    this.startPromise = this.refresh();
    return this.startPromise;
  }

  async refresh(): Promise<DeepReadonly<ProjectSnapshot> | undefined> {
    this.assertLive();
    const candidate = await this.options.bridge.readProject(this.options.projectId);
    // dispose 后到达的 IPC 响应不能再次发布到已经卸载的界面。
    if (this.disposed) return this.snapshot;
    if (candidate.document.id !== this.options.projectId) throw new Error('快照项目 ID 不匹配');
    if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 0) {
      throw new Error('快照 revision 无效');
    }
    // revision 是提交顺序，不用请求的发出/完成顺序替代它。旧响应绝不能回滚镜像。
    if (candidate.revision < this.observedRevision || candidate.revision < (this.snapshot?.revision ?? -1)) {
      return this.snapshot;
    }
    if (candidate.revision === this.snapshot?.revision) return this.snapshot;
    this.snapshot = frozenCopy(candidate);
    this.observedRevision = candidate.revision;
    this.lastError = undefined;
    this.notify();
    return this.snapshot;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = undefined;
    this.listeners.clear();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('ProjectProjectionStore 已 dispose');
  }

  private recordError(error: unknown): void {
    if (this.disposed) return;
    this.lastError = error;
    this.options.onError?.(error);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { this.options.onError?.(error); }
    }
  }
}

export interface ModalFrame {
  scopeId: string;
  object: ObjectRef;
}

function objectExists(object: DeepReadonly<ObjectRef>, project: DeepReadonly<ProjectSnapshot>): boolean {
  if (object.projectId !== project.document.id) return false;
  switch (object.kind) {
    case 'project': return true;
    case 'timeline': return Object.hasOwn(project.document.timelines, object.id);
    case 'item': return Object.hasOwn(project.document.items, object.id);
    case 'asset': return Object.hasOwn(project.document.assets, object.id);
  }
}

/** 一个宿主实例对应一个 ModalHost；scopeId 隔离同一对象被多次打开的视图状态。 */
export class ModalNavigator {
  private path: readonly DeepReadonly<ModalFrame>[] = Object.freeze([]);
  private nextScope = 0;
  private readonly listeners = new Set<() => void>();

  constructor(readonly projectId: string) {
    assertName(projectId, '项目 ID');
  }

  getPath(): readonly DeepReadonly<ModalFrame>[] { return this.path; }
  current(): DeepReadonly<ModalFrame> | undefined { return this.path.at(-1); }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  open(object: DeepReadonly<ObjectRef>): DeepReadonly<ModalFrame> {
    const frame = this.makeFrame(object);
    this.setPath([frame]);
    return frame;
  }

  push(object: DeepReadonly<ObjectRef>): DeepReadonly<ModalFrame> {
    const frame = this.makeFrame(object);
    this.setPath([...this.path, frame]);
    return frame;
  }

  pop(): DeepReadonly<ModalFrame> | undefined {
    const removed = this.current();
    if (removed) this.setPath(this.path.slice(0, -1));
    return removed;
  }

  reset(): void { if (this.path.length) this.setPath([]); }

  /** undefined 是工作区作用域；Modal 打开后工作区与非顶部 frame 都失活。 */
  isInteractive(scopeId: string | undefined): boolean {
    const top = this.current();
    return top ? top.scopeId === scopeId : scopeId === undefined;
  }

  assertInteractive(scopeId: string | undefined): void {
    if (!this.isInteractive(scopeId)) throw new Error('交互不属于当前顶部 Modal 作用域');
  }

  /** 后端删除对象后，退回路径中仍存在的祖先，防止保留悬空详情页。 */
  reconcile(project: DeepReadonly<ProjectSnapshot>): void {
    if (project.document.id !== this.projectId) throw new Error('导航项目 ID 不匹配');
    const firstMissing = this.path.findIndex(frame => !objectExists(frame.object, project));
    if (firstMissing !== -1) this.setPath(this.path.slice(0, firstMissing));
  }

  private makeFrame(object: DeepReadonly<ObjectRef>): DeepReadonly<ModalFrame> {
    if (object.projectId !== this.projectId) throw new Error('Modal 不能直接导航到另一个项目');
    if (object.kind !== 'project') assertName(object.id, '对象 ID');
    return frozenCopy({ scopeId: `modal:${++this.nextScope}`, object });
  }

  private setPath(path: readonly DeepReadonly<ModalFrame>[]): void {
    this.path = Object.freeze([...path]);
    for (const listener of this.listeners) listener();
  }
}

/** 组合根显式共享此注册表，才能跨右键与拖拽保证一个动作只有一条 GUI 路径。 */
export class GuiActionPathRegistry {
  private readonly claims = new Map<string, { path: string; owner: symbol }>();

  claim(actionType: string, path: string): Unsubscribe {
    assertName(actionType, '动作类型');
    const existing = this.claims.get(actionType);
    if (existing) throw new Error(`动作 ${actionType} 已绑定 GUI 路径 ${existing.path}`);
    const owner = Symbol(actionType);
    this.claims.set(actionType, { path, owner });
    return () => {
      if (this.claims.get(actionType)?.owner === owner) this.claims.delete(actionType);
    };
  }

  getPath(actionType: string): string | undefined { return this.claims.get(actionType)?.path; }
}

type AssetRef = { kind: 'asset'; projectId: string; id: string };
type ItemRef = { kind: 'item'; projectId: string; id: string };

/** 宿主拥有固定手势角色；模型创建时间线只能走右键，角色集合中没有 model。 */
export interface DragPayloadMap {
  asset: { object: AssetRef };
  item: { object: ItemRef };
  'item.duration': { object: ItemRef; edge: 'start' | 'end' };
  'field.reference': { object: ObjectRef; fieldKey: string };
}
export type DragSourceRole = keyof DragPayloadMap;
export type DragSource<R extends DragSourceRole = DragSourceRole> = {
  [K in R]: { role: K; payload: DragPayloadMap[K] }
}[R];
export type DragTargetRole = 'timeline.position' | 'asset-library' | 'item.edge' | 'item.reference' | 'field.reference';
export interface DragTarget<T extends DragTargetRole = DragTargetRole> {
  role: T;
  object: ObjectRef;
  /** 命中位置等语义数据，例如整数 tick；不传 DOM 节点或像素坐标作为项目数据。 */
  data: JsonObject;
}
export interface DragContext<R extends DragSourceRole = DragSourceRole, T extends DragTargetRole = DragTargetRole> {
  source: DeepReadonly<DragSource<R>>;
  target: DeepReadonly<DragTarget<T>>;
  project: DeepReadonly<ProjectSnapshot>;
  scopeId?: string;
}
export interface DragRoute<R extends DragSourceRole, T extends DragTargetRole> {
  sourceRole: R;
  targetRole: T;
  actionType: string;
  /** 纯语义预览：不能提交动作、导入资产或启动生成。 */
  preview(context: DragContext<R, T>): ActionAvailability;
  buildPayload(context: DragContext<R, T>): JsonObject;
}

export interface InteractionRegistryOptions {
  paths: GuiActionPathRegistry;
  navigator?: ModalNavigator;
}

const sourceRoles: ReadonlySet<string> = new Set(['asset', 'item', 'item.duration', 'field.reference']);
const targetRoles: ReadonlySet<string> = new Set(['timeline.position', 'asset-library', 'item.edge', 'item.reference', 'field.reference']);
type ErasedDragRoute = DragRoute<DragSourceRole, DragTargetRole>;

function checkedAvailability(value: ActionAvailability): DeepReadonly<ActionAvailability> {
  switch (value.status) {
    case 'available': return Object.freeze({ status: 'available' });
    case 'hidden': return Object.freeze({ status: 'hidden' });
    case 'disabled':
      if (typeof value.reason !== 'string' || !value.reason.trim()) throw new Error('禁用动作必须提供原因');
      return Object.freeze({ status: 'disabled', reason: value.reason });
    default: throw new Error('动作可用性无效');
  }
}

function sourceMatchesRole(source: DeepReadonly<DragSource>): boolean {
  switch (source.role) {
    case 'asset': return source.payload.object.kind === 'asset';
    case 'item': return source.payload.object.kind === 'item';
    case 'item.duration':
      return source.payload.object.kind === 'item' && (source.payload.edge === 'start' || source.payload.edge === 'end');
    case 'field.reference': return typeof source.payload.fieldKey === 'string' && source.payload.fieldKey.trim().length > 0;
  }
}

function targetMatchesRole(target: DeepReadonly<DragTarget>): boolean {
  switch (target.role) {
    case 'timeline.position': return target.object.kind === 'timeline';
    case 'asset-library': return target.object.kind === 'project';
    case 'item.edge':
    case 'item.reference': return target.object.kind === 'item';
    case 'field.reference': return true;
  }
}

export class DragRegistry {
  private readonly paths: GuiActionPathRegistry;
  private readonly routes = new Map<string, { route: ErasedDragRoute; release: Unsubscribe }>();
  private disposed = false;

  constructor(private readonly options: InteractionRegistryOptions) {
    this.paths = options.paths;
  }

  register<R extends DragSourceRole, T extends DragTargetRole>(route: DragRoute<R, T>): Unsubscribe {
    if (this.disposed) throw new Error('DragRegistry 已 dispose');
    if (!sourceRoles.has(route.sourceRole)) throw new Error('不支持该拖拽源角色；模型不能拖拽创建时间线');
    if (!targetRoles.has(route.targetRole)) throw new Error('不支持该拖拽目标角色');
    const key = this.key(route.sourceRole, route.targetRole);
    if (this.routes.has(key)) throw new Error(`拖拽路由 ${key} 已注册`);
    const release = this.paths.claim(route.actionType, `drag:${key}`);
    // 类型擦除只发生于注册边界；查找时 sourceRole/targetRole 严格匹配这条路由。
    const entry = { route: { ...route } as unknown as ErasedDragRoute, release };
    this.routes.set(key, entry);
    return () => {
      if (this.routes.get(key) !== entry) return;
      this.routes.delete(key);
      release();
    };
  }

  hover(context: DragContext): DeepReadonly<ActionAvailability> {
    if (this.disposed) throw new Error('DragRegistry 已 dispose');
    if (this.options.navigator && !this.options.navigator.isInteractive(context.scopeId)) {
      return Object.freeze({ status: 'hidden' });
    }
    if (!sourceRoles.has(context.source.role) || !targetRoles.has(context.target.role)) {
      return Object.freeze({ status: 'hidden' });
    }
    if (!sourceMatchesRole(context.source) || !targetMatchesRole(context.target)) {
      return Object.freeze({ status: 'disabled', reason: '拖拽角色与对象类型不匹配' });
    }
    if (!objectExists(context.source.payload.object, context.project) || !objectExists(context.target.object, context.project)) {
      return Object.freeze({ status: 'disabled', reason: '拖拽对象不存在或属于另一个项目' });
    }
    const route = this.routes.get(this.key(context.source.role, context.target.role))?.route;
    return route ? checkedAvailability(route.preview(context)) : Object.freeze({ status: 'hidden' });
  }

  /** drop 再次验证作用域与可用性，只返回命令；调用者显式补齐请求 ID 和 revision 后提交。 */
  drop(context: DragContext): DeepReadonly<FrontendCommand> | undefined {
    if (this.hover(context).status !== 'available') return undefined;
    const route = this.routes.get(this.key(context.source.role, context.target.role))?.route;
    return route ? command(route.actionType, route.buildPayload(context)) : undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.routes.values()) entry.release();
    this.routes.clear();
  }

  private key(source: DragSourceRole, target: DragTargetRole): string { return `${source}->${target}`; }
}

/** Electron main 的后续适配契约；token 经 DataTransfer 传递，不能序列化函数或对象实例。 */
export interface NativeDragToken {
  sessionId: string;
  projectId: string;
  expiresAtMs: number;
}
export interface NativeDragBroker {
  /** 实现必须从可信 IPC sender 绑定来源窗口，校验类型、对象归属与 TTL。 */
  begin(source: DeepReadonly<DragSource>): Promise<DeepReadonly<NativeDragToken>>;
  /** 接收窗口身份同样由 IPC sender 提供；不同项目需要单独的导入/复制动作。 */
  resolve(sessionId: string): Promise<DeepReadonly<DragSource> | undefined>;
  /** drop 时原子解析并消费 token；resolve 仅用于 hover，不能授权实际提交。 */
  consume(sessionId: string): Promise<DeepReadonly<DragSource> | undefined>;
  /** drop 或取消后消费会话；来源窗口关闭/过期也应清理，防止 token 被重复使用。 */
  end(sessionId: string, outcome: 'dropped' | 'canceled'): Promise<void>;
}

export interface ContextActionContext {
  target: DeepReadonly<ObjectRef>;
  project: DeepReadonly<ProjectSnapshot>;
  scopeId?: string;
}
export interface ContextActionDefinition {
  id: string;
  title: string;
  actionType: string;
  targetKinds: readonly ObjectRef['kind'][];
  /** 宿主过滤 hidden，保留 disabled 及其解释；后端提交时仍重新验证。 */
  availability(context: ContextActionContext): ActionAvailability;
  buildPayload(context: ContextActionContext): JsonObject;
}

export class ContextActionRegistry {
  private readonly paths: GuiActionPathRegistry;
  private readonly definitions = new Map<string, { definition: ContextActionDefinition; release: Unsubscribe }>();
  private disposed = false;

  constructor(private readonly options: InteractionRegistryOptions) {
    this.paths = options.paths;
  }

  register(definition: ContextActionDefinition): Unsubscribe {
    if (this.disposed) throw new Error('ContextActionRegistry 已 dispose');
    assertName(definition.id, '菜单动作 ID');
    if (!definition.title.trim() || !definition.targetKinds.length) throw new Error('菜单动作必须有标题和目标类型');
    if (this.definitions.has(definition.id)) throw new Error(`菜单动作 ${definition.id} 已注册`);
    const release = this.paths.claim(definition.actionType, `context:${definition.id}`);
    const entry = { definition: { ...definition, targetKinds: Object.freeze([...definition.targetKinds]) }, release };
    this.definitions.set(definition.id, entry);
    return () => {
      if (this.definitions.get(definition.id) !== entry) return;
      this.definitions.delete(definition.id);
      release();
    };
  }

  list(context: ContextActionContext): readonly DeepReadonly<ContextAction>[] {
    if (this.disposed) throw new Error('ContextActionRegistry 已 dispose');
    if (this.options.navigator && !this.options.navigator.isInteractive(context.scopeId)) return Object.freeze([]);
    if (!objectExists(context.target, context.project)) return Object.freeze([]);
    const actions: DeepReadonly<ContextAction>[] = [];
    for (const { definition } of this.definitions.values()) {
      if (!definition.targetKinds.includes(context.target.kind)) continue;
      const availability = checkedAvailability(definition.availability(context));
      if (availability.status === 'hidden') continue;
      const menuAction: ContextAction = {
        id: definition.id,
        title: definition.title,
        availability,
        command: { type: definition.actionType, payload: checkedPayload(definition.buildPayload(context)) },
      };
      actions.push(frozenCopy<ContextAction>(menuAction));
    }
    return Object.freeze(actions);
  }

  /** 打开菜单后状态可能改变，激活时重新检查，禁用动作不会返回可提交命令。 */
  commandFor(id: string, context: ContextActionContext): DeepReadonly<FrontendCommand> | undefined {
    const action = this.list(context).find(candidate => candidate.id === id);
    return action?.availability.status === 'available' ? action.command : undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.definitions.values()) entry.release();
    this.definitions.clear();
  }
}
