import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { createWorkbench, type Workbench } from './local-workbench.js';
import { decodeProjectPackage, exportProjectPackage, importedPackageState } from '../src/project-package.js';
import { generationInputFingerprint } from '../src/generation-fingerprint.js';
import type { ActionResult, GenerationRequest } from '../src/contracts.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-package-test-')); const workbench = await createWorkbench({ directory });
  context.after(async () => { await workbench.shutdown(); const checked = resolve(directory); assert.equal(dirname(checked), resolve(tmpdir())); assert.ok(basename(checked).startsWith('pixel-package-test-')); await rm(checked, { recursive: true, force: true }); });
  return workbench;
}
async function action(workbench: Workbench, type: string, payload: object): Promise<Extract<ActionResult, { ok: true }>> {
  const result = await workbench.execute({ projectId: workbench.projectId, requestId: randomUUID(), expectedRevision: (await workbench.snapshot()).revision, type, payload });
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message); return result;
}

test('whole project package roundtrip separates media, preserves history and editable data, and never exports executable jobs', async context => {
  const workbench = await fixture(context);
  const placed = await workbench.placeExternalMedia({ bytes: png, mimeType: 'image/png', name: '分镜.png', requestId: randomUUID(), expectedRevision: 0, startTick: 3000 });
  assert.equal(placed.ok, true);
  const text = await action(workbench, 'timeline.create', { typeId: 'pixel.text' });
  const note = await action(workbench, 'item.createDraft', { timelineId: text.outcome.timelineId, startTick: 2500 });
  await action(workbench, 'item.params', { itemId: note.outcome.itemId, params: { text: '分镜与提示词\n供外部 Agent 参考' } });
  const before = await workbench.repository.exportState();
  const archive = await exportProjectPackage(before, workbench.artifacts, new AbortController().signal);
  const files = unzipSync(archive); assert.ok(files['project/project.json']); assert.ok(files['manifest.json']);
  assert.equal(Object.keys(files).filter(path => path.startsWith('media/')).length, 1);
  const decoded = decodeProjectPackage(archive);
  const normalized = structuredClone(decoded.state);
  for (const document of [normalized.snapshot.document, ...normalized.history.flatMap(entry => [entry.before, entry.after])]) for (const asset of Object.values(document.assets)) {
    assert.match(String(asset.metadata.sha256), /^[a-f0-9]{64}$/);
    if (!before.snapshot.document.assets[asset.id]?.metadata.sha256) delete asset.metadata.sha256;
  }
  assert.deepEqual(normalized.snapshot, before.snapshot); assert.deepEqual(normalized.history, before.history);
  assert.deepEqual(decoded.state.requests, {}); assert.deepEqual(decoded.state.outbox, []);
  assert.deepEqual(decoded.artifacts[0]?.bytes, new Uint8Array(png));
  const imported = importedPackageState(decoded.state);
  assert.notEqual(imported.snapshot.document.id, before.snapshot.document.id);
  assert.deepEqual(Object.keys(imported.snapshot.document.assets), Object.keys(before.snapshot.document.assets));
  assert.deepEqual(Object.keys(imported.snapshot.document.items), Object.keys(before.snapshot.document.items));
  assert.notEqual(imported.snapshot.document.items[String(note.outcome.itemId)]?.generationToken, before.snapshot.document.items[String(note.outcome.itemId)]?.generationToken);
  assert.deepEqual(await workbench.repository.exportState(), before);
});

