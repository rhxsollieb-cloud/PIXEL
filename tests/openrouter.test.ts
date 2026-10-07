import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { OpenRouter } from '@openrouter/sdk';
import { HTTPClient } from '@openrouter/sdk/lib/http.js';
import type { GenerationArtifact, GenerationRequest } from '../src/contracts.js';
import type { ArtifactWriteRequest, ProviderRunContext } from '../src/generation.js';
import { ProviderError } from '../src/generation.js';
import { OpenRouterModelProvider } from '../src/providers/openrouter.js';
import { GenerationRunner, ProviderRegistry } from '../src/runtime.js';
import { FileArtifactStore, FileJobRepository } from '../src/storage.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64');
const taskId = 'gen-vid-test_123';
const mp4 = new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]);

function request(modelId = 'alibaba/wan-3.0'): GenerationRequest {
  return {
    projectId: 'project_1', targetItemId: 'item_1', generationToken: 'token_1', inputFingerprint: 'fingerprint_1',
    providerId: 'openrouter', providerVersion: '1', modelId,
    params: { prompt: 'A cloud passes over the moon' }, settings: {},
    ...(modelId === 'alibaba/wan-3.0' ? { durationMs: 5000 } : {}), references: [],
  };
}

function context(signal = new AbortController().signal) {
  const checkpoints: string[] = [];
  const writes: { request: ArtifactWriteRequest; bytes: Uint8Array }[] = [];
  const value: ProviderRunContext = {
    signal,
    attemptToken: { jobId: 'job_1', attempt: 1 },
    reportProgress: () => {},
    checkpointProviderTask: async (id) => { checkpoints.push(id); },
    media: { read: async () => ({ bytes: png, mimeType: 'image/png' }) },
    artifacts: {
      async write(input) {
        const chunks: Uint8Array[] = [];
        if (input.bytes instanceof Uint8Array) chunks.push(input.bytes);
        else for await (const chunk of input.bytes) chunks.push(chunk);
        writes.push({ request: input, bytes: Buffer.concat(chunks) });
        const id = `artifact_${writes.length}`;
        const artifact: GenerationArtifact = {
          id, jobId: input.attemptToken.jobId,
          asset: { id: `asset_${writes.length}`, kind: input.kind, fileRef: `managed:${id}`, metadata: input.metadata },
        };
        return artifact;
      },
    },
  };
  return { value, checkpoints, writes };
}

