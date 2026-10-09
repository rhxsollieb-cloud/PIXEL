import { z } from 'zod';
import type { DeepReadonly, JsonObject, JsonValue, MediaKind, TimelineData } from './contracts.js';
import { ModelRegistry, modelRegistry, type ModelDeclaration } from './models.js';
import { LocalMediaTimelinePlugin, TextTimelinePlugin, type PluginFieldDeclaration, type TimelinePlugin } from './plugins.js';
import { DomainError } from './backend.js';

/** 时间线目录描述本地语义和生成语义；SDK 模型目录继续只描述可生成模型。 */
export interface TimelineDeclaration {
  typeId: string;
  mode: 'local' | 'generated';
  pluginId: string;
  schemaVersion: number;
  title: string;
  description: string;
  draftTitle?: string;
  itemKind: string;
  capabilities: { generation: boolean; mediaPlacement: boolean; references: boolean };
  supportedActions: string[];
  referenceTextFields: string[];
  requiredTextFields?: readonly string[];
  overlapPolicy: 'allow' | 'reject';
  fields: PluginFieldDeclaration[];
  defaultFields: PluginFieldDeclaration[];
  settingsJsonSchema: JsonObject;
  paramsJsonSchema: JsonObject;
  defaultsJsonSchema: JsonObject;
  paramsDefaults: JsonObject;
  settingsDefaults: JsonObject;
  modelId?: string;
  aliases?: string[];
  providerId?: string;
  providerVersion?: string;
  outputKind?: MediaKind;
  generationDuration?: ModelDeclaration['generationDuration'];
  generationParamsJsonSchema?: JsonObject;
  contextMaxCharacters?: number;
  referenceKinds: MediaKind[];
  maxReferences: number;
  referenceMaxBytes?: number;
  referenceLimits?: readonly { field: string; equals: JsonValue; maximum: number; minimum?: number }[];
  referenceLimitSource?: ModelDeclaration['referenceLimitSource'];
}

export const timelineTypeQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(20).default(5),
  cursor: z.string().regex(/^\d+$/).max(10).optional(),
  exclude: z.array(z.string().min(1).max(200)).max(20).default([]),
  mode: z.enum(['local', 'generated']).optional(),
  providerId: z.string().min(1).max(200).optional(),
  outputKind: z.enum(['audio', 'video', 'image']).optional(),
  search: z.string().max(200).optional(),
});
export type TimelineTypeQuery = z.infer<typeof timelineTypeQuerySchema>;
export interface TimelineTypePage { items: TimelineDeclaration[]; nextCursor?: string; }

export { referenceLimit, referenceMinimum } from './reference-policy.js';

