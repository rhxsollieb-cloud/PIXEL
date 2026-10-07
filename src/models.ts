import { z } from 'zod';
import type {
  DeepReadonly, GenerationRequest, JsonObject, MediaKind,
} from './contracts.js';
import {
  BaseTimelinePlugin,
  type CreateTimelineInput,
  type PluginFieldDeclaration,
  type TimelinePluginManifest,
} from './plugins.js';
import { ProviderError } from './generation.js';

const speechMp3Formats = [
  'mp3_22050_32', 'mp3_24000_48', 'mp3_44100_32', 'mp3_44100_64',
  'mp3_44100_96', 'mp3_44100_128', 'mp3_44100_192',
] as const;
const musicMp3Formats = [
  ...speechMp3Formats, 'mp3_48000_128', 'mp3_48000_192', 'mp3_48000_240', 'mp3_48000_320',
] as const;
export const speechSettingsSchema = z.strictObject({});
export const soundEffectSettingsSchema = speechSettingsSchema;
export const musicSettingsSchema = speechSettingsSchema;

/** v4 只支持这两个 voice settings；其余模型的 style/speed 不在本模型能力中。 */
export const speechVoiceSettingsSchema = z.strictObject({
  stability: z.number().min(0).max(1).default(0.5),
  similarityBoost: z.number().min(0).max(1).default(0.75),
});
export const speechParamsSchema = z.strictObject({
  outputFormat: z.enum(speechMp3Formats).default('mp3_44100_128'),
  text: z.string().max(10_000).default(''),
  voiceId: z.string().max(200).default(''),
  languageCode: z.string().regex(/^[a-z]{2,3}$/).nullable().default(null),
  seed: z.number().int().min(0).max(4_294_967_295).nullable().default(null),
  voiceSettings: speechVoiceSettingsSchema.nullable().default(null),
});
export const speechGenerationParamsSchema = speechParamsSchema.superRefine((params, context) => {
  if (params.text.trim().length === 0) context.addIssue({ code: 'custom', path: ['text'], message: 'Speech text is required' });
  if (params.voiceId.trim().length === 0) context.addIssue({ code: 'custom', path: ['voiceId'], message: 'A voiceId is required' });
});

export const soundEffectParamsSchema = z.strictObject({
  outputFormat: z.enum(speechMp3Formats).default('mp3_44100_128'),
  text: z.string().max(20_000).default(''),
  durationSeconds: z.number().min(0.5).max(30).nullable().default(null),
  promptInfluence: z.number().min(0).max(1).default(0.3),
  loop: z.boolean().default(false),
});
export const soundEffectGenerationParamsSchema = soundEffectParamsSchema.refine(
  params => params.text.trim().length > 0,
  { path: ['text'], message: 'A sound effect prompt is required' },
);

export const musicGenerationChunkSchema = z.strictObject({
  text: z.string().max(6_132).default(''),
  durationMs: z.number().int().min(3_000).max(120_000),
  positiveStyles: z.array(z.string().min(1).max(200)).max(50),
  negativeStyles: z.array(z.string().min(1).max(200)).max(50).default([]),
  contextAdherence: z.enum(['low', 'medium', 'high']).default('high'),
}).superRefine((chunk, context) => {
  const lines = chunk.text.split(/\r?\n/);
  if (lines.length > 30 || lines.some(line => line.length > 200)) {
    context.addIssue({ code: 'custom', path: ['text'], message: 'Chunk text allows at most 30 lines and 200 characters per line' });
  }
});
/** 本次只支持生成型 chunks，uploaded songId/conditioningRef 不能绕过 Asset 引用边界。 */
export const musicCompositionPlanSchema = z.strictObject({
  chunks: z.array(musicGenerationChunkSchema).min(1).max(30),
}).superRefine((plan, context) => {
  const duration = plan.chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0);
  if (duration > 600_000) context.addIssue({ code: 'custom', path: ['chunks'], message: 'The composition plan must not exceed 600000 ms' });
});
export const musicParamsSchema = z.strictObject({
  outputFormat: z.enum(musicMp3Formats).default('mp3_48000_192'),
  prompt: z.string().max(4_100).default(''),
  compositionPlan: musicCompositionPlanSchema.nullable().default(null),
  musicLengthMs: z.number().int().min(3_000).max(600_000).nullable().default(null),
  forceInstrumental: z.boolean().default(false),
  seed: z.number().int().min(0).max(2_147_483_647).nullable().default(null),
  finetuneId: z.string().min(1).max(100).nullable().default(null),
}).superRefine((params, context) => {
  if (params.compositionPlan !== null) {
    if (params.prompt !== '') context.addIssue({ code: 'custom', path: ['prompt'], message: 'prompt and compositionPlan are mutually exclusive' });
    if (params.musicLengthMs !== null) context.addIssue({ code: 'custom', path: ['musicLengthMs'], message: 'musicLengthMs only applies to prompt mode' });
    if (params.forceInstrumental) context.addIssue({ code: 'custom', path: ['forceInstrumental'], message: 'forceInstrumental only applies to prompt mode' });
  } else if (params.seed !== null) {
    context.addIssue({ code: 'custom', path: ['seed'], message: 'seed only applies to compositionPlan mode' });
  }
});
export const musicGenerationParamsSchema = musicParamsSchema.refine(
  params => params.compositionPlan !== null || params.prompt.trim().length > 0,
  { path: ['prompt'], message: 'A music prompt or compositionPlan is required' },
);

