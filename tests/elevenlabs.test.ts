import assert from 'node:assert/strict';
import test from 'node:test';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import type { GenerationArtifact, GenerationRequest, JsonObject } from '../src/contracts.js';
import { createSdkFetch, ProviderError, type ArtifactWriteRequest, type ProviderRunContext } from '../src/generation.js';
import { ElevenLabsModelProvider } from '../src/providers/elevenlabs.js';

const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 1, 2, 3]);

function request(modelId: string, params: JsonObject): GenerationRequest {
  return {
    projectId: 'project_test', targetItemId: 'item_test', generationToken: 'generation_test',
    inputFingerprint: 'fingerprint_test', providerId: 'elevenlabs', providerVersion: '1',
    modelId, params, references: [],
  };
}

function harness(fetch: typeof globalThis.fetch, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  const writes: { request: ArtifactWriteRequest; bytes: Uint8Array }[] = [];
  const progress: number[] = [];
  const client = new ElevenLabsClient({ apiKey: 'test_key', fetch: createSdkFetch(fetch), logging: { silent: true } });
  const provider = new ElevenLabsModelProvider({ apiKey: 'test_key', client, ...options });
  const context: ProviderRunContext = {
    signal: options.signal ?? new AbortController().signal,
    attemptToken: { jobId: 'job_test', attempt: 3 },
    reportProgress: (value) => { progress.push(value.fraction); },
    checkpointProviderTask: async () => { throw new Error('Audio requests have no resumable task'); },
    artifacts: {
      async write(value) {
        const chunks: Uint8Array[] = [];
        if (value.bytes instanceof Uint8Array) chunks.push(value.bytes);
        else for await (const chunk of value.bytes) chunks.push(chunk);
        const bytes = new Uint8Array(Buffer.concat(chunks));
        if (bytes.length === 0) throw new ProviderError('INVALID_OUTPUT', 'Audio stream was empty');
        writes.push({ request: value, bytes });
        const artifact: GenerationArtifact = {
          id: `artifact_${writes.length}`, jobId: value.attemptToken.jobId,
          asset: { id: `asset_${writes.length}`, kind: value.kind, fileRef: 'managed:test', metadata: value.metadata },
        };
        return artifact;
      },
    },
  };
  return { provider, context, writes, progress };
}

function mp3Response(headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(audio.subarray(0, 5));
      controller.enqueue(audio.subarray(5));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'audio/mpeg', ...headers } });
}

test('Eleven v4 通过真实 SDK 编码 voice 路径、模型与参数，流保存携带当前 attempt', async () => {
  const calls: { url: string; body: Record<string, unknown>; signal: AbortSignal | null | undefined }[] = [];
  const h = harness(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, signal: init?.signal });
    assert.equal(new Headers(init?.headers).get('xi-api-key'), 'test_key');
    return mp3Response();
  });
  const result = await h.provider.generate(request('eleven_v4', {
    text: '[excited] Hello!', voiceId: 'voice_test', languageCode: 'en', seed: 0,
    voiceSettings: { stability: 0, similarityBoost: 0.75 },
  }), h.context);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]!.url).pathname, '/v1/text-to-speech/voice_test');
  assert.equal(new URL(calls[0]!.url).searchParams.get('output_format'), 'mp3_44100_128');
  assert.deepEqual(calls[0]!.body, {
    text: '[excited] Hello!', model_id: 'eleven_v4', language_code: 'en', seed: 0,
    voice_settings: { stability: 0, similarity_boost: 0.75 },
  });
  assert.ok(calls[0]!.signal instanceof AbortSignal);
  assert.deepEqual(result, { artifactIds: ['artifact_1'] });
  assert.deepEqual(h.writes[0]!.bytes, audio);
  assert.deepEqual(h.writes[0]!.request.attemptToken, { jobId: 'job_test', attempt: 3 });
  assert.equal(h.writes[0]!.request.metadata.mimeType, 'audio/mpeg');
  assert.equal(h.writes[0]!.request.metadata.extension, 'mp3');
  assert.equal(h.progress.at(-1), 1);
});

test('用户音效别名规范化为官方 v2 ID，duration 与 loop 由 SDK 显式发送', async () => {
  let body: Record<string, unknown> = {};
  let path = '';
  const h = harness(async (url, init) => {
    path = new URL(String(url)).pathname;
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return mp3Response();
  });
  await h.provider.generate(request('eleven_text_sound_v2', {
    text: 'Soft rain on a window', durationSeconds: 3, loop: true, promptInfluence: 0,
  }), h.context);
  assert.equal(path, '/v1/sound-generation');
  assert.deepEqual(body, {
    text: 'Soft rain on a window', model_id: 'eleven_text_to_sound_v2',
    duration_seconds: 3, loop: true, prompt_influence: 0,
  });
  assert.equal(h.writes[0]!.request.metadata.modelId, 'eleven_text_to_sound_v2');
});