export class TimelineRegistry {
  private readonly local = new Map<string, TimelinePlugin>();
  constructor(readonly models: ModelRegistry = modelRegistry, localPlugins: readonly TimelinePlugin[] = [new TextTimelinePlugin(), new LocalMediaTimelinePlugin('video'), new LocalMediaTimelinePlugin('audio'), new LocalMediaTimelinePlugin('image')]) {
    for (const plugin of localPlugins) {
      if (plugin.manifest.capabilities.generation || plugin.manifest.modelIds.length !== 0) throw new Error('Local timeline plugins cannot declare generation models');
      if (this.local.has(plugin.manifest.pluginId) || this.generated().some(model => model.modelId === plugin.manifest.pluginId || model.aliases.includes(plugin.manifest.pluginId))) throw new Error('Duplicate timeline type ID');
      this.local.set(plugin.manifest.pluginId, plugin);
    }
  }
  private generated(): ModelDeclaration[] {
    const result: ModelDeclaration[] = [];
    let cursor: string | undefined;
    do {
      const page = this.models.query({ limit: 20, ...(cursor === undefined ? {} : { cursor }) });
      result.push(...page.items); cursor = page.nextCursor;
    } while (cursor !== undefined);
    return result;
  }
  createPlugin(typeId: string): TimelinePlugin {
    return this.local.get(typeId) ?? this.models.createPlugin(typeId);
  }
  /** 以插件身份和模型身份共同解析，不把缺失模型默认为某个供应商。 */
  forTimeline(timeline: DeepReadonly<TimelineData>): TimelinePlugin {
    const local = this.local.get(timeline.pluginId);
    if (local && timeline.modelId !== undefined) throw new DomainError('INVALID_INPUT', '本地时间线不能声明生成模型');
    if (!local && timeline.modelId === undefined) throw new DomainError('INVALID_INPUT', '生成时间线缺少模型标识');
    const plugin = local ?? this.models.createPlugin(timeline.modelId!);
    if (timeline.pluginId !== plugin.manifest.pluginId || timeline.pluginVersion !== plugin.manifest.schemaVersion) throw new DomainError('NOT_APPLICABLE', '该时间线需要显式插件版本迁移后才能编辑');
    return plugin;
  }
  describe(typeId: string): TimelineDeclaration {
    const plugin = this.createPlugin(typeId);
    const manifest = plugin.manifest;
    const shared = {
      typeId, pluginId: manifest.pluginId, schemaVersion: manifest.schemaVersion,
      title: manifest.name, itemKind: manifest.itemKind, capabilities: manifest.capabilities,
      supportedActions: [...manifest.supportedActions], referenceTextFields: [...manifest.referenceTextFields], overlapPolicy: manifest.overlapPolicy,
    };
    if (manifest.capabilities.generation) {
      const model = this.models.describe(typeId);
      return structuredClone({ ...model, ...shared, typeId: model.modelId, mode: 'generated', draftTitle: '新建生成草稿' });
    }
    return structuredClone({
      ...shared, mode: 'local', description: manifest.description ?? manifest.name,
      ...(manifest.outputKind === undefined ? {} : { outputKind: manifest.outputKind }),
      ...(manifest.supportedActions.includes('item.createDraft') ? { draftTitle: '新建文本片段' } : {}),
      fields: [...manifest.fields], defaultFields: [...(manifest.defaultFields ?? [])],
      settingsJsonSchema: z.toJSONSchema(plugin.settingsSchema) as JsonObject,
      paramsJsonSchema: z.toJSONSchema(plugin.itemParamsSchema) as JsonObject,
      defaultsJsonSchema: z.toJSONSchema(plugin.itemDefaultsSchema) as JsonObject,
      paramsDefaults: plugin.validateItemParams({}), settingsDefaults: plugin.validateSettings({}),
      referenceKinds: [], maxReferences: 0,
    });
  }
  query(input: z.input<typeof timelineTypeQuerySchema> = {}): TimelineTypePage {
    const query = timelineTypeQuerySchema.parse(input);
    const excluded = new Set(query.exclude);
    const search = query.search?.toLowerCase();
    const declarations = [...this.local.keys(), ...this.generated().map(model => model.modelId)].map(id => this.describe(id)).filter(declaration =>
      !excluded.has(declaration.typeId) && !(declaration.aliases ?? []).some(alias => excluded.has(alias))
      && (query.mode === undefined || query.mode === declaration.mode)
      && (query.providerId === undefined || query.providerId === declaration.providerId)
      && (query.outputKind === undefined || query.outputKind === declaration.outputKind)
      && (search === undefined || `${declaration.typeId} ${declaration.title} ${declaration.description}`.toLowerCase().includes(search)));
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    if (!Number.isSafeInteger(offset) || offset > declarations.length) throw new DomainError('INVALID_INPUT', '时间线查询游标无效');
    const items = declarations.slice(offset, offset + query.limit);
    const nextCursor = offset + items.length < declarations.length ? String(offset + items.length) : undefined;
    return nextCursor === undefined ? { items } : { items, nextCursor };
  }
}

export const timelineRegistry = new TimelineRegistry();
