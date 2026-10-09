import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { FfmpegAudioPostProcessor, bundledFfmpegPath } from '../src/audio-processing.js';
import { ProviderError, type AudioTailProcessingRequest } from '../src/generation.js';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { ElevenLabsModelProvider } from '../src/providers/elevenlabs.js';

/** 本地产生可识别尾段的真实 WAV，不调用供应商或依赖付费素材。 */
function wave(seconds = 1, sampleRate = 44_100): Buffer {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index++) {
    const frequency = index < 0.3 * sampleRate ? 440 : 1_100;
    data.writeInt16LE(Math.round(Math.sin(index * frequency * 2 * Math.PI / sampleRate) * 12_000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function decode(bytes: Uint8Array): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(bundledFfmpegPath(), ['-v', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '44100', '-f', 's16le', 'pipe:1'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], shell: false,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (part: Buffer) => chunks.push(part));
    child.stdin.on('error', () => undefined);
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolveResult(Buffer.concat(chunks)) : reject(new Error('Test audio decode failed')));
    child.stdin.end(bytes);
  });
}

const input = (overrides: Partial<AudioTailProcessingRequest> = {}): AudioTailProcessingRequest => ({
  bytes: wave(), mimeType: 'audio/wav', outputFormat: 'mp3_44100_128',
  speechEndSeconds: 0.3, paddingMs: 40, fadeMs: 5, ...overrides,
});

test('真实音频解码后按正文末样本与余量裁切，再编码可播放 MP3', async () => {
  const processor = new FfmpegAudioPostProcessor();
  const result = await processor.trimTail(input(), new AbortController().signal);
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(result.extension, 'mp3');
  assert.equal(result.sourceDurationSeconds, 1);
  assert.equal(result.durationSeconds, 0.34);
  const pcm = await decode(result.bytes);
  assert.ok(pcm.length > 0 && pcm.length < 0.4 * 44_100 * 2, 'actual decoded media is cropped, rather than metadata only');
  // 正文末尾仍有原始幅度；仅保留余量最后 5ms 被淡出。
  const rms = (fromSeconds: number, toSeconds: number) => {
    let energy = 0;
    let count = 0;
    for (let index = Math.floor(fromSeconds * 44_100); index < Math.min(pcm.length / 2, Math.floor(toSeconds * 44_100)); index++) {
      energy += pcm.readInt16LE(index * 2) ** 2; count++;
    }
    return Math.sqrt(energy / count);
  };
  assert.ok(rms(0.28, 0.299) > 7_000);
  assert.ok(rms(0.338, 0.34) < rms(0.31, 0.33) * 0.4);
});

test('padding 不跨入额外后文，fade 不压低正文末字；0 padding 保留正文末样本', async () => {
  const processor = new FfmpegAudioPostProcessor();
  const capped = await processor.trimTail(input({ nextSpeechStartSeconds: 0.315, paddingMs: 500, fadeMs: 50 }), new AbortController().signal);
  assert.ok(capped.durationSeconds <= 0.315);
  assert.ok(capped.durationSeconds >= 0.3);
  const exact = await processor.trimTail(input({ paddingMs: 0, fadeMs: 50 }), new AbortController().signal);
  assert.equal(exact.durationSeconds, 0.3);
  const pcm = await decode(exact.bytes);
  const tail = pcm.subarray(Math.floor(0.285 * 44_100) * 2, Math.floor(0.299 * 44_100) * 2);
  let maximum = 0;
  for (let index = 0; index < tail.length; index += 2) maximum = Math.max(maximum, Math.abs(tail.readInt16LE(index)));
  assert.ok(maximum > 10_000, 'no fade enters voiced samples when no post-speech padding remains');
});

