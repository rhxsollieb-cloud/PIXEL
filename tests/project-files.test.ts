import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbench, captureGenerationRequest, type Workbench } from '../src/workbench.js';
import { preparePixelProjectLocation, readWorkbenchProjectFile } from '../src/project-files.js';
import { FileArtifactStore, FileJobRepository } from '../src/storage.js';
import { createWorkbenchFixture } from './workbench-fixtures.js';
import type { ActionResult } from '../src/contracts.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhUYAAAAASUVORK5CYII=', 'base64');
async function root(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-project-files-test-'));
  context.after(async () => {
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith('pixel-project-files-test-'));
    await rm(absolute, { recursive: true, force: true });
  });
  return directory;
}
function success(result: ActionResult) { assert.equal(result.ok, true, result.ok ? undefined : result.error.message); if (!result.ok) throw new Error('Expected success'); return result; }
async function title(workbench: Workbench, value: string) {
  return workbench.execute({ requestId: randomUUID(), projectId: workbench.projectId, expectedRevision: (await workbench.snapshot()).revision, type: 'project.title', payload: { title: value } });
}

test('an empty directory becomes its own persistent project while an existing project opens by folder or project.json', async context => {
  const base = await root(context);
  const directory = join(base, '测试'); await mkdir(directory);
  const location = await preparePixelProjectLocation(directory);
  assert.equal(location.existing, false);
  assert.equal(location.initial?.document.title, '测试');
  assert.match(location.initial!.document.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await readdir(directory), []); // Preparation is read-only.
  const workbench = await createWorkbench({ directory: location.directory, initial: location.initial! });
  context.after(() => workbench.shutdown());
  assert.equal(workbench.projectId, location.initial!.document.id);
  success(await title(workbench, '已保存作品'));
  const bytes = await readFile(join(directory, 'project.json'));
  const byFolder = await preparePixelProjectLocation(directory);
  const byFile = await preparePixelProjectLocation(join(directory, 'project.json'));
  assert.deepEqual(byFile, byFolder);
  assert.equal(byFolder.existing, true);
  assert.equal(byFolder.initial, undefined);
  assert.deepEqual(await readFile(join(directory, 'project.json')), bytes);
  const reopened = await createWorkbench({ directory }); context.after(() => reopened.shutdown());
  assert.deepEqual(await reopened.snapshot(), await workbench.snapshot());
  success(await title(reopened, '重开后可编辑'));
});

test('opening another project never moves or overwrites the original and stale sessions cannot edit', async context => {
  const base = await root(context);
  const first = await createWorkbench({ directory: join(base, 'original') }); context.after(() => first.shutdown());
  success(await title(first, '原作品'));
  const originalFile = await readFile(join(base, 'original', 'project.json'));
  await mkdir(join(base, 'second'));
  const location = await preparePixelProjectLocation(join(base, 'second'));
  await first.shutdown();
  const closed = await title(first, '不应写入');
  assert.equal(closed.ok, false); if (!closed.ok) assert.equal(closed.error.code, 'NOT_APPLICABLE');
  const imported = await first.importMedia({ bytes: png, mimeType: 'image/png', name: 'stale.png', requestId: randomUUID(), expectedRevision: 1 });
  assert.equal(imported.ok, false); if (!imported.ok) assert.equal(imported.error.code, 'NOT_APPLICABLE');
  const second = await createWorkbench({ directory: location.directory, initial: location.initial! }); context.after(() => second.shutdown());
  success(await title(second, '新作品'));
  assert.notEqual(second.projectId, first.projectId);
  assert.deepEqual(await readFile(join(base, 'original', 'project.json')), originalFile);
  assert.equal((await second.snapshot()).document.title, '新作品');
});

test('ordinary folders, arbitrary JSON, environment files and zero-byte files are rejected without changes', async context => {
  const base = await root(context);
  const nonempty = join(base, 'media'); await mkdir(nonempty); await writeFile(join(nonempty, 'photo.png'), png);
  await assert.rejects(preparePixelProjectLocation(nonempty), /不是 Pixel 项目/);
  assert.deepEqual(await readdir(nonempty), ['photo.png']);
  for (const name of ['unknown.json', '.env', 'empty.pixel']) {
    const path = join(base, name); const bytes = name === 'unknown.json' ? Buffer.from('{"title":"not a project"}') : Buffer.alloc(0);
    await writeFile(path, bytes);
    await assert.rejects(preparePixelProjectLocation(path), /project\.json/);
    assert.deepEqual(await readFile(path), bytes);
  }
  const malformed = join(base, 'malformed'); await mkdir(malformed); await writeFile(join(malformed, 'project.json'), '{}');
  await assert.rejects(preparePixelProjectLocation(malformed), /不是可打开的 Pixel 项目/);
  assert.equal(await readFile(join(malformed, 'project.json'), 'utf8'), '{}');
  await assert.rejects(preparePixelProjectLocation('relative-folder'), /绝对路径/);
});

