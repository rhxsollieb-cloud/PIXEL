import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as createPortProbe } from 'node:net';
import type { ActionEnvelope, ActionResult, DeepReadonly, GenerationRequest } from '../src/contracts.js';
import { BaseModelProvider, waitForProvider, transitionJob, type ProviderRunContext } from '../src/generation.js';
import { GenerationRunner, ProviderRegistry } from '../src/runtime.js';
import { FileArtifactStore, FileJobRepository } from '../src/storage.js';
import { createWorkbench, createInitialWorkbenchProject, WORKBENCH_PROJECT_ID, type Workbench } from '../src/workbench.js';
import { createApiServer } from '../src/server.js';
import { createWorkbenchFixture } from './workbench-fixtures.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhUYAAAAASUVORK5CYII=', 'base64');
async function directory(context: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'pixel-workbench-test-'));
  context.after(async () => {
    const checked = resolve(path);
    assert.equal(dirname(checked), resolve(tmpdir()));
    assert.ok(basename(checked).startsWith('pixel-workbench-test-'));
    await rm(checked, { recursive: true, force: true });
  });
  return path;
}
function success(result: ActionResult) { assert.equal(result.ok, true, result.ok ? undefined : result.error.message); if (!result.ok) throw new Error('Expected success'); return result; }
async function envelope(workbench: Workbench, type: string, payload: ActionEnvelope['payload']): Promise<ActionEnvelope> {
  const snapshot = await workbench.snapshot();
  return { requestId: randomUUID(), projectId: WORKBENCH_PROJECT_ID, expectedRevision: snapshot.revision, type, payload };
}
async function action(workbench: Workbench, type: string, payload: ActionEnvelope['payload']) { return workbench.execute(await envelope(workbench, type, payload)); }
async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error('Wait timed out'); await new Promise(accept => setTimeout(accept, 15)); }
}
class MockImageProvider extends BaseModelProvider {
  readonly manifest = { providerId: 'openrouter', providerVersion: '1', modelIds: ['x-ai/grok-imagine-image-2.0'], supportsCancellation: false, supportsResume: true };
  calls = 0;
  constructor(private readonly beforeOutput: (context: ProviderRunContext) => Promise<void> = async () => {}) { super({ timeoutMs: 3000 }); }
  protected async performGeneration(_request: DeepReadonly<GenerationRequest>, context: ProviderRunContext) {
    this.calls++;
    await this.beforeOutput(context);
    context.reportProgress({ attemptToken: context.attemptToken, fraction: 0.7, stage: '保存产物' });
    const artifact = await context.artifacts.write({ attemptToken: context.attemptToken, kind: 'image', bytes: png, metadata: { mimeType: 'image/png' } });
    return { artifactIds: [artifact.id] };
  }
}
function runner(root: string, provider: MockImageProvider): GenerationRunner {
  const registry = new ProviderRegistry(); registry.register(provider);
  return new GenerationRunner(registry, new FileJobRepository(join(root, 'jobs')), new FileArtifactStore(join(root, 'artifacts')));
}
function imageItem(workbenchSnapshot: Awaited<ReturnType<Workbench['snapshot']>>) { return Object.values(workbenchSnapshot.document.items).find(item => item.kind === 'image.generated')!; }

test('bootstrap contains no unsolicited timelines, items, assets or tasks; model defaults remain discoverable', async context => {
  const root = await directory(context);
  const workbench = await createWorkbench({ directory: root }); context.after(() => workbench.close());
  const snapshot = await workbench.snapshot();
  assert.deepEqual(snapshot, createInitialWorkbenchProject());
  assert.deepEqual(snapshot.document.timelines, {});
  assert.deepEqual(snapshot.document.items, {});
  assert.deepEqual(snapshot.document.assets, {});
  assert.deepEqual(await workbench.jobs(), { items: [] });
  const reopened = await createWorkbench({ directory: root }); context.after(() => reopened.close());
  assert.deepEqual(await reopened.snapshot(), snapshot);
  const declarations = workbench.models();
  assert.equal(declarations.items.length, 5);
  assert.ok(declarations.items.every(model => model.paramsDefaults && model.settingsDefaults));
  assert.doesNotThrow(() => JSON.stringify(declarations));
});

