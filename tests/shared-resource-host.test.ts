import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AssetData, GenerationArtifact } from '../src/contracts.js';
import type { ArtifactWriteRequest, MediaArtifactStore } from '../src/generation.js';
import { TemporaryMediaExports } from '../src/media-export.js';
import { migrateLegacyArtifacts } from '../src/resource-migration.js';
import { createWorkbench, FileWorkbenchRepository, createInitialWorkbenchProject } from './local-workbench.js';
import { startWorkbenchServer, preparePixelProjectLocation } from '../src/server.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhUYAAAAASUVORK5CYII=', 'base64');

/** No resolvePath: validates that every product operation goes through the storage port. */
class RemoteFixture implements MediaArtifactStore {
  readonly records = new Map<string, { artifact: GenerationArtifact; bytes: Uint8Array }>();
  reads = 0; ranges = 0;
  async importArtifact(artifact: GenerationArtifact, bytes: Uint8Array) {
    const remote = structuredClone(artifact);
    remote.asset.metadata.byteLength = bytes.length;
    this.records.set(artifact.id, { artifact: remote, bytes: new Uint8Array(bytes) });
    return remote;
  }
  async write(input: ArtifactWriteRequest) {
    assert.ok(input.bytes instanceof Uint8Array);
    const id = randomUUID();
    return this.importArtifact({ id, jobId: input.attemptToken.jobId, asset: { id, kind: input.kind, fileRef: `pixel-asset:${id}`, metadata: { ...input.metadata, extension: 'png' } } }, input.bytes);
  }
  async get(id: string) { return structuredClone(this.records.get(id)?.artifact); }
  async listByJob(jobId: string) { return [...this.records.values()].filter(record => record.artifact.jobId === jobId).map(record => structuredClone(record.artifact)); }
  async stat(asset: AssetData) {
    const record = this.records.get(asset.id); assert.ok(record); assert.equal(record.artifact.asset.fileRef, asset.fileRef);
    return { byteLength: record.bytes.length, mimeType: String(record.artifact.asset.metadata.mimeType) };
  }
  async read(asset: AssetData, signal: AbortSignal) { signal.throwIfAborted(); this.reads++; const info = await this.stat(asset); return { bytes: new Uint8Array(this.records.get(asset.id)!.bytes), mimeType: info.mimeType }; }
  async readRange(asset: AssetData, range: { start: number; end: number }, signal: AbortSignal) {
    signal.throwIfAborted(); this.ranges++; const info = await this.stat(asset);
    return { bytes: this.records.get(asset.id)!.bytes.slice(range.start, range.end + 1), mimeType: info.mimeType, totalBytes: info.byteLength };
  }
}

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'pixel-shared-resource-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(path)), resolve(tmpdir())); assert.ok(basename(path).startsWith('pixel-shared-resource-test-'));
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

