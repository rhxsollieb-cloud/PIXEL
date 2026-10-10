import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { DeepReadonly, GenerationRequest } from '../src/contracts.js';
import { BaseModelProvider, ProviderError, type GenerationOutput, type ProviderRunContext } from '../src/generation.js';
import { GenerationRunner, ProviderRegistry } from '../src/runtime.js';
import { FileArtifactStore, FileJobRepository } from '../src/storage.js';

const request = (): GenerationRequest => ({ projectId: 'project', targetItemId: 'item', generationToken: 'token', inputFingerprint: 'ignored',
  providerId: 'openrouter', providerVersion: '1', modelId: 'alibaba/wan-3.0', params: { prompt: 'an actual test' }, references: [] });

class CountedProvider extends BaseModelProvider {
  readonly manifest = { providerId: 'openrouter', providerVersion: '1', modelIds: ['alibaba/wan-3.0'], supportsCancellation: true };
  entries = 0;
  override async generate(input: DeepReadonly<GenerationRequest>, context: ProviderRunContext): Promise<GenerationOutput> {
    this.entries += 1; return super.generate(input, context);
  }
  protected async performGeneration(_input: DeepReadonly<GenerationRequest>, context: ProviderRunContext): Promise<GenerationOutput> {
    const artifact = await context.artifacts.write({ attemptToken: context.attemptToken, kind: 'video', metadata: { mimeType: 'video/mp4' }, bytes: new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112]) });
    return { artifactIds: [artifact.id] };
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pixel-runtime-fence-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('pixel-runtime-fence-'));
    await rm(root, { recursive: true, force: true });
  });
  const provider = new CountedProvider(); const providers = new ProviderRegistry(); providers.register(provider);
  return { provider, providers, jobs: new FileJobRepository(join(root, 'jobs')), artifacts: new FileArtifactStore(join(root, 'artifacts')) };
}

test('trusted execution fence checks after durable running state and prevents provider entry when rejected', async t => {
  const { provider, providers, jobs, artifacts } = await fixture(t);
  let id = ''; let fences = 0;
  const runner = new GenerationRunner(providers, jobs, artifacts, async () => {
    fences += 1; assert.equal((await jobs.get(id))?.state, 'running');
    throw new ProviderError('AUTHENTICATION', 'Host execution authority expired');
  });
  const result = await runner.run(request(), { onJob: job => { id = job.id; } });
  assert.equal(result.state, 'failed'); assert.equal(fences, 1); assert.equal(provider.entries, 0);
  assert.deepEqual(result.artifactIds, []);
});

test('cancellation arriving during the trusted fence prevents even calling provider.generate', async t => {
  const { provider, providers, jobs, artifacts } = await fixture(t);
  const controller = new AbortController();
  const runner = new GenerationRunner(providers, jobs, artifacts, async () => { controller.abort(); });
  const result = await runner.run(request(), { signal: controller.signal });
  assert.equal(result.state, 'canceled'); assert.equal(provider.entries, 0); assert.deepEqual(result.artifactIds, []);
});

test('a valid trusted host fence permits the existing generation kernel and artifact ownership checks', async t => {
  const { provider, providers, jobs, artifacts } = await fixture(t);
  let fences = 0;
  const runner = new GenerationRunner(providers, jobs, artifacts, async () => { fences += 1; });
  const result = await runner.run(request());
  assert.equal(result.state, 'succeeded'); assert.equal(fences, 1); assert.equal(provider.entries, 1);
  assert.equal(result.artifactIds.length, 1); assert.equal((await artifacts.get(result.artifactIds[0]!))?.jobId, result.id);
});
