import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ActionResult, JsonObject } from '../src/contracts.js';
import { createWorkbench, captureGenerationRequest, type Workbench } from '../src/workbench.js';
import { builtinModelDescriptors, modelRegistry, ModelRegistry, type ModelDescriptor } from '../src/models.js';
import { LocalMediaTimelinePlugin, TextTimelinePlugin } from '../src/plugins.js';
import { referenceLimit, timelineRegistry } from '../src/timeline-catalog.js';
import { validateWorkbenchProjectFile } from '../src/project-files.js';
import { bundledFfmpegPath } from '../src/audio-processing.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhUYAAAAASUVORK5CYII=', 'base64');
async function directory(context: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'pixel-timeline-core-'));
  context.after(async () => {
    const checked = resolve(path);
    assert.equal(dirname(checked), resolve(tmpdir())); assert.ok(basename(checked).startsWith('pixel-timeline-core-'));
    await rm(checked, { recursive: true, force: true });
  });
  return path;
}
function success(result: ActionResult) { assert.equal(result.ok, true, result.ok ? undefined : result.error.message); if (!result.ok) throw new Error('Expected success'); return result; }
async function action(workbench: Workbench, type: string, payload: JsonObject) {
  return workbench.execute({ projectId: workbench.projectId, expectedRevision: (await workbench.snapshot()).revision, requestId: randomUUID(), type, payload });
}
function wav(durationMs = 250): Buffer {
  const bytes = Buffer.alloc(44 + 8000 * durationMs / 1000 * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40); return bytes;
}

test('timeline catalog separates four local semantics from five SDK models and discovers shared policies', () => {
  assert.equal(modelRegistry.query({ limit: 20 }).items.length, 5);
  const first = timelineRegistry.query({ limit: 3 });
  assert.deepEqual(first.items.map(type => type.typeId), ['pixel.text', 'pixel.video.local', 'pixel.audio.local']);
  assert.equal(first.nextCursor, '3');
  assert.equal(timelineRegistry.query({ limit: 20, cursor: first.nextCursor! }).items.length, 6);
  assert.equal(timelineRegistry.query({ mode: 'local', limit: 20 }).items.length, 4);
  assert.equal(timelineRegistry.query({ outputKind: 'image', limit: 20 }).items.length, 2);
  assert.equal(timelineRegistry.query({ exclude: ['eleven_text_sound_v2'], limit: 20 }).items.length, 8);
  const text = timelineRegistry.describe('pixel.text');
  assert.equal(text.modelId, undefined); assert.equal(text.providerId, undefined); assert.equal(text.outputKind, undefined);
  assert.deepEqual(text.referenceTextFields, ['text']); assert.deepEqual(text.capabilities, { generation: false, mediaPlacement: false, references: false });
  const wan = timelineRegistry.describe('alibaba/wan-3.0');
  assert.equal(referenceLimit(wan, {}), 3); assert.equal(referenceLimit(wan, { referenceMode: 'firstFrame' }), 1);
  assert.throws(() => timelineRegistry.query({ limit: 21 })); assert.throws(() => timelineRegistry.query({ cursor: '999' }));
});

test('local plugins use BaseTimelinePlugin validation without manufacturing model or generation settings', () => {
  const plugin = new TextTimelinePlugin();
  const timeline = plugin.createTimeline({ id: 'text', ticksPerSecond: 1000, settings: {} });
  assert.equal(Object.hasOwn(timeline, 'modelId'), false);
  const item = plugin.createItem({ timeline, id: 'note', startTick: 0, durationTicks: 1000, params: { text: '笔记\n分镜' }, generationToken: 'token' });
  assert.equal(item.kind, 'text.note'); assert.equal(item.params.text, '笔记\n分镜'); assert.equal(item.generationSettings, undefined);
  assert.throws(() => plugin.createTimeline({ id: 'text', modelId: 'eleven_v4', ticksPerSecond: 1000, settings: {} }));
  assert.throws(() => plugin.createItem({ timeline, id: 'note', startTick: 0, durationTicks: 1, params: {}, referenceAssetIds: ['asset'], generationToken: 'token' }));
  assert.throws(() => plugin.createItem({ timeline, id: 'note', startTick: 0, durationTicks: 1, params: {}, sourceOffsetTicks: 1, generationToken: 'token' }));
  assert.throws(() => plugin.validateItemParams({ text: 'a'.repeat(20_001) }));
  assert.throws(() => plugin.validateItemParams({ prompt: 'wrong field' }));
  assert.equal(new LocalMediaTimelinePlugin('audio').manifest.capabilities.generation, false);
});

