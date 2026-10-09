import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { createSdkFetch } from '../src/generation.js';
import { MAX_VOICE_SAMPLE_BYTES, voiceCloneCommandSchema, type VoiceCloneInput, type VoiceSummary } from '../src/voice-contracts.js';
import { VoiceService, VoiceServiceError, type VoiceProvider } from '../src/voices.js';
import { ElevenLabsVoiceProvider } from '../src/providers/elevenlabs-voices.js';

const sample = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
function input(overrides: Partial<VoiceCloneInput> = {}): VoiceCloneInput {
  return { requestId: 'request_test', projectId: 'project_test', timelineId: 'timeline_test', expectedRevision: 2,
    name: '我的声纹', bytes: sample, mimeType: 'audio/mpeg', fileName: 'sample.mp3', ...overrides };
}
function voice(voiceId = 'voice_test', category: VoiceSummary['category'] = 'cloned'): VoiceSummary {
  return { voiceId, name: `声音 ${voiceId}`, category, status: 'ready' };
}
function rejected(code: string): (error: unknown) => boolean {
  return error => error instanceof VoiceServiceError && error.code === code;
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function provider(fetch: typeof globalThis.fetch): ElevenLabsVoiceProvider {
  return new ElevenLabsVoiceProvider({ apiKey: 'voice_test_key', client: new ElevenLabsClient({
    apiKey: 'voice_test_key', fetch: createSdkFetch(fetch), logging: { silent: true },
  }) });
}
function mock(overrides: Partial<VoiceProvider> = {}): VoiceProvider {
  return { accountScope: 'account_test', query: async () => ({ items: [] }), clone: async () => voice(), ...overrides };
}
async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-voices-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('官方 SDK search 使用 v2 过滤账号来源，保留超过请求数量的首屏及验证状态', async () => {
  const urls: URL[] = [];
  const adapter = provider(async (url, init) => {
    urls.push(new URL(String(url)));
    assert.equal(new Headers(init?.headers).get('xi-api-key'), 'voice_test_key');
    assert.ok(init?.signal instanceof AbortSignal);
    return json({ voices: [
      { voice_id: 'new_default', name: '新默认声音', category: 'high_quality', samples: [{ transcript: 'private' }] },
      { voice_id: 'verify', name: '待验证', category: 'professional', voice_verification: {
        requires_verification: true, is_verified: false, verification_failures: [], verification_attempts_count: 0,
      } },
      { voice_id: 'blocked', name: '不可用', safety_control: 'BAN' },
    ], has_more: true, next_page_token: 'sdk_next', total_count: 3 });
  });
  const result = await adapter.query({ category: 'default', limit: 1, search: '声音' }, new AbortController().signal);
  assert.equal(urls[0]!.pathname, '/v2/voices');
  assert.equal(urls[0]!.searchParams.get('voice_type'), 'default');
  assert.equal(urls[0]!.searchParams.get('page_size'), '1');
  assert.equal(urls[0]!.searchParams.get('include_total_count'), 'false');
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items.map(item => item.status), ['ready', 'verificationRequired', 'unavailable']);
  assert.equal(result.items[0]!.category, 'default');
  assert.equal('samples' in result.items[0]!, false);
  assert.equal(result.nextCursor, 'sdk_next');
});

test('自己的声纹包含 IVC 和 PVC，排除声音设计及明确非本人资源；缺验证字段不虚构受限状态', async () => {
  const adapter = provider(async url => {
    const parsed = new URL(String(url));
    assert.equal(parsed.searchParams.get('voice_type'), 'personal');
    assert.equal(parsed.searchParams.get('next_page_token'), 'page_2');
    return json({ voices: [
      { voice_id: 'ivc', name: 'IVC', category: 'cloned', is_owner: true },
      { voice_id: 'pvc', name: 'PVC', category: 'professional' },
      { voice_id: 'pending', name: '待处理 PVC', category: 'professional', fine_tuning: { state: { eleven_v4: 'queued' } } },
      { voice_id: 'pvc_verify', name: '待验证 PVC', category: 'professional', fine_tuning: { state: { eleven_v4: 'not_verified' } } },
      { voice_id: 'design', category: 'generated' },
      { voice_id: 'other', category: 'cloned', is_owner: false },
    ], has_more: false, total_count: 4 });
  });
  const result = await adapter.query({ category: 'cloned', limit: 5, cursor: 'page_2' }, new AbortController().signal);
  assert.deepEqual(result.items.map(item => item.voiceId), ['ivc', 'pvc', 'pending', 'pvc_verify']);
  assert.deepEqual(result.items.map(item => item.status), ['ready', 'ready', 'unavailable', 'verificationRequired']);
});

