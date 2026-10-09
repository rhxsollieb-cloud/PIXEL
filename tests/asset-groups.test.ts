import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assertProjectInvariants, MemoryProjectRepository } from '../src/backend.js';
import { assetGroupTitleSchema, type ActionResult, type CallerContext, type ProjectDocument } from '../src/contracts.js';
import { validateWorkbenchProjectFile } from '../src/project-files.js';
import { createWorkbench, type Workbench } from './local-workbench.js';

function document(): ProjectDocument {
  const ids = [randomUUID(), randomUUID()];
  return { schemaVersion: 1, id: 'project', title: 'Pixel', timelines: {}, items: {},
    assets: Object.fromEntries(ids.map(id => [id, { id, kind: 'image' as const, fileRef: `pixel-asset:${id}`, metadata: {} }])) };
}
function file(document: ProjectDocument) { return { version: 1, snapshot: { revision: 0, document }, requests: {}, history: [], outbox: [] }; }
function grouped(): ProjectDocument {
  const project = document(); const assets = Object.keys(project.assets);
  project.assetGroups = { first: { id: 'first', title: '分镜', assetIds: [assets[0]!] }, second: { id: 'second', title: '分镜', assetIds: [assets[1]!] } };
  return project;
}

test('version-1 projects preserve missing groups, and explicit groups accept independent IDs with the same name', () => {
  const old = document();
  assert.doesNotThrow(() => assertProjectInvariants(old));
  const loaded = validateWorkbenchProjectFile(file(old));
  assert.equal(Object.hasOwn(loaded.snapshot.document, 'assetGroups'), false);
  const project = grouped();
  project.assetGroups!.empty = { id: 'empty', title: '待整理', assetIds: [] };
  assert.doesNotThrow(() => assertProjectInvariants(project));
  assert.deepEqual(validateWorkbenchProjectFile(file(project)).snapshot.document, project);
  assert.equal(assetGroupTitleSchema.parse('  已整理 \n'), '已整理');
  for (const title of ['', '   ', '字'.repeat(81)]) assert.equal(assetGroupTitleSchema.safeParse(title).success, false);
});

test('common project and file validation reject invalid group identity, membership and noncanonical names', () => {
  const cases: ((project: ProjectDocument) => void)[] = [
    project => { project.assetGroups!.first!.id = 'different'; },
    project => { project.assetGroups!.first!.assetIds = ['missing']; },
    project => { project.assetGroups!.first!.assetIds.push(project.assetGroups!.first!.assetIds[0]!); },
    project => { project.assetGroups!.second!.assetIds.push(project.assetGroups!.first!.assetIds[0]!); },
    project => { project.assetGroups!.first!.title = ''; },
    project => { project.assetGroups!.first!.title = '   '; },
    project => { project.assetGroups!.first!.title = '字'.repeat(81); },
    project => { project.assetGroups!.first!.title = ' 未规范化 '; },
    project => { (project.assetGroups!.first as unknown as Record<string, unknown>).extra = 'unknown'; },
    project => { project.assetGroups = [] as unknown as NonNullable<ProjectDocument['assetGroups']>; },
  ];
  for (const corrupt of cases) {
    const project = grouped(); corrupt(project);
    assert.throws(() => assertProjectInvariants(project));
    assert.throws(() => validateWorkbenchProjectFile(file(project)));
  }
});

test('group invariants guard transaction commit and every saved history state without changing the original project', async () => {
  const project = grouped(); const snapshot = { revision: 0, document: project };
  const repository = new MemoryProjectRepository([snapshot]);
  const caller: CallerContext = { actorId: 'test', source: 'gui', projectIds: new Set(['project']), permissions: new Set(['project.edit']) };
  await assert.rejects(repository.commit({ projectId: 'project', requestId: 'bad-membership', expectedRevision: 0, type: 'assetGroup.moveAsset', payload: {} }, caller, draft => {
    draft.assetGroups!.second!.assetIds.push(draft.assetGroups!.first!.assetIds[0]!);
    return { undoable: true, outcome: {} };
  }));
  assert.deepEqual(await repository.read('project'), snapshot); assert.deepEqual(repository.history('project'), []);
  const saved = { ...file(project), history: [{ requestId: 'group-create', before: document(), after: project }] };
  // History documents may omit groups, while present groups must retain all invariants.
  assert.doesNotThrow(() => validateWorkbenchProjectFile(saved));
  saved.history[0]!.after = structuredClone(project); saved.history[0]!.after.assetGroups!.first!.assetIds.push('missing');
  assert.throws(() => validateWorkbenchProjectFile(saved));
});