test('new models declare alternate text or non-text generation schemas without catalog assumptions about prompt', () => {
  const base = builtinModelDescriptors.find(model => model.modelId === 'x-ai/grok-imagine-image-2.0')!;
  const caption = z.strictObject({ caption: z.string().default('') });
  const numeric = z.strictObject({ intensity: z.number().min(0).max(1).default(0.5) });
  const descriptors: ModelDescriptor[] = [
    { ...base, modelId: 'custom/caption', pluginId: 'custom.caption', fields: [{ scope: 'itemParams', key: 'caption', label: 'Caption', valueType: 'string' }],
      paramsSchema: caption, generationParamsSchema: caption.refine(params => params.caption.trim().length > 0), referenceTextFields: ['caption'], requiredTextFields: ['caption'] },
    { ...base, modelId: 'custom/numeric', pluginId: 'custom.numeric', fields: [{ scope: 'itemParams', key: 'intensity', label: 'Intensity', valueType: 'number' }],
      paramsSchema: numeric, generationParamsSchema: numeric, referenceTextFields: [], requiredTextFields: [] },
  ];
  const registry = new ModelRegistry(descriptors);
  const description = registry.describe('custom/caption');
  assert.equal((description.generationParamsJsonSchema.properties as JsonObject).prompt, undefined);
  assert.equal(((description.generationParamsJsonSchema.properties as JsonObject).caption as JsonObject).minLength, 1);
  assert.deepEqual(registry.createPlugin('custom/caption').manifest.referenceTextFields, ['caption']);
  assert.deepEqual(registry.describe('custom/numeric').paramsDefaults, { intensity: 0.5 });
  assert.equal(registry.query({ limit: 20 }).items.length, 2);
});

test('text editing, overlapping positioning, resize and duplicate persist through common Actions without jobs', async context => {
  const root = await directory(context);
  const workbench = await createWorkbench({ directory: root }); context.after(() => workbench.shutdown());
  const timelineId = String(success(await action(workbench, 'timeline.create', { typeId: 'pixel.text' })).outcome.timelineId);
  const itemId = String(success(await action(workbench, 'item.createDraft', { timelineId, startTick: 1000 })).outcome.itemId);
  success(await action(workbench, 'item.params', { itemId, params: { text: '第一个分镜\n供外部 Agent 参考' } }));
  const overlappingId = String(success(await action(workbench, 'item.createDraft', { timelineId, startTick: 1000 })).outcome.itemId);
  success(await action(workbench, 'item.move', { itemId, startTick: 2000 }));
  success(await action(workbench, 'item.resize', { itemId, startTick: 2000, durationTicks: 2000 }));
  const duplicateId = String(success(await action(workbench, 'item.duplicate', { itemId })).outcome.itemId);
  const snapshot = await workbench.snapshot();
  assert.equal(snapshot.document.items[duplicateId]!.params.text, snapshot.document.items[itemId]!.params.text);
  assert.deepEqual(snapshot.document.items[itemId]!.referenceAssetIds, []); assert.equal(snapshot.document.items[itemId]!.outputAssetId, undefined);
  assert.deepEqual(await workbench.jobs(), { items: [] }); assert.deepEqual(snapshot.document.assets, {});
  assert.throws(() => captureGenerationRequest(snapshot.document, snapshot.document.items[itemId]!));
  for (const [type, payload] of [
    ['generation.submit', { itemId }], ['timeline.defaults', { timelineId, itemDefaults: {} }],
    ['timeline.refreshDefaults', { timelineId }], ['timeline.settings', { timelineId, settings: {} }],
  ] as const) {
    const rejected = await action(workbench, type, payload); assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, 'NOT_APPLICABLE');
    assert.deepEqual(await workbench.snapshot(), snapshot);
  }
  const reopened = await createWorkbench({ directory: root }); context.after(() => reopened.shutdown());
  assert.deepEqual(await reopened.snapshot(), snapshot);
  success(await action(reopened, 'item.delete', { itemId: overlappingId }));
  success(await action(reopened, 'timeline.delete', { timelineId }));
  assert.deepEqual((await reopened.snapshot()).document.items, {});
});

