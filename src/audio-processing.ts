import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ProviderError,
  type AudioPostProcessor,
  type AudioTailProcessingRequest,
  type AudioTailProcessingResult,
} from './generation.js';

const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
const MAX_PCM_BYTES = 256 * 1024 * 1024;
const FORMATS = new Set([
  'mp3_22050_32', 'mp3_24000_48', 'mp3_44100_32', 'mp3_44100_64',
  'mp3_44100_96', 'mp3_44100_128', 'mp3_44100_192',
]);

/** electron-builder unpack 的可执行文件路径由后端适配，项目不保存编解码器路径。 */
export function bundledFfmpegPath(): string {
  // NodeNext 的 CJS 类型与运行时 ESM default 形状可能不同，先窄化真实导出。
  const imported: unknown = ffmpegPath;
  const binary = typeof imported === 'string' ? imported
    : imported && typeof imported === 'object' && 'default' in imported && typeof imported.default === 'string'
      ? imported.default : undefined;
  if (!binary) throw new ProviderError('INVALID_OUTPUT', '当前平台没有可用的音频处理器');
  return binary.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

/** 每次调用隔离进程、限制输出并继承生成任务取消；不使用 shell 或转发 stderr。 */
async function runFfmpeg(binary: string, args: string[], bytes: Uint8Array, signal: AbortSignal, maxBytes: number): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: unknown;
    const stop = (reason: unknown) => { failure ??= reason; child.kill('SIGKILL'); };
    const onAbort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(new ProviderError('INVALID_OUTPUT', '音频处理超过执行时限')), 60_000);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stop(new ProviderError('INVALID_OUTPUT', '音频处理输出超出大小限制'));
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => { /* 输出失败由 process close 统一报告，避免泄露文件路径。 */ });
    child.on('error', () => { failure ??= new ProviderError('INVALID_OUTPUT', '无法启动音频处理器'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0) reject(new ProviderError('INVALID_OUTPUT', '生成音频无法解码或重新编码'));
      else resolveResult(Buffer.concat(chunks, size));
    });
    child.stdin.end(bytes);
  });
}

/** 把语音解码成单声道 PCM 后按样本裁尾、短淡出，再编码成带 gapless header 的 MP3。 */
export class FfmpegAudioPostProcessor implements AudioPostProcessor {
  private readonly binary: string;

  constructor(options: { binaryPath?: string } = {}) {
    this.binary = options.binaryPath ?? bundledFfmpegPath();
  }

  async trimTail(request: AudioTailProcessingRequest, signal: AbortSignal): Promise<AudioTailProcessingResult> {
    signal.throwIfAborted();
    if (!(request.bytes instanceof Uint8Array) || request.bytes.length === 0 || request.bytes.length > MAX_AUDIO_BYTES
      || !['audio/mpeg', 'audio/wav'].includes(request.mimeType) || !FORMATS.has(request.outputFormat)
      || !Number.isFinite(request.speechEndSeconds) || request.speechEndSeconds <= 0
      || !Number.isSafeInteger(request.paddingMs) || request.paddingMs < 0 || request.paddingMs > 500
      || !Number.isSafeInteger(request.fadeMs) || request.fadeMs < 0 || request.fadeMs > 50
      || (request.nextSpeechStartSeconds !== undefined && (!Number.isFinite(request.nextSpeechStartSeconds)
        || request.nextSpeechStartSeconds < request.speechEndSeconds))) {
      throw new ProviderError('INVALID_OUTPUT', '音频正文边界或后处理参数无效');
    }
    const [, rateText, bitrateText] = request.outputFormat.split('_');
    const sampleRate = Number(rateText);
    const source = await runFfmpeg(this.binary, [
      // 不自动识别 playlist/容器，也不允许媒体解码打开其他文件或远端资源。
      '-protocol_whitelist', 'pipe', '-f', request.mimeType === 'audio/wav' ? 'wav' : 'mp3',
      '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(sampleRate),
      '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1',
    ], request.bytes, signal, MAX_PCM_BYTES);
    signal.throwIfAborted();
    if (!source.length || source.length % 2) throw new ProviderError('INVALID_OUTPUT', '生成音频没有有效的 PCM 样本');
    const sourceDurationSeconds = source.length / (2 * sampleRate);
    if (request.speechEndSeconds > sourceDurationSeconds + 1 / sampleRate) {
      throw new ProviderError('INVALID_OUTPUT', '正文时间戳超出了实际音频长度');
    }
    const boundary = Math.min(sourceDurationSeconds, request.speechEndSeconds + request.paddingMs / 1_000,
      request.nextSpeechStartSeconds ?? Infinity);
    // ceil 保留完整正文末样本，nextSpeech 起点用 floor 防止把后文首样本带进结果。
    const endSample = Math.min(source.length / 2, Math.ceil(boundary * sampleRate),
      request.nextSpeechStartSeconds === undefined ? Infinity : Math.floor(request.nextSpeechStartSeconds * sampleRate));
    if (!Number.isSafeInteger(endSample) || endSample <= 0 || endSample / sampleRate + 1 / sampleRate < request.speechEndSeconds) {
      throw new ProviderError('INVALID_OUTPUT', '正文与后续发音边界无法可靠分离');
    }
    const pcm = Buffer.from(source.subarray(0, endSample * 2));
    // 只在正文结束后的保留余量内淡出，不压低最后一个字的真实发音。
    const fadeSamples = Math.min(Math.max(0, endSample - Math.ceil(request.speechEndSeconds * sampleRate)),
      Math.round(request.fadeMs * sampleRate / 1_000));
    for (let index = 0; index < fadeSamples; index++) {
      const sampleIndex = endSample - fadeSamples + index;
      const gain = fadeSamples === 1 ? 0 : 1 - index / (fadeSamples - 1);
      pcm.writeInt16LE(Math.round(pcm.readInt16LE(sampleIndex * 2) * gain), sampleIndex * 2);
    }
    signal.throwIfAborted();
    const directory = resolve(await mkdtemp(join(tmpdir(), 'pixel-speech-tail-')));
    const output = join(directory, 'speech.mp3');
    try {
      // 可 seek 的临时输出让 libmp3lame 写入 delay / padding 信息；播放不多出编码器尾部静音。
      await runFfmpeg(this.binary, [
        '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0',
        '-map_metadata', '-1', '-codec:a', 'libmp3lame', '-b:a', `${bitrateText}k`,
        '-write_xing', '1', '-y', output,
      ], pcm, signal, MAX_AUDIO_BYTES);
      signal.throwIfAborted();
      const encoded = await readFile(output, { signal });
      if (!encoded.length || encoded.length > MAX_AUDIO_BYTES) throw new ProviderError('INVALID_OUTPUT', '处理后音频为空或超出大小限制');
      return { bytes: encoded, mimeType: 'audio/mpeg', extension: 'mp3', sourceDurationSeconds, durationSeconds: endSample / sampleRate };
    } finally {
      // 仅删除本次 mkdtemp 创建的准确目标，不递归删除供应商或用户提供的路径。
      if (dirname(directory) === resolve(tmpdir()) && directory.split(/[\\/]/).at(-1)?.startsWith('pixel-speech-tail-')) {
        await unlink(output).catch(() => undefined);
        await rmdir(directory).catch(() => undefined);
      }
    }
  }
}
