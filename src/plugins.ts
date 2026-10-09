import { z } from 'zod';
import type { DeepReadonly, JsonObject, JsonValue, MediaKind, TimelineData, TimelineItemData } from './contracts.js';

/** 字段只描述数据含义；具体控件、菜单、拖动和键盘交互由宿主决定。 */
export interface PluginFieldDeclaration {
  scope: 'settings' | 'itemParams';
  key: string;
  label: string;
  valueType: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array';
  children?: readonly PluginFieldDeclaration[];
  visibleWhen?: { field: string; equals: JsonValue };
  nullable?: boolean;
  description?: string;
  options?: readonly { value: string; label: string }[];
}

export interface TimelinePluginManifest {
  pluginId: string;
  name: string;
  description?: string;
  outputKind?: MediaKind;
  /** 对应持久化 TimelineData.pluginVersion；不是插件安装包的版本号。 */
  schemaVersion: number;
  modelIds: readonly string[];
  /** 插件声明能力，宿主统一据此路由；本地语义无需提供生成模型。 */
  capabilities: { generation: boolean; mediaPlacement: boolean; references: boolean };
  /** 供只读 Agent 投影读取的正文参数键，不从模型名称猜测。 */
  referenceTextFields: readonly string[];
  itemKind: string;
  fields: readonly PluginFieldDeclaration[];
  /** 可作为片段默认值的参数字段；正文与手动上下文不在此列表。 */
  defaultFields?: readonly PluginFieldDeclaration[];
  supportedActions: readonly string[];
  /** reject 使用宿主统一的半开 tick 区间检测，同一 timeline 内不允许重叠。 */
  overlapPolicy: 'allow' | 'reject';
}

export interface CreateTimelineItemInput {
  timeline: DeepReadonly<TimelineData>;
  id: string;
  startTick: number;
  durationTicks: number;
  sourceOffsetTicks?: number;
  params: JsonObject;
  referenceAssetIds?: readonly string[];
  /** 由宿主生成；插件不读取时钟或自行产生标识。 */
  generationToken: string;
}

export interface CreateTimelineInput {
  id: string;
  modelId?: string;
  ticksPerSecond: number;
  settings: JsonObject;
}

export interface TimelinePlugin<
  TSettings extends JsonObject = JsonObject,
  TParams extends JsonObject = JsonObject,
> {
  readonly manifest: TimelinePluginManifest;
  readonly settingsSchema: z.ZodType<TSettings>;
  readonly itemParamsSchema: z.ZodType<TParams>;
  readonly itemDefaultsSchema: z.ZodType<JsonObject>;
  supportsModel(modelId: string): boolean;
  validateSettings(settings: unknown): TSettings;
  validateItemParams(params: unknown): TParams;
  validateItemDefaults(defaults: unknown): JsonObject;
  resolveItemDefaults(defaults: unknown): JsonObject;
  createTimeline(input: CreateTimelineInput): TimelineData;
  createItem(input: CreateTimelineItemInput): TimelineItemData;
}

const timelineShellSchema = z.strictObject({
  id: z.string().min(1),
  modelId: z.string().min(1).optional(),
  ticksPerSecond: z.number().int().positive().safe(),
});

const itemShellSchema = z.strictObject({
  id: z.string().min(1),
  timelineId: z.string().min(1),
  startTick: z.number().int().nonnegative().safe(),
  durationTicks: z.number().int().positive().safe(),
  sourceOffsetTicks: z.number().int().nonnegative().safe(),
  referenceAssetIds: z.array(z.string().min(1)),
  generationToken: z.string().min(1),
});

/** 只生产和校验纯数据。资源存在性、成员关系和重叠检查属于宿主事务。 */
export abstract class BaseTimelinePlugin<
  TSettings extends JsonObject = JsonObject,
  TParams extends JsonObject = JsonObject,