test('timeline packages reuse Timeline clocks, scope only related items/assets/groups, and include no unrelated history', async context => {
  const workbench = await fixture(context);
  const placed = await workbench.placeExternalMedia({ bytes: png, mimeType: 'image/png', name: '相关.png', requestId: randomUUID(), expectedRevision: 0, startTick: 1234 });
  assert.ok(placed.ok); if (!placed.ok) return;
  const selected = String(placed.outcome.timelineId); const assetId = String(placed.outcome.assetId);
  await action(workbench, 'timeline.create', { typeId: 'pixel.text' });
  await workbench.importMedia({ bytes: png, mimeType: 'image/png', name: '无关.png', requestId: randomUUID(), expectedRevision: (await workbench.snapshot()).revision });
  const group = await action(workbench, 'assetGroup.create', { title: '镜头组' });
  await action(workbench, 'assetGroup.moveAsset', { assetId, groupId: group.outcome.groupId });
  const before = await workbench.repository.exportState();
  const decoded = decodeProjectPackage(await exportProjectPackage(before, workbench.artifacts, new AbortController().signal, selected));
  assert.deepEqual(Object.keys(decoded.state.snapshot.document.timelines), [selected]);
  assert.deepEqual(decoded.state.snapshot.document.timelines[selected], before.snapshot.document.timelines[selected]);
  assert.deepEqual(Object.keys(decoded.state.snapshot.document.assets), [assetId]); assert.equal(decoded.artifacts.length, 1);
  assert.deepEqual(decoded.state.history, []);
  assert.deepEqual(decoded.state.snapshot.document.assetGroups?.[String(group.outcome.groupId)]?.assetIds, [assetId]);
});

test('plain text timelines export as editable packages even when they have no media', async context => {
  const workbench = await fixture(context); const timeline = await action(workbench, 'timeline.create', { typeId: 'pixel.text' });
  const decoded = decodeProjectPackage(await exportProjectPackage(await workbench.repository.exportState(), workbench.artifacts, new AbortController().signal, String(timeline.outcome.timelineId)));
  assert.equal(decoded.artifacts.length, 0); assert.equal(Object.keys(decoded.state.snapshot.document.timelines).length, 1);
});

test('package import refuses traversal, unrelated files, malformed structures and tampered media hashes before any remote writes', async context => {
  const workbench = await fixture(context);
  const result = await workbench.importMedia({ bytes: png, mimeType: 'image/png', name: 'image.png', requestId: randomUUID(), expectedRevision: 0 }); assert.ok(result.ok);
  const archive = await exportProjectPackage(await workbench.repository.exportState(), workbench.artifacts, new AbortController().signal);
  for (const path of ['../project.json', 'media/../../.env', 'secrets.env']) assert.throws(() => decodeProjectPackage(zipSync({ ...unzipSync(archive), [path]: strToU8('bad') }, {level:0})), /不允许/);
  const corrupt = unzipSync(archive); const media = Object.keys(corrupt).find(path => path.startsWith('media/'))!; corrupt[media]![0] = 0;
  assert.throws(() => decodeProjectPackage(zipSync(corrupt, {level:0})), /哈希/);
  assert.throws(() => decodeProjectPackage(new Uint8Array([1, 2, 3])), /工程包/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(exportProjectPackage(await workbench.repository.exportState(), workbench.artifacts, controller.signal));
});

test('media locator changes cannot alter a generation input fingerprint when the asset content is unchanged', () => {
  const id = randomUUID(); const request: GenerationRequest = { projectId: 'p', targetItemId: 'item', generationToken: 'token', inputFingerprint: 'pending', providerId: 'openrouter', providerVersion: '1.0.0', modelId: 'x-ai/grok-imagine-image-2.0', params: { prompt: 'scene' }, settings: {}, references: [{ id, kind: 'image', fileRef: `pixel-asset:${id}`, metadata: { sha256: 'a'.repeat(64), storage: { path: '/old/path' } } }] };
  const before = generationInputFingerprint(request); request.references[0]!.metadata.storage = { path: '/new/path' };
  assert.equal(generationInputFingerprint(request), before);
  request.references[0]!.metadata.sha256 = 'b'.repeat(64); assert.notEqual(generationInputFingerprint(request), before);
});

test('package parser rejects compressed and ZIP64 entries before invoking the ZIP decoder', async context => {
  const workbench = await fixture(context);
  const archive = await exportProjectPackage(await workbench.repository.exportState(), workbench.artifacts, new AbortController().signal);
  assert.throws(() => decodeProjectPackage(zipSync(unzipSync(archive))), /ZIP32/);
  const malformed = new Uint8Array(archive);
  const view = new DataView(malformed.buffer);
  const end = malformed.length - 22;
  const central = view.getUint32(end + 16, true);
  view.setUint32(central + 20, 0xffffffff, true);
  view.setUint16(central + 30, 4, true);
  assert.throws(() => decodeProjectPackage(malformed), /ZIP32/);
});