test('remote imports, preview byte ranges, project reopen and native export never need a local resource path', async t => {
  const root = await directory(t); const artifacts = new RemoteFixture();
  const repository = await FileWorkbenchRepository.open(root, createInitialWorkbenchProject(), artifacts);
  const { server, workbench } = await startWorkbenchServer({ directory: root, apiPort: 0, artifacts, repository, providers: { elevenlabs: false, openrouter: false } });
  t.after(async () => { await workbench.shutdown(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  const receipt = await (await fetch(`${base}/api/import`, { method: 'POST', body: png, headers: {
    'Content-Type': 'image/png', 'X-Pixel-Project-Id': workbench.projectId, 'X-Pixel-Revision': '0', 'X-Pixel-Request-Id': randomUUID(), 'X-Pixel-Name': 'remote.png',
  } })).json();
  assert.equal(receipt.ok, true); const id = receipt.outcome.assetId;
  await assert.rejects(stat(join(root, 'artifacts')), { code: 'ENOENT' });
  const head = await fetch(`${base}/api/media/${id}`, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(artifacts.reads, 0);
  const partial = await fetch(`${base}/api/media/${id}`, { headers: { Range: 'bytes=2-6' } });
  assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), `bytes 2-6/${png.length}`); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), png.subarray(2, 7)); assert.equal(artifacts.ranges, 1);
  assert.equal((await fetch(`${base}/api/media/${id}`, { headers: { Range: 'bytes=9999-' } })).status, 416);
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/media/${id}`)).arrayBuffer()), png);
  const reopened = await createWorkbench({ directory: root, artifacts }); t.after(() => reopened.shutdown());
  assert.equal((await preparePixelProjectLocation(root, { artifacts })).existing, true);
  const copy = await reopened.prepareMediaExport(id); assert.ok(basename(dirname(copy)).startsWith('pixel-export-')); assert.deepEqual(await readFile(copy), png);
  await reopened.shutdown(); await assert.rejects(stat(copy), { code: 'ENOENT' });
});

test('legacy resource migration preserves handles, project history and original media, then uses remote authority', async t => {
  const root = await directory(t);
  const legacy = await createWorkbench({ directory: root });
  const result = await legacy.importMedia({ bytes: png, mimeType: 'image/png', name: 'old.png', requestId: randomUUID(), expectedRevision: 0 }); assert.ok(result.ok);
  const asset = (await legacy.snapshot()).document.assets[String(result.outcome.assetId)]!;
  const originalProject = await readFile(join(root, 'project.json'));
  const originalPath = await legacy.artifacts.resolvePath!(asset); await legacy.shutdown();
  const remote = new RemoteFixture();
  assert.deepEqual(await migrateLegacyArtifacts(root, remote), { migrated: 1 });
  assert.deepEqual(await readFile(join(root, 'project.json')), originalProject); assert.deepEqual(await readFile(originalPath), png);
  assert.equal((await remote.get(asset.id))!.asset.fileRef, asset.fileRef);
  const shared = await createWorkbench({ directory: root, artifacts: remote }); t.after(() => shared.shutdown());
  assert.deepEqual((await shared.artifacts.read(asset, new AbortController().signal)).bytes, new Uint8Array(png));
  assert.deepEqual(await migrateLegacyArtifacts(root, remote), { migrated: 0 });
  await unlink(originalPath);
  assert.deepEqual(await migrateLegacyArtifacts(root, remote), { migrated: 0 });
  assert.equal((await preparePixelProjectLocation(root, { artifacts: remote })).existing, true);
});

test('project ingress rejects wrong filenames and pending outbox before accessing the resource adapter', async t => {
  const root = await directory(t);
  const workbench = await createWorkbench({ directory: root }); await workbench.shutdown();
  const note = join(root, 'notes.txt'); await writeFile(note, 'not a project');
  let accesses = 0;
  const remote = new RemoteFixture(); remote.get = async () => { accesses++; throw new Error('must not access resources'); };
  await assert.rejects(preparePixelProjectLocation(note, { artifacts: remote }), /project.json/);
  const projectPath = join(root, 'project.json');
  const file = JSON.parse(await readFile(projectPath, 'utf8'));
  file.outbox.push({ id: randomUUID(), operation: 'cancel', jobId: randomUUID(), itemId: 'missing', done: false });
  await writeFile(projectPath, JSON.stringify(file));
  await assert.rejects(preparePixelProjectLocation(root, { artifacts: remote }), /待处理/);
  assert.equal(accesses, 0);
});

test('temporary export rejects inconsistent bytes and closes while a remote preparation is pending', async t => {
  const remote = new RemoteFixture();
  const artifact = await remote.write({ attemptToken: { jobId: 'fixture', attempt: 1 }, kind: 'image', bytes: png, metadata: { mimeType: 'image/png' } });
  const exports = new TemporaryMediaExports(remote); t.after(() => exports.close());
  remote.read = async () => ({ bytes: new Uint8Array(1), mimeType: 'image/png' });
  await assert.rejects(exports.prepare(artifact.asset), /索引不一致/);
  let ready: () => void = () => {}; const started = new Promise<void>(done => { ready = done; });
  remote.read = async (_asset, signal) => { ready(); await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true })); signal.throwIfAborted(); throw new Error(); };
  const pending = exports.prepare(artifact.asset); const rejection = assert.rejects(pending);
  await started; await exports.close(); await rejection;
  await assert.rejects(exports.prepare(artifact.asset), /关闭/);
});
