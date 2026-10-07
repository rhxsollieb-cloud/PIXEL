import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { DeepReadonly, GenerationJob, GenerationRequest } from '../src/contracts.js';
import { BaseModelProvider, ProviderError, type GenerationOutput, type ProviderRunContext } from '../src/generation.js';
import { modelRegistry } from '../src/models.js';
import { GenerationRunner, ProviderRegistry, generationInputFingerprint, loadBackendConfiguration } from '../src/runtime.js';
import { FileArtifactStore, FileJobRepository } from '../src/storage.js';

async function directory(t: TestContext): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), 'pixel-runtime-test-'));
  t.after(async () => {
    const checked = resolve(temporary);
    assert.equal(dirname(checked), resolve(tmpdir()));
    assert.ok(basename(checked).startsWith('pixel-runtime-test-'));
    await rm(checked, { recursive: true, force: true });
  });
  return temporary;
}

function request(): GenerationRequest {
  return {
    projectId: 'project', targetItemId: 'item', generationToken: 'generation_1',
    inputFingerprint: 'ignored-untrusted-fingerprint', providerId: 'openrouter', providerVersion: '1',
    modelId: 'alibaba/wan-3.0', params: { prompt: 'A sunrise over mountains' }, references: [],
  };
}

test('后端配置读取已知 env 键，环境覆盖文件，缺失配置不输出凭证', async t => {
  const root = await directory(t);
  const envPath = join(root, '.env');
  await writeFile(envPath, 'ELEVENLABS_API_KEY=file-eleven-test\nOPENROUTER_API_KEY=file-router-test\nVITE_OTHER=ignored\n');
  const configuration = await loadBackendConfiguration({ envPath, environment: { OPENROUTER_API_KEY: 'environment-test' }, storageDirectory: join(root, 'data') });
  assert.equal(configuration.elevenlabsApiKey, 'file-eleven-test');
  assert.equal(configuration.openrouterApiKey, 'environment-test');
  assert.deepEqual(Object.keys(configuration).sort(), ['elevenlabsApiKey', 'openrouterApiKey', 'storageDirectory']);
  await assert.rejects(loadBackendConfiguration({ envPath: join(root, 'missing'), environment: { ELEVENLABS_API_KEY: 'private-test-value' } }),
    error => error instanceof ProviderError && error.code === 'AUTHENTICATION' && !error.message.includes('private-test-value'));
});

test('产物流保存真实字节与可解析句柄；空内容和超限失败没有残留发布文件', async t => {
  const root = await directory(t);
  const store = new FileArtifactStore(join(root, 'artifacts'), 8);
  const artifact = await store.write({
    attemptToken: { jobId: 'job', attempt: 2 }, kind: 'image', metadata: { mimeType: 'image/png' },
    bytes: (async function* () { yield new Uint8Array([1, 2]); yield new Uint8Array([3, 4]); })(),
  });
  assert.ok((await store.resolvePath(artifact.asset)).endsWith('.png'));
  assert.deepEqual((await store.read(artifact.asset, new AbortController().signal)).bytes, Buffer.from([1, 2, 3, 4]));
  assert.equal((await store.get(artifact.id))?.asset.metadata.attempt, 2);
  assert.equal((await store.listByJob('job')).length, 1);
  const filesBefore = (await readdir(join(root, 'artifacts'))).sort();
  for (const bytes of [new Uint8Array(), new Uint8Array(9)]) {
    await assert.rejects(store.write({ attemptToken: { jobId: 'failed', attempt: 1 }, kind: 'image', metadata: { mimeType: 'image/png' }, bytes }),
      error => error instanceof ProviderError && error.code === 'INVALID_OUTPUT');
  }
  assert.deepEqual((await readdir(join(root, 'artifacts'))).sort(), filesBefore);
  await assert.rejects(store.resolvePath({ ...artifact.asset, fileRef: '../.env' }));
  await assert.rejects(store.resolvePath({ ...artifact.asset, id: 'different-asset' }));
});