test('共享查询分页保存供应商首屏溢出、绑定筛选并继续供应商 cursor', async t => {
  const directory = await temporary(t);
  const calls: string[] = [];
  const service = new VoiceService(mock({ query: async query => {
    calls.push(query.cursor ?? 'first');
    return query.cursor ? { items: [voice('last', 'default')] }
      : { items: Array.from({ length: 8 }, (_, index) => voice(String(index), 'default')), nextCursor: 'upstream_next' };
  } }), directory);
  t.after(() => service.shutdown());
  const first = await service.query({ category: 'default' });
  assert.deepEqual(first.items.map(item => item.voiceId), ['0', '1', '2', '3', '4']);
  await assert.rejects(service.query({ category: 'cloned', cursor: first.nextCursor! }), rejected('INVALID_INPUT'));
  await assert.rejects(service.query({ category: 'default', cursor: first.nextCursor!, search: 'changed' }), rejected('INVALID_INPUT'));
  const second = await service.query({ category: 'default', cursor: first.nextCursor! });
  assert.deepEqual(second.items.map(item => item.voiceId), ['5', '6', '7']);
  assert.deepEqual(calls, ['first']);
  const third = await service.query({ category: 'default', cursor: second.nextCursor! });
  assert.deepEqual(third.items.map(item => item.voiceId), ['last']);
  assert.equal(third.nextCursor, undefined);
  assert.deepEqual(calls, ['first', 'upstream_next']);
  const other = new VoiceService(mock({ accountScope: 'other_account' }), directory);
  t.after(() => other.shutdown());
  await assert.rejects(other.query({ category: 'default', cursor: first.nextCursor! }), rejected('INVALID_INPUT'));
});

test('筛除后空页仍保留后续 cursor，不丢失后页自己的克隆', async t => {
  const service = new VoiceService(provider(async url => {
    const token = new URL(String(url)).searchParams.get('next_page_token');
    return json(token ? { voices: [{ voice_id: 'mine', name: '我的声纹', category: 'cloned' }], has_more: false, total_count: 1 }
      : { voices: [{ voice_id: 'design', category: 'generated' }], has_more: true, next_page_token: 'after_design', total_count: 2 });
  }), await temporary(t));
  t.after(() => service.shutdown());
  const first = await service.query({ category: 'cloned' });
  assert.deepEqual(first.items, []);
  assert.ok(first.nextCursor);
  const second = await service.query({ category: 'cloned', cursor: first.nextCursor });
  assert.equal(second.items[0]!.voiceId, 'mine');
});