const wanAspectRatios = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;
const grokAspectRatios = [
  '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '9:19.5',
  '19.5:9', '9:20', '20:9', '1:2', '2:1', 'auto',
] as const;
export const wanSettingsSchema = z.strictObject({
  resolution: z.enum(['480p', '720p', '1080p']).default('720p'),
  aspectRatio: z.enum(wanAspectRatios).default('16:9'),
});
export const wanParamsSchema = z.strictObject({
  prompt: z.string().max(20_000).default(''),
  durationSeconds: z.number().int().min(2).max(30).default(5),
  generateAudio: z.boolean().default(true),
  seed: z.number().int().nonnegative().safe().nullable().default(null),
  referenceMode: z.enum(['reference', 'firstFrame']).default('reference'),
});
export const wanGenerationParamsSchema = wanParamsSchema.refine(
  params => params.prompt.trim().length > 0,
  { path: ['prompt'], message: 'A video prompt is required' },
);
export const grokImageSettingsSchema = z.strictObject({
  resolution: z.enum(['1K', '2K']).default('1K'),
  quality: z.enum(['low', 'medium']).default('low'),
  aspectRatio: z.enum(grokAspectRatios).default('1:1'),
});
export const grokImageParamsSchema = z.strictObject({
  prompt: z.string().max(20_000).default(''),
});
export const grokImageGenerationParamsSchema = grokImageParamsSchema.refine(
  params => params.prompt.trim().length > 0,
  { path: ['prompt'], message: 'An image prompt is required' },
);

export interface ModelDescriptor {
  modelId: string;
  aliases: readonly string[];
  providerId: 'elevenlabs' | 'openrouter';
  providerVersion: '1';
  pluginId: string;
  itemKind: string;
  title: string;
  description: string;
  outputKind: MediaKind;
  generationDuration: 'natural' | 'parameter' | 'still';
  referenceKinds: readonly MediaKind[];
  maxReferences: number;
  referenceLimitSource: 'endpoint' | 'host';
  fields: readonly PluginFieldDeclaration[];
  settingsSchema: z.ZodType<JsonObject>;
  paramsSchema: z.ZodType<JsonObject>;
  generationParamsSchema: z.ZodType<JsonObject>;
}

const settingsOutputField = (formats: readonly string[]): PluginFieldDeclaration => ({
  scope: 'itemParams', key: 'outputFormat', label: 'Output format', valueType: 'enum',
  options: formats.map(value => ({ value, label: value })),
});
const promptField = (key = 'prompt'): PluginFieldDeclaration => ({
  scope: 'itemParams', key, label: key === 'text' ? 'Text' : 'Prompt', valueType: 'string',
});
const seedField: PluginFieldDeclaration = {
  scope: 'itemParams', key: 'seed', label: 'Seed', valueType: 'number', nullable: true,
  description: 'null requests a random seed; a fixed seed does not guarantee reproducibility.',
};
const enumField = (scope: 'settings' | 'itemParams', key: string, label: string, values: readonly string[]): PluginFieldDeclaration => ({
  scope, key, label, valueType: 'enum', options: values.map(value => ({ value, label: value })),
});
const supportedActions = [
  'timeline.create', 'item.create', 'item.move', 'item.resize', 'item.updateParams',
  'item.delete', 'generation.submit',
] as const;

