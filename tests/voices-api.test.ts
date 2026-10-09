import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startWorkbenchServer } from '../src/server.js';
import { VoiceService, type VoiceProvider } from '../src/voices.js';
import type { Workbench } from '../src/workbench.js';

function wav(): Uint8Array<ArrayBuffer> {
  const length = 3200;
  const bytes = new Uint8Array(44 + length);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, length, true);
  return bytes;
}
async function action(workbench: Workbench, type: string, payload: Record<string, string>) {
  const result = await workbench.execute({ requestId: randomUUID(), projectId: workbench.projectId,
    expectedRevision: (await workbench.snapshot()).revision, type, payload });
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  if (!result.ok) throw new Error('Expected successful fixture action');
  return result;
}
async function setup(t: TestContext, configured = true) {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-voice-api-'));
  let queries = 0;
  let clones = 0;
  const provider: VoiceProvider = {
    accountScope: 'api_test_account',
    query: async input => { queries++; return { items: [{ voiceId: 'known', name: '声音', category: input.category, status: 'ready' }] }; },
    clone: async input => { clones++; return { voiceId: 'new_voice', name: input.name, category: 'cloned', status: 'ready' }; },
  };
  const voices = configured ? new VoiceService(provider, join(directory, 'voice-operations')) : undefined;
  const { server, workbench } = await startWorkbenchServer({ directory, apiPort: 0, sessionToken: 'voice_api_session',
    providers: { elevenlabs: false, openrouter: false }, ...(voices ? { voices } : {}) });
  t.after(async () => {
    await workbench.shutdown(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Cookie: 'pixel_desktop_session=voice_api_session' };
  const created = await action(workbench, 'timeline.create', { modelId: 'eleven_v4' });
  const timelineId = String(created.outcome.timelineId);
  const cloneHeaders = async (overrides: Record<string, string> = {}) => ({ ...headers, 'content-type': 'audio/wav',
    'x-pixel-project-id': workbench.projectId, 'x-pixel-request-id': randomUUID(),
    'x-pixel-revision': String((await workbench.snapshot()).revision), 'x-pixel-name': 'sample.wav',
    'x-pixel-voice-name': encodeURIComponent('自己的声音'), 'x-pixel-timeline-id': timelineId, ...overrides });
  return { base, headers, cloneHeaders, timelineId, workbench, directory, counts: () => ({ queries, clones }) };
}
async function errorCode(response: Response): Promise<string> { return (await response.json()).error.code as string; }

test('声纹 API 先校验桌面会话/来源/当前项目，未授权请求不触达供应商', async t => {
  const h = await setup(t);
  assert.equal((await fetch(`${h.base}/api/voices`)).status, 403);
  assert.equal((await fetch(`${h.base}/api/voices`, { headers: { ...h.headers, Origin: 'https://foreign.example' } })).status, 403);
  const headers = await h.cloneHeaders({ 'x-pixel-project-id': 'another_project' });
  const response = await fetch(`${h.base}/api/voice-clone`, { method: 'POST', headers, body: wav() });
  assert.equal(await errorCode(response), 'FORBIDDEN');
  assert.deepEqual(h.counts(), { queries: 0, clones: 0 });
});

test('声纹 API 查询严格验证字段和页大小，默认及自己的声音走共享查询入口', async t => {
  const h = await setup(t);
  for (const query of ['category=other', 'limit=21', 'limit=-1', 'limit=1.5', 'unknown=field']) {
    assert.equal(await errorCode(await fetch(`${h.base}/api/voices?${query}`, { headers: h.headers })), 'INVALID_INPUT');
  }
  assert.deepEqual(h.counts(), { queries: 0, clones: 0 });
  const first = await fetch(`${h.base}/api/voices`, { headers: h.headers });
  assert.equal((await first.json()).items[0].category, 'default');
  const second = await fetch(`${h.base}/api/voices?category=cloned&limit=5`, { headers: h.headers });
  assert.equal((await second.json()).items[0].category, 'cloned');
  assert.deepEqual(h.counts(), { queries: 2, clones: 0 });
});

test('声纹 API 拒绝错误目标、陈旧版本及伪造音频，fresh 命令不产生远程资源', async t => {
  const h = await setup(t);
  const image = await action(h.workbench, 'timeline.create', { modelId: 'x-ai/grok-imagine-image-2.0' });
  const wrong = await fetch(`${h.base}/api/voice-clone`, { method: 'POST',
    headers: await h.cloneHeaders({ 'x-pixel-timeline-id': String(image.outcome.timelineId) }), body: wav() });
  assert.equal(await errorCode(wrong), 'NOT_APPLICABLE');
  const stale = await fetch(`${h.base}/api/voice-clone`, { method: 'POST', headers: await h.cloneHeaders({ 'x-pixel-revision': '0' }), body: wav() });
  assert.equal(await errorCode(stale), 'REVISION_CONFLICT');
  const fake = await fetch(`${h.base}/api/voice-clone`, { method: 'POST', headers: await h.cloneHeaders(), body: new Uint8Array([1, 2, 3]) });
  assert.equal(await errorCode(fake), 'INVALID_INPUT');
  assert.deepEqual(h.counts(), { queries: 0, clones: 0 });
});

test('声纹克隆创建账号资源并保持项目/defaults/任务/产物不变，后续 revision 后仍可重放原回执', async t => {
  const h = await setup(t);
  const before = await h.workbench.snapshot();
  const headers = await h.cloneHeaders({ 'content-type': 'audio/x-wav' });
  const first = await fetch(`${h.base}/api/voice-clone`, { method: 'POST', headers, body: wav() });
  assert.equal(first.status, 200, await first.clone().text());
  const result = await first.json();
  assert.equal(result.voice.voiceId, 'new_voice');
  assert.deepEqual(await h.workbench.snapshot(), before);
  assert.deepEqual(await h.workbench.jobs(), { items: [] });
  assert.deepEqual(await readdir(join(h.directory, 'artifacts')).catch(() => []), []);
  await action(h.workbench, 'project.title', { title: '后续编辑' });
  const replay = await fetch(`${h.base}/api/voice-clone`, { method: 'POST', headers: { ...headers, 'content-type': 'audio/wave' }, body: wav() });
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.deepEqual(await replay.json(), result);
  assert.deepEqual(h.counts(), { queries: 0, clones: 1 });
});

test('未配置 ElevenLabs 时声纹查询与上传返回可理解的不可用原因', async t => {
  const h = await setup(t, false);
  assert.equal(await errorCode(await fetch(`${h.base}/api/voices`, { headers: h.headers })), 'NOT_APPLICABLE');
  const upload = await fetch(`${h.base}/api/voice-clone`, { method: 'POST', headers: await h.cloneHeaders(), body: wav() });
  assert.equal(await errorCode(upload), 'NOT_APPLICABLE');
  assert.deepEqual(h.counts(), { queries: 0, clones: 0 });
});
