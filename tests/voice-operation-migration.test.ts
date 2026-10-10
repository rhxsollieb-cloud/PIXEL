import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DomainError } from '../src/backend.js';
import { createModelBackend } from '../src/runtime.js';
import { SharedJobRepository, SharedVersionedDocument, type SharedDocumentStore } from '../src/shared-projects.js';
import type { MediaArtifactStore } from '../src/generation.js';
import type { BackendConfiguration } from '../src/backend-configuration.js';
import { migrateLegacyVoiceOperations } from '../src/voice-operation-migration.js';
import { VoiceServiceError, voiceOperationSchema } from '../src/voices.js';

class Documents implements SharedDocumentStore {
  readonly values = new Map<string, unknown>();
  async documentEntries(path: string) {
    const entries = new Map<string, { type: string; name: string }>();
    for (const key of this.values.keys()) {
      if (!key.startsWith(`${path}/`)) continue;
      const parts = key.slice(path.length + 1).split('/');
      entries.set(parts[0]!, { type: parts.length === 1 ? 'file' : 'dir', name: parts[0]! });
    }
    return [...entries.values()];
  }
  async readDocument(path: string) { return structuredClone(this.values.get(path)); }
  async createDocument(path: string, value: unknown) {
    if (this.values.has(path)) throw new DomainError('REVISION_CONFLICT', 'Collision');
    this.values.set(path, structuredClone(value));
  }
}

const operation = () => voiceOperationSchema.parse({
  version: 1, command: 'voice.clone', requestId: 'original-request', accountScope: 'account-fingerprint',
  fingerprint: 'a'.repeat(64), state: 'succeeded', createdAt: 1, updatedAt: 2,
  result: { requestId: 'original-request', voice: { voiceId: 'clone-id', name: '音色', category: 'cloned', status: 'ready' } },
});
const keyOf = (record: ReturnType<typeof operation>) => createHash('sha256').update(`${record.accountScope}\0${record.requestId}`).digest('hex');
const isVoiceError = (code: VoiceServiceError['code']) => (error: unknown) => error instanceof VoiceServiceError && error.code === code;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pixel-voice-migration-'));
  // This exact mkdtemp result is the only recursive cleanup target.
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'voice-operations'); await mkdir(directory);
  const record = operation(); const path = join(directory, `${keyOf(record)}.json`);
  await writeFile(path, JSON.stringify(record));
  return { root, directory, path, record, key: keyOf(record), store: new Documents() };
}

test('legacy voice claims migrate to shared immutable slots without rewriting originals', async t => {
  const { root, directory, path, record, key, store } = await fixture(t);
  const before = await readFile(path);
  assert.deepEqual(await migrateLegacyVoiceOperations(root, store), { migrated: 1 });
  assert.deepEqual((await new SharedVersionedDocument(store, `operations/${key}`, value => voiceOperationSchema.parse(value)).read())?.value, record);
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readdir(directory), [`${key}.json`]);
  assert.deepEqual(await migrateLegacyVoiceOperations(root, store), { migrated: 0 });
  assert.equal(store.values.size, 1);
});

test('matching remote fingerprints preserve remote outcome even when local clone succeeded', async t => {
  const { root, record, key, store } = await fixture(t);
  const { result: _result, ...claim } = record;
  const remote = { ...claim, state: 'unknown' as const, errorCode: 'OUTCOME_UNKNOWN' as const };
  const file = new SharedVersionedDocument(store, `operations/${key}`, value => voiceOperationSchema.parse(value));
  await file.publish(undefined, remote);
  assert.deepEqual(await migrateLegacyVoiceOperations(root, store), { migrated: 0 });
  assert.deepEqual((await file.read())?.value, remote);
  assert.equal(store.values.size, 1);
});

test('conflicting remote voice fingerprints reject instead of overwriting an account operation', async t => {
  const { root, record, key, store } = await fixture(t);
  const file = new SharedVersionedDocument(store, `operations/${key}`, value => voiceOperationSchema.parse(value));
  await file.publish(undefined, { ...record, fingerprint: 'b'.repeat(64) });
  await assert.rejects(migrateLegacyVoiceOperations(root, store), isVoiceError('REQUEST_ID_REUSED'));
  assert.equal((await file.read())?.value.fingerprint, 'b'.repeat(64));
  assert.equal(store.values.size, 1);
});

test('concurrent identical voice migration claims accept one immutable winner', async t => {
  const { root, store } = await fixture(t);
  const results = await Promise.all([migrateLegacyVoiceOperations(root, store), migrateLegacyVoiceOperations(root, store)]);
  assert.equal(results.reduce((sum, result) => sum + result.migrated, 0), 1);
  assert.equal(store.values.size, 1);
});

test('voice filename must bind the account and request, and malformed records never publish', async t => {
  const { root, path, record, store } = await fixture(t);
  await writeFile(path, JSON.stringify({ ...record, accountScope: 'other-account' }));
  await assert.rejects(migrateLegacyVoiceOperations(root, store), isVoiceError('OUTCOME_UNKNOWN'));
  assert.equal(store.values.size, 0);
  await writeFile(path, JSON.stringify({ ...record, result: { ...record.result!, requestId: 'other-request' } }));
  await assert.rejects(migrateLegacyVoiceOperations(root, store), isVoiceError('OUTCOME_UNKNOWN'));
  assert.equal(store.values.size, 0);
  await writeFile(path, '{secret-invalid-json');
  await assert.rejects(migrateLegacyVoiceOperations(root, store), error => isVoiceError('OUTCOME_UNKNOWN')(error)
    && !(error as Error).message.includes('secret-invalid-json'));
});

test('voice migration rejects oversized records and linked ledger directories', async t => {
  const { root, path, directory, store } = await fixture(t);
  await writeFile(path, 'x'.repeat(16 * 1024 + 1));
  await assert.rejects(migrateLegacyVoiceOperations(root, store), isVoiceError('UPSTREAM'));
  const linkedProject = join(root, 'linked-project'); await mkdir(linkedProject);
  await symlink(directory, join(linkedProject, 'voice-operations'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(migrateLegacyVoiceOperations(linkedProject, store), isVoiceError('UPSTREAM'));
  assert.equal(store.values.size, 0);
});

test('voice migration rejects a linked record without reading or changing its external content', async t => {
  const { root, path, record, store } = await fixture(t);
  const external = join(root, 'external.json'); await writeFile(external, JSON.stringify(record));
  await rm(path);
  try { await symlink(external, path, 'file'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows account cannot create file symlinks'); return; }
    throw error;
  }
  await assert.rejects(migrateLegacyVoiceOperations(root, store), isVoiceError('UPSTREAM'));
  assert.equal(store.values.size, 0); assert.equal(await readFile(external, 'utf8'), JSON.stringify(record));
});

test('missing legacy voice operations need no shared writes; model backends require an injected job repository', async t => {
  const { root, directory, path, store } = await fixture(t);
  await rm(path); await rmdir(directory);
  assert.deepEqual(await migrateLegacyVoiceOperations(root, store), { migrated: 0 });
  const configuration: BackendConfiguration = { elevenlabsApiKey: 'test', openrouterApiKey: 'test', storageDirectory: join(root, 'unused') };
  const artifacts = {} as MediaArtifactStore;
  assert.throws(() => createModelBackend(configuration, artifacts, undefined as never), /明确提供/);
  const backend = createModelBackend(configuration, artifacts, new SharedJobRepository(store, 'diagnostic'));
  assert.equal(await backend.jobs.get('missing-job'), undefined);
  assert.deepEqual(await readdir(root), []);
});