> implements TimelinePlugin<TSettings, TParams> {
  abstract readonly manifest: TimelinePluginManifest;
  abstract readonly settingsSchema: z.ZodType<TSettings>;
  abstract readonly itemParamsSchema: z.ZodType<TParams>;
  /** 插件必须显式声明可作为默认值的字段；未声明时拒绝任何默认键。 */
  readonly itemDefaultsSchema: z.ZodType<JsonObject> = z.strictObject({});

  supportsModel(modelId: string): boolean {
    return this.manifest.modelIds.includes(modelId);
  }

  validateSettings(settings: unknown): TSettings {
    return this.settingsSchema.parse(settings);
  }

  validateItemParams(params: unknown): TParams {
    return this.itemParamsSchema.parse(params);
  }

  validateItemDefaults(defaults: unknown): JsonObject {
    return this.itemDefaultsSchema.parse(z.record(z.string(), z.json()).parse(defaults));
  }

  /** 创建与显式刷新使用相同的有效默认值，持久化配置仍只保存显式键。 */
  resolveItemDefaults(defaults: unknown): JsonObject {
    const sparse = this.validateItemDefaults(defaults);
    if (this.manifest.defaultFields === undefined) return sparse;
    const params = this.validateItemParams({});
    const baseline: JsonObject = {};
    for (const field of this.manifest.defaultFields) {
      const value = params[field.key];
      if (value !== undefined) baseline[field.key] = value;
    }
    return this.validateItemDefaults({ ...baseline, ...sparse });
  }

  createTimeline(input: CreateTimelineInput): TimelineData {
    const shell = timelineShellSchema.parse({
      id: input.id,
      modelId: input.modelId,
      ticksPerSecond: input.ticksPerSecond,
    });
    if (shell.modelId === undefined ? this.manifest.capabilities.generation : !this.supportsModel(shell.modelId)) {
      throw new Error(`Model ${shell.modelId} is unsupported by ${this.manifest.pluginId}`);
    }
    return {
      id: shell.id, ticksPerSecond: shell.ticksPerSecond,
      ...(shell.modelId === undefined ? {} : { modelId: shell.modelId }),
      pluginId: this.manifest.pluginId,
      pluginVersion: this.manifest.schemaVersion,
      itemIds: [],
      settings: this.validateSettings(input.settings),
      itemDefaults: {},
    };
  }

  createItem(input: CreateTimelineItemInput): TimelineItemData {
    const timeline = input.timeline;
    if (timeline.pluginId !== this.manifest.pluginId) {
      throw new Error(`Timeline ${timeline.id} belongs to a different plugin`);
    }
    if (timeline.pluginVersion !== this.manifest.schemaVersion) {
      throw new Error(`Timeline ${timeline.id} requires an explicit schema migration`);
    }
    if (timeline.modelId === undefined ? this.manifest.capabilities.generation : !this.supportsModel(timeline.modelId)) {
      throw new Error(`Model ${timeline.modelId} is unsupported by ${this.manifest.pluginId}`);
    }
    if (!Number.isSafeInteger(timeline.ticksPerSecond) || timeline.ticksPerSecond <= 0) {
      throw new Error('ticksPerSecond must be a positive safe integer');
    }
    this.validateSettings(timeline.settings);
    if (!this.manifest.capabilities.references && (input.referenceAssetIds?.length ?? 0) > 0) {
      throw new Error('This timeline does not accept media references');
    }
    if (!this.manifest.capabilities.mediaPlacement && (input.sourceOffsetTicks ?? 0) !== 0) {
      throw new Error('This timeline does not have a media source offset');
    }
    const shell = itemShellSchema.parse({
      id: input.id,
      timelineId: timeline.id,
      startTick: input.startTick,
      durationTicks: input.durationTicks,
      sourceOffsetTicks: input.sourceOffsetTicks ?? 0,
      referenceAssetIds: [...(input.referenceAssetIds ?? [])],
      generationToken: input.generationToken,
    });
    if (!Number.isSafeInteger(shell.startTick + shell.durationTicks)) {
      throw new Error('The item end tick exceeds the safe integer range');
    }
    return {
      ...shell,
      kind: this.manifest.itemKind,
      params: this.validateItemParams({ ...this.resolveItemDefaults(timeline.itemDefaults ?? {}), ...input.params }),
      ...(this.manifest.capabilities.generation ? { generationSettings: this.validateSettings(timeline.settings) } : {}),
    };
  }
}

export const videoSettingsSchema = z.strictObject({
  width: z.number().int().positive().max(16_384).default(1920),
  height: z.number().int().positive().max(16_384).default(1080),
  frameRate: z.number().positive().max(240).default(30),
});
export const videoItemParamsSchema = z.strictObject({
  prompt: z.string().max(20_000).default(''),
  negativePrompt: z.string().max(20_000).default(''),
  seed: z.number().int().nonnegative().safe().nullable().default(null),
});
export type VideoSettings = z.infer<typeof videoSettingsSchema>;
export type VideoItemParams = z.infer<typeof videoItemParamsSchema>;