function success(result: ActionResult) {
  assert.ok(result.ok, result.ok ? undefined : result.error.message);
  if (!result.ok) throw new Error('Expected success');
  return result;
}
async function action(workbench: Workbench, type: string, payload: Record<string, string>) {
  const snapshot = await workbench.snapshot();
  return workbench.execute({ requestId: randomUUID(), projectId: snapshot.document.id, expectedRevision: snapshot.revision, type, payload });
}

test('group Actions share durable membership, retain assets on removal, clean asset deletion and replay after reopening', async context => {
  const root = await mkdtemp(join(tmpdir(), 'pixel-asset-groups-test-'));
  context.after(async () => {
    const checked = resolve(root); assert.equal(dirname(checked), resolve(tmpdir()));
    assert.ok(basename(checked).startsWith('pixel-asset-groups-test-'));
    await rm(checked, { recursive: true, force: true });
  });
  const workbench = await createWorkbench({ directory: root }); context.after(() => workbench.close());
  const imported = success(await workbench.importMedia({
    bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhUYAAAAASUVORK5CYII=', 'base64'),
    mimeType: 'image/png', name: '分镜.png', requestId: randomUUID(), expectedRevision: 0,
  }));
  const assetId = String(imported.outcome.assetId);
  const beforeCreate = await workbench.snapshot();
  const createInput = { requestId: randomUUID(), projectId: workbench.projectId, expectedRevision: beforeCreate.revision, type: 'assetGroup.create', payload: { title: '  分镜  ' } };
  const createReceipt = success(await workbench.execute(createInput)); const first = String(createReceipt.outcome.groupId);
  const second = String(success(await action(workbench, 'assetGroup.create', { title: '分镜' })).outcome.groupId);
  assert.notEqual(first, second);
  success(await action(workbench, 'assetGroup.moveAsset', { assetId, groupId: first }));
  success(await action(workbench, 'assetGroup.moveAsset', { assetId, groupId: second }));
  let snapshot = await workbench.snapshot();
  assert.deepEqual(snapshot.document.assetGroups![first]!.assetIds, []);
  assert.deepEqual(snapshot.document.assetGroups![second]!.assetIds, [assetId]);
  success(await action(workbench, 'assetGroup.rename', { groupId: second, title: '  选用 \n' }));
  assert.equal((await workbench.snapshot()).document.assetGroups![second]!.title, '选用');
  success(await action(workbench, 'assetGroup.moveAsset', { assetId }));
  assert.deepEqual((await workbench.snapshot()).document.assetGroups![second]!.assetIds, []);
  success(await action(workbench, 'assetGroup.moveAsset', { assetId, groupId: second }));
  const beforeInvalid = await workbench.snapshot();
  for (const [type, payload] of [
    ['assetGroup.moveAsset', { assetId, groupId: 'missing' }], ['assetGroup.moveAsset', { assetId: 'missing', groupId: second }],
    ['assetGroup.rename', { groupId: 'missing', title: '有效' }], ['assetGroup.remove', { groupId: 'missing' }],
    ['assetGroup.create', { title: '  ' }], ['assetGroup.rename', { groupId: second, title: '字'.repeat(81) }],
  ] as const) {
    const result = await action(workbench, type, payload); assert.equal(result.ok, false);
    assert.deepEqual(await workbench.snapshot(), beforeInvalid);
  }
  const stale = await workbench.execute({ ...createInput, requestId: randomUUID() });
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, 'REVISION_CONFLICT');
  success(await action(workbench, 'assetGroup.remove', { groupId: second }));
  const asset = await workbench.mediaAsset(assetId);
  assert.ok((await workbench.artifacts.read(asset, new AbortController().signal)).bytes.length > 0);
  assert.ok((await workbench.snapshot()).document.assets[assetId]);
  success(await action(workbench, 'assetGroup.moveAsset', { assetId, groupId: first }));
  success(await action(workbench, 'asset.remove', { assetId }));
  snapshot = await workbench.snapshot();
  assert.deepEqual(snapshot.document.assetGroups![first]!.assetIds, []);
  assert.equal(snapshot.document.assets[assetId], undefined);
  const reopened = await createWorkbench({ directory: root }); context.after(() => reopened.close());
  assert.deepEqual(await reopened.snapshot(), snapshot);
  assert.deepEqual(await reopened.execute(createInput), createReceipt);
  assert.deepEqual(await reopened.snapshot(), snapshot);
  const reused = await reopened.execute({ ...createInput, payload: { title: '其他' } });
  assert.equal(reused.ok, false); if (!reused.ok) assert.equal(reused.error.code, 'REQUEST_ID_REUSED');
});
