import { z } from 'zod';

/** IPC、项目文件和插件参数只使用可序列化数据。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type ReadonlyJsonValue = string | number | boolean | null | readonly ReadonlyJsonValue[] | ReadonlyJsonObject;
export type ReadonlyJsonObject = { readonly [key: string]: ReadonlyJsonValue };
/** 给 JSON 字典使用具名递归类型，避免无限展开 mapped type，保留领域记录的精确字段。 */
export type DeepReadonly<T> = T extends readonly (infer Element)[]
  ? readonly DeepReadonly<Element>[]
  : T extends object
    ? string extends keyof T
      ? T extends JsonObject ? ReadonlyJsonObject : { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
export type MediaKind = 'video' | 'audio' | 'image';

export interface AssetData {
  id: string;
  kind: MediaKind;
  fileRef: string; // 后端解析的文件句柄，不是插件可任意读取的路径。
  metadata: JsonObject;
}

/** Asset remains the media object; a group only records one project-local library membership. */
export interface AssetGroupData {
  id: string;
  title: string;
  assetIds: string[];
}

export const assetGroupTitleSchema = z.string().trim().min(1).max(80);
export const assetGroupDataSchema = z.strictObject({
  id: z.string().min(1).max(200),
  // Stored data is canonical; Action inputs use assetGroupTitleSchema to trim before committing.
  title: z.string().refine(title => title === title.trim() && assetGroupTitleSchema.safeParse(title).success, '分组名称必须为已去除首尾空白的 1–80 字符文本'),
  assetIds: z.array(z.string().min(1).max(200)),
});
export const assetGroupsSchema = z.record(z.string().min(1).max(200), assetGroupDataSchema);
export const timelineOrderSchema = z.array(z.string().min(1).max(200));

export interface TimelineData {
  id: string;
  pluginId: string;
  pluginVersion: number;
  /** 仅生成时间线声明模型；本地语义插件（如纯文本）不伪造模型 ID。 */
  modelId?: string;
  /** 每秒整数 tick 数；区间统一为 [startTick, startTick + durationTicks)。 */
  ticksPerSecond: number;
  itemIds: string[];
  settings: JsonObject;
  /** 新片段的稀疏参数默认配置；旧项目缺省为 {}，修改不重写已有片段。 */
  itemDefaults?: JsonObject;
}

/** 通用时间壳 + 插件专属 params，不要求音乐、对话等都继承 VideoClip。 */
export interface TimelineItemData {
  id: string;
  timelineId: string;
  kind: string;
  startTick: number;
  durationTicks: number;
  sourceOffsetTicks: number;
  params: JsonObject;
  /** 时间线设置在创建/显式刷新时捕获；旧片段缺省时由宿主惰性兼容。 */
  generationSettings?: JsonObject;
  referenceAssetIds: string[];
  outputAssetId?: string;
  /** 人工上传与已有素材保留编辑意图；只有生成输出随生成输入失效。 */
  outputOrigin?: 'placement' | 'generated' | 'manual';
  /** 每次影响生成输入的编辑或重新生成都换 token，撤销也不能复用旧 token。 */
  generationToken: string;
}

export interface ProjectDocument {
  schemaVersion: 1;
  id: string;
  title: string;
  timelines: Record<string, TimelineData>;
  items: Record<string, TimelineItemData>;
  assets: Record<string, AssetData>;
  /** Missing in older version-1 projects; no automatic grouping or migration is needed. */
  assetGroups?: Record<string, AssetGroupData>;
  /** Top-to-bottom layer order. Missing in older projects, which retain dictionary insertion order. */
  timelineOrder?: string[];
}

/** Read-only presentation order; querying an old project never migrates or rewrites it. */
export function orderedTimelineIds(document: Pick<DeepReadonly<ProjectDocument>, 'timelines' | 'timelineOrder'>): string[] {
  return document.timelineOrder ? [...document.timelineOrder] : Object.keys(document.timelines);
}

export interface ProjectSnapshot {
  revision: number;
  document: ProjectDocument;
}

export const actionEnvelopeSchema = z.strictObject({
  requestId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  expectedRevision: z.number().int().nonnegative(),
  type: z.string().min(1).max(200),
  payload: z.json(),
});
export type ActionEnvelope = z.infer<typeof actionEnvelopeSchema>;

/** 由可信适配器提供，不接受 renderer 自称为 internal 或提供权限。 */
export interface CallerContext {
  actorId: string;
  source: 'gui' | 'cli' | 'agent' | 'internal';
  projectIds: ReadonlySet<string>;
  permissions: ReadonlySet<'project.edit' | 'generation.submit' | 'generation.apply'>;
}

export type ErrorCode =
  | 'INVALID_INPUT' | 'NOT_FOUND' | 'NOT_APPLICABLE' | 'FORBIDDEN'
  | 'REVISION_CONFLICT' | 'REQUEST_ID_REUSED' | 'STALE_RESULT' | 'INTERNAL';

export interface ActionFailure {
  ok: false;
  requestId?: string;
  error: { code: ErrorCode; message: string };
}

export interface ActionReceipt {
  ok: true;
  requestId: string;
  projectId: string;
  revision: number;
  undoable: boolean;
  outcome: JsonObject;
}
export type ActionResult = ActionReceipt | ActionFailure;
export type Unsubscribe = () => void;

export interface ProjectChanged {
  type: 'project.changed';
  projectId: string;
  revision: number;
  requestId: string;
}

export type ObjectRef =
  | { kind: 'project'; projectId: string }
  | { kind: 'timeline' | 'item' | 'asset'; projectId: string; id: string };

export type ActionAvailability =
  | { status: 'available' }
  | { status: 'disabled'; reason: string }
  | { status: 'hidden' };

export interface ContextAction {
  id: string;
  title: string;
  availability: ActionAvailability;
  command: { type: string; payload: JsonObject };
}

/** GUI 菜单与 Agent 能力发现使用同一语义目录；此骨架仅声明查询契约。 */
export interface ActionCapability {
  type: string;
  title: string;
  description: string;
  payloadJsonSchema: JsonObject;
  availability: ActionAvailability;
}

export const capabilityQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(20).default(5),
  cursor: z.string().max(500).optional(),
  exclude: z.array(z.string().max(200)).max(20).default([]),
});
export type CapabilityQuery = z.infer<typeof capabilityQuerySchema>;
export interface CapabilityPage {
  items: ActionCapability[];
  nextCursor?: string;
}