test('timeline creation is empty and persisted idempotency never duplicates objects', async context => {
  const root = await directory(context);
  const workbench = await createWorkbench({ directory: root }); context.after(() => workbench.close());
  const input = await envelope(workbench, 'timeline.create', { modelId: 'eleven_v4' });
  const first = success(await workbench.execute(input));
  const timelineId = String(first.outcome.timelineId);
  const created = (await workbench.snapshot()).document.timelines[timelineId]!;
  assert.deepEqual(created.itemIds, []);
  assert.deepEqual((await workbench.snapshot()).document.items, {});
  assert.deepEqual(first.outcome, { timelineId });
  const reopened = await createWorkbench({ directory: root }); context.after(() => reopened.close());
  assert.deepEqual(await reopened.execute(input), first);
  assert.equal((await reopened.snapshot()).revision, 1);
  const reused = await reopened.execute({ ...input, payload: { modelId: 'music_v2_5' } });
  assert.equal(reused.ok, false); if (!reused.ok) assert.equal(reused.error.code, 'REQUEST_ID_REUSED');
});

test('opening persisted projects preserves existing content rather than removing previous example data', async context => {
  const root = await directory(context);
  const initial = createWorkbenchFixture();
  initial.document.title = '已保存的作品';
  const workbench = await createWorkbench({ directory: root, initial }); context.after(() => workbench.close());
  const item = imageItem(await workbench.snapshot());
  success(await action(workbench, 'item.params', { itemId: item.id, params: { prompt: '用户保存的提示词' } }));
  const saved = await workbench.snapshot();
  const reopened = await createWorkbench({ directory: root }); context.after(() => reopened.close());
  assert.deepEqual(await reopened.snapshot(), saved);
});

test('draft creation is explicit, idempotent and distinct from asset placement; invalid drafts never commit', async context => {
  const root = await directory(context);
  const workbench = await createWorkbench({ directory: root }); context.after(() => workbench.close());
  const timeline = success(await action(workbench, 'timeline.create', { modelId: 'eleven_v4' }));
  const timelineId = String(timeline.outcome.timelineId);
  assert.deepEqual((await workbench.snapshot()).document.items, {});
  const input = await envelope(workbench, 'item.createDraft', { timelineId, startTick: 0 });
  const created = success(await workbench.execute(input));
  const snapshot = await workbench.snapshot();
  const item = snapshot.document.items[String(created.outcome.itemId)]!;
  assert.deepEqual(snapshot.document.timelines[timelineId]!.itemIds, [item.id]);
  assert.equal(item.params.voiceId, '');
  assert.equal(item.outputAssetId, undefined);
  assert.deepEqual(item.referenceAssetIds, []);
  assert.deepEqual(snapshot.document.assets, {});
  assert.deepEqual(await workbench.jobs(), { items: [] });
  assert.deepEqual(await workbench.execute(input), created);
  const reopened = await createWorkbench({ directory: root }); context.after(() => reopened.close());
  assert.deepEqual(await reopened.execute(input), created);
  assert.deepEqual(await reopened.snapshot(), snapshot);

  const invalidDrafts = [
    { payload: { timelineId, startTick: 6000, assetId: randomUUID() }, code: 'INVALID_INPUT' },
    { payload: { timelineId, startTick: 6000, durationTicks: 2000 }, code: 'INVALID_INPUT' },
    { payload: { timelineId: 'unknown-timeline', startTick: 6000 }, code: 'NOT_FOUND' },
    { payload: { timelineId, startTick: 0 }, code: 'NOT_APPLICABLE' },
  ];
  for (const invalid of invalidDrafts) {
    const rejected = await action(reopened, 'item.createDraft', invalid.payload);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, invalid.code);
    assert.deepEqual(await reopened.snapshot(), snapshot);
  }
  const missingAsset = await action(reopened, 'item.create', { timelineId, startTick: 6000 });
  assert.equal(missingAsset.ok, false);
  if (!missingAsset.ok) assert.equal(missingAsset.error.code, 'INVALID_INPUT');
  assert.deepEqual(await reopened.snapshot(), snapshot);
});