/** 无网络调用的示例语义插件；example.video 是本地示例模型标识。 */
export class VideoTimelinePlugin extends BaseTimelinePlugin<VideoSettings, VideoItemParams> {
  readonly manifest: TimelinePluginManifest = {
    pluginId: 'pixel.video',
    name: 'Video timeline',
    schemaVersion: 1,
    modelIds: ['example.video'],
    capabilities: { generation: true, mediaPlacement: true, references: true },
    referenceTextFields: ['prompt'],
    itemKind: 'video.clip',
    overlapPolicy: 'reject',
    supportedActions: ['timeline.create', 'item.createDraft', 'item.create', 'item.move', 'item.resize', 'item.updateParams', 'item.delete', 'generation.submit'],
    fields: [
      { scope: 'settings', key: 'width', label: 'Width', valueType: 'number' },
      { scope: 'settings', key: 'height', label: 'Height', valueType: 'number' },
      { scope: 'settings', key: 'frameRate', label: 'Frame rate', valueType: 'number' },
      { scope: 'itemParams', key: 'prompt', label: 'Prompt', valueType: 'string' },
      { scope: 'itemParams', key: 'negativePrompt', label: 'Negative prompt', valueType: 'string' },
      { scope: 'itemParams', key: 'seed', label: 'Seed', valueType: 'number', nullable: true, description: 'null selects a random seed.' },
    ],
    defaultFields: [{ scope: 'itemParams', key: 'seed', label: 'Seed', valueType: 'number', nullable: true }],
  };
  readonly settingsSchema = videoSettingsSchema;
  readonly itemParamsSchema = videoItemParamsSchema;
  override readonly itemDefaultsSchema: z.ZodType<JsonObject> = z.strictObject({ seed: z.number().int().nonnegative().safe().nullable().optional() }) as unknown as z.ZodType<JsonObject>;
}

export const textItemParamsSchema = z.strictObject({ text: z.string().max(20_000).default('') });

/** 可编辑的本地文字使用同一时间壳与 Action，无模型调用、输出或媒体引用。 */
export class TextTimelinePlugin extends BaseTimelinePlugin {
  readonly manifest: TimelinePluginManifest = {
    pluginId: 'pixel.text', name: '纯文本时间轴', schemaVersion: 1, modelIds: [],
    description: '本地文字时间轴，用于通用笔记、分镜和提示词参考。',
    itemKind: 'text.note', overlapPolicy: 'allow',
    capabilities: { generation: false, mediaPlacement: false, references: false },
    referenceTextFields: ['text'],
    fields: [{ scope: 'itemParams', key: 'text', label: '文本', valueType: 'string', description: '记录通用笔记、分镜或提示词参考；不会自动启动模型生成。' }],
    defaultFields: [],
    supportedActions: ['timeline.create', 'timeline.delete', 'item.createDraft', 'item.move', 'item.resize', 'item.params', 'item.duplicate', 'item.delete'],
  };
  readonly settingsSchema: z.ZodType<JsonObject> = z.strictObject({});
  readonly itemParamsSchema: z.ZodType<JsonObject> = textItemParamsSchema;
}

/** 普通媒体复用同一时间壳，仅放置已验证素材，不宣称具备生成能力。 */
export class LocalMediaTimelinePlugin extends BaseTimelinePlugin {
  readonly manifest: TimelinePluginManifest;
  readonly settingsSchema: z.ZodType<JsonObject> = z.strictObject({});
  readonly itemParamsSchema: z.ZodType<JsonObject> = z.strictObject({});
  constructor(kind: MediaKind) {
    super();
    const names = { video: '普通视频', audio: '普通音频', image: '普通图片' };
    this.manifest = {
      pluginId: `pixel.${kind}.local`, name: names[kind], description: `放置已有${names[kind].slice(2)}素材，保留真实媒体输出。`,
      outputKind: kind, schemaVersion: 1, modelIds: [], itemKind: `${kind}.local`,
      overlapPolicy: kind === 'audio' ? 'allow' : 'reject',
      capabilities: { generation: false, mediaPlacement: true, references: false }, referenceTextFields: [],
      fields: [], defaultFields: [],
      supportedActions: ['timeline.create', 'timeline.delete', 'item.create', 'item.move', 'item.resize', 'item.duplicate', 'item.delete', 'asset.saveFromItem'],
    };
  }
}