test('Music v2.5 支持 prompt 与纯生成 chunks 计划，保存 song-id 及明确 MP3 格式', async () => {
  const bodies: Record<string, unknown>[] = [];
  const h = harness(async (url, init) => {
    assert.equal(new URL(String(url)).pathname, '/v1/music');
    assert.equal(new URL(String(url)).searchParams.get('output_format'), 'mp3_48000_192');
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return mp3Response({ 'song-id': 'remote_song_test' });
  });
  await h.provider.generate(request('music_v2_5', {
    prompt: 'Bright ambient piano', musicLengthMs: 5_000, forceInstrumental: true,
  }), h.context);
  await h.provider.generate(request('music_v2_5', {
    compositionPlan: {
      chunks: [{ text: '[Intro]', durationMs: 3_000, positiveStyles: ['piano'], contextAdherence: 'high' }],
    },
    seed: 0,
  }), h.context);
  assert.deepEqual(bodies[0], {
    model_id: 'music_v2_5', prompt: 'Bright ambient piano', music_length_ms: 5_000, force_instrumental: true,
  });
  assert.equal(bodies[1]!.model_id, 'music_v2_5');
  assert.equal(bodies[1]!.seed, 0);
  assert.equal(bodies[1]!.prompt, undefined);
  assert.equal(bodies[1]!.force_instrumental, undefined);
  const plan = bodies[1]!.composition_plan as { chunks: Record<string, unknown>[] };
  assert.equal(plan.chunks[0]!.duration_ms, 3_000);
  assert.deepEqual(plan.chunks[0]!.positive_styles, ['piano']);
  assert.equal(h.writes[1]!.request.metadata.songId, 'remote_song_test');
});

test('无 voice、无效音效范围、无效音乐组合及不支持引用在请求前拒绝', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return mp3Response(); });
  const invalid = [
    request('eleven_v4', { text: 'Hello' }),
    request('eleven_v4', { text: 'Hello', voiceId: 'voice_test', voiceSettings: { speed: 1 } }),
    request('eleven_text_to_sound_v2', { text: 'Wind', durationSeconds: 31 }),
    request('music_v2_5', { prompt: 'Music', seed: 3 }),
    request('music_v2_5', { prompt: 'Music', musicLengthMs: 2_000 }),
    request('music_v2_5', {
      prompt: 'Music', compositionPlan: { chunks: [{ text: '[Intro]', durationMs: 3_000, positiveStyles: [] }] },
    }),
    request('music_v2_5', { compositionPlan: { chunks: [{ songId: 'remote_song', range: { startMs: 0, endMs: 3_000 } }] } }),
  ];
  for (const input of invalid) {
    await assert.rejects(h.provider.generate(input, h.context), (error: unknown) =>
      error instanceof ProviderError && error.code === 'INVALID_INPUT');
  }
  const withReference = request('music_v2_5', { prompt: 'Music' });
  withReference.references.push({ id: 'asset_ref', kind: 'audio', fileRef: 'managed:ref', metadata: {} });
  await assert.rejects(h.provider.generate(withReference, h.context), (error: unknown) =>
    error instanceof ProviderError && error.code === 'UNSUPPORTED_REFERENCE');
  assert.equal(calls, 0);
  assert.equal(h.writes.length, 0);
});

test('生成失败不触发 SDK 自动重试，错误不暴露供应商原始内容', async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return new Response(JSON.stringify({ detail: 'sensitive upstream content test_key' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  });
  await assert.rejects(h.provider.generate(request('eleven_v4', { text: 'Hello', voiceId: 'voice_test' }), h.context),
    (error: unknown) => error instanceof ProviderError && error.code === 'UPSTREAM'
      && !error.message.includes('sensitive') && !error.message.includes('test_key'));
  assert.equal(calls, 1);
  assert.equal(h.writes.length, 0);
});

test('网络 fetch 拒绝由 SDK transport 清理请求计时器，并脱敏为一次上游失败', async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    throw new Error('raw network error contains test_key and signed URL');
  });
  await assert.rejects(h.provider.generate(request('eleven_v4', { text: 'Hello', voiceId: 'voice_test' }), h.context),
    (error: unknown) => error instanceof ProviderError && error.code === 'UPSTREAM'
      && !error.message.includes('test_key') && !error.message.includes('signed URL'));
  assert.equal(calls, 1);
  assert.equal(h.writes.length, 0);
});

test('HTTP 成功但返回 JSON 或空音频时不产生成功产物', async () => {
  for (const response of [
    new Response('{"error":"unexpected"}', { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array(), { headers: { 'content-type': 'audio/mpeg' } }),
  ]) {
    const h = harness(async () => response);
    await assert.rejects(h.provider.generate(request('music_v2_5', { prompt: 'Music' }), h.context),
      (error: unknown) => error instanceof ProviderError && error.code === 'INVALID_OUTPUT');
    assert.equal(h.writes.length, 0);
  }
});

test('流在 HTTP 响应之后挂起，核心总超时仍会取消消费且不会提交产物', async () => {
  let canceled = false;
  const stalled = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  const h = harness(async () => new Response(stalled, { headers: { 'content-type': 'audio/mpeg' } }), { timeoutMs: 30 });
  await assert.rejects(h.provider.generate(request('music_v2_5', { prompt: 'Music' }), h.context),
    (error: unknown) => error instanceof ProviderError && error.code === 'TIMEOUT');
  assert.equal(canceled, true);
  assert.equal(h.writes.length, 0);
});

test('用户取消流消费后返回 CANCELED，不能将半个音频挂为结果', async () => {
  const controller = new AbortController();
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(output) { output.enqueue(audio.subarray(0, 3)); },
    cancel() { canceled = true; },
  });
  const h = harness(async () => new Response(stream, { headers: { 'content-type': 'audio/mpeg' } }), { signal: controller.signal });
  const generation = h.provider.generate(request('eleven_v4', { text: 'Hello', voiceId: 'voice_test' }), h.context);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(generation, (error: unknown) => error instanceof ProviderError && error.code === 'CANCELED');
  assert.equal(canceled, true);
  assert.equal(h.writes.length, 0);
});