export const builtinModelDescriptors: readonly ModelDescriptor[] = [
  {
    modelId: 'eleven_v4', aliases: [], providerId: 'elevenlabs', providerVersion: '1',
    pluginId: 'pixel.elevenlabs.speech', itemKind: 'audio.speech', title: 'Eleven v4',
    description: 'Generate speech from text and a selected voice; length follows the spoken text.',
    outputKind: 'audio', generationDuration: 'natural', referenceKinds: [], maxReferences: 0, referenceLimitSource: 'endpoint',
    settingsSchema: speechSettingsSchema, paramsSchema: speechParamsSchema, generationParamsSchema: speechGenerationParamsSchema,
    fields: [
      settingsOutputField(speechMp3Formats), promptField('text'),
      { scope: 'itemParams', key: 'voiceId', label: 'Voice', valueType: 'string' },
      { scope: 'itemParams', key: 'languageCode', label: 'Language code', valueType: 'string', nullable: true },
      seedField,
      { scope: 'itemParams', key: 'voiceSettings', label: 'Voice settings', valueType: 'object', nullable: true,
        description: 'null uses the selected voice settings.', children: [
          { scope: 'itemParams', key: 'stability', label: 'Stability', valueType: 'number' },
          { scope: 'itemParams', key: 'similarityBoost', label: 'Similarity', valueType: 'number' },
        ] },
    ],
  },
  {
    modelId: 'eleven_text_to_sound_v2', aliases: ['eleven_text_sound_v2'], providerId: 'elevenlabs', providerVersion: '1',
    pluginId: 'pixel.elevenlabs.sound', itemKind: 'audio.soundEffect', title: 'Eleven Sound Effects v2',
    description: 'Generate sound effects, optionally with a chosen length or a seamless loop.',
    outputKind: 'audio', generationDuration: 'parameter', referenceKinds: [], maxReferences: 0, referenceLimitSource: 'endpoint',
    settingsSchema: soundEffectSettingsSchema, paramsSchema: soundEffectParamsSchema, generationParamsSchema: soundEffectGenerationParamsSchema,
    fields: [
      settingsOutputField(speechMp3Formats), promptField('text'),
      { scope: 'itemParams', key: 'durationSeconds', label: 'Duration (seconds)', valueType: 'number', nullable: true, description: 'null lets the model choose a length.' },
      { scope: 'itemParams', key: 'promptInfluence', label: 'Prompt influence', valueType: 'number' },
      { scope: 'itemParams', key: 'loop', label: 'Loop', valueType: 'boolean' },
    ],
  },
  {
    modelId: 'music_v2_5', aliases: [], providerId: 'elevenlabs', providerVersion: '1',
    pluginId: 'pixel.elevenlabs.music', itemKind: 'audio.music', title: 'Eleven Music v2.5',
    description: 'Compose music from a prompt or a sequence of generation chunks.',
    outputKind: 'audio', generationDuration: 'parameter', referenceKinds: [], maxReferences: 0, referenceLimitSource: 'endpoint',
    settingsSchema: musicSettingsSchema, paramsSchema: musicParamsSchema, generationParamsSchema: musicGenerationParamsSchema,
    fields: [
      settingsOutputField(musicMp3Formats), promptField(),
      { scope: 'itemParams', key: 'compositionPlan', label: 'Composition plan', valueType: 'object', nullable: true, children: [
        { scope: 'itemParams', key: 'chunks', label: 'Chunks', valueType: 'array', children: [
          promptField('text'),
          { scope: 'itemParams', key: 'durationMs', label: 'Duration (milliseconds)', valueType: 'number' },
          { scope: 'itemParams', key: 'positiveStyles', label: 'Desired styles', valueType: 'array' },
          { scope: 'itemParams', key: 'negativeStyles', label: 'Excluded styles', valueType: 'array' },
          enumField('itemParams', 'contextAdherence', 'Context adherence', ['low', 'medium', 'high']),
        ] },
      ] },
      { scope: 'itemParams', key: 'musicLengthMs', label: 'Music length (milliseconds)', valueType: 'number', nullable: true,
        visibleWhen: { field: 'compositionPlan', equals: null }, description: 'null lets the model choose the length in prompt mode.' },
      { scope: 'itemParams', key: 'forceInstrumental', label: 'Instrumental', valueType: 'boolean', visibleWhen: { field: 'compositionPlan', equals: null } },
      { ...seedField, description: 'Only applies to compositionPlan mode; null requests a random seed.' },
      { scope: 'itemParams', key: 'finetuneId', label: 'Music finetune', valueType: 'string', nullable: true },
    ],
  },
  {
    modelId: 'alibaba/wan-3.0', aliases: [], providerId: 'openrouter', providerVersion: '1',
    pluginId: 'pixel.openrouter.wan', itemKind: 'video.generated', title: 'Alibaba: Wan 3.0',
    description: 'Generate video from text, first-frame input or reference images.',
    outputKind: 'video', generationDuration: 'parameter', referenceKinds: ['image'], maxReferences: 3, referenceLimitSource: 'host',
    settingsSchema: wanSettingsSchema, paramsSchema: wanParamsSchema, generationParamsSchema: wanGenerationParamsSchema,
    fields: [
      enumField('settings', 'resolution', 'Resolution', ['480p', '720p', '1080p']),
      enumField('settings', 'aspectRatio', 'Aspect ratio', wanAspectRatios), promptField(),
      { scope: 'itemParams', key: 'durationSeconds', label: 'Duration (seconds)', valueType: 'number' },
      { scope: 'itemParams', key: 'generateAudio', label: 'Generate audio', valueType: 'boolean' },
      seedField, enumField('itemParams', 'referenceMode', 'Reference role', ['reference', 'firstFrame']),
    ],
  },
  {
    modelId: 'x-ai/grok-imagine-image-2.0', aliases: [], providerId: 'openrouter', providerVersion: '1',
    pluginId: 'pixel.openrouter.grokImage', itemKind: 'image.generated', title: 'Grok Imagine Image 2.0',
    description: 'Generate or edit one image using a prompt and up to three reference images.',
    outputKind: 'image', generationDuration: 'still', referenceKinds: ['image'], maxReferences: 3, referenceLimitSource: 'endpoint',
    settingsSchema: grokImageSettingsSchema, paramsSchema: grokImageParamsSchema, generationParamsSchema: grokImageGenerationParamsSchema,
    fields: [
      enumField('settings', 'resolution', 'Resolution', ['1K', '2K']),
      enumField('settings', 'quality', 'Quality', ['low', 'medium']),
      enumField('settings', 'aspectRatio', 'Aspect ratio', grokAspectRatios), promptField(),
    ],
  },
];