test('标准 voice.clone 命令严格校验单 MP3/WAV、大小及信封，非法输入不调用 SDK', async t => {
  let calls = 0;
  const service = new VoiceService(mock({ clone: async () => { calls++; return voice(); } }), await temporary(t));
  t.after(() => service.shutdown());
  assert.ok(voiceCloneCommandSchema.safeParse({ type: 'voice.clone', input: input() }).success);
  assert.equal(voiceCloneCommandSchema.safeParse({ type: 'voice.clone', input: input(), alternate: true }).success, false);
  const invalid = [input({ bytes: new Uint8Array() }), input({ bytes: new Uint8Array(MAX_VOICE_SAMPLE_BYTES + 1) }),
    input({ fileName: '../sample.mp3' }), input({ fileName: 'sample.wav' }), input({ name: '  ' }), input({ expectedRevision: -1 })];
  for (const value of invalid) await assert.rejects(service.clone(value), rejected('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('官方 SDK IVC multipart 与持久化顺序：POST 前已有 attempt，成功后可重启重放', async t => {
  const directory = await temporary(t);
  let calls = 0;
  const adapter = provider(async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).pathname, '/v1/voices/add');
    assert.equal(init?.method, 'POST');
    const files = await readdir(directory);
    const attempt = JSON.parse(await readFile(join(directory, files.find(file => file.endsWith('.json'))!), 'utf8'));
    assert.equal(attempt.command, 'voice.clone');
    assert.equal(attempt.state, 'attempted');
    assert.equal('bytes' in attempt, false);
    assert.equal(JSON.stringify(attempt).includes('voice_test_key'), false);
    const body = init?.body;
    assert.ok(body instanceof FormData);
    assert.equal(body.get('name'), '我的声纹');
    assert.equal(body.get('remove_background_noise'), 'false');
    assert.equal(body.getAll('files').length, 1);
    const file = body.get('files') as File;
    assert.equal(file.name, 'sample.mp3');
    assert.equal(file.type, 'audio/mpeg');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), sample);
    return json({ voice_id: 'created', requires_verification: false });
  });
  const service = new VoiceService(adapter, directory);
  const result = await service.clone(input());
  assert.equal(result.voice.voiceId, 'created');
  assert.equal(result.voice.status, 'ready');
  assert.deepEqual(await service.clone(input()), result);
  await service.shutdown();
  const restored = new VoiceService(adapter, directory);
  t.after(() => restored.shutdown());
  assert.deepEqual(await restored.clone(input()), result);
  assert.equal(calls, 1);
});

test('同一请求绑定完整内容，正在提交及成功后均拒绝内容改变', async t => {
  const gate = deferred<VoiceSummary>();
  const started = deferred<void>();
  let calls = 0;
  const service = new VoiceService(mock({ clone: async () => { calls++; started.resolve(); return gate.promise; } }), await temporary(t));
  t.after(() => service.shutdown());
  const original = input();
  const first = service.clone(original);
  await started.promise;
  const duplicate = service.clone(input());
  for (const change of [{ name: '另一声音' }, { expectedRevision: 3 }, { projectId: 'another_project' },
    { timelineId: 'another_timeline' }, { fileName: 'other.mp3' }, { bytes: new Uint8Array([9, 9]) }]) {
    await assert.rejects(service.clone(input(change)), rejected('REQUEST_ID_REUSED'));
  }
  gate.resolve(voice());
  assert.deepEqual(await first, await duplicate);
  await assert.rejects(service.clone(input({ name: 'changed' })), rejected('REQUEST_ID_REUSED'));
  assert.equal(calls, 1);
});

test('两个服务竞争同一 durable operation 只能发出一次 POST', async t => {
  const directory = await temporary(t);
  const gate = deferred<VoiceSummary>();
  const started = deferred<void>();
  let calls = 0;
  const adapter = mock({ clone: async () => { calls++; started.resolve(); return gate.promise; } });
  const first = new VoiceService(adapter, directory);
  const second = new VoiceService(adapter, directory);
  t.after(async () => { await first.shutdown(); await second.shutdown(); });
  const leader = first.clone(input());
  await started.promise;
  await assert.rejects(second.clone(input()), rejected('OUTCOME_UNKNOWN'));
  gate.resolve(voice());
  await leader;
  assert.equal(calls, 1);
  assert.equal((await second.clone(input())).voice.voiceId, 'voice_test');
});

test('创建响应要求验证时保留声纹 ID 并禁用待验证项', async t => {
  const service = new VoiceService(provider(async () => json({ voice_id: 'verify_created', requires_verification: true })), await temporary(t));
  t.after(() => service.shutdown());
  const result = await service.clone(input());
  assert.equal(result.voice.voiceId, 'verify_created');
  assert.equal(result.voice.status, 'verificationRequired');
  assert.match(result.voice.reason!, /ElevenLabs/);
});

test('网络断线后记录 unknown、脱敏、无重试；重启仍拒绝重新创建', async t => {
  const directory = await temporary(t);
  let calls = 0;
  const adapter = provider(async () => { calls++; throw new Error('secret_api_key upload-transcript-private'); });
  const service = new VoiceService(adapter, directory);
  await assert.rejects(service.clone(input()), error => rejected('OUTCOME_UNKNOWN')(error) && !String(error).includes('secret_api_key'));
  await service.shutdown();
  const restored = new VoiceService(adapter, directory);
  t.after(() => restored.shutdown());
  await assert.rejects(restored.clone(input()), rejected('OUTCOME_UNKNOWN'));
  assert.equal(calls, 1);
  const stored = await readFile(join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!), 'utf8');
  assert.equal(JSON.parse(stored).state, 'unknown');
  assert.equal(stored.includes('secret_api_key'), false);
});

