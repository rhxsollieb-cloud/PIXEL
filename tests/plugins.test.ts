import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeepReadonly, TimelineData } from '../src/contracts.js';
import { VideoTimelinePlugin } from '../src/plugins.js';

function view<T>(value: T): DeepReadonly<T> { return value as DeepReadonly<T>; }
const plugin = new VideoTimelinePlugin();
function timeline(): TimelineData {
  return plugin.createTimeline({ id: 'timeline_1', modelId: 'example.video', ticksPerSecond: 1000, settings: {} });
}
function itemInput() {
  return {
    timeline: view(timeline()), id: 'item_1', startTick: 0, durationTicks: 5000,
    params: { prompt: '海边日落' }, generationToken: 'input_v1', referenceAssetIds: ['reference_1'],
  };
}

test('插件纯构造 timeline 和 item，默认参数经 schema 标准化且不修改输入', () => {
  const createdTimeline = timeline();
  assert.equal(createdTimeline.pluginId, 'pixel.video');
  assert.equal(createdTimeline.pluginVersion, 1);
  assert.deepEqual(createdTimeline.settings, { width: 1920, height: 1080, frameRate: 30 });
  const input = itemInput();
  const createdItem = plugin.createItem(input);
  assert.equal(createdItem.kind, 'video.clip');
  assert.equal(createdItem.sourceOffsetTicks, 0);
  assert.deepEqual(createdItem.params, { prompt: '海边日落', negativePrompt: '', seed: null });
  assert.equal(createdItem.generationToken, 'input_v1');
  assert.deepEqual(input.timeline.itemIds, []);
  createdItem.referenceAssetIds.push('new_reference');
  assert.deepEqual(input.referenceAssetIds, ['reference_1']);
  assert.deepEqual(input.params, { prompt: '海边日落' });
});

test('创建 timeline 拒绝不支持的模型、无效 tick 精度及未知设置字段', () => {
  const input = { id: 'timeline_1', modelId: 'example.video', ticksPerSecond: 1000, settings: {} };
  assert.throws(() => plugin.createTimeline({ ...input, modelId: 'unknown.model' }), /unsupported/);
  assert.throws(() => plugin.createTimeline({ ...input, ticksPerSecond: 0 }));
  assert.throws(() => plugin.createTimeline({ ...input, ticksPerSecond: 0.5 }));
  assert.throws(() => plugin.createTimeline({ ...input, settings: { width: -1 } }));
  assert.throws(() => plugin.createTimeline({ ...input, settings: { unexpected: true } }));
});

test('item 创建检查插件归属、schema 版本和 timeline 的模型兼容性', () => {
  const input = itemInput();
  assert.throws(() => plugin.createItem({ ...input, timeline: { ...input.timeline, pluginId: 'another.plugin' } }), /different plugin/);
  assert.throws(() => plugin.createItem({ ...input, timeline: { ...input.timeline, pluginVersion: 2 } }), /migration/);
  assert.throws(() => plugin.createItem({ ...input, timeline: { ...input.timeline, modelId: 'unknown.model' } }), /unsupported/);
});

test('item 创建拒绝无效长度、结束 tick 溢出、无效参数；nullable 字段由宿主声明', () => {
  const input = itemInput();
  assert.throws(() => plugin.createItem({ ...input, durationTicks: 0 }));
  assert.throws(() => plugin.createItem({ ...input, startTick: -1 }));
  assert.throws(() => plugin.createItem({ ...input, startTick: Number.MAX_SAFE_INTEGER }), /safe integer/);
  assert.throws(() => plugin.createItem({ ...input, params: { seed: -1 } }));
  assert.throws(() => plugin.createItem({ ...input, params: { unknown: 'field' } }));
  const seedField = plugin.manifest.fields.find(field => field.scope === 'itemParams' && field.key === 'seed');
  assert.equal(seedField?.nullable, true);
  assert.equal(plugin.manifest.supportedActions.includes('timeline.create'), true);
  assert.equal(plugin.manifest.overlapPolicy, 'reject');
});