test('错乱边界、超音频时间戳、损坏媒体与缺失编解码器明确失败，不声称去尾成功', async () => {
  const processor = new FfmpegAudioPostProcessor();
  for (const request of [
    input({ speechEndSeconds: NaN }), input({ nextSpeechStartSeconds: 0.2 }), input({ speechEndSeconds: 1.1 }),
    input({ bytes: new Uint8Array([1, 2, 3]) }), input({ fadeMs: 51 }), input({ outputFormat: 'mp3_44100_128;echo' }),
  ]) {
    await assert.rejects(processor.trimTail(request, new AbortController().signal), (error: unknown) =>
      error instanceof ProviderError && error.code === 'INVALID_OUTPUT');
  }
  await assert.rejects(new FfmpegAudioPostProcessor({ binaryPath: 'pixel-missing-codec.exe' }).trimTail(input(), new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'INVALID_OUTPUT' && !error.message.includes('pixel-missing-codec'));
});

test('音频后处理继承取消信号，已取消任务不会启动编解码', async () => {
  const controller = new AbortController();
  controller.abort(new Error('test cancellation'));
  await assert.rejects(new FfmpegAudioPostProcessor({ binaryPath: 'must-not-start.exe' }).trimTail(input(), controller.signal), /test cancellation/);
});

test('处理中取消真实 FFmpeg 进程，任务等待进程关闭后拒绝且不返回半个产物', async () => {
  const controller = new AbortController();
  const processing = new FfmpegAudioPostProcessor().trimTail(input({ bytes: wave(10) }), controller.signal);
  // trimTail 已同步启动子进程，然后在下一个事件循环取消它。
  setImmediate(() => controller.abort(new Error('running audio cancellation')));
  await assert.rejects(processing, /running audio cancellation/);
});

test('真实 SDK 时间戳响应接默认处理器，存下的实际 MP3 已移除正文之后的长尾', async () => {
  const full = await new FfmpegAudioPostProcessor().trimTail(input({ speechEndSeconds: 1, paddingMs: 0, fadeMs: 0 }), new AbortController().signal);
  let saved: Uint8Array | undefined;
  let calls = 0;
  const client = new ElevenLabsClient({ apiKey: 'unit_test', logging: { silent: true }, fetch: async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).pathname, '/v1/text-to-dialogue/with-timestamps');
    assert.deepEqual(JSON.parse(String(init?.body)).inputs, [{ text: 'Hello!', voice_id: 'test_voice' }]);
    return new Response(JSON.stringify({
      audio_base64: Buffer.from(full.bytes).toString('base64'), voice_segments: [],
      alignment: { characters: Array.from('Hello!'), character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5],
        character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] },
    }), { headers: { 'content-type': 'application/json' } });
  } });
  const provider = new ElevenLabsModelProvider({ apiKey: 'unit_test', client });
  await provider.generate({
    projectId: 'test', targetItemId: 'test_item', generationToken: 'test_token', inputFingerprint: 'test_fingerprint',
    providerId: 'elevenlabs', providerVersion: '1', modelId: 'eleven_v4',
    params: { text: 'Hello!', voiceId: 'test_voice' }, references: [],
  }, {
    signal: new AbortController().signal, attemptToken: { jobId: 'audio_job', attempt: 1 }, reportProgress() {},
    async checkpointProviderTask() { throw new Error('no remote audio job'); }, artifacts: {
      async write(request) {
        assert.ok(request.bytes instanceof Uint8Array);
        saved = request.bytes;
        assert.equal(request.metadata.durationMs, 540);
        assert.equal(request.metadata.tailTrimmed, true);
        return { id: 'test_artifact', jobId: 'audio_job', asset: { id: 'test_asset', kind: 'audio', fileRef: 'pixel-asset:test', metadata: request.metadata } };
      },
    },
  });
  assert.equal(calls, 1);
  assert.ok(saved);
  const duration = (await decode(saved)).length / (44_100 * 2);
  assert.ok(duration >= 0.5 && duration < 0.6, 'real cropped media preserves the last spoken character and removes the remaining tail');
});
