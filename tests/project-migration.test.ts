import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ActionResult, DeepReadonly, GenerationJob, GenerationRequest } from '../src/contracts.js';
import { BaseModelProvider, type GenerationOutput, type ProviderRunContext } from '../src/generation.js';
import { generationInputFingerprint } from '../src/generation-fingerprint.js';
import { modelRegistry } from '../src/models.js';
import { importLegacyProject } from '../src/project-migration.js';
import { readWorkbenchProjectFile, type WorkbenchProjectFile } from '../src/project-files.js';
import { SeafileArtifactStore } from '../src/seafile-storage.js';
import { SharedJobRepository, SharedProjectCatalog, SharedVersionedDocument } from '../src/shared-projects.js';
import { FileJobRepository } from '../src/storage.js';
import { GenerationRunner, ProviderRegistry } from '../src/runtime.js';
import { voiceOperationSchema } from '../src/voices.js';
import { createWorkbench as createSharedWorkbench } from '../src/workbench.js';
import { createWorkbench as createLocalWorkbench, captureGenerationRequest, type Workbench } from './local-workbench.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhUYAAAAASUVORK5CYII=', 'base64');
const repoId = '29aab405-8aa0-4592-a9a2-eb1989a72aab';
const origin = 'http://project-migration.example.test';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

/** Minimal real Seafile transport: immutable uploads, directory entries and signed byte reads. */
async function remoteFixture() {
  const files = new Map<string, { bytes: Uint8Array; id: string }>();
  const directories = new Set(['/']);
  const transport: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, origin);
    const method = init.method ?? 'GET'; const path = url.searchParams.get('p') ?? '/';
    if (url.pathname.startsWith('/api2/')) {
      assert.equal(new Headers(init.headers).get('Authorization'), 'Token isolated-test-token');
      if (url.pathname === `/api2/repos/${repoId}/`) return json({ id: repoId, name: 'Pixel', permission: 'rw', encrypted: false });
      if (url.pathname.endsWith('/dir/')) {
        if (method === 'POST') {
          const parts = path.split('/').filter(Boolean);
          for (let index = 1; index <= parts.length; index++) directories.add(`/${parts.slice(0, index).join('/')}`);
          return json('success', 201);
        }
        if (!directories.has(path)) return json({}, 404);
        return json([
          ...[...files.keys()].filter(name => name.slice(0, name.lastIndexOf('/')) === path).map(name => ({ type: 'file', name: name.slice(name.lastIndexOf('/') + 1) })),
          ...[...directories].filter(name => name !== '/' && (name.slice(0, name.lastIndexOf('/')) || '/') === path).map(name => ({ type: 'dir', name: name.slice(name.lastIndexOf('/') + 1) })),
        ]);
      }
      if (url.pathname.endsWith('/upload-link/')) return json(`${origin}/upload-api/link?dir=${encodeURIComponent(path)}`);
      if (url.pathname.endsWith('/file/detail/')) {
        const file = files.get(path); return file ? json({ type: 'file', name: path.slice(path.lastIndexOf('/') + 1), size: file.bytes.length, id: file.id }) : json({}, 404);
      }
      if (url.pathname.endsWith('/file/')) return files.has(path) ? json(`${origin}/files/link?p=${encodeURIComponent(path)}`) : json({}, 404);
    }
    assert.equal(new Headers(init.headers).get('Authorization'), null);
    if (url.pathname.startsWith('/upload-api/')) {
      assert.ok(init.body instanceof FormData); assert.equal(init.body.get('replace'), '0');
      const upload = init.body.get('file'); assert.ok(upload instanceof Blob && 'name' in upload);
      const name = String(upload.name); const directory = String(init.body.get('parent_dir'));
      assert.equal(directory, url.searchParams.get('dir'));
      const bytes = new Uint8Array(await upload.arrayBuffer()); const id = createHash('sha1').update(bytes).digest('hex');
      const destination = `${directory}/${name}`;
      if (files.has(destination)) return json([{ name: `${name} (1)`, id, size: bytes.length }]);
      files.set(destination, { bytes, id }); return json([{ name, id, size: bytes.length }]);
    }
    if (url.pathname.startsWith('/files/')) {
      const file = files.get(path); return file ? new Response(new Uint8Array(file.bytes), { headers: { 'Content-Length': String(file.bytes.length) } }) : json({}, 404);
    }
    throw new Error('Unexpected isolated Seafile request');
  };
  const store = await SeafileArtifactStore.open({ serverUrl: `${origin}/`, token: 'isolated-test-token', repoId,
    libraryName: 'Pixel', rootPath: '/pixel', allowedFileOrigins: [origin], timeoutMs: 1000, maxBytes: 1024 * 1024 }, { fetch: transport });
  return { store, projects: new SharedProjectCatalog(store), files };
}

