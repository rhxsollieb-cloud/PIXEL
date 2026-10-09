import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationReference, GenerationRequest, JsonObject } from '../src/contracts.js';
import { ProviderError, referenceDataUrl, type ProviderRunContext } from '../src/generation.js';
import { MAX_IMAGE_REFERENCE_BYTES } from '../src/reference-policy.js';
import { TimelineRegistry } from '../src/timeline-catalog.js';
import {
  builtinModelDescriptors, grokImageSettingsSchema, modelRegistry, ModelRegistry,
  musicGenerationParamsSchema, musicParamsSchema, speechGenerationParamsSchema,
  speechParamsSchema,
} from '../src/models.js';

function request(modelId: string, params: JsonObject): GenerationRequest {
  const descriptor = modelRegistry.resolve(modelId);
  return {
    projectId: 'project_1', targetItemId: 'item_1', generationToken: 'token_1',
    inputFingerprint: 'fingerprint_1', providerId: descriptor.providerId,
    providerVersion: descriptor.providerVersion, modelId, params, references: [],
  };
}
function image(id = 'image_1'): GenerationReference {
  return { id, kind: 'image', fileRef: `managed:${id}`, metadata: {} };
}
function code(expected: string) {
  return (error: unknown) => error instanceof ProviderError && error.code === expected;
}
const plan = {
  chunks: [
    { text: '[Intro]\nA calm piano phrase', durationMs: 5000, positiveStyles: ['calm piano'] },
    { text: '[Chorus]\nHere comes the sun', durationMs: 10000, positiveStyles: ['bright chorus'] },
  ],
};

test('五个指定模型拥有独立输出语义，音效别名只规范到同一个官方模型', () => {
  const page = modelRegistry.query();
  assert.equal(page.items.length, 5);
  assert.deepEqual(page.items.map(model => model.outputKind), ['audio', 'audio', 'audio', 'video', 'image']);
  const prepared = modelRegistry.prepareRequest(request('eleven_text_sound_v2', { text: 'rain' }));
  assert.equal(prepared.modelId, 'eleven_text_to_sound_v2');
  assert.deepEqual(prepared.params, { text: 'rain', durationSeconds: null, promptInfluence: 0.3, loop: false, outputFormat: 'mp3_44100_128' });
  assert.deepEqual(prepared.settings, {});
  assert.throws(() => modelRegistry.resolve('alibaba/wan-2.7'), code('UNSUPPORTED_MODEL'));
  assert.throws(() => modelRegistry.prepareRequest({ ...request('eleven_v4', { text: 'hello', voiceId: 'voice_1' }), providerId: 'openrouter' }), code('UNSUPPORTED_MODEL'));
});