function sdk(handler: (request: Request, call: number) => Promise<Response> | Response) {
  const calls: Request[] = [];
  const client = new OpenRouter({
    apiKey: 'test-openrouter-key',
    // 错误配置也不得把 API key 带出官方域名。
    serverURL: 'https://example.invalid/api',
    httpClient: new HTTPClient({
      fetcher: async (input, init) => {
        const outgoing = new Request(input, init);
        calls.push(outgoing);
        return handler(outgoing, calls.length);
      },
    }),
  });
  return { client, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function video(status: string, extra: Record<string, unknown> = {}) {
  return { id: taskId, status, polling_url: 'https://attacker.invalid/poll', ...extra };
}

test('Wan 使用官方视频 SDK 提交、持久化 ID、轮询并经固定 content 端点保存产物', async () => {
  const { client, calls } = sdk((outgoing) => {
    if (outgoing.method === 'POST') return json(video('pending'), 202);
    if (outgoing.url.includes('/content')) return new Response(mp4, { headers: { 'content-type': 'video/mp4' } });
    return json(video('completed', { unsigned_urls: ['https://attacker.invalid/content'] }));
  });
  const run = context();
  const output = await new OpenRouterModelProvider(client, { pollIntervalMs: 1 }).generate(request(), run.value);
  assert.deepEqual(run.checkpoints, [taskId]);
  assert.deepEqual(output.artifactIds, ['artifact_1']);
  assert.equal(calls.length, 3);
  const payload = await calls[0]!.json() as Record<string, unknown>;
  assert.equal(payload.model, 'alibaba/wan-3.0');
  assert.equal(payload.duration, 5);
  assert.equal(payload.resolution, '720p');
  assert.equal(payload.aspect_ratio, '16:9');
  for (const outgoing of calls) {
    assert.equal(new URL(outgoing.url).origin, 'https://openrouter.ai');
    assert.equal(outgoing.redirect, 'error');
    assert.equal(outgoing.headers.get('authorization'), 'Bearer test-openrouter-key');
  }
  assert.match(calls[2]!.url, new RegExp(`/videos/${taskId}/content\\?index=0$`));
  assert.equal(run.writes[0]!.request.kind, 'video');
  assert.equal(run.writes[0]!.request.metadata.providerTaskId, taskId);
  assert.deepEqual(run.writes[0]!.bytes, Buffer.from(mp4));
});

test('远程 ID checkpoint 完成之前不会轮询或下载', async () => {
  let completeCheckpoint!: () => void;
  let checkpointStarted!: () => void;
  const started = new Promise<void>((resolve) => { checkpointStarted = resolve; });
  const durable = new Promise<void>((resolve) => { completeCheckpoint = resolve; });
  const { client, calls } = sdk((outgoing) => outgoing.method === 'POST'
    ? json(video('pending'), 202)
    : outgoing.url.includes('/content')
      ? new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
      : json(video('completed', { unsigned_urls: ['https://ignored.invalid'] })));
  const run = context();
  run.value.checkpointProviderTask = async () => { checkpointStarted(); await durable; };
  const output = new OpenRouterModelProvider(client, { pollIntervalMs: 1 }).generate(request(), run.value);
  await started;
  assert.equal(calls.length, 1);
  completeCheckpoint();
  await output;
  assert.equal(calls.length, 3);
});

test('Wan 恢复已有远程任务只 GET，不重复收费提交；非法 ID 不发请求', async () => {
  const { client, calls } = sdk((outgoing) => outgoing.url.includes('/content')
    ? new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
    : json(video('completed')));
  const run = context();
  run.value.providerTaskId = taskId;
  await new OpenRouterModelProvider(client).generate(request(), run.value);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((outgoing) => outgoing.method === 'GET'));
  assert.deepEqual(run.checkpoints, []);
  const invalid = context();
  invalid.value.providerTaskId = '../escape';
  await assert.rejects(new OpenRouterModelProvider(client).generate(request(), invalid.value), { code: 'INVALID_OUTPUT' });
  assert.equal(calls.length, 2);
});

test('Wan 首帧与参考模式通过可信媒体读取器转换成 data URL，不能静默忽略引用', async () => {
  let payload: Record<string, unknown> | undefined;
  const { client } = sdk(async (outgoing) => {
    if (outgoing.method === 'POST') { payload = await outgoing.json() as Record<string, unknown>; return json(video('completed'), 202); }
    return new Response(mp4, { headers: { 'content-type': 'video/mp4' } });
  });
  const input = request();
  input.params.referenceMode = 'firstFrame';
  input.references.push({ id: 'ref_1', kind: 'image', fileRef: 'managed:ref_1', metadata: { url: 'https://attacker.invalid' } });
  await new OpenRouterModelProvider(client).generate(input, context().value);
  assert.deepEqual(payload?.frame_images, [{ type: 'image_url', frame_type: 'first_frame', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }]);
  assert.equal(payload?.input_references, undefined);
  input.params.referenceMode = 'reference';
  await new OpenRouterModelProvider(client).generate(input, context().value);
  assert.ok(Array.isArray(payload?.input_references));
  assert.equal(payload?.frame_images, undefined);
});

test('Grok 使用专用 images SDK，保存解码后的 PNG 并识别省略的 MIME', async () => {
  let payload: Record<string, unknown> | undefined;
  const { client, calls } = sdk(async (outgoing) => {
    payload = await outgoing.json() as Record<string, unknown>;
    return json({ created: 1786500000, data: [{ b64_json: png.toString('base64') }] });
  });
  const input = request('x-ai/grok-imagine-image-2.0');
  input.settings = { resolution: '2K', quality: 'medium', aspectRatio: '3:2' };
  input.references.push({ id: 'ref_1', kind: 'image', fileRef: 'managed:ref_1', metadata: {} });
  const run = context();
  assert.deepEqual(await new OpenRouterModelProvider(client).generate(input, run.value), { artifactIds: ['artifact_1'] });
  assert.equal(calls[0]!.url, 'https://openrouter.ai/api/v1/images');
  assert.equal(payload?.model, 'x-ai/grok-imagine-image-2.0');
  assert.equal(payload?.resolution, '2K');
  assert.equal(payload?.aspect_ratio, '3:2');
  assert.equal(payload?.quality, 'medium');
  assert.equal(payload?.n, 1);
  assert.equal(payload?.stream, false);
  assert.equal(run.writes[0]!.request.metadata.mimeType, 'image/png');
  assert.deepEqual(run.writes[0]!.bytes, png);
  assert.deepEqual(run.checkpoints, []);
});

test('不支持的参数、引用和图像恢复在网络调用前拒绝', async () => {
  const { client, calls } = sdk(() => { throw new Error('Unexpected network request'); });
  const provider = new OpenRouterModelProvider(client);
  const invalid = request();
  invalid.params.durationSeconds = 31;
  await assert.rejects(provider.generate(invalid, context().value), { code: 'INVALID_INPUT' });
  const audio = request();
  audio.references.push({ id: 'audio_1', kind: 'audio', fileRef: 'managed:audio_1', metadata: {} });
  await assert.rejects(provider.generate(audio, context().value), ProviderError);
  const image = request('x-ai/grok-imagine-image-2.0');
  image.settings = { quality: 'high' };
  await assert.rejects(provider.generate(image, context().value), { code: 'INVALID_INPUT' });
  const resume = context();
  resume.value.providerTaskId = taskId;
  await assert.rejects(provider.generate(request('x-ai/grok-imagine-image-2.0'), resume.value), { code: 'UNSUPPORTED_RESUME' });
  assert.equal(calls.length, 0);
});

test('上游失败不会盲目重试，未知视频状态与任务 ID 不可下载', async () => {
  const failure = sdk(() => json({ error: { code: 500, message: 'test-openrouter-key secret' } }, 500));
  await assert.rejects(new OpenRouterModelProvider(failure.client).generate(request(), context().value), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.doesNotMatch(error.message, /test-openrouter-key|secret/);
    return true;
  });
  assert.equal(failure.calls.length, 1);
  for (const data of [video('unexpected'), video('completed', { id: 'other_task' }), video('failed')]) {
    const invalid = sdk(() => json(data));
    const run = context();
    run.value.providerTaskId = taskId;
    await assert.rejects(new OpenRouterModelProvider(invalid.client).generate(request(), run.value),
      { code: data.status === 'failed' ? 'REMOTE_FAILED' : 'INVALID_OUTPUT' });
    assert.equal(run.writes.length, 0);
    assert.equal(invalid.calls.length, 1);
  }
});