test('move and resize enforce half-open non-overlap and preserve input tokens; invalid updates never commit', async context => {
  const workbench = await createWorkbench({ directory: await directory(context), initial: createWorkbenchFixture() }); context.after(() => workbench.close());
  const original = imageItem(await workbench.snapshot());
  const duplicate = success(await action(workbench, 'item.duplicate', { itemId: original.id }));
  const copyId = String(duplicate.outcome.itemId);
  assert.equal((await workbench.snapshot()).document.items[copyId]!.startTick, 5000);
  const before = await workbench.snapshot();
  const overlap = await action(workbench, 'item.move', { itemId: copyId, startTick: 2500 });
  assert.equal(overlap.ok, false); if (!overlap.ok) assert.equal(overlap.error.code, 'NOT_APPLICABLE');
  assert.deepEqual(await workbench.snapshot(), before);
  success(await action(workbench, 'item.resize', { itemId: copyId, startTick: 5000, durationTicks: 2000 }));
  assert.equal((await workbench.snapshot()).document.items[original.id]!.generationToken, original.generationToken);
});

test('input edits invalidate only relevant item tokens; project title and placement leave requests valid', async context => {
  const workbench = await createWorkbench({ directory: await directory(context), initial: createWorkbenchFixture() }); context.after(() => workbench.close());
  const snapshot = await workbench.snapshot();
  const item = imageItem(snapshot);
  success(await action(workbench, 'item.params', { itemId: item.id, params: { prompt: '新的像素山谷' } }));
  assert.notEqual((await workbench.snapshot()).document.items[item.id]!.generationToken, item.generationToken);
  const tokens = Object.fromEntries(Object.values((await workbench.snapshot()).document.items).map(value => [value.id, value.generationToken]));
  success(await action(workbench, 'project.title', { title: '山谷习作' }));
  success(await action(workbench, 'item.move', { itemId: item.id, startTick: 1000 }));
  assert.deepEqual(Object.fromEntries(Object.values((await workbench.snapshot()).document.items).map(value => [value.id, value.generationToken])), tokens);
  success(await action(workbench, 'timeline.settings', { timelineId: item.timelineId, settings: { resolution: '2K' } }));
  const after = await workbench.snapshot();
  assert.notEqual(after.document.items[item.id]!.generationToken, tokens[item.id]);
  for (const other of Object.values(after.document.items)) if (other.id !== item.id) assert.equal(other.generationToken, tokens[other.id]);
});

