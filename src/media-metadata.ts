import { spawn } from 'node:child_process';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DomainError } from './backend.js';
import { bundledFfmpegPath } from './audio-processing.js';

/** 仅解析宿主自己的临时媒体文件；禁用网络/额外协议，不把文件路径或原始日志返回 UI。 */
export async function probeMediaDuration(bytes: Uint8Array, kind: 'audio' | 'video', mimeType: string, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const formats: Record<string, string> = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'video/mp4': 'mov' };
  const format = formats[mimeType];
  if (!format || bytes.length === 0 || bytes.length > 256 * 1024 * 1024) throw new DomainError('INVALID_INPUT', '媒体格式或大小无效');
  const root = await mkdtemp(join(tmpdir(), 'pixel-media-probe-'));
  const file = join(root, 'input.media');
  try {
    await writeFile(file, bytes, { flag: 'wx' });
    signal.throwIfAborted();
    const output = await new Promise<string>((accept, reject) => {
      const child = spawn(bundledFfmpegPath(), [
        '-hide_banner', '-nostdin', '-protocol_whitelist', 'file,pipe', '-f', format,
        ...(format === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
        '-i', file, '-t', '0', '-f', 'null', '-',
      ], { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      let failure: DomainError | undefined;
      const stop = (message: string) => { failure ??= new DomainError('INVALID_INPUT', message); child.kill('SIGKILL'); };
      const onAbort = () => child.kill('SIGKILL');
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      const timer = setTimeout(() => stop('媒体读取超过执行时限'), 15_000);
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 256_000) stop('媒体信息超出读取限制');
      });
      child.on('error', () => { failure ??= new DomainError('INVALID_INPUT', '无法启动媒体读取器'); });
      child.on('close', code => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(new DomainError('NOT_APPLICABLE', '项目会话已关闭，媒体放置已取消'));
        else if (failure) reject(failure);
        else if (code !== 0) reject(new DomainError('INVALID_INPUT', '媒体内容无法读取'));
        else accept(stderr);
      });
    });
    // FFmpeg banner reports container duration to centiseconds (MP3 may be estimated).
    // This sets the initial display interval; it is not a sample-accurate trim boundary.
    const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(output);
    const hasStream = kind === 'video' ? /Stream #[^\r\n]+Video:/.test(output) : /Stream #[^\r\n]+Audio:/.test(output);
    if (!duration || !hasStream) throw new DomainError('INVALID_INPUT', '媒体没有可用的时长或对应内容');
    const durationMs = Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new DomainError('INVALID_INPUT', '媒体时长无效');
    return durationMs;
  } finally {
    const checked = resolve(root);
    if (dirname(checked) === resolve(tmpdir()) && basename(checked).startsWith('pixel-media-probe-')) {
      await unlink(file).catch(() => {}); await rmdir(checked).catch(() => {});
    }
  }
}
