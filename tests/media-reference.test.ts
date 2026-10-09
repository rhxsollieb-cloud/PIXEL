import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createWorkbench, type Workbench } from '../src/workbench.js';
import type { ActionResult, JsonObject, ProjectSnapshot } from '../src/contracts.js';
import { referenceLimit, referenceMinimum, timelineRegistry } from '../src/timeline-catalog.js';
import { MAX_IMAGE_REFERENCE_BYTES } from '../src/reference-policy.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhUYAAAAASUVORK5CYII=', 'base64');
function success(result: ActionResult) { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error('Expected success'); return result; }
async function action(workbench: Workbench, type: string, payload: JsonObject, requestId = randomUUID()) {
  const snapshot = await workbench.snapshot();
  return workbench.execute({ requestId, projectId: workbench.projectId, expectedRevision: snapshot.revision, type, payload });
}
async function fixture(context: import('node:test').TestContext, initial?: ProjectSnapshot) {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-reference-upload-'));
  const workbench = await createWorkbench({ directory, ...(initial ? { initial } : {}) });
  context.after(async () => { await workbench.shutdown(); const checked = resolve(directory);
    assert.equal(dirname(checked), resolve(tmpdir())); assert.ok(basename(checked).startsWith('pixel-reference-upload-')); await rm(checked, { recursive: true, force: true }); });
  return { workbench, directory };
}

test('reference upload is one verified atomic Action with shared dynamic limits, idempotency and no implicit generation', async context => {
  const { workbench } = await fixture(context);
  const timelineId = String(success(await action(workbench, 'timeline.create', { modelId: 'alibaba/wan-3.0' })).outcome.timelineId);
  const itemId = String(success(await action(workbench, 'item.createDraft', { timelineId, startTick: 0 })).outcome.itemId);
  success(await action(workbench, 'item.params', { itemId, params: { prompt: 'scene', referenceMode: 'firstFrame' } }));
  const declaration = timelineRegistry.describe('alibaba/wan-3.0');
  assert.equal(referenceMinimum(declaration, { referenceMode: 'firstFrame' }), 1); assert.equal(referenceLimit(declaration, { referenceMode: 'firstFrame' }), 1);
  const before = await workbench.snapshot();
  const input = { bytes: png, mimeType: 'image/png', name: '参考图.png', requestId: randomUUID(), expectedRevision: before.revision, itemId };
  const receipt = success(await workbench.importReferenceMedia(input));
  assert.equal(receipt.revision, before.revision + 1);
  let snapshot = await workbench.snapshot(); const assetId = String(receipt.outcome.assetId);
  assert.deepEqual(snapshot.document.items[itemId]!.referenceAssetIds, [assetId]);
  assert.equal(snapshot.document.items[itemId]!.outputAssetId, undefined);
  assert.notEqual(snapshot.document.items[itemId]!.generationToken, before.document.items[itemId]!.generationToken);
  assert.equal(snapshot.document.assets[assetId]!.kind, 'image');
  assert.deepEqual(await workbench.importReferenceMedia(input), receipt);
  await assert.rejects(workbench.importReferenceMedia({ ...input, requestId: randomUUID(), expectedRevision: snapshot.revision }), /上限/);
  assert.deepEqual(await workbench.snapshot(), snapshot);
  success(await action(workbench, 'item.params', { itemId, params: { prompt: 'scene', referenceMode: 'reference' } }));
  assert.equal(referenceMinimum(declaration, { referenceMode: 'reference' }), 0); assert.equal(referenceLimit(declaration, { referenceMode: 'reference' }), 3);
  for (let index = 0; index < 2; index++) { snapshot = await workbench.snapshot(); success(await workbench.importReferenceMedia({ ...input, requestId: randomUUID(), expectedRevision: snapshot.revision })); }
  snapshot = await workbench.snapshot(); assert.equal(snapshot.document.items[itemId]!.referenceAssetIds.length, 3);
  assert.deepEqual(await workbench.jobs(), { items: [] });
  const forged = await action(workbench, 'media.referenceExternal', { itemId, asset: snapshot.document.assets[assetId] as unknown as JsonObject });
  assert.equal(forged.ok, false); if (!forged.ok) assert.equal(forged.error.code, 'FORBIDDEN');
  assert.deepEqual(await workbench.snapshot(), snapshot);
});