test('external media placement creates asset, ordinary timeline and real output in one durable idempotent Action', async context => {
  const root = await directory(context); const workbench = await createWorkbench({ directory: root }); context.after(() => workbench.shutdown());
  const input = { bytes: png, mimeType: 'image/png', name: '分镜.png', requestId: randomUUID(), expectedRevision: 0, startTick: 1500 };
  const first = success(await workbench.placeExternalMedia(input)); const snapshot = await workbench.snapshot();
  assert.equal(snapshot.revision, 1); assert.equal(Object.keys(snapshot.document.timelines).length, 1); assert.equal(Object.keys(snapshot.document.assets).length, 1);
  const timeline = snapshot.document.timelines[String(first.outcome.timelineId)]!; const item = snapshot.document.items[String(first.outcome.itemId)]!;
  assert.equal(timeline.pluginId, 'pixel.image.local'); assert.equal(timeline.modelId, undefined);
  assert.equal(item.outputAssetId, first.outcome.assetId); assert.equal(item.outputOrigin, 'placement'); assert.equal(item.startTick, 1500);
  assert.deepEqual(await workbench.placeExternalMedia(input), first);
  const reopened = await createWorkbench({ directory: root }); context.after(() => reopened.shutdown());
  assert.deepEqual(await reopened.placeExternalMedia(input), first); assert.deepEqual(await reopened.snapshot(), snapshot);
  const reused = await reopened.placeExternalMedia({ ...input, startTick: 2000 }); assert.equal(reused.ok, false);
  if (!reused.ok) assert.equal(reused.error.code, 'REQUEST_ID_REUSED');
  assert.deepEqual(await readFile(await reopened.artifacts.resolvePath(snapshot.document.assets[String(first.outcome.assetId)]!)), png);
  const file = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as { history: unknown[] };
  assert.equal(file.history.length, 1);
});

test('external placement rollback preserves project on incompatible targets, overlap, revision conflict and forged Action', async context => {
  const workbench = await createWorkbench({ directory: await directory(context) }); context.after(() => workbench.shutdown());
  const textId = String(success(await action(workbench, 'timeline.create', { typeId: 'pixel.text' })).outcome.timelineId);
  let before = await workbench.snapshot();
  const incompatible = await workbench.placeExternalMedia({ bytes: png, mimeType: 'image/png', name: 'image.png', requestId: randomUUID(), expectedRevision: before.revision, startTick: 0, timelineId: textId });
  assert.equal(incompatible.ok, false); assert.deepEqual(await workbench.snapshot(), before);
  const created = success(await workbench.placeExternalMedia({ bytes: png, mimeType: 'image/png', name: 'image.png', requestId: randomUUID(), expectedRevision: before.revision, startTick: 0 }));
  before = await workbench.snapshot();
  const overlapping = await workbench.placeExternalMedia({ bytes: png, mimeType: 'image/png', name: 'other.png', requestId: randomUUID(), expectedRevision: before.revision, startTick: 0, timelineId: String(created.outcome.timelineId) });
  assert.equal(overlapping.ok, false); assert.deepEqual(await workbench.snapshot(), before);
  const stale = await workbench.placeExternalMedia({ bytes: png, mimeType: 'image/png', name: 'image.png', requestId: randomUUID(), expectedRevision: before.revision - 1, startTick: 6000 });
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, 'REVISION_CONFLICT');
  const asset = before.document.assets[String(created.outcome.assetId)]!;
  const forged = await action(workbench, 'media.placeExternal', { asset: asset as unknown as JsonObject, startTick: 6000 });
  assert.equal(forged.ok, false); if (!forged.ok) assert.equal(forged.error.code, 'FORBIDDEN');
  assert.deepEqual(await workbench.snapshot(), before);
  const draft = await action(workbench, 'item.createDraft', { timelineId: String(created.outcome.timelineId), startTick: 6000 });
  assert.equal(draft.ok, false); assert.deepEqual(await workbench.snapshot(), before);
});