test('同一模型目录支持有界查询、过滤、排除、继续查询且返回纯数据副本', () => {
  const first = modelRegistry.query({ limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.nextCursor, '2');
  const second = modelRegistry.query({ limit: 2, cursor: first.nextCursor! });
  assert.equal(second.nextCursor, '4');
  assert.equal(modelRegistry.query({ limit: 2, cursor: second.nextCursor! }).nextCursor, undefined);
  assert.deepEqual(modelRegistry.query({ outputKind: 'image' }).items.map(model => model.modelId), ['x-ai/grok-imagine-image-2.0']);
  assert.equal(modelRegistry.query({ providerId: 'openrouter' }).items.length, 2);
  assert.equal(modelRegistry.query({ search: 'speech' }).items.length, 1);
  assert.equal(modelRegistry.query({ exclude: ['eleven_text_sound_v2'] }).items.length, 4);
  assert.throws(() => modelRegistry.query({ limit: 21 }));
  assert.throws(() => modelRegistry.query({ cursor: '999' }), /cursor/);
  const declaration = first.items[0]!;
  declaration.fields.length = 0;
  assert.ok(modelRegistry.describe('eleven_v4').fields.length > 0);
  assert.deepEqual(JSON.parse(JSON.stringify(declaration)), declaration);
  assert.throws(() => new ModelRegistry([builtinModelDescriptors[0]!, builtinModelDescriptors[0]!]), /Duplicate/);
});

test('所有模型插件允许默认草稿，仍由同一基础类校验时间壳；生成只接受已填写参数', () => {
  for (const descriptor of builtinModelDescriptors) {
    const plugin = modelRegistry.createPlugin(descriptor.modelId);
    const timeline = plugin.createTimeline({ id: 'timeline_1', modelId: descriptor.modelId, settings: {}, ticksPerSecond: 1000 });
    const item = plugin.createItem({ timeline, id: 'item_1', startTick: 0, durationTicks: 5000, params: {}, generationToken: 'token_1' });
    assert.equal(item.kind, descriptor.itemKind);
    assert.throws(() => modelRegistry.prepareRequest(request(descriptor.modelId, item.params)));
    assert.throws(() => plugin.createItem({ timeline, id: 'bad', startTick: 0, durationTicks: 0, params: {}, generationToken: 'token_1' }));
    assert.equal(plugin.manifest.supportedActions.includes('generation.submit'), true);
  }
  const aliasTimeline = modelRegistry.createPlugin('eleven_text_sound_v2').createTimeline({
    id: 'sound', modelId: 'eleven_text_sound_v2', ticksPerSecond: 1000, settings: {},
  });
  assert.equal(aliasTimeline.modelId, 'eleven_text_to_sound_v2');
});

test('Eleven v4仅声明其支持的voice settings，并且seed的nullable含义供宿主共享', () => {
  const prepared = modelRegistry.prepareRequest(request('eleven_v4', { text: '[excited] Hello!', voiceId: 'voice_1', voiceSettings: {} }));
  assert.deepEqual(prepared.params.voiceSettings, { stability: 0.5, similarityBoost: 0.75 });
  assert.equal(prepared.params.seed, null);
  assert.equal(prepared.durationMs, undefined);
  assert.throws(() => speechParamsSchema.parse({ voiceSettings: { speed: 1.2 } }));
  assert.throws(() => speechParamsSchema.parse({ seed: 4_294_967_296 }));
  assert.throws(() => speechGenerationParamsSchema.parse({ text: '  ', voiceId: 'voice_1' }));
  assert.throws(() => speechGenerationParamsSchema.parse({ text: 'Hi', voiceId: '' }));
  assert.throws(() => modelRegistry.prepareRequest({ ...request('eleven_v4', { text: 'Hi', voiceId: 'voice_1' }), durationMs: 5000 }), code('INVALID_INPUT'));
  const seedField = modelRegistry.describe('eleven_v4').fields.find(field => field.key === 'seed');
  assert.equal(seedField?.nullable, true);
  const voiceField = modelRegistry.describe('eleven_v4').fields.find(field => field.key === 'voiceSettings');
  assert.deepEqual(voiceField?.children?.map(field => field.key), ['stability', 'similarityBoost']);
});

test('SFX和music毫秒时长经一次规范化，参数与捕获时长矛盾时拒绝', () => {
  const sound = modelRegistry.prepareRequest({ ...request('eleven_text_to_sound_v2', { text: 'rain' }), durationMs: 5500 });
  assert.equal(sound.params.durationSeconds, 5.5);
  assert.equal(sound.durationMs, 5500);
  assert.throws(() => modelRegistry.prepareRequest({ ...request('eleven_text_to_sound_v2', { text: 'rain', durationSeconds: 2 }), durationMs: 5500 }), code('INVALID_INPUT'));
  assert.throws(() => modelRegistry.prepareRequest(request('eleven_text_to_sound_v2', { text: 'rain', durationSeconds: 31 })));
  const music = modelRegistry.prepareRequest({ ...request('music_v2_5', { prompt: 'calm piano' }), durationMs: 30000 });
  assert.equal(music.params.musicLengthMs, 30000);
  assert.equal(music.params.outputFormat, 'mp3_48000_192');
  assert.equal(modelRegistry.prepareRequest(request('music_v2_5', { prompt: 'calm piano' })).durationMs, undefined);
  assert.throws(() => modelRegistry.prepareRequest(request('music_v2_5', { prompt: 'calm piano', musicLengthMs: 2999 })));
});

test('music生成chunks计划严格遵守时长及prompt互斥；上传与引用型chunks不能被忽略', () => {
  const prepared = modelRegistry.prepareRequest(request('music_v2_5', { compositionPlan: plan, seed: 42 }));
  assert.equal(prepared.durationMs, 15000);
  assert.equal(musicGenerationParamsSchema.parse(prepared.params).compositionPlan?.chunks[0]?.contextAdherence, 'high');
  assert.throws(() => musicParamsSchema.parse({ prompt: 'piano', seed: 1 }));
  assert.throws(() => musicParamsSchema.parse({ prompt: 'piano', compositionPlan: plan }));
  assert.throws(() => musicParamsSchema.parse({ compositionPlan: plan, musicLengthMs: 15000 }));
  assert.throws(() => musicParamsSchema.parse({ compositionPlan: plan, forceInstrumental: true }));
  assert.throws(() => musicParamsSchema.parse({ compositionPlan: { chunks: [{ songId: 'remote_song', range: { startMs: 0, endMs: 5000 } }] } }));
  assert.throws(() => musicParamsSchema.parse({ compositionPlan: { chunks: [{ text: 'x'.repeat(201), durationMs: 5000, positiveStyles: [] }] } }));
  assert.throws(() => musicParamsSchema.parse({ compositionPlan: { chunks: Array.from({ length: 6 }, () => ({ text: '', durationMs: 120000, positiveStyles: [] })) } }));
  assert.throws(() => modelRegistry.prepareRequest({ ...request('music_v2_5', { compositionPlan: plan }), durationMs: 16000 }), code('INVALID_INPUT'));
  assert.ok(modelRegistry.describe('music_v2_5').generationParamsJsonSchema.allOf);
});

test('image保留独立参数与输出，不能悄悄套用视频时长、seed、帧率或音频格式', () => {
  const prepared = modelRegistry.prepareRequest(request('x-ai/grok-imagine-image-2.0', { prompt: 'a cat' }));
  assert.deepEqual(prepared.params, { prompt: 'a cat' });
  assert.deepEqual(prepared.settings, { resolution: '1K', quality: 'low', aspectRatio: '1:1' });
  assert.equal(grokImageSettingsSchema.parse({ aspectRatio: '9:19.5' }).aspectRatio, '9:19.5');
  assert.throws(() => modelRegistry.prepareRequest({ ...request('x-ai/grok-imagine-image-2.0', { prompt: 'a cat' }), durationMs: 5000 }), code('INVALID_INPUT'));
  assert.throws(() => modelRegistry.prepareRequest(request('x-ai/grok-imagine-image-2.0', { prompt: 'a cat', seed: null })));
  assert.throws(() => modelRegistry.prepareRequest({ ...request('x-ai/grok-imagine-image-2.0', { prompt: 'a cat' }), settings: { frameRate: 30 } }));
  assert.throws(() => modelRegistry.prepareRequest({ ...request('eleven_v4', { text: 'Hi', voiceId: 'voice_1' }), settings: { outputFormat: 'mp3_44100_128' } }));
  assert.throws(() => modelRegistry.prepareRequest(request('eleven_v4', { text: 'Hi', voiceId: 'voice_1', outputFormat: 'pcm_44100' })));
});

test('引用能力和角色在共同边界校验；所有音频模型显式拒绝引用而非忽略', () => {
  const wan = request('alibaba/wan-3.0', { prompt: 'forest walk', referenceMode: 'firstFrame' });
  wan.references = [{ ...image(), role: 'first-frame' }];
  const prepared = modelRegistry.prepareRequest(wan);
  assert.equal(prepared.durationMs, 5000);
  assert.equal(modelRegistry.describe(wan.modelId).referenceLimitSource, 'host');
  assert.throws(() => modelRegistry.prepareRequest({ ...wan, references: [] }), code('UNSUPPORTED_REFERENCE'));
  assert.throws(() => modelRegistry.prepareRequest({ ...wan, references: [{ ...image(), role: 'last-frame' }] }), code('UNSUPPORTED_REFERENCE'));
  assert.throws(() => modelRegistry.prepareRequest({ ...wan, params: { prompt: 'forest walk' } }), code('UNSUPPORTED_REFERENCE'));
  const grok = request('x-ai/grok-imagine-image-2.0', { prompt: 'portrait' });
  grok.references = [image('one'), image('two'), image('three')];
  assert.equal(modelRegistry.prepareRequest(grok).references.length, 3);
  assert.throws(() => modelRegistry.prepareRequest({ ...grok, references: [...grok.references, image('four')] }), code('UNSUPPORTED_REFERENCE'));
  assert.throws(() => modelRegistry.prepareRequest({ ...grok, references: [{ ...image(), kind: 'audio' }] }), code('UNSUPPORTED_REFERENCE'));
  assert.throws(() => modelRegistry.prepareRequest({ ...grok, references: [image(), image()] }), code('UNSUPPORTED_REFERENCE'));
  for (const [modelId, params] of [
    ['eleven_v4', { text: 'Hi', voiceId: 'voice_1' }],
    ['eleven_text_to_sound_v2', { text: 'Rain' }],
    ['music_v2_5', { prompt: 'piano' }],
  ] as [string, JsonObject][]) {
    assert.throws(() => modelRegistry.prepareRequest({ ...request(modelId, params), references: [image()] }), code('UNSUPPORTED_REFERENCE'));
  }
});

test('model and timeline declarations share byte limits, preserve absent legacy metadata, and reject known oversized references', () => {
  for (const modelId of ['alibaba/wan-3.0', 'x-ai/grok-imagine-image-2.0']) {
    assert.equal(modelRegistry.resolve(modelId).referenceMaxBytes, MAX_IMAGE_REFERENCE_BYTES);
    assert.equal(modelRegistry.describe(modelId).referenceMaxBytes, MAX_IMAGE_REFERENCE_BYTES);
    const input = { ...request(modelId, { prompt: 'scene' }), references: [{ ...image(), metadata: { byteLength: MAX_IMAGE_REFERENCE_BYTES } }] };
    assert.equal(modelRegistry.prepareRequest(input).references.length, 1);
    assert.equal(modelRegistry.prepareRequest({ ...input, references: [image()] }).references.length, 1);
    assert.throws(() => modelRegistry.prepareRequest({ ...input, references: [{ ...image(), metadata: { byteLength: MAX_IMAGE_REFERENCE_BYTES + 1 } }] }), code('UNSUPPORTED_REFERENCE'));
  }
  assert.equal(modelRegistry.describe('eleven_v4').referenceMaxBytes, undefined);
  const descriptor = { ...builtinModelDescriptors.find(model => model.outputKind === 'image')!, modelId: 'custom/image', pluginId: 'custom.image', referenceMaxBytes: 8 };
  const registry = new ModelRegistry([descriptor]); const timelines = new TimelineRegistry(registry);
  assert.equal(timelines.describe(descriptor.modelId).referenceMaxBytes, 8);
  assert.equal(timelines.describe('pixel.text').referenceMaxBytes, undefined);
  const input = { ...request('x-ai/grok-imagine-image-2.0', { prompt: 'custom' }), modelId: descriptor.modelId, references: [{ ...image(), metadata: { byteLength: 8 } }] };
  assert.equal(registry.prepareRequest(input).references.length, 1);
  assert.throws(() => registry.prepareRequest({ ...input, references: [{ ...image(), metadata: { byteLength: 9 } }] }), code('UNSUPPORTED_REFERENCE'));
});

test('the controlled SDK reader still rejects oversized actual bytes when historical metadata omits its length', async () => {
  const context: ProviderRunContext = { signal: new AbortController().signal, attemptToken: { jobId: 'test', attempt: 1 },
    reportProgress: () => {}, checkpointProviderTask: async () => {}, artifacts: { write: async () => { throw new Error('No artifact should be written'); } },
    media: { read: async () => ({ mimeType: 'image/png', bytes: new Uint8Array(MAX_IMAGE_REFERENCE_BYTES + 1) }) } };
  await assert.rejects(referenceDataUrl(image(), context), code('UNSUPPORTED_REFERENCE'));
  context.media = { read: async () => ({ mimeType: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhUYAAAAASUVORK5CYII=', 'base64') }) };
  assert.match(await referenceDataUrl(image(), context), /^data:image\/png;base64,/);
});

test('规范化请求与返回字段schema不污染调用者输入', () => {
  const original = request('alibaba/wan-3.0', { prompt: 'sunrise' });
  const copy = structuredClone(original);
  const prepared = modelRegistry.prepareRequest(original);
  prepared.params.prompt = 'changed';
  assert.deepEqual(original, copy);
  const description = modelRegistry.describe('eleven_v4');
  assert.equal((description.generationParamsJsonSchema.properties as JsonObject).text !== undefined, true);
  assert.equal(((description.generationParamsJsonSchema.properties as JsonObject).text as JsonObject).pattern, '\\S');
  (description.paramsJsonSchema.properties as JsonObject).text = { type: 'number' };
  assert.equal(((modelRegistry.describe('eleven_v4').paramsJsonSchema.properties as JsonObject).text as JsonObject).type, 'string');
});

test('模型默认配置显式排除正文且保持稀疏，嵌套音色默认值也不会被补全', () => {
  const speech = modelRegistry.createPlugin('eleven_v4');
  assert.deepEqual(speech.validateItemDefaults({}), {});
  assert.deepEqual(speech.validateItemDefaults({ voiceSettings: { stability: 0.3 } }), { voiceSettings: { stability: 0.3 } });
  assert.deepEqual(speech.validateItemDefaults({ voiceId: '' }), { voiceId: '' });
  const effective = speech.resolveItemDefaults({ voiceId: 'selected' });
  assert.equal(effective.trimTail, true);
  assert.equal(effective.tailPaddingMs, 40);
  assert.equal(effective.voiceId, 'selected');
  assert.equal(Object.hasOwn(effective, 'text'), false);
  assert.equal(Object.hasOwn(effective, 'previousText'), false);
  for (const forbidden of ['text', 'previousText', 'nextText', 'unknown']) assert.throws(() => speech.validateItemDefaults({ [forbidden]: 'ignored?' }));
  assert.throws(() => speech.validateItemDefaults({ voiceSettings: { speed: 1.2 } }));
  assert.throws(() => speech.validateItemDefaults({ trimTail: undefined }));
  const declaration = modelRegistry.describe('eleven_v4');
  assert.deepEqual(declaration.paramsDefaults.contextMode, 'neighbors');
  assert.equal(declaration.contextMaxCharacters, 100);
  assert.ok(declaration.defaultFields.some(field => field.key === 'voiceSettings'));
  assert.equal(declaration.defaultFields.some(field => ['text', 'previousText', 'nextText'].includes(field.key)), false);
  assert.equal(JSON.stringify(declaration.defaultsJsonSchema).includes('"default"'), false);
  assert.throws(() => modelRegistry.createPlugin('music_v2_5').validateItemDefaults({ compositionPlan: plan }));
});

test('语音上下文按模式捕获，100字上限按Unicode码点而非UTF16计数', () => {
  const manual = modelRegistry.prepareRequest(request('eleven_v4', { text: '正文', voiceId: 'voice_1', contextMode: 'manual', previousText: '🙂'.repeat(100), nextText: '后文' }));
  assert.equal([...manual.context!.previousText!].length, 100);
  assert.deepEqual(manual.context?.nextText, '后文');
  assert.throws(() => speechParamsSchema.parse({ previousText: '🙂'.repeat(101) }));
  const none = modelRegistry.prepareRequest({ ...request('eleven_v4', { text: '正文', voiceId: 'voice_1', contextMode: 'none' }), context: { previousText: 'ignored' } });
  assert.equal(none.context, undefined);
  assert.throws(() => modelRegistry.prepareRequest({ ...request('eleven_v4', { text: '正文', voiceId: 'voice_1' }), context: { previousText: 'x'.repeat(101) } }), code('INVALID_INPUT'));
  assert.throws(() => modelRegistry.prepareRequest({ ...request('x-ai/grok-imagine-image-2.0', { prompt: 'cat' }), context: { nextText: 'not supported' } }), code('INVALID_INPUT'));
  const unknownContext = { ...request('eleven_v4', { text: '正文', voiceId: 'voice_1' }), context: { previousText: 'valid', privateFilePath: 'not allowed' } };
  assert.throws(() => modelRegistry.prepareRequest(unknownContext));
});