export interface ModelDeclaration {
  modelId: string;
  aliases: string[];
  providerId: string;
  providerVersion: string;
  pluginId: string;
  itemKind: string;
  title: string;
  description: string;
  outputKind: MediaKind;
  generationDuration: ModelDescriptor['generationDuration'];
  referenceKinds: MediaKind[];
  maxReferences: number;
  referenceLimitSource: ModelDescriptor['referenceLimitSource'];
  fields: PluginFieldDeclaration[];
  settingsJsonSchema: JsonObject;
  paramsJsonSchema: JsonObject;
  generationParamsJsonSchema: JsonObject;
}

export const modelQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(20).default(5),
  cursor: z.string().regex(/^\d+$/).max(10).optional(),
  exclude: z.array(z.string().min(1).max(200)).max(20).default([]),
  providerId: z.enum(['elevenlabs', 'openrouter']).optional(),
  outputKind: z.enum(['audio', 'video', 'image']).optional(),
  search: z.string().max(200).optional(),
});
export type ModelQuery = z.infer<typeof modelQuerySchema>;
export interface ModelPage { items: ModelDeclaration[]; nextCursor?: string; }

export class ModelRegistry {
  readonly #models = new Map<string, ModelDescriptor>();
  readonly #aliases = new Map<string, string>();