test('克隆超时产生 unknown，迟到的成功不会覆盖记录或自动修改选中的声音', async t => {
  const gate = deferred<VoiceSummary>();
  const started = deferred<void>();
  let calls = 0;
  const directory = await temporary(t);
  // 超时覆盖磁盘准备阶段；先确认上游已开始，再推动时钟，避免把 IO 竞争误当 SDK 超时。
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = new VoiceService(mock({ clone: async () => { calls++; started.resolve(); return gate.promise; } }), directory, { timeoutMs: 80 });
  t.after(() => service.shutdown());
  const pending = service.clone(input());
  const failure = assert.rejects(pending, rejected('OUTCOME_UNKNOWN'));
  await started.promise;
  assert.equal(calls, 1);
  t.mock.timers.tick(80);
  await failure;
  gate.resolve(voice('late_voice'));
  await Promise.resolve();
  await assert.rejects(service.clone(input()), rejected('OUTCOME_UNKNOWN'));
  assert.equal(calls, 1);
});

test('关闭先取消正在运行的查询/克隆，再等待 durable unknown，拒绝后续操作', async t => {
  const directory = await temporary(t);
  const cloneStarted = deferred<void>();
  const queryStarted = deferred<void>();
  const signals: AbortSignal[] = [];
  const service = new VoiceService(mock({
    clone: async (_input, signal) => { signals.push(signal); cloneStarted.resolve(); return new Promise(() => undefined); },
    query: async (_input, signal) => { signals.push(signal); queryStarted.resolve(); return new Promise(() => undefined); },
  }), directory);
  const clonePromise = service.clone(input());
  const queryPromise = service.query({ category: 'default' });
  // 先安装拒绝处理器，避免关闭导致 test runner 误判 unhandled rejection。
  const cloneFailure = assert.rejects(clonePromise, rejected('OUTCOME_UNKNOWN'));
  const queryFailure = assert.rejects(queryPromise, rejected('CANCELED'));
  await Promise.all([cloneStarted.promise, queryStarted.promise]);
  const shutdown = service.shutdown();
  assert.ok(signals.every(signal => signal.aborted));
  await shutdown;
  await Promise.all([cloneFailure, queryFailure]);
  assert.equal(JSON.parse(await readFile(join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!), 'utf8')).state, 'unknown');
  await assert.rejects(service.clone(input({ requestId: 'new_request' })), rejected('CLOSED'));
  await assert.rejects(service.query({ category: 'default' }), rejected('CLOSED'));
});

test('明确权限/限流错误脱敏且不自动重投同一克隆命令', async t => {
  for (const [status, code] of [[401, 'AUTHENTICATION'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED']] as const) {
    let calls = 0;
    const service = new VoiceService(provider(async () => { calls++; return json({ detail: 'private_key_and_transcript' }, status); }), await temporary(t));
    t.after(() => service.shutdown());
    await assert.rejects(service.clone(input()), error => rejected(code)(error) && !String(error).includes('private_key_and_transcript'));
    await assert.rejects(service.clone(input()), rejected(code));
    assert.equal(calls, 1);
  }
});

test('查询超时和无效供应商分页有清楚边界，损坏 ledger 不能触发重复创建', async t => {
  const service = new VoiceService(mock({ query: async () => new Promise(() => undefined) }), await temporary(t), { timeoutMs: 15 });
  t.after(() => service.shutdown());
  await assert.rejects(service.query({ category: 'default' }), rejected('TIMEOUT'));
  const invalid = new VoiceService(mock({ query: async () => ({ items: [voice('wrong_category', 'cloned')] }) }), await temporary(t));
  t.after(() => invalid.shutdown());
  await assert.rejects(invalid.query({ category: 'default' }), rejected('INVALID_OUTPUT'));
  const directory = await temporary(t);
  let calls = 0;
  const recorded = new VoiceService(mock({ clone: async () => { calls++; return voice(); } }), directory);
  t.after(() => recorded.shutdown());
  await recorded.clone(input());
  const path = join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!);
  await writeFile(path, '{broken', 'utf8');
  await assert.rejects(recorded.clone(input()), rejected('OUTCOME_UNKNOWN'));
  assert.equal(calls, 1);
});

test('replay 仅读取绑定原命令的回执，fresh 返回空；未知 attempt 不调用供应商', async t => {
  const directory = await temporary(t);
  let calls = 0;
  const service = new VoiceService(mock({ clone: async () => { calls++; return voice(); } }), directory);
  t.after(() => service.shutdown());
  assert.equal(await service.replay(input()), undefined);
  const result = await service.clone(input());
  assert.deepEqual(await service.replay(input()), result);
  await assert.rejects(service.replay(input({ projectId: 'other_project' })), rejected('REQUEST_ID_REUSED'));
  await assert.rejects(service.replay(input({ expectedRevision: 3 })), rejected('REQUEST_ID_REUSED'));
  const path = join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!);
  const recorded = JSON.parse(await readFile(path, 'utf8'));
  delete recorded.result;
  await writeFile(path, JSON.stringify({ ...recorded, state: 'attempted' }));
  await assert.rejects(service.replay(input()), rejected('OUTCOME_UNKNOWN'));
  assert.equal(calls, 1);
});

