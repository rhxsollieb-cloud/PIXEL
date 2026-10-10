import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { DomainError } from '../src/backend.js';
import { SharedProjectCatalog, SharedProjectLease, SharedVersionedDocument, SharedJobRepository, type SharedDocumentStore } from '../src/shared-projects.js';
import { transitionJob } from '../src/generation.js';
import type { GenerationJob, GenerationRequest } from '../src/contracts.js';

export class MemoryDocuments implements SharedDocumentStore {
  readonly files = new Map<string, unknown>();
  async documentEntries(path: string) {
    const entries = new Map<string, { type: string; name: string }>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(`${path}/`)) continue;
      const parts = key.slice(path.length + 1).split('/'); const name = parts[0]!;
      entries.set(name, { type: parts.length === 1 ? 'file' : 'dir', name });
    }
    return [...entries.values()];
  }
  async readDocument(path: string) { return structuredClone(this.files.get(path)); }
  async createDocument(path: string, value: unknown) {
    if (this.files.has(path)) throw new DomainError('REVISION_CONFLICT', 'Remote create-only collision');
    this.files.set(path, structuredClone(value));
  }
}
const caller = (id: string) => ({ actorId: 'tester', source: 'gui' as const, projectIds: new Set([id]), permissions: new Set(['project.edit' as const]) });

test('shared project transactions preserve one authority, history and receipts across hosts without local files', async () => {
  const store = new MemoryDocuments(); const catalog = new SharedProjectCatalog(store); const id = await catalog.create('团队作品');
  const first = await catalog.repository(id); const second = await catalog.repository(id);
  const action = { projectId: id, requestId: randomUUID(), expectedRevision: 0, type: 'project.title', payload: { title: '新版' } };
  const result = await first.commit(action, caller(id), document => { document.title = '新版'; return { outcome: {}, undoable: true }; });
  assert.equal(result.receipt.revision, 1);
  assert.equal((await second.read(id)).document.title, '新版');
  assert.equal((await second.commit(action, caller(id), () => { throw new Error('Replay cannot mutate'); })).replayed, true);
  const state = await catalog.state(id); assert.equal(state.history.length, 1); assert.equal(Object.keys(state.requests).length, 1);
  await assert.rejects(second.commit({ ...action, payload: { title: '别的' } }, caller(id), () => ({ outcome: {}, undoable: true })), /相同请求/);
});

