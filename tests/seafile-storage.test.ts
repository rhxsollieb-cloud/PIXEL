import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { DeepReadonly, GenerationArtifact, GenerationRequest } from '../src/contracts.js';
import { loadSeafileConfiguration, type SeafileConfiguration } from '../src/backend-configuration.js';
import { BaseModelProvider, ProviderError, type ProviderRunContext } from '../src/generation.js';
import { SeafileArtifactStore } from '../src/seafile-storage.js';
import { SharedProjectCatalog, SharedVersionedDocument } from '../src/shared-projects.js';
import { startWorkbenchServer } from '../src/server.js';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const repoId = '29aab405-8aa0-4592-a9a2-eb1989a72aab';
const serverUrl = 'http://seafile.example.test/';
const privateToken = 'private-test-token';
function configuration(overrides: Partial<SeafileConfiguration> = {}): SeafileConfiguration {
  return { serverUrl, token: privateToken, libraryName: 'Pixel', rootPath: '/pixel', allowedFileOrigins: [new URL(serverUrl).origin], timeoutMs: 1000, maxBytes: 32, ...overrides };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

/** HTTP request/response fixture, including Seafile's signed links and actual FormData bodies. */
function remote() {
  const files = new Map<string, { bytes: Uint8Array; id: string }>();
  const directories = new Set(['/']);
  const requests: Array<{ method: string; path: string }> = [];
  let libraries = [{ id: repoId, name: 'Pixel', permission: 'rw', encrypted: false }];
  const controls = { failIndex: false, untrustedLink: false, rangeIgnored: false, badRange: false, delayed: false, unauthorized: false, holdMediaUpload: false, creations: 0, uploads: 0 };
  let mediaStarted: () => void = () => {};
  const mediaUploadStarted = new Promise<void>(resolve => { mediaStarted = resolve; });
  const transport: typeof fetch = async (input, init = {}) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    requests.push({ method, path: url.pathname });
    if (controls.delayed) return new Promise<Response>((_resolve, reject) => {
      if (init.signal?.aborted) reject(init.signal.reason);
      else init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    if (url.pathname.startsWith('/api2/')) {
      if (url.pathname === '/api2/auth-token/') {
        assert.ok(init.body instanceof URLSearchParams); assert.equal(init.body.get('username'), 'private-account'); assert.equal(init.body.get('password'), 'private-password');
        return json({ token: privateToken });
      }
      assert.equal(headers.get('Authorization'), `Token ${privateToken}`);
      if (controls.unauthorized) return json({ error: 'private-account private-password private-test-token' }, 403);
      if (url.pathname === '/api2/repos/') {
        if (method === 'POST') { controls.creations++; libraries = [{ id: repoId, name: 'Pixel', permission: 'rw', encrypted: false }]; return json({ repo_id: repoId }); }
        return json(libraries);
      }
      if (url.pathname === `/api2/repos/${repoId}/`) return json(libraries[0]);
      const path = url.searchParams.get('p') ?? '/';
      if (url.pathname.endsWith('/dir/')) {
        if (method === 'POST') { assert.ok(init.body instanceof URLSearchParams); assert.equal(init.body.get('operation'), 'mkdir'); const parts = path.split('/').filter(Boolean); for (let i = 1; i <= parts.length; i++) directories.add(`/${parts.slice(0, i).join('/')}`); return json('success', 201); }
        if (!directories.has(path)) return json({}, 404);
        return json([... [...files.keys()].filter(file => file.slice(0, file.lastIndexOf('/')) === path).map(file => ({ type: 'file', name: file.slice(file.lastIndexOf('/') + 1) })), ...[...directories].filter(dir => dir !== '/' && (dir.slice(0, dir.lastIndexOf('/')) || '/') === path).map(dir => ({ type: 'dir', name: dir.slice(dir.lastIndexOf('/') + 1) }))]);
      }
      if (url.pathname.endsWith('/upload-link/')) return json(`${controls.untrustedLink ? 'http://attacker.example.test' : new URL(serverUrl).origin}/upload-api/link?dir=${encodeURIComponent(path)}`);
      if (url.pathname.endsWith('/file/detail/')) {
        const file = files.get(path); if (!file) return json({}, 404);
        return json({ type: 'file', name: path.slice(path.lastIndexOf('/') + 1), size: file.bytes.length, id: file.id });
      }
      if (url.pathname.endsWith('/file/')) {
        if (!files.has(path)) return json({}, 404);
        return json(`${controls.untrustedLink ? 'http://attacker.example.test' : new URL(serverUrl).origin}/files/link?p=${encodeURIComponent(path)}`);
      }
    }
    assert.equal(headers.get('Authorization'), null, 'signed file URLs must not receive an account token');
    assert.equal(url.origin, new URL(serverUrl).origin, 'never contact an untrusted file origin');
    if (url.pathname.startsWith('/upload-api/')) {
      assert.ok(init.body instanceof FormData);
      const directory = String(init.body.get('parent_dir'));
      assert.equal(directory, url.searchParams.get('dir')); assert.equal(init.body.get('replace'), '0');
      const file = init.body.get('file'); assert.ok(file instanceof Blob && 'name' in file);
      const name = String(file.name); const path = `${directory}/${name}`;
      controls.uploads++;
      if (controls.failIndex && name.endsWith('.json')) return json({ error: 'private-password' }, 503);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const id = createHash('sha1').update(bytes).digest('hex');
      if (files.has(path)) return json([{ name: `${name} (1)`, id, size: bytes.length }]);
      files.set(path, { bytes, id });
      if (!name.endsWith('.json')) {
        mediaStarted();
        if (controls.holdMediaUpload) return new Promise<Response>((_resolve, reject) => {
          if (init.signal?.aborted) reject(init.signal.reason);
          else init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      return json([{ name, id, size: bytes.length }]);
    }
    if (url.pathname.startsWith('/files/')) {
      const file = files.get(String(url.searchParams.get('p'))); if (!file) return json({}, 404);
      const range = headers.get('Range');
      if (range && !controls.rangeIgnored) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range)!; const start = Number(match[1]); const end = Number(match[2]);
        return new Response(new Uint8Array(file.bytes.slice(start, end + 1)), { status: 206, headers: { 'Content-Range': controls.badRange ? 'bytes 0-1/999' : `bytes ${start}-${end}/${file.bytes.length}` } });
      }
      return new Response(new Uint8Array(file.bytes), { headers: { 'Content-Length': String(file.bytes.length) } });
    }
    throw new Error('unhandled mock API request');
  };
  return { transport, files, directories, requests, controls, mediaUploadStarted, setLibraries: (value: typeof libraries) => { libraries = value; } };
}

test('Seafile configuration reads existing credentials and validates remote scope without revealing secrets', async () => {
  const cfg = await loadSeafileConfiguration({ envPath: 'does-not-exist.pixel-test.env', environment: {
    SEAFILE_URL: 'http://seafile.example.test', SEAFILE_PORT: '8080', SEAFILE_ADMIN_EMAIL: 'private-account', SEAFILE_ADMIN_PASSWORD: 'private-password',
  } });
  assert.equal(new URL(cfg.serverUrl).port, '8080'); assert.equal(cfg.username, 'private-account'); assert.equal(cfg.rootPath, '/pixel'); assert.equal(cfg.libraryName, 'Pixel');
  const tokenCfg = await loadSeafileConfiguration({ envPath: 'does-not-exist.pixel-test.env', environment: { SEAFILE_URL: serverUrl, SEAFILE_TOKEN: privateToken, SEAFILE_REPO_ID: repoId } });
  assert.equal(tokenCfg.token, privateToken); assert.equal(tokenCfg.username, undefined);
  for (const environment of [
    { SEAFILE_URL: 'https://private-account:private-password@example.test', SEAFILE_TOKEN: privateToken },
    { SEAFILE_URL: serverUrl, SEAFILE_TOKEN: privateToken, SEAFILE_ROOT_PATH: '/pixel/../secret' },
    { SEAFILE_URL: serverUrl, SEAFILE_TOKEN: privateToken, SEAFILE_PORT: '90000' },
    { SEAFILE_URL: 'https://seafile.example.test/', SEAFILE_TOKEN: privateToken, SEAFILE_FILE_SERVER_URL: 'http://seafile.example.test/' },
    { SEAFILE_URL: serverUrl, SEAFILE_ADMIN_PASSWORD: 'private-password' },
  ]) await assert.rejects(loadSeafileConfiguration({ envPath: 'does-not-exist.pixel-test.env', environment }), error => error instanceof ProviderError && !/private-password|private-account|private-test-token/.test(error.message));
});

test('Seafile project versions are create-only and stale publication cannot overwrite the shared winner', async () => {
  const fixture = remote(); const store = await SeafileArtifactStore.open(configuration(), { fetch: fixture.transport });
  const catalog = new SharedProjectCatalog(store); const id = await catalog.create('Seafile 作品');
  assert.equal((await catalog.list()).items[0]?.id, id);
  const file = new SharedVersionedDocument(store, 'operations/cas-test', value => value);
  await file.publish(undefined, { revision: 0 }); const current = await file.read();
  const results = await Promise.allSettled([file.publish(current, { revision: 1, actor: 'A' }), file.publish(current, { revision: 1, actor: 'B' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(fixture.requests.some(request => request.method === 'PUT' || request.method === 'DELETE'), false);
  assert.ok(fixture.files.has(`/pixel/projects/${id}/state/part-000000000/000000000000.json`));
});

test('explicit file-service mapping routes internal advertised ports through the configured origin and rejects foreign hosts', async () => {
  const fixture = remote();
  const mappedTransport: typeof fetch = async (input, init) => {
    const response = await fixture.transport(input, init);
    const url = new URL(String(input));
    if (response.ok && (url.pathname.endsWith('/upload-link/') || url.pathname.endsWith('/file/'))) {
      const advertised = new URL(await response.json() as string); advertised.port = '8090';
      return json(advertised.href);
    }
    return response;
  };
  const store = await SeafileArtifactStore.open(configuration({ fileServerUrl: serverUrl }), { fetch: mappedTransport });
  const artifact = await store.write({ attemptToken: { jobId: 'mapped', attempt: 1 }, kind: 'image', metadata: { mimeType: 'image/png' }, bytes: new Uint8Array([1, 2, 3]) });
  assert.deepEqual((await store.read(artifact.asset, new AbortController().signal)).bytes, new Uint8Array([1, 2, 3]));
  fixture.controls.untrustedLink = true;
  await assert.rejects(store.read(artifact.asset, new AbortController().signal), /未经配置/);
});

test('a new team host can open another project when the first is occupied without stealing its lease', async t => {
  const fixture = remote(); const store = await SeafileArtifactStore.open(configuration(), { fetch: fixture.transport });
  const catalog = new SharedProjectCatalog(store); await catalog.create('Project A', 'A'); await catalog.create('Project B', 'B');
  const first = await startWorkbenchServer({ artifacts: store, projectId: 'A', apiPort: 0, providers: { elevenlabs: false, openrouter: false } });
  t.after(() => first.shutdown());
  const second = await startWorkbenchServer({ artifacts: store, directory: 'does-not-exist.pixel-team-test', apiPort: 0, providers: { elevenlabs: false, openrouter: false } });
  t.after(() => second.shutdown());
  assert.equal(first.workbench.projectId, 'A'); assert.equal(second.workbench.projectId, 'B');
  await assert.rejects(startWorkbenchServer({ artifacts: store, projectId: 'A', apiPort: 0, providers: { elevenlabs: false, openrouter: false } }), /其他 Pixel/);
  assert.equal((await catalog.state('A')).snapshot.document.title, 'Project A');
});

test('moved and renamed media is recovered by SHA256 without changing asset identity or project state', async () => {
  const fixture = remote(); const store = await SeafileArtifactStore.open(configuration(), { fetch: fixture.transport });
  const artifact = await store.write({ attemptToken: { jobId: 'job', attempt: 1 }, kind: 'image', metadata: { mimeType: 'image/png' }, bytes: new Uint8Array([1, 2, 3]) });
  const original = `/pixel/media/${artifact.id}.png`; const moved = '/team/storyboards/renamed-picture.dat';
  fixture.directories.add('/team'); fixture.directories.add('/team/storyboards');
  fixture.files.set(moved, fixture.files.get(original)!); fixture.files.delete(original);
  await assert.rejects(store.stat(artifact.asset), /不存在/);
  const before = structuredClone(artifact);
  const report = await store.recoverMedia([artifact.asset], new AbortController().signal);
  assert.deepEqual(report.repaired, [artifact.id]); assert.deepEqual(report.missing, []);
  assert.deepEqual(artifact, before);
  assert.equal((await store.get(artifact.id))?.asset.fileRef, before.asset.fileRef);
  assert.deepEqual((await store.read(artifact.asset, new AbortController().signal)).bytes, new Uint8Array([1, 2, 3]));
  assert.deepEqual((await store.readRange(artifact.asset, { start: 1, end: 2 }, new AbortController().signal)).bytes, new Uint8Array([2, 3]));
  assert.equal(fixture.files.has(original), false, 'recovery links to the moved file rather than copying it back');
});

test('hash recovery rejects same-size wrong content and cancellation without publishing a location', async () => {
  const fixture = remote(); const store = await SeafileArtifactStore.open(configuration(), { fetch: fixture.transport });
  const artifact = await store.write({ attemptToken: { jobId: 'job', attempt: 1 }, kind: 'image', metadata: { mimeType: 'image/png' }, bytes: new Uint8Array([1, 2, 3]) });
  fixture.files.delete(`/pixel/media/${artifact.id}.png`);
  fixture.files.set(`/pixel/media/guess.png`, { bytes: new Uint8Array([4, 5, 6]), id: 'a'.repeat(40) });
  const report = await store.recoverMedia([artifact.asset], new AbortController().signal);
  assert.deepEqual(report.repaired, []); assert.deepEqual(report.missing, [artifact.id]);
  assert.equal([...fixture.files.keys()].some(path => path.startsWith('/pixel/locations/')), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.recoverMedia([artifact.asset], controller.signal), /取消/);
});

test('production shared host never creates a local project or task directory and releases its editing lease on shutdown', async context => {
  const fixture = remote(); const store = await SeafileArtifactStore.open(configuration(), { fetch: fixture.transport });
  const catalog = new SharedProjectCatalog(store); const id = await catalog.create('Cloud');
  const root = await mkdtemp(join(tmpdir(), 'pixel-cloud-host-')); const directory = join(root, 'must-stay-absent');
  context.after(async () => { const checked = resolve(root); assert.equal(dirname(checked), resolve(tmpdir())); assert.ok(basename(checked).startsWith('pixel-cloud-host-')); await rm(checked, { recursive: true, force: true }); });
  const host = await startWorkbenchServer({ directory, projectId: id, artifacts: store, providers: { elevenlabs: false, openrouter: false }, apiPort: 0 });
  context.after(() => host.shutdown());
  const result = await host.workbench.execute({ projectId: id, expectedRevision: 0, requestId: randomUUID(), type: 'project.title', payload: { title: 'Shared change' } });
  assert.equal(result.ok, true);
  await assert.rejects(lstat(directory), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
  await host.shutdown();
  const reopened = await startWorkbenchServer({ directory, projectId: id, artifacts: store, providers: { elevenlabs: false, openrouter: false }, apiPort: 0 });
  assert.equal((await reopened.workbench.snapshot()).document.title, 'Shared change'); await reopened.shutdown();
});

test('Seafile uploads publish media before index, survive fresh store recovery and preserve opaque handles', async () => {
  const fixture = remote(); const store = await SeafileArtifactStore.open(configuration(), { fetch: fixture.transport });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const artifact = await store.write({ attemptToken: { jobId: 'job_1', attempt: 2 }, kind: 'image', metadata: { mimeType: 'image/png', name: '图.png' }, bytes: (async function* () { yield bytes.slice(0, 2); yield bytes.slice(2); })() });
  assert.equal(artifact.asset.fileRef, `pixel-asset:${artifact.id}`); assert.equal(artifact.asset.metadata.attempt, 2); assert.equal(artifact.asset.metadata.byteLength, 4);
  assert.deepEqual([...fixture.files.keys()], [`/pixel/media/${artifact.id}.png`, `/pixel/artifacts/${artifact.id}.json`]);
  assert.equal(JSON.stringify(artifact).includes(privateToken), false);
  const restored = await SeafileArtifactStore.open(configuration(), { fetch: fixture.transport });
  assert.deepEqual(await restored.get(artifact.id), artifact); assert.deepEqual(await restored.listByJob('job_1'), [artifact]); assert.deepEqual(await restored.listByJob('other'), []);
  assert.deepEqual(await restored.stat(artifact.asset), { byteLength: 4, mimeType: 'image/png' });
  assert.deepEqual(await restored.read({ ...artifact.asset, metadata: { mimeType: 'secret', storage: { path: '/secret' } } }, new AbortController().signal), { bytes, mimeType: 'image/png' });
  assert.equal('resolvePath' in restored, false);
  for (const asset of [{ ...artifact.asset, id: randomUUID() }, { ...artifact.asset, kind: 'video' as const }, { ...artifact.asset, fileRef: '../.env' }]) await assert.rejects(restored.read(asset, new AbortController().signal), error => error instanceof ProviderError && error.code === 'UNSUPPORTED_REFERENCE');
});

test('Seafile migration preserves existing IDs and refuses conflicting bytes without replacing remote files', async () => {
  const fixture = remote(); const store = await SeafileArtifactStore.open(configuration(), { fetch: fixture.transport });
  const id = randomUUID(); const old: GenerationArtifact = { id, jobId: 'old_job', asset: { id, kind: 'video', fileRef: `pixel-asset:${id}`, metadata: { mimeType: 'video/mp4', attempt: 1, durationSeconds: 7, title: '旧片段' } } };
  const bytes = new Uint8Array([1, 2, 3]); const migrated = await store.importArtifact(old, bytes);
  assert.equal(migrated.id, old.id); assert.equal(migrated.asset.fileRef, old.asset.fileRef); assert.equal(migrated.asset.metadata.title, '旧片段');
  assert.deepEqual(await store.importArtifact(old, bytes), migrated); assert.equal(fixture.controls.uploads, 2);
  await assert.rejects(store.importArtifact(old, new Uint8Array([9])), /未覆盖/); assert.equal(fixture.controls.uploads, 2);
});

test('Seafile range reads verify bounds and object identity and handle file servers without ranges', async () => {
  const fixture = remote(); const store = await SeafileArtifactStore.open(configuration(), { fetch: fixture.transport });
  const artifact = await store.write({ attemptToken: { jobId: 'job', attempt: 1 }, kind: 'video', metadata: { mimeType: 'video/mp4' }, bytes: new Uint8Array([1, 2, 3, 4]) });
  const signal = new AbortController().signal;
  assert.deepEqual(await store.readRange(artifact.asset, { start: 1, end: 2 }, signal), { bytes: new Uint8Array([2, 3]), mimeType: 'video/mp4', totalBytes: 4 });
  fixture.controls.rangeIgnored = true;
  assert.deepEqual((await store.readRange(artifact.asset, { start: 1, end: 2 }, signal)).bytes, new Uint8Array([2, 3]));
  for (const range of [{ start: -1, end: 1 }, { start: 0, end: 4 }, { start: 2, end: 1 }]) await assert.rejects(store.readRange(artifact.asset, range, signal), error => error instanceof ProviderError && error.code === 'INVALID_INPUT');
  fixture.controls.rangeIgnored = false; fixture.controls.badRange = true;
  await assert.rejects(store.readRange(artifact.asset, { start: 0, end: 1 }, signal), /范围响应无效/);
  const file = fixture.files.get(`/pixel/media/${artifact.id}.mp4`)!; file.id = '9'.repeat(40);
  await assert.rejects(store.stat(artifact.asset), /已变更/);
});

test('failed index publication, unsupported output and byte limits cannot publish a resource record', async () => {
  const fixture = remote(); const store = await SeafileArtifactStore.open(configuration({ maxBytes: 3 }), { fetch: fixture.transport });
  for (const bytes of [new Uint8Array(), new Uint8Array(4)]) await assert.rejects(store.write({ attemptToken: { jobId: 'job', attempt: 1 }, kind: 'image', metadata: { mimeType: 'image/png' }, bytes }), error => error instanceof ProviderError && error.code === 'INVALID_OUTPUT');
  await assert.rejects(store.write({ attemptToken: { jobId: 'job', attempt: 1 }, kind: 'video', metadata: { mimeType: 'image/png' }, bytes: new Uint8Array([1]) }));
  assert.equal(fixture.controls.uploads, 0);
  fixture.controls.failIndex = true;
  await assert.rejects(store.write({ attemptToken: { jobId: 'job', attempt: 1 }, kind: 'image', metadata: { mimeType: 'image/png' }, bytes: new Uint8Array([1]) }), error => error instanceof ProviderError && error.code === 'UPSTREAM' && !error.message.includes('private-password'));
  assert.equal(fixture.files.size, 1); assert.deepEqual(await store.listByJob('job'), []);
});

test('a preserved UUID retries interrupted index publication by verifying and reusing its orphaned media', async () => {
  const fixture = remote(); const store = await SeafileArtifactStore.open(configuration(), { fetch: fixture.transport });
  const id = randomUUID(); const existing: GenerationArtifact = { id, jobId: 'migration', asset: { id, kind: 'image', fileRef: `pixel-asset:${id}`, metadata: { mimeType: 'image/png', attempt: 1 } } };
  fixture.controls.failIndex = true;
  await assert.rejects(store.importArtifact(existing, new Uint8Array([1, 2])), error => error instanceof ProviderError && error.code === 'UPSTREAM');
  assert.equal(fixture.files.size, 1); assert.equal(fixture.controls.uploads, 2); assert.equal(await store.get(id), undefined);
  await assert.rejects(store.importArtifact(existing, new Uint8Array([9, 9])), /未覆盖/);
  assert.equal(fixture.controls.uploads, 2);
  fixture.controls.failIndex = false;
  const restored = await SeafileArtifactStore.open(configuration(), { fetch: fixture.transport });
  const recovered = await restored.importArtifact(existing, new Uint8Array([1, 2]));
  assert.equal(recovered.id, id); assert.equal(fixture.controls.uploads, 3); assert.equal(fixture.files.size, 2);
  assert.deepEqual((await restored.read(recovered.asset, new AbortController().signal)).bytes, new Uint8Array([1, 2]));
});

test('Seafile ownership validates the persisted index and a bounded full read verifies SHA256', async () => {
  const fixture = remote(); const store = await SeafileArtifactStore.open(configuration(), { fetch: fixture.transport });
  const artifact = await store.write({ attemptToken: { jobId: 'job', attempt: 1 }, kind: 'image', metadata: { mimeType: 'image/png' }, bytes: new Uint8Array([1, 2]) });
  const indexFile = fixture.files.get(`/pixel/artifacts/${artifact.id}.json`)!;
  const index = JSON.parse(new TextDecoder().decode(indexFile.bytes)); index.asset.metadata.storage.path = '/outside/secret'; indexFile.bytes = new TextEncoder().encode(JSON.stringify(index));
  await assert.rejects(store.get(artifact.id), /句柄不一致/);
  indexFile.bytes = new TextEncoder().encode(JSON.stringify(artifact));
  const mediaFile = fixture.files.get(`/pixel/media/${artifact.id}.png`)!; mediaFile.bytes = new Uint8Array([9, 9]);
  await assert.rejects(store.read(artifact.asset, new AbortController().signal), /完整性校验失败/);
  mediaFile.bytes = new Uint8Array(33);
  await assert.rejects(store.read(artifact.asset, new AbortController().signal), /已变更/);
});

test('unknown signed-link origins, authentication failures, timeouts and cancellation are sanitized', async () => {
  const fixture = remote(); const cfg = configuration({ timeoutMs: 20 }); const store = await SeafileArtifactStore.open(cfg, { fetch: fixture.transport });
  fixture.controls.untrustedLink = true;
  await assert.rejects(store.write({ attemptToken: { jobId: 'job', attempt: 1 }, kind: 'image', metadata: { mimeType: 'image/png' }, bytes: new Uint8Array([1]) }), /未经配置允许/);
  assert.equal(fixture.controls.uploads, 0); fixture.controls.untrustedLink = false;
  const artifact = await store.write({ attemptToken: { jobId: 'job', attempt: 1 }, kind: 'image', metadata: { mimeType: 'image/png' }, bytes: new Uint8Array([1]) });
  fixture.controls.unauthorized = true;
  await assert.rejects(store.get(artifact.id), error => error instanceof ProviderError && error.code === 'AUTHENTICATION' && !/private/.test(error.message));
  fixture.controls.unauthorized = false; fixture.controls.delayed = true;
  // AbortSignal.timeout timers are unref'd; keep the mock event loop alive until its pending fetch settles.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(store.get(artifact.id), error => error instanceof ProviderError && error.code === 'TIMEOUT');
    const controller = new AbortController(); const pending = store.read(artifact.asset, controller.signal); controller.abort();
    await assert.rejects(pending, error => error instanceof ProviderError && error.code === 'CANCELED');
    await assert.rejects(store.read(artifact.asset, controller.signal), error => error instanceof ProviderError && error.code === 'CANCELED');
  } finally { clearInterval(keepAlive); }
});

test('an aborted artifact write performs no remote mutations and cancellation interrupts a blocked source iterator', async () => {
  const fixture = remote(); const store = new SeafileArtifactStore(configuration(), { fetch: fixture.transport });
  const controller = new AbortController(); controller.abort();
  const request = { attemptToken: { jobId: 'job', attempt: 1 }, kind: 'image' as const, metadata: { mimeType: 'image/png' }, bytes: new Uint8Array([1]), signal: controller.signal };
  await assert.rejects(store.write(request), error => error instanceof ProviderError && error.code === 'CANCELED');
  const id = randomUUID();
  await assert.rejects(store.importArtifact({ id, jobId: 'old', asset: { id, kind: 'image', fileRef: `pixel-asset:${id}`, metadata: { mimeType: 'image/png' } } }, request.bytes, controller.signal), error => error instanceof ProviderError && error.code === 'CANCELED');
  assert.equal(fixture.requests.length, 0); assert.equal(fixture.controls.uploads, 0);
  let sourceWaiting: () => void = () => {}; const waiting = new Promise<void>(resolve => { sourceWaiting = resolve; });
  const source = { async *[Symbol.asyncIterator]() { yield new Uint8Array([1]); sourceWaiting(); await new Promise<void>(() => {}); } };
  const active = new AbortController(); const pending = store.write({ ...request, bytes: source, signal: active.signal });
  const rejected = assert.rejects(pending, error => error instanceof ProviderError && error.code === 'CANCELED');
  await waiting; active.abort(); await rejected;
  assert.equal(fixture.requests.length, 0); assert.equal(fixture.controls.uploads, 0);
});

test('cancellation during a remote media upload never continues to publish its artifact index', async () => {
  const fixture = remote(); const store = await SeafileArtifactStore.open(configuration(), { fetch: fixture.transport });
  fixture.controls.holdMediaUpload = true;
  const controller = new AbortController();
  const pending = store.write({ attemptToken: { jobId: 'canceled_job', attempt: 1 }, kind: 'image', metadata: { mimeType: 'image/png' }, bytes: new Uint8Array([1, 2]), signal: controller.signal });
  const rejected = assert.rejects(pending, error => error instanceof ProviderError && error.code === 'CANCELED');
  await fixture.mediaUploadStarted; controller.abort(); await rejected;
  assert.equal(fixture.controls.uploads, 1); assert.equal(fixture.files.size, 1);
  assert.ok([...fixture.files.keys()].every(path => path.startsWith('/pixel/media/')));
  assert.deepEqual(await store.listByJob('canceled_job'), []);
});

test('the provider base supplies the real task signal even when a provider passes its own write signal', async () => {
  const fixture = remote(); const store = await SeafileArtifactStore.open(configuration(), { fetch: fixture.transport });
  fixture.controls.holdMediaUpload = true;
  const unrelated = new AbortController();
  class UploadingProvider extends BaseModelProvider {
    readonly manifest = { providerId: 'fixture', providerVersion: '1', modelIds: ['fixture.video'], supportsCancellation: true };
    protected async performGeneration(_request: DeepReadonly<GenerationRequest>, context: ProviderRunContext) {
      const artifact = await context.artifacts.write({ attemptToken: context.attemptToken, kind: 'video', metadata: { mimeType: 'video/mp4' }, bytes: new Uint8Array([1, 2]), signal: unrelated.signal });
      return { artifactIds: [artifact.id] };
    }
  }
  const controller = new AbortController();
  const pending = new UploadingProvider().generate({ projectId: 'project', targetItemId: 'item', generationToken: 'current', inputFingerprint: 'fingerprint', providerId: 'fixture', providerVersion: '1', modelId: 'fixture.video', params: {}, references: [] }, {
    signal: controller.signal, attemptToken: { jobId: 'provider_canceled', attempt: 1 }, reportProgress: () => {}, checkpointProviderTask: async () => {},
    artifacts: { write: async input => { assert.notEqual(input.signal, unrelated.signal); return store.write(input); } }, media: store,
  });
  const rejected = assert.rejects(pending, error => error instanceof ProviderError && error.code === 'CANCELED');
  await fixture.mediaUploadStarted; controller.abort(); await rejected;
  assert.equal(unrelated.signal.aborted, false); assert.deepEqual(await store.listByJob('provider_canceled'), []); assert.equal(fixture.controls.uploads, 1);
});

test('a dedicated library may be created; ambiguous, read-only and encrypted libraries are never selected', async () => {
  const fixture = remote(); fixture.setLibraries([]);
  await SeafileArtifactStore.open(configuration({ token: undefined, username: 'private-account', password: 'private-password' } as unknown as Partial<SeafileConfiguration>), { fetch: fixture.transport });
  assert.equal(fixture.controls.creations, 1);
  const duplicate = remote(); duplicate.setLibraries([{ id: repoId, name: 'Pixel', permission: 'rw', encrypted: false }, { id: randomUUID(), name: 'Pixel', permission: 'rw', encrypted: false }]);
  await assert.rejects(SeafileArtifactStore.open(configuration(), { fetch: duplicate.transport }), /多个同名/); assert.equal(duplicate.controls.creations, 0);
  for (const denied of [{ permission: 'r', encrypted: false }, { permission: 'rw', encrypted: true }]) {
    const fixture = remote(); fixture.setLibraries([{ id: repoId, name: 'Pixel', ...denied }]);
    await assert.rejects(SeafileArtifactStore.open(configuration({ repoId }), { fetch: fixture.transport }), error => error instanceof ProviderError && error.code === 'AUTHENTICATION');
    assert.equal(fixture.controls.creations, 0);
  }
});