test('ledger 目录 junction/symlink 不允许把账号资源记录写到目录外', async t => {
  const root = await temporary(t);
  const outside = await temporary(t);
  const directory = join(root, 'voice-operations');
  await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  let calls = 0;
  const service = new VoiceService(mock({ clone: async () => { calls++; return voice(); } }), directory);
  t.after(() => service.shutdown());
  await assert.rejects(service.replay(input()), rejected('UPSTREAM'));
  await assert.rejects(service.clone(input()), rejected('UPSTREAM'));
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(outside), []);
});

test('ledger 记录 symlink 被拒绝，外部记录不会被读取或覆盖', async t => {
  const directory = await temporary(t);
  const outside = await temporary(t);
  let calls = 0;
  const service = new VoiceService(mock({ clone: async () => { calls++; return voice(); } }), directory);
  t.after(() => service.shutdown());
  await service.clone(input());
  const path = join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!);
  const external = join(outside, 'external.json');
  const content = await readFile(path, 'utf8');
  await writeFile(external, content);
  await unlink(path);
  try { await symlink(external, path, 'file'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('当前 Windows 账号不允许创建文件 symlink'); return; }
    throw error;
  }
  await assert.rejects(service.replay(input()), rejected('UPSTREAM'));
  await assert.rejects(service.clone(input()), rejected('UPSTREAM'));
  assert.equal(calls, 1);
  assert.equal(await readFile(external, 'utf8'), content);
});

test('关闭通过官方 SDK 将 AbortSignal 传到 fetch，查询错误仍脱敏', async t => {
  const started = deferred<void>();
  let fetchSignal: AbortSignal | undefined;
  const service = new VoiceService(provider(async (_url, init) => {
    fetchSignal = init?.signal ?? undefined;
    started.resolve();
    return new Promise<Response>((_resolve, reject) => fetchSignal!.addEventListener('abort',
      () => reject(new Error('private_transport_key')), { once: true }));
  }), await temporary(t));
  const query = service.query({ category: 'default' });
  const failure = assert.rejects(query, error => rejected('CANCELED')(error) && !String(error).includes('private_transport_key'));
  await started.promise;
  await service.shutdown();
  assert.equal(fetchSignal?.aborted, true);
  await failure;
});

test('关闭也阻止读取成功回执后的晚到返回，已保存声纹仍可在新会话读取', async t => {
  const directory = await temporary(t);
  const first = new VoiceService(mock(), directory);
  const result = await first.clone(input());
  await first.shutdown();
  const closing = new VoiceService(mock(), directory);
  const replay = closing.clone(input());
  const failure = assert.rejects(replay, rejected('CANCELED'));
  await closing.shutdown();
  await failure;
  const next = new VoiceService(mock(), directory);
  t.after(() => next.shutdown());
  assert.deepEqual(await next.replay(input()), result);
});