test('verified import replays by bytes across restart; source placement and reference are distinct validated semantics', async context => {
  const root = await directory(context);
  const workbench = await createWorkbench({ directory: root, initial: createWorkbenchFixture() }); context.after(() => workbench.close());
  const input = { bytes: png, mimeType: 'image/png', name: '山谷.png', requestId: randomUUID(), expectedRevision: 0 };
  const imported = success(await workbench.importMedia(input));
  const assetId = String(imported.outcome.assetId);
  const reopened = await createWorkbench({ directory: root }); context.after(() => reopened.close());
  assert.deepEqual(await reopened.importMedia(input), imported);
  const different = await reopened.importMedia({ ...input, name: '不同.png' });
  assert.equal(different.ok, false); if (!different.ok) assert.equal(different.error.code, 'REQUEST_ID_REUSED');
  const snapshot = await reopened.snapshot();
  const image = imageItem(snapshot);
  const placed = success(await action(reopened, 'item.create', { timelineId: image.timelineId, startTick: 5000, assetId }));
  const placement = (await reopened.snapshot()).document.items[String(placed.outcome.itemId)]!;
  assert.equal(placement.outputAssetId, assetId); assert.deepEqual(placement.referenceAssetIds, []);
  success(await action(reopened, 'item.reference.add', { itemId: image.id, assetId }));
  assert.deepEqual((await reopened.snapshot()).document.items[image.id]!.referenceAssetIds, [assetId]);
  const music = Object.values(snapshot.document.items).find(item => item.kind === 'audio.music')!;
  const audioRef = await action(reopened, 'item.reference.add', { itemId: music.id, assetId });
  assert.equal(audioRef.ok, false); if (!audioRef.ok) assert.equal(audioRef.error.code, 'NOT_APPLICABLE');
  const video = Object.values(snapshot.document.items).find(item => item.kind === 'video.generated')!;
  const imageOnVideo = await action(reopened, 'item.create', { timelineId: video.timelineId, startTick: 5000, assetId });
  assert.equal(imageOnVideo.ok, false); if (!imageOnVideo.ok) assert.equal(imageOnVideo.error.code, 'NOT_APPLICABLE');
});

test('renderer cannot import arbitrary file handles or apply generation results, and malformed media is rejected', async context => {
  const workbench = await createWorkbench({ directory: await directory(context), initial: createWorkbenchFixture() }); context.after(() => workbench.close());
  const asset = { id: randomUUID(), kind: 'image', fileRef: 'C:/private/.env', metadata: {} };
  const forged = await action(workbench, 'asset.import', { asset });
  assert.equal(forged.ok, false); if (!forged.ok) assert.equal(forged.error.code, 'FORBIDDEN');
  const apply = await action(workbench, 'generation.apply', { jobId: randomUUID(), itemId: imageItem(await workbench.snapshot()).id, generationToken: 'fake', inputFingerprint: 'fake', asset });
  assert.equal(apply.ok, false); if (!apply.ok) assert.equal(apply.error.code, 'FORBIDDEN');
  await assert.rejects(workbench.importMedia({ bytes: Buffer.from('text'), mimeType: 'image/png', name: 'fake.png', requestId: randomUUID(), expectedRevision: 0 }), /媒体格式/);
  assert.equal((await workbench.snapshot()).revision, 0);
});

test('generation commits a durable outbox before dispatch, saves real bytes, and applies only through internal Action', async context => {
  const root = await directory(context); const provider = new MockImageProvider();
  const workbench = await createWorkbench({ directory: root, runner: runner(root, provider), initial: createWorkbenchFixture() }); context.after(() => workbench.close());
  const item = imageItem(await workbench.snapshot());
  const input = await envelope(workbench, 'generation.submit', { itemId: item.id });
  // Invoke the same ActionExecutor without starting its consumer to simulate a crash between commit and dispatch.
  const caller = { actorId: 'local-gui', source: 'gui' as const, projectIds: new Set([WORKBENCH_PROJECT_ID]), permissions: new Set(['generation.submit'] as const) };
  const queued = success(await workbench.executor.execute(input, caller));
  const jobId = String(queued.outcome.jobId);
  assert.equal((await workbench.repository.outbox()).length, 1);
  assert.equal(await workbench.runner!.jobs.get(jobId), undefined);
  const stored = JSON.parse(await readFile(join(root, 'project.json'), 'utf8'));
  assert.equal(stored.outbox[0].jobId, jobId);
  assert.equal(stored.snapshot.document.items[item.id].generationToken, stored.outbox[0].request.generationToken);
  const reopened = await createWorkbench({ directory: root, runner: runner(root, provider) }); context.after(() => reopened.close());
  await waitUntil(async () => Boolean((await reopened.snapshot()).document.items[item.id]!.outputAssetId));
  assert.equal(provider.calls, 1);
  const outputId = (await reopened.snapshot()).document.items[item.id]!.outputAssetId!;
  const media = await reopened.artifacts.read(await reopened.mediaAsset(outputId), new AbortController().signal);
  assert.deepEqual(Buffer.from(media.bytes), png);
  assert.equal((await reopened.runner!.jobs.get(jobId))!.state, 'succeeded');
  assert.deepEqual(await reopened.execute(input), queued);
  assert.equal(provider.calls, 1);
});