test('核心模板拒绝未通过当前 writer 创建的产物与其他 attempt', async () => {
  class ForeignProvider extends BaseModelProvider {
    readonly manifest = { providerId: 'openrouter', providerVersion: '1', modelIds: ['alibaba/wan-3.0'], supportsCancellation: false };
    protected async performGeneration(_request: DeepReadonly<GenerationRequest>, _context: ProviderRunContext): Promise<GenerationOutput> { return { artifactIds: ['foreign-artifact'] }; }
  }
  const provider = new ForeignProvider();
  const context: ProviderRunContext = {
    signal: new AbortController().signal, attemptToken: { jobId: 'job', attempt: 1 },
    reportProgress: () => {}, checkpointProviderTask: async () => {},
    artifacts: { write: async () => { throw new Error('not reached'); } },
  };
  await assert.rejects(provider.generate(request(), context), error => error instanceof ProviderError && error.code === 'INVALID_OUTPUT');
  class StaleWriterProvider extends ForeignProvider {
    protected override async performGeneration(_request: DeepReadonly<GenerationRequest>, context: ProviderRunContext): Promise<GenerationOutput> {
      await context.artifacts.write({
        attemptToken: { jobId: context.attemptToken.jobId, attempt: context.attemptToken.attempt + 1 },
        kind: 'video', metadata: { mimeType: 'video/mp4' }, bytes: new Uint8Array([1]),
      });
      throw new Error('stale attempt must be rejected before reaching the underlying writer');
    }
  }
  await assert.rejects(new StaleWriterProvider().generate(request(), context), error => error instanceof ProviderError && error.code === 'INVALID_OUTPUT');
});

test('持久化中断任务恢复继续同一远端 ID，产生新 attempt 且只提交一次', async t => {
  const root = await directory(t);
  const registry = new ProviderRegistry();
  class ResumableProvider extends BaseModelProvider {
    readonly manifest = { providerId: 'openrouter', providerVersion: '1', modelIds: ['alibaba/wan-3.0'], supportsCancellation: false, supportsResume: true };
    submits = 0;
    protected async performGeneration(_request: DeepReadonly<GenerationRequest>, context: ProviderRunContext): Promise<GenerationOutput> {
      if (!context.providerTaskId) {
        this.submits++;
        await context.checkpointProviderTask('remote-task');
        throw new ProviderError('UPSTREAM', 'Polling disconnected');
      }
      assert.equal(context.providerTaskId, 'remote-task');
      const artifact = await context.artifacts.write({
        attemptToken: context.attemptToken, kind: 'video', metadata: { mimeType: 'video/mp4' },
        bytes: new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112]),
      });
      return { artifactIds: [artifact.id] };
    }
  }
  const provider = new ResumableProvider();
  registry.register(provider);
  const jobs = new FileJobRepository(join(root, 'jobs'));
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const runner = new GenerationRunner(registry, jobs, artifacts);
  const interrupted = await runner.run(request());
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.providerTaskId, 'remote-task');
  assert.notEqual(interrupted.request.inputFingerprint, request().inputFingerprint);
  // 新实例模拟进程重启，依赖磁盘记录而非旧 runner 的局部内存。
  const recoveredRunner = new GenerationRunner(registry, new FileJobRepository(join(root, 'jobs')), new FileArtifactStore(join(root, 'artifacts')));
  const succeeded = await recoveredRunner.resume(interrupted.id);
  assert.equal(succeeded.state, 'succeeded');
  assert.equal(succeeded.attempt, 2);
  assert.equal(succeeded.providerTaskId, 'remote-task');
  assert.equal(provider.submits, 1);
  assert.equal(succeeded.artifactIds.length, 1);
  assert.equal((await artifacts.get(succeeded.artifactIds[0]!))?.jobId, succeeded.id);
  const stale = await jobs.update({ attemptToken: { jobId: succeeded.id, attempt: 1 }, states: ['running'] }, current => structuredClone(current) as GenerationJob);
  assert.equal(stale, undefined);
});