test('图像格式、base64 和产物大小校验失败时不保存输出', async () => {
  const cases = [
    { b64_json: 'not base64!' },
    { b64_json: Buffer.from('text masquerading as an image').toString('base64') },
    { b64_json: png.toString('base64'), media_type: 'image/jpeg' },
  ];
  for (const data of cases) {
    const { client } = sdk(() => json({ created: 1786500000, data: [data] }));
    const run = context();
    await assert.rejects(new OpenRouterModelProvider(client).generate(request('x-ai/grok-imagine-image-2.0'), run.value), { code: 'INVALID_OUTPUT' });
    assert.equal(run.writes.length, 0);
  }
  const large = sdk(() => json({ created: 1786500000, data: [{ b64_json: png.toString('base64') }] }));
  await assert.rejects(new OpenRouterModelProvider(large.client, { maxArtifactBytes: 4 }).generate(request('x-ai/grok-imagine-image-2.0'), context().value), { code: 'INVALID_OUTPUT' });
});

test('取消轮询保留远程 task checkpoint；超时 signal 传给 SDK 且不重提', async () => {
  const controller = new AbortController();
  const pending = sdk(() => json(video('pending'), 202));
  const run = context(controller.signal);
  run.value.reportProgress = () => controller.abort();
  await assert.rejects(new OpenRouterModelProvider(pending.client).generate(request(), run.value), { code: 'CANCELED' });
  assert.deepEqual(run.checkpoints, [taskId]);
  assert.equal(pending.calls.length, 1);
  const hanging = sdk(async (outgoing) => new Promise<Response>((_resolve, reject) => {
    outgoing.signal.addEventListener('abort', () => reject(outgoing.signal.reason), { once: true });
  }));
  await assert.rejects(new OpenRouterModelProvider(hanging.client, { timeoutMs: 20 }).generate(request(), context().value), { code: 'TIMEOUT' });
  assert.equal(hanging.calls.length, 1);
  assert.equal(hanging.calls[0]!.signal.aborted, true);
});