async function root(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-project-migration-'));
  t.after(async () => {
    const checked = resolve(directory); assert.equal(dirname(checked), resolve(tmpdir())); assert.ok(basename(checked).startsWith('pixel-project-migration-'));
    await rm(checked, { recursive: true, force: true });
  });
  return directory;
}
function success(result: ActionResult) { assert.equal(result.ok, true, result.ok ? undefined : result.error.message); if (!result.ok) throw new Error('Expected action success'); return result; }
async function action(workbench: Workbench, type: string, payload: Record<string, string | number>) {
  return success(await workbench.execute({ projectId: workbench.projectId, requestId: randomUUID(), expectedRevision: (await workbench.snapshot()).revision, type, payload }));
}
async function legacy(directory: string, options: { title?: string; media?: boolean; draft?: boolean } = {}) {
  const workbench = await createLocalWorkbench({ directory });
  await action(workbench, 'project.title', { title: options.title ?? '旧作品' });
  let assetId: string | undefined; let itemId: string | undefined;
  if (options.media) assetId = String(success(await workbench.importMedia({ bytes: png, mimeType: 'image/png', name: 'original.png', requestId: randomUUID(), expectedRevision: (await workbench.snapshot()).revision })).outcome.assetId);
  if (options.draft) {
    const timelineId = String((await action(workbench, 'timeline.create', { typeId: 'alibaba/wan-3.0' })).outcome.timelineId);
    itemId = String((await action(workbench, 'item.createDraft', { timelineId, startTick: 0 })).outcome.itemId);
    success(await workbench.execute({ projectId: workbench.projectId, requestId: randomUUID(), expectedRevision: (await workbench.snapshot()).revision, type: 'item.params', payload: { itemId, params: { prompt: 'Migration test shot' } } }));
  }
  const snapshot = await workbench.snapshot(); await workbench.shutdown();
  return { projectId: snapshot.document.id, snapshot, ...(assetId ? { assetId } : {}), ...(itemId ? { itemId } : {}) };
}
async function originals(directory: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child); else if (entry.isFile()) files.set(relative(directory, child), await readFile(child));
    }
  }
  await walk(directory); return files;
}

test('central legacy ingress preserves all originals, revision/history and opaque media identity', async t => {
  const directory = await root(t); const source = await legacy(directory, { media: true });
  const before = await originals(directory); const old = await readWorkbenchProjectFile(directory, { validateResources: false });
  const { store, projects, files } = await remoteFixture();
  const destinationId = await importLegacyProject(directory, store, projects);
  const imported = await projects.state(destinationId);
  assert.notEqual(destinationId, source.projectId); assert.match(destinationId, /^[a-f0-9-]{36}$/);
  assert.equal(imported.snapshot.revision, old.snapshot.revision); assert.equal(imported.history.length, old.history.length);
  assert.ok(imported.history.every(entry => entry.before.id === destinationId && entry.after.id === destinationId));
  assert.deepEqual(imported.requests, {}); assert.deepEqual(imported.outbox, []);
  const asset = imported.snapshot.document.assets[source.assetId!]!;
  assert.equal(asset.fileRef, old.snapshot.document.assets[asset.id]!.fileRef);
  assert.deepEqual((await store.read(asset, new AbortController().signal)).bytes, new Uint8Array(png));
  assert.ok(files.has(`/pixel/media/${asset.id}.png`));
  assert.ok([...files.keys()].some(path => path.startsWith(`/pixel/projects/${destinationId}/state/`) && path.endsWith('/000000000000.json')));
  assert.equal(JSON.stringify(imported).includes('"storage"'), false);
  assert.deepEqual(await originals(directory), before);
});