export interface CapabilityCatalog {
  /** 后端根据对象、插件和调用者权限查询；UI 的作用域过滤再由宿主执行。 */
  query(target: ObjectRef, options: CapabilityQuery, caller: CallerContext): Promise<CapabilityPage>;
}

export type JobState =
  | 'queued' | 'running' | 'cancelRequested'
  | 'succeeded' | 'failed' | 'canceled' | 'interrupted';

export interface GenerationRequest {
  projectId: string;
  targetItemId: string;
  generationToken: string;
  inputFingerprint: string;
  providerId: string;
  providerVersion: string;
  modelId: string;
  params: JsonObject;
  /** 捕获的时间线设置；与 item 参数一起构成模型输入。 */
  settings?: JsonObject;
  /** 明确的生成时长约束；自然时长语音与静态图像不接受伪时长。 */
  durationMs?: number;
  /** 提交时捕获的语音上下文；供应商仅将其用作参考，不拼入正文。 */
  context?: { previousText?: string; nextText?: string };
  references: GenerationReference[];
}

export interface GenerationReference extends AssetData {
  role?: 'reference' | 'first-frame' | 'last-frame';
}

const jsonObjectSchema = z.record(z.string(), z.json());
export const generationRequestSchema = z.strictObject({
  projectId: z.string().min(1).max(200),
  targetItemId: z.string().min(1).max(200),
  generationToken: z.string().min(1).max(200),
  inputFingerprint: z.string().min(1).max(200),
  providerId: z.string().min(1).max(200),
  providerVersion: z.string().min(1).max(200),
  modelId: z.string().min(1).max(200),
  params: jsonObjectSchema,
  settings: jsonObjectSchema.optional(),
  durationMs: z.number().int().positive().safe().optional(),
  context: z.strictObject({
    previousText: z.string().max(10_000).optional(),
    nextText: z.string().max(10_000).optional(),
  }).optional(),
  references: z.array(z.strictObject({
    id: z.string().min(1).max(200),
    kind: z.enum(['image', 'audio', 'video']),
    fileRef: z.string().min(1).max(500),
    metadata: jsonObjectSchema,
    role: z.enum(['reference', 'first-frame', 'last-frame']).optional(),
  })).max(30),
});

/** 任务存于独立 ledger，不进入 ProjectDocument 的撤销历史。 */
export interface GenerationJob {
  id: string;
  request: GenerationRequest;
  state: JobState;
  attempt: number;
  progress: number;
  providerTaskId?: string;
  artifactIds: string[];
  error?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface GenerationArtifact {
  id: string;
  jobId: string;
  asset: AssetData;
}