test('unsupported media, local tracks and non-reference models reject uploads without adding assets or modifying Items', async context => {
  const { workbench } = await fixture(context);
  for (const typeId of ['pixel.text', 'eleven_v4', 'music_v2_5']) {
    const timelineId = String(success(await action(workbench, 'timeline.create', { typeId })).outcome.timelineId);
    const itemId = String(success(await action(workbench, 'item.createDraft', { timelineId, startTick: 0 })).outcome.itemId);
    const snapshot = await workbench.snapshot();
    await assert.rejects(workbench.importReferenceMedia({ bytes: png, mimeType: 'image/png', name: 'image.png', requestId: randomUUID(), expectedRevision: snapshot.revision, itemId }));
    assert.deepEqual(await workbench.snapshot(), snapshot);
  }
  const timelineId = String(success(await action(workbench, 'timeline.create', { modelId: 'x-ai/grok-imagine-image-2.0' })).outcome.timelineId);
  const itemId = String(success(await action(workbench, 'item.createDraft', { timelineId, startTick: 0 })).outcome.itemId);
  const snapshot = await workbench.snapshot();
  await assert.rejects(workbench.importReferenceMedia({ bytes: Buffer.from('ID3bad'), mimeType: 'audio/mpeg', name: 'audio.mp3', requestId: randomUUID(), expectedRevision: snapshot.revision, itemId }), /不支持/);
  assert.deepEqual(await workbench.snapshot(), snapshot);
});

test('model byte declarations reject oversized real PNG uploads before any artifact or project mutation', async context => {
  const { workbench, directory } = await fixture(context);
  const oversized = Buffer.alloc(MAX_IMAGE_REFERENCE_BYTES + 1); png.copy(oversized);
  for (const modelId of ['alibaba/wan-3.0', 'x-ai/grok-imagine-image-2.0']) {
    const timelineId = String(success(await action(workbench, 'timeline.create', { modelId })).outcome.timelineId);
    const itemId = String(success(await action(workbench, 'item.createDraft', { timelineId, startTick: 0 })).outcome.itemId);
    assert.equal(timelineRegistry.describe(modelId).referenceMaxBytes, MAX_IMAGE_REFERENCE_BYTES);
    const before = await workbench.snapshot();
    await assert.rejects(workbench.importReferenceMedia({ bytes: oversized, mimeType: 'image/png', name: '超限.png', requestId: randomUUID(), expectedRevision: before.revision, itemId }), /25 MiB/);
    assert.deepEqual(await workbench.snapshot(), before);
    assert.deepEqual(before.document.assets, {}); assert.deepEqual(before.document.items[itemId]!.referenceAssetIds, []);
    await assert.rejects(readdir(join(directory, 'artifacts')), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  }
  assert.deepEqual(await workbench.jobs(), { items: [] });
});

test('library assets remain valid media but cannot become model references when their known byte length exceeds its limit', async context => {
  const { workbench } = await fixture(context);
  const oversized = Buffer.alloc(MAX_IMAGE_REFERENCE_BYTES + 1); png.copy(oversized);
  const imported = success(await workbench.importMedia({ bytes: oversized, mimeType: 'image/png', name: '大图.png', requestId: randomUUID(), expectedRevision: 0 }));
  const assetId = String(imported.outcome.assetId);
  assert.equal((await workbench.mediaAsset(assetId)).metadata.byteLength, oversized.byteLength);
  for (const modelId of ['alibaba/wan-3.0', 'x-ai/grok-imagine-image-2.0']) {
    const timelineId = String(success(await action(workbench, 'timeline.create', { modelId })).outcome.timelineId);
    const itemId = String(success(await action(workbench, 'item.createDraft', { timelineId, startTick: 0 })).outcome.itemId);
    const before = await workbench.snapshot(); const result = await action(workbench, 'item.reference.add', { itemId, assetId });
    assert.equal(result.ok, false); if (!result.ok) { assert.equal(result.error.code, 'NOT_APPLICABLE'); assert.match(result.error.message, /25 MiB/); }
    assert.deepEqual(await workbench.snapshot(), before);
  }
});

test('older Asset metadata without byte length remains attachable without claiming that its real bytes were checked', async context => {
  const assetId = randomUUID();
  const initial: ProjectSnapshot = { revision: 0, document: { schemaVersion: 1, id: randomUUID(), title: '旧项目', timelines: {}, items: {},
    assets: { [assetId]: { id: assetId, kind: 'image', fileRef: `pixel-asset:${assetId}`, metadata: {} } } } };
  const { workbench } = await fixture(context, initial);
  const timelineId = String(success(await action(workbench, 'timeline.create', { modelId: 'x-ai/grok-imagine-image-2.0' })).outcome.timelineId);
  const itemId = String(success(await action(workbench, 'item.createDraft', { timelineId, startTick: 0 })).outcome.itemId);
  success(await action(workbench, 'item.reference.add', { itemId, assetId }));
  const snapshot = await workbench.snapshot();
  assert.deepEqual(snapshot.document.items[itemId]!.referenceAssetIds, [assetId]);
  assert.deepEqual(snapshot.document.assets[assetId]!.metadata, {});
  assert.deepEqual(await workbench.jobs(), { items: [] });
});