test('reopening the same source path and unchanged state reuses one remote destination and no extra publications', async t => {
  const directory = await root(t); await legacy(directory, { media: true });
  const { store, projects, files } = await remoteFixture();
  const first = await importLegacyProject(directory, store, projects); const count = files.size;
  const second = await importLegacyProject(join(directory, '.'), store, projects);
  assert.equal(second, first); assert.equal(files.size, count); assert.equal((await projects.list()).items.length, 1);
});

test('different source directories carrying the old pixel-project ID remain separate shared projects', async t => {
  const base = await root(t); const first = join(base, 'first'); const second = join(base, 'second');
  const left = await legacy(first, { title: '作品甲' }); const right = await legacy(second, { title: '作品乙' });
  assert.equal(left.projectId, 'pixel-project'); assert.equal(right.projectId, left.projectId);
  const originalFirst = await originals(first); const originalSecond = await originals(second);
  const { store, projects } = await remoteFixture();
  const leftId = await importLegacyProject(first, store, projects); const rightId = await importLegacyProject(second, store, projects);
  assert.notEqual(leftId, rightId); assert.equal((await projects.state(leftId)).snapshot.document.title, '作品甲');
  assert.equal((await projects.state(rightId)).snapshot.document.title, '作品乙'); assert.equal((await projects.list()).items.length, 2);
  assert.deepEqual(await originals(first), originalFirst); assert.deepEqual(await originals(second), originalSecond);
});

test('old active jobs import as interrupted with their provider task identity, and opening cannot auto-submit', async t => {
  const directory = await root(t); const source = await legacy(directory, { draft: true });
  const captured = captureGenerationRequest(source.snapshot.document, source.snapshot.document.items[source.itemId!]!);
  const localJobs = new FileJobRepository(join(directory, 'jobs')); const ids: string[] = [];
  for (const state of ['queued', 'running', 'cancelRequested'] as const) {
    const id = randomUUID(); ids.push(id); const now = new Date().toISOString();
    await localJobs.create({ id, state, request: captured, attempt: 2, progress: 0.3, artifactIds: [], createdAt: now, updatedAt: now,
      ...(state !== 'queued' ? { providerTaskId: `original-${state}` } : {}) });
  }
  const path = join(directory, 'project.json'); const file = JSON.parse(await readFile(path, 'utf8')) as WorkbenchProjectFile;
  file.outbox.push({ id: randomUUID(), operation: 'start', jobId: ids[0]!, itemId: source.itemId!, request: captured, done: false });
  await writeFile(path, JSON.stringify(file)); const before = await originals(directory);
  const { store, projects } = await remoteFixture(); const destinationId = await importLegacyProject(directory, store, projects);
  const jobs = new SharedJobRepository(store, destinationId);
  for (const [index, state] of ['queued', 'running', 'cancelRequested'].entries()) {
    const job = await jobs.get(ids[index]!); assert.ok(job); assert.equal(job.state, 'interrupted'); assert.equal(job.attempt, 2);
    assert.equal(job.request.projectId, destinationId); assert.equal(job.request.inputFingerprint, generationInputFingerprint(job.request));
    assert.equal(job.error?.code, 'LEGACY_IMPORTED'); assert.equal(job.error?.retryable, false);
    assert.equal(job.providerTaskId, state === 'queued' ? undefined : `original-${state}`);
  }
  class CountedProvider extends BaseModelProvider {
    readonly manifest = { providerId: 'openrouter', providerVersion: modelRegistry.resolve('alibaba/wan-3.0').providerVersion, modelIds: ['alibaba/wan-3.0'], supportsCancellation: true };
    calls = 0;
    protected async performGeneration(_input: DeepReadonly<GenerationRequest>, _context: ProviderRunContext): Promise<GenerationOutput> { this.calls++; throw new Error('Unexpected automatic supplier call'); }
  }
  const provider = new CountedProvider(); const providers = new ProviderRegistry(); providers.register(provider);
  const runner = new GenerationRunner(providers, jobs, store);
  const opened = await createSharedWorkbench({ repository: await projects.repository(destinationId), artifacts: store, runner });
  await opened.shutdown(); assert.equal(provider.calls, 0);
  assert.deepEqual((await projects.state(destinationId)).outbox, []); assert.deepEqual(await originals(directory), before);
});