test('ordinary media assets share placement and positioning Actions while text rejects media relationships', async context => {
  const workbench = await createWorkbench({ directory: await directory(context) }); context.after(() => workbench.shutdown());
  const imported = success(await workbench.importMedia({ bytes: png, mimeType: 'image/png', name: 'image.png', requestId: randomUUID(), expectedRevision: 0 }));
  const assetId = String(imported.outcome.assetId);
  const imageId = String(success(await action(workbench, 'timeline.create', { typeId: 'pixel.image.local' })).outcome.timelineId);
  const itemId = String(success(await action(workbench, 'item.create', { timelineId: imageId, assetId, startTick: 0 })).outcome.itemId);
  success(await action(workbench, 'item.move', { itemId, startTick: 1000 })); success(await action(workbench, 'item.resize', { itemId, startTick: 1000, durationTicks: 2000 }));
  const textId = String(success(await action(workbench, 'timeline.create', { typeId: 'pixel.text' })).outcome.timelineId);
  const textItemId = String(success(await action(workbench, 'item.createDraft', { timelineId: textId, startTick: 0 })).outcome.itemId);
  const before = await workbench.snapshot();
  for (const [type, payload] of [
    ['item.create', { timelineId: textId, assetId, startTick: 0 }], ['item.reference.add', { itemId: textItemId, assetId }], ['generation.submit', { itemId }],
  ] as const) { assert.equal((await action(workbench, type, payload)).ok, false); assert.deepEqual(await workbench.snapshot(), before); }
});