for (const code of ['RATE_LIMITED', 'AUTHENTICATION'] as const) {
  test(`远端任务已保存后 ${code} 保留恢复能力，恢复不重复提交`, async t => {
    const root = await directory(t);
    class RecoverableAccessProvider extends BaseModelProvider {
      readonly manifest = { providerId: 'openrouter', providerVersion: '1', modelIds: ['alibaba/wan-3.0'], supportsCancellation: false, supportsResume: true };
      submits = 0;
      protected async performGeneration(_request: DeepReadonly<GenerationRequest>, context: ProviderRunContext): Promise<GenerationOutput> {
        if (!context.providerTaskId) {
          this.submits++;
          await context.checkpointProviderTask('remote-existing');
          throw new ProviderError(code, 'Temporary access problem');
        }
        assert.equal(context.providerTaskId, 'remote-existing');
        const artifact = await context.artifacts.write({
          attemptToken: context.attemptToken, kind: 'video', metadata: { mimeType: 'video/mp4' },
          bytes: new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112]),
        });
        return { artifactIds: [artifact.id] };
      }
    }
    const provider = new RecoverableAccessProvider();
    const registry = new ProviderRegistry(); registry.register(provider);
    const jobs = new FileJobRepository(join(root, 'jobs'));
    const artifacts = new FileArtifactStore(join(root, 'artifacts'));
    const interrupted = await new GenerationRunner(registry, jobs, artifacts).run(request());
    assert.equal(interrupted.state, 'interrupted');
    assert.equal(interrupted.error?.code, code);
    assert.equal(interrupted.error?.retryable, false);
    const recovered = await new GenerationRunner(registry, new FileJobRepository(join(root, 'jobs')), artifacts).resume(interrupted.id);
    assert.equal(recovered.state, 'succeeded');
    assert.equal(recovered.attempt, 2);
    assert.equal(provider.submits, 1);
  });
}

test('用户在提交前取消时不调用供应商，取消状态按两步持久化', async t => {
  const root = await directory(t);
  class CancelProvider extends BaseModelProvider {
    readonly manifest = { providerId: 'openrouter', providerVersion: '1', modelIds: ['alibaba/wan-3.0'], supportsCancellation: false };
    calls = 0;
    protected async performGeneration(): Promise<GenerationOutput> { this.calls++; throw new Error('must not run'); }
  }
  const provider = new CancelProvider();
  const registry = new ProviderRegistry(); registry.register(provider);
  const jobs = new FileJobRepository(join(root, 'jobs'));
  const runner = new GenerationRunner(registry, jobs, new FileArtifactStore(join(root, 'artifacts')));
  const controller = new AbortController(); controller.abort();
  const canceled = await runner.run(request(), { signal: controller.signal });
  assert.equal(canceled.state, 'canceled');
  assert.equal((await jobs.get(canceled.id))?.state, 'canceled');
  assert.equal(provider.calls, 0);
  await assert.rejects(runner.resume(canceled.id), error => error instanceof ProviderError && error.code === 'UNSUPPORTED_RESUME');
});

test('规范输入指纹不受字典键顺序、项目位置与 token 影响，相关输入变化会改变指纹', () => {
  const first = modelRegistry.prepareRequest(request());
  const second = structuredClone(first);
  second.projectId = 'unrelated'; second.generationToken = 'new-generation';
  second.params = Object.fromEntries(Object.entries(first.params).reverse()) as typeof first.params;
  assert.equal(generationInputFingerprint(first), generationInputFingerprint(second));
  second.settings = { ...second.settings, resolution: '1080p' };
  assert.notEqual(generationInputFingerprint(first), generationInputFingerprint(second));
});