test('two independent project commits from one revision publish exactly one winner and no overwritten history', async () => {
  const store = new MemoryDocuments(); const catalog = new SharedProjectCatalog(store); const id = await catalog.create('原始');
  const hosts = await Promise.all([catalog.repository(id), catalog.repository(id)]);
  const results = await Promise.allSettled(hosts.map((host, index) => host.commit({ projectId: id, requestId: randomUUID(), expectedRevision: 0, type: 'project.title', payload: {} }, caller(id), document => { document.title = `host-${index}`; return { outcome: {}, undoable: true }; })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const loser = results.find(result => result.status === 'rejected'); assert.ok(loser?.status === 'rejected' && loser.reason instanceof DomainError && loser.reason.code === 'REVISION_CONFLICT');
  const state = await catalog.state(id); assert.equal(state.snapshot.revision, 1); assert.equal(state.history.length, 1);
});

test('remote slots reject missing/forged chains and recover uncertain publication only for identical data', async () => {
  const store = new MemoryDocuments(); const file = new SharedVersionedDocument(store, 'operations/test', input => input as { title: string });
  await file.publish(undefined, { title: 'A' }); const first = await file.read(); await file.publish(first, { title: 'B' });
  store.files.set('operations/test/part-000000000/000000000001.json', { version: 1, publicationId: randomUUID(), sequence: 1, parent: '0'.repeat(64), value: { title: 'forged' } });
  await assert.rejects(file.read(), /前后版本/);
  store.files.delete('operations/test/part-000000000/000000000000.json'); await assert.rejects(file.read(), /版本链/);
  const uncertain = new MemoryDocuments(); const create = uncertain.createDocument.bind(uncertain);
  uncertain.createDocument = async (path, value) => { await create(path, value); throw new Error('Lost response'); };
  const recovered = new SharedVersionedDocument(uncertain, 'operations/test', value => value);
  await recovered.publish(undefined, { recovered: true }); assert.deepEqual((await recovered.read())?.value, { recovered: true });
});

test('catalog pages remain bounded and incomplete imports never appear as opened projects', async () => {
  const store = new MemoryDocuments(); const catalog = new SharedProjectCatalog(store);
  for (const id of ['A', 'B', 'C']) await catalog.create(id, id);
  await store.createDocument('projects/incomplete/jobs/test/000000000000.json', {});
  const first = await catalog.list({ limit: 2 }); assert.deepEqual(first.items.map(project => project.id), ['A', 'B']); assert.equal(first.nextCursor, 'B');
  const second = await catalog.list({ limit: 2, cursor: first.nextCursor! }); assert.deepEqual(second.items.map(project => project.id), ['C']);
  await assert.rejects(catalog.list({ cursor: 'unknown' }), /失效/);
  await assert.rejects(catalog.create('bad', '../escape'), /ID/);
});

test('immutable ledgers cross shard boundaries without unbounded directory listings', async () => {
  const store = new MemoryDocuments();
  let parent: string | null = null;
  for (let sequence = 0; sequence < 1000; sequence++) {
    const value = { sequence };
    store.files.set(`operations/sharded/part-000000000/${String(sequence).padStart(12, '0')}.json`, { version: 1, publicationId: randomUUID(), sequence, parent, value });
    parent = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  const file = new SharedVersionedDocument(store, 'operations/sharded', value => value as { sequence: number });
  await file.publish(await file.read(), { sequence: 1000 });
  assert.ok(store.files.has('operations/sharded/part-000000001/000000001000.json'));
  assert.equal((await file.read())?.sequence, 1000);
  assert.equal((await store.documentEntries('operations/sharded/part-000000000')).length, 1000);
  store.files.delete('operations/sharded/part-000000000/000000000999.json');
  await assert.rejects(file.read());
});

test('publication is authorized after the final remote reread and before create-only upload', async () => {
  const store = new MemoryDocuments(); let allowed = true;
  const file = new SharedVersionedDocument(store, 'operations/fenced', value => value, async () => { if (!allowed) throw new Error('Lease expired'); });
  await file.publish(undefined, { title: 'original' }); const current = await file.read(); allowed = false;
  await assert.rejects(file.publish(current, { title: 'stale' }), /Lease expired/);
  assert.deepEqual((await file.read())?.value, { title: 'original' });
});

test('a shared editing lease prevents another host from interrupting active generation; expiry revokes old owner', async () => {
  const store = new MemoryDocuments(); let clock = 1000;
  const first = await SharedProjectLease.acquire(store, 'project', () => clock);
  await assert.rejects(SharedProjectLease.acquire(store, 'project', () => clock), /其他 Pixel/);
  clock += 20_000; await first.renew(); await first.assertWritable();
  clock += 120_001; await assert.rejects(first.assertWritable(), /过期/);
  const second = await SharedProjectLease.acquire(store, 'project', () => clock);
  await assert.rejects(first.renew(), /失效/);
  await first.release(); await second.assertWritable(); await second.release();
  const third = await SharedProjectLease.acquire(store, 'project', () => clock); await third.release();
});

test('remote generation jobs enforce project, attempt and transition guards across hosts', async () => {
  const store = new MemoryDocuments(); const id = randomUUID();
  const first = new SharedJobRepository(store, 'project'); const second = new SharedJobRepository(store, 'project');
  const request: GenerationRequest = { projectId: 'project', targetItemId: 'item', generationToken: 'token', inputFingerprint: 'fingerprint', providerId: 'elevenlabs', providerVersion: '1.0.0', modelId: 'eleven_v4', params: { text: 'hello', voiceId: 'voice' }, settings: {}, references: [] };
  const job: GenerationJob = { id, request, state: 'queued', attempt: 1, progress: 0, artifactIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await first.create(job);
  const guards = { attemptToken: { jobId: id, attempt: 1 }, states: ['queued' as const] };
  const results = await Promise.all([first.update(guards, current => transitionJob(current, 'running', new Date().toISOString())), second.update(guards, current => transitionJob(current, 'running', new Date().toISOString()))]);
  assert.equal(results.filter(Boolean).length, 1); assert.equal((await second.get(id))?.state, 'running');
  assert.equal(await first.update({ ...guards, attemptToken: { jobId: id, attempt: 9 } }, current => ({ ...current } as GenerationJob)), undefined);
  await assert.rejects(second.update({ ...guards, states: ['running'] }, current => ({ ...structuredClone(current), request: { ...request, projectId: 'other' } } as GenerationJob)), /身份或请求/);
});
