import { z } from 'zod';
import type { DeepReadonly, JsonObject, JsonValue, TimelineData, TimelineItemData } from './contracts.js';

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
  /** 对应持久化 TimelineData.pluginVersion；不是插件安装包的版本号。 */
  schemaVersion: number;
  modelIds: readonly string[];
  itemKind: string;
  fields: readonly PluginFieldDeclaration[];
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
  modelId: string;
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
  supportsModel(modelId: string): boolean;
  validateSettings(settings: unknown): TSettings;
  validateItemParams(params: unknown): TParams;
  createTimeline(input: CreateTimelineInput): TimelineData;
  createItem(input: CreateTimelineItemInput): TimelineItemData;
}

const timelineShellSchema = z.strictObject({
  id: z.string().min(1),
  modelId: z.string().min(1),
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

  supportsModel(modelId: string): boolean {
    return this.manifest.modelIds.includes(modelId);
  }

  validateSettings(settings: unknown): TSettings {
    return this.settingsSchema.parse(settings);
  }

  validateItemParams(params: unknown): TParams {
    return this.itemParamsSchema.parse(params);
  }

  createTimeline(input: CreateTimelineInput): TimelineData {
    const shell = timelineShellSchema.parse({
      id: input.id,
      modelId: input.modelId,
      ticksPerSecond: input.ticksPerSecond,
    });
    if (!this.supportsModel(shell.modelId)) {
      throw new Error(`Model ${shell.modelId} is unsupported by ${this.manifest.pluginId}`);
    }
    return {
      ...shell,
      pluginId: this.manifest.pluginId,
      pluginVersion: this.manifest.schemaVersion,
      itemIds: [],
      settings: this.validateSettings(input.settings),
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
    if (!this.supportsModel(timeline.modelId)) {
      throw new Error(`Model ${timeline.modelId} is unsupported by ${this.manifest.pluginId}`);
    }
    if (!Number.isSafeInteger(timeline.ticksPerSecond) || timeline.ticksPerSecond <= 0) {
      throw new Error('ticksPerSecond must be a positive safe integer');
    }
    this.validateSettings(timeline.settings);
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
      params: this.validateItemParams(input.params),
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
    itemKind: 'video.clip',
    overlapPolicy: 'reject',
    supportedActions: ['timeline.create', 'item.create', 'item.move', 'item.resize', 'item.updateParams', 'item.delete', 'generation.submit'],
    fields: [
      { scope: 'settings', key: 'width', label: 'Width', valueType: 'number' },
      { scope: 'settings', key: 'height', label: 'Height', valueType: 'number' },
      { scope: 'settings', key: 'frameRate', label: 'Frame rate', valueType: 'number' },
      { scope: 'itemParams', key: 'prompt', label: 'Prompt', valueType: 'string' },
      { scope: 'itemParams', key: 'negativePrompt', label: 'Negative prompt', valueType: 'string' },
      { scope: 'itemParams', key: 'seed', label: 'Seed', valueType: 'number', nullable: true, description: 'null selects a random seed.' },
    ],
  };
  readonly settingsSchema = videoSettingsSchema;
  readonly itemParamsSchema = videoItemParamsSchema;
}