test('external audio/video preserve probed duration and reject header-only media without partial project edits', async context => {
  const root = await directory(context); const workbench = await createWorkbench({ directory: root }); context.after(() => workbench.shutdown());
  const audio = success(await workbench.placeExternalMedia({ bytes: wav(), mimeType: 'audio/wav', name: 'short.wav', requestId: randomUUID(), expectedRevision: 0, startTick: 0 }));
  let snapshot = await workbench.snapshot();
  assert.equal(snapshot.document.items[String(audio.outcome.itemId)]!.durationTicks, 250);
  assert.equal(snapshot.document.assets[String(audio.outcome.assetId)]!.metadata.durationMs, 250);
  const videoFile = join(root, 'short.mp4');
  await new Promise<void>((accept, reject) => {
    const child = spawn(bundledFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=10:d=0.3', '-c:v', 'mpeg4', '-y', videoFile], { windowsHide: true, shell: false, stdio: 'ignore' });
    child.on('error', reject); child.on('close', code => code === 0 ? accept() : reject(new Error('Video fixture failed')));
  });
  const video = success(await workbench.placeExternalMedia({ bytes: await readFile(videoFile), mimeType: 'video/mp4', name: 'short.mp4', requestId: randomUUID(), expectedRevision: snapshot.revision, startTick: 0 }));
  snapshot = await workbench.snapshot(); assert.equal(snapshot.document.items[String(video.outcome.itemId)]!.durationTicks, 300);
  assert.equal(snapshot.document.assets[String(video.outcome.assetId)]!.metadata.durationMs, 300);
  await assert.rejects(workbench.placeExternalMedia({ bytes: Buffer.from('RIFF1234WAVE'), mimeType: 'audio/wav', name: 'fake.wav', requestId: randomUUID(), expectedRevision: snapshot.revision, startTick: 0 }));
  assert.deepEqual(await workbench.snapshot(), snapshot); assert.deepEqual(await workbench.jobs(), { items: [] });
});

test('library import and direct placement preserve the same actual audio/video duration through shared import validation', async context => {
  const root = await directory(context); const workbench = await createWorkbench({ directory: root }); context.after(() => workbench.shutdown());
  const videoFile = join(root, 'library-short.mp4');
  await new Promise<void>((accept, reject) => {
    const child = spawn(bundledFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=10:d=0.3', '-c:v', 'mpeg4', '-y', videoFile], { windowsHide: true, shell: false, stdio: 'ignore' });
    child.on('error', reject); child.on('close', code => code === 0 ? accept() : reject(new Error('Video fixture failed')));
  });
  for (const fixture of [
    { kind: 'audio', bytes: wav(), mimeType: 'audio/wav', name: 'library-short.wav', durationMs: 250 },
    { kind: 'video', bytes: await readFile(videoFile), mimeType: 'video/mp4', name: 'library-short.mp4', durationMs: 300 },
  ] as const) {
    const input = { bytes: fixture.bytes, mimeType: fixture.mimeType, name: fixture.name, expectedRevision: (await workbench.snapshot()).revision, requestId: randomUUID() };
    const imported = success(await workbench.importMedia(input));
    const assetId = String(imported.outcome.assetId);
    assert.deepEqual(await workbench.importMedia(input), imported);
    assert.equal((await workbench.snapshot()).document.assets[assetId]!.metadata.durationMs, fixture.durationMs);
    const timelineId = String(success(await action(workbench, 'timeline.create', { typeId: `pixel.${fixture.kind}.local` })).outcome.timelineId);
    const itemId = String(success(await action(workbench, 'item.create', { timelineId, assetId, startTick: 0 })).outcome.itemId);
    const direct = success(await workbench.placeExternalMedia({ ...input, requestId: randomUUID(), expectedRevision: (await workbench.snapshot()).revision, startTick: 0 }));
    const snapshot = await workbench.snapshot();
    assert.equal(snapshot.document.items[itemId]!.durationTicks, fixture.durationMs);
    assert.equal(snapshot.document.items[itemId]!.durationTicks, snapshot.document.items[String(direct.outcome.itemId)]!.durationTicks);
  }
  const before = await workbench.snapshot();
  await assert.rejects(workbench.importMedia({ bytes: Buffer.from('RIFF1234WAVE'), mimeType: 'audio/wav', name: 'fake.wav', expectedRevision: before.revision, requestId: randomUUID() }));
  assert.deepEqual(await workbench.snapshot(), before);
  const reopened = await createWorkbench({ directory: root }); context.after(() => reopened.shutdown());
  assert.deepEqual(await reopened.snapshot(), before);
});

test('project file validation rejects fake model identity and generated/media relations on local text', async context => {
  const root = await directory(context); const workbench = await createWorkbench({ directory: root }); context.after(() => workbench.shutdown());
  const id = String(success(await action(workbench, 'timeline.create', { typeId: 'pixel.text' })).outcome.timelineId);
  const itemId = String(success(await action(workbench, 'item.createDraft', { timelineId: id, startTick: 0 })).outcome.itemId);
  const source = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as { snapshot: Awaited<ReturnType<Workbench['snapshot']>> };
  const fakeModel = structuredClone(source); fakeModel.snapshot.document.timelines[id]!.modelId = 'eleven_v4';
  assert.throws(() => validateWorkbenchProjectFile(fakeModel));
  const fakeGenerated = structuredClone(source); fakeGenerated.snapshot.document.items[itemId]!.generationSettings = {};
  assert.throws(() => validateWorkbenchProjectFile(fakeGenerated));
  const fakeParams = structuredClone(source); fakeParams.snapshot.document.items[itemId]!.params = { text: 'note', prompt: 'pretend generated' };
  assert.throws(() => validateWorkbenchProjectFile(fakeParams));
  const invalidSelector = await action(workbench, 'timeline.create', { modelId: 'pixel.text' }); assert.equal(invalidSelector.ok, false);
});