  constructor(descriptors: readonly ModelDescriptor[] = builtinModelDescriptors) {
    for (const descriptor of descriptors) {
      if (this.#models.has(descriptor.modelId) || this.#aliases.has(descriptor.modelId)) throw new Error(`Duplicate model ID ${descriptor.modelId}`);
      this.#models.set(descriptor.modelId, descriptor);
      for (const alias of descriptor.aliases) {
        if (this.#models.has(alias) || this.#aliases.has(alias)) throw new Error(`Duplicate model alias ${alias}`);
        this.#aliases.set(alias, descriptor.modelId);
      }
    }
  }

  resolve(modelId: string): ModelDescriptor {
    const descriptor = this.#models.get(this.#aliases.get(modelId) ?? modelId);
    if (descriptor === undefined) throw new ProviderError('UNSUPPORTED_MODEL', 'Unknown model ID');
    return descriptor;
  }

  describe(modelId: string): ModelDeclaration {
    const descriptor = this.resolve(modelId);
    const { settingsSchema, paramsSchema, generationParamsSchema, ...declaration } = descriptor;
    const generationJson = z.toJSONSchema(generationParamsSchema) as JsonObject;
    // Custom cross-field checks remain enforced by prepareRequest and are also discoverable.
    if (descriptor.modelId === 'music_v2_5') {
      generationJson.allOf = [{ oneOf: [
        { properties: { compositionPlan: { type: 'null' }, seed: { type: 'null' }, prompt: { type: 'string', minLength: 1 } } },
        { properties: { compositionPlan: { type: 'object' }, prompt: { const: '' }, musicLengthMs: { type: 'null' }, forceInstrumental: { const: false } } },
      ] }];
    } else {
      const properties = generationJson.properties as JsonObject;
      const requiredKey = descriptor.modelId === 'eleven_v4' || descriptor.modelId === 'eleven_text_to_sound_v2' ? 'text' : 'prompt';
      const field = properties[requiredKey] as JsonObject;
      field.minLength = 1;
      field.pattern = '\\S';
      if (descriptor.modelId === 'eleven_v4') {
        (properties.voiceId as JsonObject).minLength = 1;
        (properties.voiceId as JsonObject).pattern = '\\S';
      }
    }
    return structuredClone({
      ...declaration,
      settingsJsonSchema: z.toJSONSchema(settingsSchema) as JsonObject,
      paramsJsonSchema: z.toJSONSchema(paramsSchema) as JsonObject,
      generationParamsJsonSchema: generationJson,
    }) as ModelDeclaration;
  }

  query(input: z.input<typeof modelQuerySchema> = {}): ModelPage {
    const query = modelQuerySchema.parse(input);
    const excluded = new Set(query.exclude.map(id => this.#aliases.get(id) ?? id));
    const search = query.search?.toLowerCase();
    const descriptors = [...this.#models.values()].filter(descriptor => !excluded.has(descriptor.modelId)
      && (query.providerId === undefined || descriptor.providerId === query.providerId)
      && (query.outputKind === undefined || descriptor.outputKind === query.outputKind)
      && (search === undefined || `${descriptor.modelId} ${descriptor.title} ${descriptor.description}`.toLowerCase().includes(search)));
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    if (!Number.isSafeInteger(offset) || offset > descriptors.length) throw new Error('Invalid model query cursor');
    const items = descriptors.slice(offset, offset + query.limit).map(descriptor => this.describe(descriptor.modelId));
    const nextCursor = offset + items.length < descriptors.length ? String(offset + items.length) : undefined;
    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  /** 同一个执行边界供 GUI/CLI/Agent 和 SDK providers 使用；不访问凭证或项目状态。 */
  prepareRequest(request: DeepReadonly<GenerationRequest>): GenerationRequest {
    const descriptor = this.resolve(request.modelId);
    if (request.providerId !== descriptor.providerId || request.providerVersion !== descriptor.providerVersion) throw new ProviderError('UNSUPPORTED_MODEL', 'The model does not match this provider contract');
    if (request.durationMs !== undefined && (!Number.isSafeInteger(request.durationMs) || request.durationMs <= 0)) throw new ProviderError('INVALID_INPUT', 'durationMs must be a positive safe integer');
    const paramsInput = structuredClone(request.params) as JsonObject;
    if (request.durationMs !== undefined) {
      if (descriptor.generationDuration !== 'parameter') throw new ProviderError('INVALID_INPUT', 'This model does not accept a fixed generation duration');
      if (descriptor.modelId === 'eleven_text_to_sound_v2' && (paramsInput.durationSeconds === undefined || paramsInput.durationSeconds === null)) paramsInput.durationSeconds = request.durationMs / 1000;
      if (descriptor.modelId === 'music_v2_5' && (paramsInput.compositionPlan === undefined || paramsInput.compositionPlan === null)
        && (paramsInput.musicLengthMs === undefined || paramsInput.musicLengthMs === null)) paramsInput.musicLengthMs = request.durationMs;
    }
    const params = descriptor.generationParamsSchema.parse(paramsInput);
    const settings = descriptor.settingsSchema.parse(request.settings ?? {});
    const references = structuredClone(request.references) as GenerationRequest['references'];
    if (references.length > descriptor.maxReferences) throw new ProviderError('UNSUPPORTED_REFERENCE', 'The model reference asset limit was exceeded');
    if (new Set(references.map(reference => reference.id)).size !== references.length) throw new ProviderError('UNSUPPORTED_REFERENCE', 'Reference asset IDs must be unique');
    for (const reference of references) {
      if (!descriptor.referenceKinds.includes(reference.kind)) throw new ProviderError('UNSUPPORTED_REFERENCE', 'The model does not accept this reference media kind');
      if (reference.role !== undefined && !['reference', 'first-frame', 'last-frame'].includes(reference.role)) throw new ProviderError('UNSUPPORTED_REFERENCE', 'Unknown generation reference role');
      if (reference.role === 'last-frame') throw new ProviderError('UNSUPPORTED_REFERENCE', 'This model does not support last-frame references');
      if (descriptor.outputKind === 'image' && reference.role === 'first-frame') throw new ProviderError('UNSUPPORTED_REFERENCE', 'Image generation does not have frame reference roles');
    }
    if (descriptor.modelId === 'alibaba/wan-3.0') {
      const firstFrame = params.referenceMode === 'firstFrame';
      if (firstFrame && references.length !== 1) throw new ProviderError('UNSUPPORTED_REFERENCE', 'firstFrame mode requires exactly one image reference');
      if (references.some(reference => firstFrame ? reference.role === 'reference' : reference.role === 'first-frame')) throw new ProviderError('UNSUPPORTED_REFERENCE', 'Reference roles must match referenceMode');
    }
    let durationMs: number | undefined;
    if (descriptor.modelId === 'eleven_text_to_sound_v2' && typeof params.durationSeconds === 'number') durationMs = Math.round(params.durationSeconds * 1000);
    if (descriptor.modelId === 'music_v2_5') {
      const musicParams = musicGenerationParamsSchema.parse(params);
      if (musicParams.compositionPlan !== null) durationMs = musicParams.compositionPlan.chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0);
      else if (musicParams.musicLengthMs !== null) durationMs = musicParams.musicLengthMs;
    }
    if (descriptor.modelId === 'alibaba/wan-3.0') durationMs = (params.durationSeconds as number) * 1000;
    if (request.durationMs !== undefined && durationMs !== request.durationMs) throw new ProviderError('INVALID_INPUT', 'durationMs must match the model generation duration');
    const prepared = structuredClone(request) as GenerationRequest;
    prepared.modelId = descriptor.modelId;
    prepared.params = params;
    prepared.settings = settings;
    prepared.references = references;
    if (durationMs !== undefined) prepared.durationMs = durationMs;
    return prepared;
  }

  createPlugin(modelId: string): ModelTimelinePlugin { return new ModelTimelinePlugin(this.resolve(modelId)); }
}

/** 一种模型对应一种语义插件；仍使用宿主统一的字段、菜单、Action 和时间壳。 */
export class ModelTimelinePlugin extends BaseTimelinePlugin {
  readonly manifest: TimelinePluginManifest;
  readonly settingsSchema: z.ZodType<JsonObject>;
  readonly itemParamsSchema: z.ZodType<JsonObject>;

  constructor(readonly descriptor: ModelDescriptor) {
    super();
    this.manifest = {
      pluginId: descriptor.pluginId, name: descriptor.title, schemaVersion: 1,
      modelIds: [descriptor.modelId, ...descriptor.aliases], itemKind: descriptor.itemKind,
      fields: descriptor.fields, supportedActions, overlapPolicy: 'reject',
    };
    this.settingsSchema = descriptor.settingsSchema;
    this.itemParamsSchema = descriptor.paramsSchema;
  }

  override createTimeline(input: CreateTimelineInput) {
    if (!this.supportsModel(input.modelId)) return super.createTimeline(input);
    return super.createTimeline({ ...input, modelId: this.descriptor.modelId });
  }
}

export const modelRegistry = new ModelRegistry();