test('late generation cannot overwrite edited inputs and duplicate submit cannot charge twice', async context => {
  const root = await directory(context);
  let release!: () => void; const gate = new Promise<void>(accept => { release = accept; });
  const provider = new MockImageProvider(async () => gate);
  const workbench = await createWorkbench({ directory: root, runner: runner(root, provider), initial: createWorkbenchFixture() }); context.after(() => { release(); workbench.close(); });
  const item = imageItem(await workbench.snapshot());
  const submitted = success(await action(workbench, 'generation.submit', { itemId: item.id }));
  await waitUntil(async () => provider.calls === 1);
  const duplicate = await action(workbench, 'generation.submit', { itemId: item.id });
  assert.equal(duplicate.ok, false); if (!duplicate.ok) assert.equal(duplicate.error.code, 'NOT_APPLICABLE');
  success(await action(workbench, 'item.params', { itemId: item.id, params: { prompt: '修改后的输入' } }));
  release();
  await waitUntil(async () => (await workbench.runner!.jobs.get(String(submitted.outcome.jobId)))?.state === 'succeeded');
  await waitUntil(async () => (await workbench.repository.outbox()).length === 0);
  assert.equal((await workbench.snapshot()).document.items[item.id]!.outputAssetId, undefined);
  assert.equal(provider.calls, 1);
  assert.equal((await workbench.runner!.jobs.get(String(submitted.outcome.jobId)))!.artifactIds.length, 1);
});

test('cancel goes through an Action, invalidates the old token, and retains a terminal ledger without output', async context => {
  const root = await directory(context); const provider = new MockImageProvider(context => waitForProvider(100000, context.signal));
  const workbench = await createWorkbench({ directory: root, runner: runner(root, provider), initial: createWorkbenchFixture() }); context.after(() => workbench.close());
  const item = imageItem(await workbench.snapshot());
  const submitted = success(await action(workbench, 'generation.submit', { itemId: item.id }));
  const jobId = String(submitted.outcome.jobId);
  await waitUntil(async () => provider.calls === 1);
  const token = (await workbench.snapshot()).document.items[item.id]!.generationToken;
  success(await action(workbench, 'generation.cancel', { jobId }));
  await waitUntil(async () => (await workbench.runner!.jobs.get(jobId))?.state === 'canceled');
  assert.notEqual((await workbench.snapshot()).document.items[item.id]!.generationToken, token);
  assert.equal((await workbench.snapshot()).document.items[item.id]!.outputAssetId, undefined);
});

test('restart never re-submits an ambiguous running task without a persisted remote ID', async context => {
  const root = await directory(context); const provider = new MockImageProvider();
  const backend = runner(root, provider);
  const workbench = await createWorkbench({ directory: root, runner: backend, initial: createWorkbenchFixture() }); context.after(() => workbench.close());
  const item = imageItem(await workbench.snapshot());
  const caller = { actorId: 'local-gui', source: 'gui' as const, projectIds: new Set([WORKBENCH_PROJECT_ID]), permissions: new Set(['generation.submit'] as const) };
  const submitted = success(await workbench.executor.execute(await envelope(workbench, 'generation.submit', { itemId: item.id }), caller));
  const pending = (await workbench.repository.outbox())[0]!;
  const job = await backend.enqueue(pending.request!, String(submitted.outcome.jobId));
  await backend.jobs.update({ attemptToken: { jobId: job.id, attempt: 1 }, states: ['queued'] }, current => transitionJob(current, 'running', new Date().toISOString()));
  const reopened = await createWorkbench({ directory: root, runner: runner(root, provider) }); context.after(() => reopened.close());
  await waitUntil(async () => (await reopened.runner!.jobs.get(job.id))?.state === 'interrupted');
  assert.equal(provider.calls, 0);
  const resume = await action(reopened, 'generation.resume', { jobId: job.id });
  assert.equal(resume.ok, false); if (!resume.ok) assert.equal(resume.error.code, 'NOT_APPLICABLE');
});