test('a changed job ledger creates a new migration version even when project.json is unchanged', async t => {
  const directory = await root(t); const source = await legacy(directory, { draft: true });
  const captured = captureGenerationRequest(source.snapshot.document, source.snapshot.document.items[source.itemId!]!); const id = randomUUID(); const now = new Date().toISOString();
  const job: GenerationJob = { id, request: captured, state: 'queued', attempt: 1, progress: 0, artifactIds: [], createdAt: now, updatedAt: now };
  const local = new FileJobRepository(join(directory, 'jobs')); await local.create(job);
  const projectBefore = await readFile(join(directory, 'project.json'));
  const { store, projects } = await remoteFixture(); const first = await importLegacyProject(directory, store, projects);
  await writeFile(join(directory, 'jobs', `${id}.json`), JSON.stringify({ ...job, state: 'failed', error: { code: 'OLD_FAILURE', message: 'Original result', retryable: false } }));
  const second = await importLegacyProject(directory, store, projects);
  assert.notEqual(second, first); assert.equal((await new SharedJobRepository(store, first).get(id))?.state, 'interrupted');
  assert.equal((await new SharedJobRepository(store, second).get(id))?.state, 'failed');
  assert.deepEqual(await readFile(join(directory, 'project.json')), projectBefore);
});

test('legacy first-frame jobs retain their reference role and still match the migrated Item fingerprint', async t => {
  const directory = await root(t); const source = await legacy(directory, { draft: true, media: true });
  const workbench = await createLocalWorkbench({ directory });
  await action(workbench, 'item.reference.add', { itemId: source.itemId!, assetId: source.assetId! });
  success(await workbench.execute({ projectId: workbench.projectId, requestId: randomUUID(), expectedRevision: (await workbench.snapshot()).revision,
    type: 'item.params', payload: { itemId: source.itemId!, params: { prompt: 'First frame shot', referenceMode: 'firstFrame' } } }));
  const snapshot = await workbench.snapshot(); await workbench.shutdown();
  const request = captureGenerationRequest(snapshot.document, snapshot.document.items[source.itemId!]!);
  assert.equal(request.references[0]?.role, 'first-frame');
  const jobId = randomUUID(); const now = new Date().toISOString();
  await new FileJobRepository(join(directory, 'jobs')).create({ id: jobId, request, state: 'running', attempt: 1, progress: 0, artifactIds: [],
    providerTaskId: 'recover-original-first-frame', createdAt: now, updatedAt: now });
  const { store, projects } = await remoteFixture(); const id = await importLegacyProject(directory, store, projects);
  const migrated = await projects.state(id); const job = await new SharedJobRepository(store, id).get(jobId);
  assert.equal(job?.request.references[0]?.role, 'first-frame');
  const current = captureGenerationRequest(migrated.snapshot.document, migrated.snapshot.document.items[source.itemId!]!);
  assert.equal(job?.request.inputFingerprint, current.inputFingerprint);
});

test('central ingress migrates old voice clone outcomes without recreating or changing the local operation', async t => {
  const directory = await root(t); await legacy(directory);
  const operation = voiceOperationSchema.parse({ version: 1, command: 'voice.clone', accountScope: 'account-fingerprint', requestId: 'old-clone-request',
    fingerprint: 'a'.repeat(64), state: 'succeeded', createdAt: 1, updatedAt: 2,
    result: { requestId: 'old-clone-request', voice: { voiceId: 'old-voice-id', name: '原音色', category: 'cloned', status: 'ready' } } });
  const key = createHash('sha256').update(`${operation.accountScope}\0${operation.requestId}`).digest('hex');
  await mkdir(join(directory, 'voice-operations')); const path = join(directory, 'voice-operations', `${key}.json`);
  await writeFile(path, JSON.stringify(operation)); const before = await originals(directory);
  const { store, projects } = await remoteFixture();
  const destinationId = await importLegacyProject(directory, store, projects);
  assert.ok(await projects.state(destinationId));
  assert.deepEqual((await new SharedVersionedDocument(store, `operations/${key}`, value => voiceOperationSchema.parse(value)).read())?.value, operation);
  assert.deepEqual(await originals(directory), before);
  const repeated = await importLegacyProject(directory, store, projects); assert.equal(repeated, destinationId);
});