test('strict project validation rejects unknown keys, wrong plugin versions and forged media handles', async context => {
  const base = await root(context);
  const workbench = await createWorkbench({ directory: base, initial: createWorkbenchFixture() }); context.after(() => workbench.shutdown());
  const original = await readFile(join(base, 'project.json'), 'utf8');
  const variants: unknown[] = [];
  const unknown = JSON.parse(original); unknown.environment = { credentials: 'untrusted' }; variants.push(unknown);
  const badVersion = JSON.parse(original); Object.values<{ pluginVersion: number }>(badVersion.snapshot.document.timelines)[0]!.pluginVersion = 2; variants.push(badVersion);
  const badHandle = JSON.parse(original); const assetId = randomUUID();
  badHandle.snapshot.document.assets[assetId] = { id: assetId, kind: 'image', fileRef: '../.env', metadata: { mimeType: 'image/png', extension: 'png' } }; variants.push(badHandle);
  for (const variant of variants) {
    const text = JSON.stringify(variant); await writeFile(join(base, 'project.json'), text);
    await assert.rejects(preparePixelProjectLocation(base));
    assert.equal(await readFile(join(base, 'project.json'), 'utf8'), text);
  }
});

test('project assets reopen with media and missing files fail before switching', async context => {
  const base = await root(context);
  const workbench = await createWorkbench({ directory: base }); context.after(() => workbench.shutdown());
  const receipt = success(await workbench.importMedia({ bytes: png, mimeType: 'image/png', name: 'sample.png', requestId: randomUUID(), expectedRevision: 0 }));
  const asset = (await workbench.snapshot()).document.assets[String(receipt.outcome.assetId)]!;
  assert.equal((await preparePixelProjectLocation(base)).existing, true);
  const reopened = await createWorkbench({ directory: base }); context.after(() => reopened.shutdown());
  assert.deepEqual((await reopened.artifacts.read(asset, new AbortController().signal)).bytes, png);
  const path = await workbench.artifacts.resolvePath(asset); await rm(path);
  await assert.rejects(preparePixelProjectLocation(base), /素材文件缺失/);
  assert.equal((await workbench.snapshot()).document.assets[asset.id]!.id, asset.id);
});

test('untrusted pending outbox or running ledger cannot auto-start models; completed and interrupted records are preserved', async context => {
  const base = await root(context);
  const initial = createWorkbenchFixture();
  const workbench = await createWorkbench({ directory: base, initial }); context.after(() => workbench.shutdown());
  const document = (await workbench.snapshot()).document;
  const item = Object.values(document.items).find(candidate => candidate.kind === 'image.generated')!;
  const request = captureGenerationRequest(document, item);
  const path = join(base, 'project.json'); const file = JSON.parse(await readFile(path, 'utf8'));
  file.outbox.push({ id: randomUUID(), operation: 'start', jobId: randomUUID(), itemId: item.id, request, done: false });
  await writeFile(path, JSON.stringify(file));
  await assert.rejects(preparePixelProjectLocation(base), /待处理的生成任务/);
  assert.equal((await readWorkbenchProjectFile(base)).outbox[0]!.done, false);
  file.outbox[0].done = true; await writeFile(path, JSON.stringify(file));
  assert.equal((await preparePixelProjectLocation(base)).existing, true);
  const jobs = new FileJobRepository(join(base, 'jobs'));
  const jobId = randomUUID(); const now = new Date().toISOString();
  await jobs.create({ id: jobId, request, state: 'running', attempt: 1, progress: 0.1, artifactIds: [], createdAt: now, updatedAt: now });
  await assert.rejects(preparePixelProjectLocation(base), /未结束的生成任务/);
  await jobs.update({ attemptToken: { jobId, attempt: 1 }, states: ['running'] }, current => ({ ...current, request: structuredClone(current.request) as typeof request, artifactIds: [], state: 'interrupted', updatedAt: now }));
  assert.equal((await preparePixelProjectLocation(base)).existing, true);
  assert.equal((await jobs.get(jobId))!.state, 'interrupted');
  assert.equal((await readWorkbenchProjectFile(base)).outbox[0]!.done, true);
});

test('project and live artifact reads reject directory links outside controlled storage', async context => {
  const base = await root(context);
  const project = join(base, 'project'); const outside = join(base, 'outside'); await mkdir(project); await mkdir(outside);
  const workbench = await createWorkbench({ directory: project }); context.after(() => workbench.shutdown());
  const artifact = await new FileArtifactStore(join(outside, 'artifacts')).write({ attemptToken: { jobId: 'import_fixture', attempt: 1 }, bytes: png, kind: 'image', metadata: { mimeType: 'image/png' } });
  await symlink(join(outside, 'artifacts'), join(project, 'artifacts'), 'junction');
  const file = JSON.parse(await readFile(join(project, 'project.json'), 'utf8')); file.snapshot.document.assets[artifact.id] = artifact.asset;
  await writeFile(join(project, 'project.json'), JSON.stringify(file));
  await assert.rejects(preparePixelProjectLocation(project), /超出了项目目录/);
  await assert.rejects(workbench.artifacts.get(artifact.id), /超出了项目存储范围/);
  await assert.rejects(workbench.artifacts.resolvePath(artifact.asset), /超出了项目存储范围/);
});

test('new project publication never overwrites a file created after directory preparation', async context => {
  const base = await root(context);
  const location = await preparePixelProjectLocation(base);
  const concurrent = await createWorkbench({ directory: base }); context.after(() => concurrent.shutdown());
  success(await title(concurrent, '并发写入的作品'));
  const bytes = await readFile(join(base, 'project.json'));
  const opened = await createWorkbench({ directory: location.directory, initial: location.initial! }); context.after(() => opened.shutdown());
  assert.equal((await opened.snapshot()).document.title, '并发写入的作品');
  assert.deepEqual(await readFile(join(base, 'project.json')), bytes);
});