test('host shutdown preserves interrupted remote work and explicit resume queries its original identity', async context => {
  const root = await directory(context);
  let submissions = 0;
  const provider = new MockImageProvider(async context => {
    if (!context.providerTaskId) {
      submissions++;
      await context.checkpointProviderTask('remote-original-task');
      await waitForProvider(100000, context.signal);
    } else assert.equal(context.providerTaskId, 'remote-original-task');
  });
  const workbench = await createWorkbench({ directory: root, runner: runner(root, provider), initial: createWorkbenchFixture() });
  const item = imageItem(await workbench.snapshot());
  const submitted = success(await action(workbench, 'generation.submit', { itemId: item.id }));
  const jobId = String(submitted.outcome.jobId);
  await waitUntil(async () => (await workbench.runner!.jobs.get(jobId))?.providerTaskId === 'remote-original-task');
  await workbench.shutdown();
  await waitUntil(async () => (await workbench.runner!.jobs.get(jobId))?.state === 'interrupted');
  await waitUntil(async () => (await workbench.repository.outbox()).length === 0);
  const reopened = await createWorkbench({ directory: root, runner: runner(root, provider) }); context.after(() => reopened.close());
  assert.equal((await reopened.runner!.jobs.get(jobId))!.state, 'interrupted');
  success(await action(reopened, 'generation.resume', { jobId }));
  await waitUntil(async () => Boolean((await reopened.snapshot()).document.items[item.id]!.outputAssetId));
  const restored = (await reopened.runner!.jobs.get(jobId))!;
  assert.equal(restored.state, 'succeeded'); assert.equal(restored.providerTaskId, 'remote-original-task'); assert.equal(restored.attempt, 2);
  assert.equal(submissions, 1);
});

test('progress reads merge only the current attempt in memory without creating project revisions or disk checkpoints', async context => {
  const root = await directory(context);
  let release!: () => void; const gate = new Promise<void>(accept => { release = accept; });
  const provider = new MockImageProvider(async context => {
    context.reportProgress({ attemptToken: context.attemptToken, fraction: 0.65, stage: '生成中' });
    context.reportProgress({ attemptToken: context.attemptToken, fraction: 0.2, stage: '等待' });
    await gate;
  });
  const workbench = await createWorkbench({ directory: root, runner: runner(root, provider), initial: createWorkbenchFixture() }); context.after(() => { release(); workbench.close(); });
  const submitted = success(await action(workbench, 'generation.submit', { itemId: imageItem(await workbench.snapshot()).id }));
  const jobId = String(submitted.outcome.jobId);
  await waitUntil(async () => (await workbench.jobs()).items.some(job => job.id === jobId && job.progress === 0.65));
  assert.equal((await workbench.snapshot()).revision, submitted.revision);
  assert.equal((await workbench.runner!.jobs.get(jobId))!.progress, 0);
  release();
  await waitUntil(async () => (await workbench.repository.outbox()).length === 0);
  assert.equal((await workbench.jobs()).items.find(job => job.id === jobId)!.state, 'succeeded');
});

