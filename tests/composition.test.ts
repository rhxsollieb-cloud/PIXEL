import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { assertProjectInvariants } from '../src/backend.js';
import { orderedTimelineIds, type MediaKind, type ProjectDocument } from '../src/contracts.js';
import { validateWorkbenchProjectFile } from '../src/project-files.js';
import { activeCompositionLayers, buildCompositionPlan, compositionFrameAtMs } from '../web/composition.js';

function project(): ProjectDocument {
  return { id: 'project', title: '多层作品', schemaVersion: 1, assets: {}, timelines: {}, items: {} };
}
function timeline(document: ProjectDocument, id: string, kind: MediaKind | 'text', clock = 1000) {
  document.timelines[id] = { id, pluginId: kind === 'text' ? 'pixel.text' : `pixel.${kind}.local`, pluginVersion: 1,
    ticksPerSecond: clock, itemIds: [], settings: {} };
}
function item(document: ProjectDocument, timelineId: string, id: string, start: number, duration: number, kind?: MediaKind, offset = 0) {
  const assetId = randomUUID();
  if (kind) document.assets[assetId] = { id: assetId, kind, fileRef: `pixel-asset:${assetId}`, metadata: {} };
  document.items[id] = { id, timelineId, kind: kind ? `${kind}.local` : 'text.note', startTick: start, durationTicks: duration,
    sourceOffsetTicks: offset, params: kind ? {} : { text: '纯文本不会入画' }, referenceAssetIds: [], generationToken: 'token',
    ...(kind ? { outputAssetId: assetId, outputOrigin: 'placement' as const } : {}) };
  document.timelines[timelineId]!.itemIds.push(id); return assetId;
}
function file(document: ProjectDocument) { return { version: 1, snapshot: { revision: 0, document }, requests: {}, history: [], outbox: [] }; }

test('timeline order stays optional for legacy files and enforces complete unique project-local coverage, including history', () => {
  const document = project(); timeline(document, 'first', 'image'); timeline(document, 'second', 'video');
  assert.deepEqual(orderedTimelineIds(document), ['first', 'second']);
  const queried = orderedTimelineIds(document); queried.reverse();
  assert.deepEqual(orderedTimelineIds(document), ['first', 'second']);
  assert.equal(Object.hasOwn(validateWorkbenchProjectFile(file(document)).snapshot.document, 'timelineOrder'), false);
  document.timelineOrder = ['second', 'first'];
  assert.deepEqual(orderedTimelineIds(document), ['second', 'first']);
  assert.deepEqual(validateWorkbenchProjectFile(file(document)).snapshot.document, document);
  for (const bad of [[], ['first'], ['first', 'first'], ['first', 'missing'], ['first', 'second', 'missing'], ['first', 1], 'first']) {
    const invalid = { ...document, timelineOrder: bad } as ProjectDocument;
    assert.throws(() => assertProjectInvariants(invalid)); assert.throws(() => validateWorkbenchProjectFile(file(invalid)));
    assert.throws(() => validateWorkbenchProjectFile({ ...file(document), history: [{ requestId: 'reorder', before: invalid, after: document }] }));
  }
});

test('composition includes every concurrent output, puts top timelines in front, preserves source offsets and excludes text', () => {
  const document = project(); timeline(document, 'background', 'video', 2000); timeline(document, 'foreground', 'image');
  timeline(document, 'audio', 'audio'); timeline(document, 'notes', 'text');
  item(document, 'background', 'video', 1000, 4000, 'video', 750);
  item(document, 'foreground', 'image', 500, 2000, 'image');
  item(document, 'audio', 'audio-1', 0, 2000, 'audio', 125); item(document, 'audio', 'audio-2', 1000, 2000, 'audio', 500);
  item(document, 'notes', 'note', 0, 4000);
  document.timelineOrder = ['foreground', 'notes', 'background', 'audio'];
  const plan = buildCompositionPlan(document);
  assert.equal(plan.layers.length, 4); assert.equal(plan.durationInFrames, 241); assert.equal(plan.maximumConcurrentAudio, 2);
  const layers = activeCompositionLayers(plan, 90);
  assert.deepEqual(layers.map(layer => layer.itemId), ['image', 'video', 'audio-1', 'audio-2']);
  assert.ok(layers[0]!.zIndex > layers[1]!.zIndex);
  const video = plan.layers.find(layer => layer.itemId === 'video')!;
  assert.equal((90 - video.from + video.trimBefore) / plan.fps, 1.375);
  assert.equal(activeCompositionLayers(plan, 30).filter(layer => layer.kind !== 'audio').length, 2);
  assert.equal(activeCompositionLayers(plan, 150).some(layer => layer.itemId === 'video' || layer.itemId === 'image'), false);
  assert.deepEqual(activeCompositionLayers(plan, compositionFrameAtMs(plan, 90_000)), []);
});

test('tick intervals remain half-open at non-frame boundaries; frame rounding never changes stored ticks', () => {
  const document = project(); timeline(document, 'audio', 'audio');
  item(document, 'audio', 'first', 7, 20, 'audio', 17); item(document, 'audio', 'second', 27, 20, 'audio');
  const before = structuredClone(document); const plan = buildCompositionPlan(document);
  assert.equal(plan.maximumConcurrentAudio, 1);
  assert.deepEqual(activeCompositionLayers(plan, 0), []);
  assert.deepEqual(activeCompositionLayers(plan, 1).map(layer => layer.itemId), ['first']);
  assert.deepEqual(activeCompositionLayers(plan, 2).map(layer => layer.itemId), ['second']);
  const first = plan.layers[0]!;
  assert.ok(Math.abs(first.trimBefore / 60 - (0.017 + 1 / 60 - 0.007)) < 1e-10);
  assert.equal(compositionFrameAtMs(plan, -1), 0); assert.equal(compositionFrameAtMs(plan, NaN), 0);
  assert.equal(compositionFrameAtMs(plan, Infinity), 0); assert.deepEqual(document, before);
  assert.equal(buildCompositionPlan(project()).durationInFrames, 1);
  assert.throws(() => buildCompositionPlan(document, 0));
});
