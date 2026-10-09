import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { ActionResult, CallerContext, DeepReadonly, GenerationRequest, JsonObject } from '../src/contracts.js';
import { BaseModelProvider, type ArtifactWriteRequest, type ProviderRunContext } from '../src/generation.js';
import { bundledFfmpegPath } from '../src/audio-processing.js';
import { GenerationRunner, ProviderRegistry } from '../src/runtime.js';
import { FileArtifactStore, FileJobRepository } from '../src/storage.js';
import { timelineRegistry } from '../src/timeline-catalog.js';
import { captureGenerationRequest, createWorkbench, type Workbench } from './local-workbench.js';
import { validateWorkbenchProjectFile } from '../src/project-files.js';

function success(result: ActionResult) { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error('Expected success'); return result; }
async function action(workbench: Workbench, type: string, payload: JsonObject) {
  return workbench.execute({ projectId: workbench.projectId, expectedRevision: (await workbench.snapshot()).revision, requestId: randomUUID(), type, payload });
}
function barrier() { let release!: () => void; const promise = new Promise<void>(accept => { release = accept; }); return { promise, release }; }
async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error('Manual output check timed out'); await new Promise(accept => setTimeout(accept, 15)); }
}
let sharedVideo: Promise<Buffer> | undefined;
async function video(root: string) {
  return sharedVideo ??= (async () => {
    const file = join(root, 'fixture.mp4');
    await new Promise<void>((accept, reject) => {
      const child = spawn(bundledFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=10:d=0.3', '-c:v', 'mpeg4', '-y', file], { windowsHide: true, shell: false, stdio: 'ignore' });
      child.on('error', reject); child.on('close', code => code === 0 ? accept() : reject(new Error('Video fixture failed')));
    });
    return readFile(file);
  })();
}
class VideoProvider extends BaseModelProvider {
  readonly manifest = { providerId: 'openrouter', providerVersion: '1', modelIds: ['alibaba/wan-3.0'], supportsCancellation: false, supportsResume: true };
  readonly started = barrier();
  readonly continue = barrier();
  calls = 0;
  constructor(private readonly bytes: Uint8Array) { super({ timeoutMs: 10_000 }); }
  protected async performGeneration(_request: DeepReadonly<GenerationRequest>, context: ProviderRunContext) {
    this.calls++; this.started.release(); await this.continue.promise;
    const artifact = await context.artifacts.write({ attemptToken: context.attemptToken, bytes: this.bytes, kind: 'video', metadata: { mimeType: 'video/mp4' } });
    return { artifactIds: [artifact.id] };
  }
}
class BlockingImports extends FileArtifactStore {
  readonly written = barrier();
  readonly continue = barrier();
  override async write(request: ArtifactWriteRequest) {
    const artifact = await super.write(request);
    if (request.attemptToken.jobId.startsWith('import_')) { this.written.release(); await this.continue.promise; }
    return artifact;
  }
}
async function fixture(context: TestContext, options: { provider?: boolean; blockedImports?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pixel-manual-output-'));
  const bytes = await video(root);
  const store = options.blockedImports ? new BlockingImports(join(root, 'artifacts')) : new FileArtifactStore(join(root, 'artifacts'));
  const provider = options.provider ? new VideoProvider(bytes) : undefined;
  const registry = new ProviderRegistry(); if (provider) registry.register(provider);
  const runner = provider ? new GenerationRunner(registry, new FileJobRepository(join(root, 'jobs')), store) : undefined;
  const workbench = await createWorkbench({ directory: root, artifacts: store, ...(runner ? { runner } : {}) });
  context.after(async () => {
    provider?.continue.release(); if (store instanceof BlockingImports) store.continue.release();
    await workbench.shutdown();
    const checked = resolve(root); assert.equal(dirname(checked), resolve(tmpdir())); assert.ok(basename(checked).startsWith('pixel-manual-output-'));
    await rm(checked, { recursive: true, force: true });
  });
  return { root, bytes, workbench, provider, store };
}
async function draft(workbench: Workbench, startTick = 1200) {
  const timelineId = String(success(await action(workbench, 'timeline.create', { typeId: 'alibaba/wan-3.0' })).outcome.timelineId);
  const itemId = String(success(await action(workbench, 'item.createDraft', { timelineId, startTick })).outcome.itemId);
  success(await action(workbench, 'item.params', { itemId, params: { prompt: '保留原始分镜与生成提示词' } }));
  return { itemId, timelineId };
}
async function uploadInput(workbench: Workbench, bytes: Uint8Array, itemId: string, provenance: 'manual' | 'external' = 'manual') {
  return { bytes, itemId, provenance, mimeType: 'video/mp4', name: '网页视频.mp4', requestId: randomUUID(), expectedRevision: (await workbench.snapshot()).revision };
}

test('manual video outputs preserve model inputs, persist provenance, replay exactly, and retain files across subsequent edits', async context => {
  const { root, bytes, workbench } = await fixture(context);
  const { itemId, timelineId } = await draft(workbench);
  assert.equal(timelineRegistry.describe('alibaba/wan-3.0').capabilities.manualOutput, true);
  assert.equal(timelineRegistry.describe('x-ai/grok-imagine-image-2.0').capabilities.manualOutput, undefined);
  const before = await workbench.snapshot();
  const input = await uploadInput(workbench, bytes, itemId, 'external');
  const receipt = success(await workbench.importOutputMedia(input));
  assert.equal(receipt.undoable, true); assert.equal(receipt.revision, before.revision + 1);
  assert.equal(Object.hasOwn(receipt.outcome, 'generationCommands'), false);
  const assetId = String(receipt.outcome.assetId);
  let snapshot = await workbench.snapshot(); const item = snapshot.document.items[itemId]!;
  assert.equal(item.outputAssetId, assetId); assert.equal(item.outputOrigin, 'manual');
  assert.equal(item.startTick, 1200); assert.equal(item.durationTicks, 300); assert.equal(item.sourceOffsetTicks, 0);
  assert.deepEqual(item.params, before.document.items[itemId]!.params); assert.deepEqual(item.generationSettings, before.document.items[itemId]!.generationSettings);
  assert.notEqual(item.generationToken, before.document.items[itemId]!.generationToken);
  assert.equal(snapshot.document.assets[assetId]!.metadata.outputProvenance, 'external');
  assert.equal(snapshot.document.assets[assetId]!.metadata.durationMs, 300);
  assert.deepEqual(await workbench.importOutputMedia(input), receipt);
  for (const changed of [{ provenance: 'manual' as const }, { itemId: randomUUID() }, { name: '不同名称.mp4' }, { bytes: Uint8Array.from([...bytes, 0]) }]) {
    const result = await workbench.importOutputMedia({ ...input, ...changed });
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'REQUEST_ID_REUSED');
  }
  assert.deepEqual(await workbench.snapshot(), snapshot);
  success(await action(workbench, 'item.params', { itemId, params: { prompt: '人工输出仍可作为分镜预览', durationSeconds: 7 } }));
  success(await action(workbench, 'timeline.defaults', { timelineId, itemDefaults: { durationSeconds: 8 } }));
  success(await action(workbench, 'timeline.refreshDefaults', { timelineId }));
  snapshot = await workbench.snapshot(); assert.equal(snapshot.document.items[itemId]!.outputAssetId, assetId); assert.equal(snapshot.document.items[itemId]!.outputOrigin, 'manual');
  const reopened = await createWorkbench({ directory: root }); context.after(() => reopened.shutdown());
  assert.deepEqual(await reopened.snapshot(), snapshot);
  const persisted = validateWorkbenchProjectFile(JSON.parse(await readFile(join(root, 'project.json'), 'utf8')));
  const uploadHistory = persisted.history.find(entry => entry.requestId === input.requestId)!;
  assert.equal(uploadHistory.before.items[itemId]!.outputAssetId, undefined); assert.equal(uploadHistory.after.items[itemId]!.outputAssetId, assetId);
  success(await action(workbench, 'item.delete', { itemId })); success(await action(workbench, 'asset.remove', { assetId }));
  assert.deepEqual((await workbench.artifacts.read(snapshot.document.assets[assetId]!, new AbortController().signal)).bytes, bytes);
  assert.deepEqual(await workbench.jobs(), { items: [] });
});

test('longer uploaded sources keep the edited interval and reset source offset without moving neighbors', async context => {
  const { bytes, workbench } = await fixture(context);
  const { itemId, timelineId } = await draft(workbench, 0);
  success(await action(workbench, 'item.resize', { itemId, startTick: 0, durationTicks: 100 }));
  const nextId = String(success(await action(workbench, 'item.createDraft', { timelineId, startTick: 100 })).outcome.itemId);
  success(await workbench.importOutputMedia(await uploadInput(workbench, bytes, itemId)));
  const snapshot = await workbench.snapshot(); assert.equal(snapshot.document.items[itemId]!.durationTicks, 100); assert.equal(snapshot.document.items[nextId]!.startTick, 100);
});

test('unsupported targets, forged Actions and fake MP4 files do not attach assets or change generation intent', async context => {
  const { root, bytes, workbench } = await fixture(context);
  const { itemId } = await draft(workbench);
  const before = await workbench.snapshot();
  const fake = Buffer.alloc(32); fake.write('ftyp', 4);
  await assert.rejects(workbench.importOutputMedia(await uploadInput(workbench, fake, itemId)), /无法读取|没有可用/);
  await assert.rejects(workbench.importOutputMedia({ ...await uploadInput(workbench, bytes, itemId), provenance: 'unknown' as 'manual' }), /来源/);
  assert.deepEqual(await workbench.snapshot(), before);
  await assert.rejects(readdir(join(root, 'artifacts')), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  const local = success(await workbench.placeExternalMedia({ bytes, mimeType: 'video/mp4', name: '普通.mp4', requestId: randomUUID(), expectedRevision: before.revision, startTick: 0 }));
  for (const targetId of [String(local.outcome.itemId), String(success(await action(workbench, 'item.createDraft', { timelineId: String(success(await action(workbench, 'timeline.create', { typeId: 'x-ai/grok-imagine-image-2.0' })).outcome.timelineId), startTick: 0 })).outcome.itemId)]) {
    const unchanged = await workbench.snapshot();
    await assert.rejects(workbench.importOutputMedia(await uploadInput(workbench, bytes, targetId)));
    assert.deepEqual(await workbench.snapshot(), unchanged);
  }
  const snapshot = await workbench.snapshot(); const asset = snapshot.document.assets[String(local.outcome.assetId)]!;
  const forged = await action(workbench, 'media.outputExternal', { itemId, provenance: 'manual', asset: asset as unknown as JsonObject, cancelJobIds: [] });
  assert.equal(forged.ok, false); if (!forged.ok) assert.equal(forged.error.code, 'FORBIDDEN');
  assert.deepEqual(await workbench.snapshot(), snapshot);
});

test('manual upload atomically cancels an active job and rejects its late result; explicit future generation can replace it', async context => {
  const { bytes, workbench, provider } = await fixture(context, { provider: true });
  const { itemId } = await draft(workbench);
  const oldRequest = captureGenerationRequest((await workbench.snapshot()).document, (await workbench.snapshot()).document.items[itemId]!);
  const submitted = success(await action(workbench, 'generation.submit', { itemId }));
  await provider!.started.promise;
  const running = (await workbench.jobs()).items.find(job => job.id === submitted.outcome.jobId)!;
  success(await workbench.importOutputMedia(await uploadInput(workbench, bytes, itemId, 'external')));
  await until(async () => (await workbench.jobs()).items.some(job => job.id === running.id && job.state === 'canceled'));
  const snapshot = await workbench.snapshot(); const assetId = snapshot.document.items[itemId]!.outputAssetId!;
  const late = await workbench.executor.execute({ projectId: workbench.projectId, expectedRevision: snapshot.revision, requestId: randomUUID(), type: 'generation.apply', payload: { jobId: running.id, itemId, generationToken: running.request.generationToken, inputFingerprint: running.request.inputFingerprint, asset: snapshot.document.assets[assetId] } }, { actorId: 'trusted-result-host', source: 'internal', projectIds: new Set([workbench.projectId]), permissions: new Set(['generation.apply']) });
  assert.equal(late.ok, false); if (!late.ok) assert.equal(late.error.code, 'STALE_RESULT');
  assert.deepEqual(await workbench.snapshot(), snapshot); assert.notEqual(oldRequest.generationToken, snapshot.document.items[itemId]!.generationToken);
  provider!.continue.release();
  const newJob = success(await action(workbench, 'generation.submit', { itemId }));
  await until(async () => (await workbench.jobs()).items.some(job => job.id === newJob.outcome.jobId && job.state === 'succeeded'));
  await until(async () => (await workbench.snapshot()).document.items[itemId]!.outputOrigin === 'generated');
  assert.equal(provider!.calls, 2); assert.notEqual((await workbench.snapshot()).document.items[itemId]!.outputAssetId, assetId);
});

test('a pending start superseded by upload never calls its provider even before its AbortController exists', async context => {
  const { bytes, workbench, provider } = await fixture(context, { provider: true });
  const { itemId } = await draft(workbench);
  const caller: CallerContext = { actorId: 'local-gui', source: 'gui', projectIds: new Set([workbench.projectId]), permissions: new Set(['generation.submit']) };
  const submitted = success(await workbench.executor.execute({ projectId: workbench.projectId, expectedRevision: (await workbench.snapshot()).revision, requestId: randomUUID(), type: 'generation.submit', payload: { itemId } }, caller));
  assert.equal(provider!.calls, 0);
  success(await workbench.importOutputMedia(await uploadInput(workbench, bytes, itemId)));
  try { await until(async () => (await workbench.repository.outbox()).length === 0); }
  catch (error) { throw new Error(`${(error as Error).message}; ${JSON.stringify({ outbox: await workbench.repository.outbox(), jobs: await workbench.jobs(), calls: provider!.calls })}`); }
  assert.equal(provider!.calls, 0); assert.equal((await workbench.snapshot()).document.items[itemId]!.outputOrigin, 'manual');
  const job = (await workbench.jobs()).items.find(candidate => candidate.id === submitted.outcome.jobId);
  assert.equal(job?.state, 'canceled');
});

test('an upload losing the revision race does not cancel the accepted generation or detach its output', async context => {
  const { root, bytes, workbench, provider, store } = await fixture(context, { provider: true, blockedImports: true });
  const { itemId } = await draft(workbench);
  const submitted = success(await action(workbench, 'generation.submit', { itemId })); await provider!.started.promise;
  const before = await workbench.snapshot(); const operation = workbench.importOutputMedia(await uploadInput(workbench, bytes, itemId));
  await (store as BlockingImports).written.promise;
  success(await action(workbench, 'project.title', { title: '并发编辑先提交' }));
  (store as BlockingImports).continue.release(); const rejected = await operation;
  assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error.code, 'REVISION_CONFLICT');
  const current = await workbench.snapshot(); assert.equal(current.document.items[itemId]!.generationToken, before.document.items[itemId]!.generationToken); assert.equal(current.document.items[itemId]!.outputAssetId, undefined);
  const file = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as { outbox: { operation: string }[] };
  assert.equal(file.outbox.some(entry => entry.operation === 'cancel'), false);
  provider!.continue.release();
  await until(async () => (await workbench.jobs()).items.some(job => job.id === submitted.outcome.jobId && job.state === 'succeeded'));
  await until(async () => (await workbench.snapshot()).document.items[itemId]!.outputOrigin === 'generated');
  assert.equal(provider!.calls, 1);
});