test('取消正在读取的视频流会释放 reader；空流和超限流不会成为产物', async () => {
  const controller = new AbortController();
  let canceledStream = false;
  const waiting = sdk((outgoing) => {
    if (outgoing.method === 'POST') return json(video('completed'), 202);
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(mp4);
        setTimeout(() => controller.abort(), 10);
      },
      cancel() { canceledStream = true; },
    }), { headers: { 'content-type': 'video/mp4' } });
  });
  const run = context(controller.signal);
  await assert.rejects(new OpenRouterModelProvider(waiting.client).generate(request(), run.value), { code: 'CANCELED' });
  assert.equal(canceledStream, true);
  assert.deepEqual(run.checkpoints, [taskId]);
  assert.equal(run.writes.length, 0);
  for (const bytes of [new Uint8Array(), new Uint8Array([1, 2, 3, 4, 5])]) {
    const invalid = sdk((outgoing) => outgoing.method === 'POST'
      ? json(video('completed'), 202)
      : new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
    const output = context();
    await assert.rejects(new OpenRouterModelProvider(invalid.client, { maxArtifactBytes: 4 }).generate(request(), output.value), { code: 'INVALID_OUTPUT' });
    assert.equal(output.writes.length, 0);
  }
});

test('HTTP 200 错误页不能冒充 MP4；跨 chunk 的 MP4 header 保持流式读取', async () => {
  for (const errorPage of ['{"error":"failed"}', '<html>upstream failure</html>']) {
    const invalid = sdk((outgoing) => outgoing.method === 'POST'
      ? json(video('completed'), 202)
      : new Response(errorPage, { headers: { 'content-type': 'video/mp4' } }));
    const run = context();
    await assert.rejects(new OpenRouterModelProvider(invalid.client).generate(request(), run.value), { code: 'INVALID_OUTPUT' });
    assert.equal(run.writes.length, 0);
  }
  const valid = sdk((outgoing) => outgoing.method === 'POST' ? json(video('completed'), 202)
    : new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(mp4.subarray(0, 3));
        stream.enqueue(mp4.subarray(3, 6));
        stream.enqueue(mp4.subarray(6));
        stream.close();
      },
    }), { headers: { 'content-type': 'video/mp4' } }));
  const run = context();
  await new OpenRouterModelProvider(valid.client).generate(request(), run.value);
  assert.deepEqual(run.writes[0]!.bytes, Buffer.from(mp4));
});

test('远端 failed/cancelled/expired 任务进入失败终态，Runner 不将它们标为可恢复中断', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-openrouter-'));
  try {
    for (const status of ['failed', 'cancelled', 'expired']) {
      const remote = sdk(() => json(video(status), 202));
      const providers = new ProviderRegistry();
      providers.register(new OpenRouterModelProvider(remote.client));
      const jobs = new FileJobRepository(join(directory, status, 'jobs'));
      const artifacts = new FileArtifactStore(join(directory, status, 'artifacts'));
      const runner = new GenerationRunner(providers, jobs, artifacts);
      const job = await runner.run(request());
      assert.equal(job.state, 'failed');
      assert.equal(job.error?.code, 'REMOTE_FAILED');
      assert.equal(job.providerTaskId, taskId);
      await assert.rejects(runner.resume(job.id), { code: 'UNSUPPORTED_RESUME' });
      assert.equal(remote.calls.length, 1);
    }
  } finally {
    const target = resolve(directory);
    assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`) && basename(target).startsWith('pixel-openrouter-'));
    await rm(target, { recursive: true, force: true });
  }
});