test('trusted parent IPC closes the Windows-compatible local host cleanly without forced process termination', async context => {
  const root = await directory(context);
  const probe = createPortProbe();
  await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
  const address = probe.address(); assert.ok(address && typeof address === 'object');
  const apiPort = address.port;
  await new Promise<void>(accept => probe.close(() => accept()));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/server.ts')], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PIXEL_STORAGE_DIR: root, PIXEL_API_PORT: String(apiPort), ELEVENLABS_API_KEY: '', OPENROUTER_API_KEY: '' } });
  let output = ''; let acknowledged = false; let exited = false; let exitCode: number | null = null;
  child.stdout!.on('data', data => { output += data.toString(); });
  child.stderr!.on('data', data => { output += data.toString(); });
  child.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'pixel.closed') acknowledged = true; });
  child.on('exit', code => { exited = true; exitCode = code; });
  context.after(() => { if (!exited) child.kill(); });
  await waitUntil(async () => output.includes('本地宿主已启动'));
  assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/status`)).status, 200);
  child.send({ type: 'pixel.shutdown' });
  await waitUntil(async () => exited);
  assert.equal(acknowledged, true); assert.equal(exitCode, 0);
});

test('model discovery stays bounded and can continue or filter instead of returning an unbounded catalog', async context => {
  const workbench = await createWorkbench({ directory: await directory(context) }); context.after(() => workbench.close());
  const first = workbench.models({ limit: 2 });
  assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  const second = workbench.models({ limit: 2, cursor: first.nextCursor });
  assert.equal(second.items.length, 2); assert.ok(second.items.every(model => !first.items.some(previous => model.modelId === previous.modelId)));
  assert.equal(workbench.models({ outputKind: 'video' }).items[0]!.modelId, 'alibaba/wan-3.0');
  assert.throws(() => workbench.models({ limit: 1000 }), /查询条件/);
});

test('local HTTP bridge rejects hostile origins and serves imported media with bounded byte ranges', async context => {
  const workbench = await createWorkbench({ directory: await directory(context) });
  const server = createApiServer(workbench);
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const hostile = await fetch(`${base}/api/project`, { headers: { Origin: 'https://untrusted.example' } }); assert.equal(hostile.status, 403);
  const trusted = await fetch(`${base}/api/status`, { headers: { Origin: 'http://localhost:4310' } });
  assert.deepEqual(await trusted.json(), { providers: { elevenlabs: false, openrouter: false } });
  const upload = await fetch(`${base}/api/import`, { method: 'POST', headers: { Origin: 'http://localhost:4310', 'Content-Type': 'image/png', 'X-Pixel-Name': encodeURIComponent('山谷.png'), 'X-Pixel-Request-Id': randomUUID(), 'X-Pixel-Revision': '0' }, body: png });
  const imported = success(await upload.json() as ActionResult);
  const media = await fetch(`${base}/api/media/${imported.outcome.assetId}`, { headers: { Range: 'bytes=0-7' } });
  assert.equal(media.status, 206); assert.equal(media.headers.get('content-range'), `bytes 0-7/${png.length}`);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), png.subarray(0, 8));
  const invalid = await fetch(`${base}/api/media/${imported.outcome.assetId}`, { headers: { Range: 'bytes=999999-' } }); assert.equal(invalid.status, 416);
  const wrongOrigin = await fetch(`${base}/api/actions`, { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify(await envelope(workbench, 'project.title', { title: '恶意修改' })) });
  assert.equal(wrongOrigin.status, 403); assert.equal((await workbench.snapshot()).document.title, '未命名作品');
});

test('SSE publishes authoritative project revisions and disconnect cleans the subscription', async context => {
  const workbench = await createWorkbench({ directory: await directory(context) });
  const server = createApiServer(workbench); await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const abort = new AbortController();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, { signal: abort.signal });
  const reader = response.body!.getReader();
  await reader.read();
  const receipt = success(await action(workbench, 'project.title', { title: '事件测试' }));
  const part = await reader.read();
  const text = new TextDecoder().decode(part.value);
  assert.match(text, /project.changed/); assert.match(text, new RegExp(`"revision":${receipt.revision}`));
  abort.abort(); await reader.cancel().catch(() => {});
});
