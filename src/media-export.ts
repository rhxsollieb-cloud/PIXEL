import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { AssetData, DeepReadonly } from './contracts.js';
import { ProviderError, type MediaArtifactStore } from './generation.js';

const extensions: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'video/mp4': 'mp4',
};

/** Native startDrag requires a file. These session-scoped copies never become resource storage. */
export class TemporaryMediaExports {
  private directory: Promise<string> | undefined;
  private readonly pending = new Map<string, Promise<string>>();
  private readonly controller = new AbortController();
  private closed = false;
  private cleanup: Promise<void> | undefined;

  constructor(private readonly store: MediaArtifactStore, private readonly maximumBytes = 512 * 1024 * 1024) {}

  prepare(asset: DeepReadonly<AssetData>): Promise<string> {
    if (this.closed) return Promise.reject(new ProviderError('INVALID_INPUT', '导出会话已关闭'));
    const key = `${asset.id}:${asset.fileRef}`;
    const previous = this.pending.get(key);
    if (previous) return previous;
    const operation = this.download(asset).catch(error => { this.pending.delete(key); throw error; });
    this.pending.set(key, operation);
    return operation;
  }

  private async download(asset: DeepReadonly<AssetData>): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(asset.id) || asset.fileRef !== `pixel-asset:${asset.id}`) {
      throw new ProviderError('INVALID_INPUT', '导出素材句柄无效');
    }
    const signal = this.controller.signal;
    const info = await this.store.stat(asset, signal);
    const extension = extensions[info.mimeType];
    if (!extension || !Number.isSafeInteger(info.byteLength) || info.byteLength <= 0 || info.byteLength > this.maximumBytes) {
      throw new ProviderError('INVALID_OUTPUT', '导出媒体格式或大小无效');
    }
    const media = await this.store.read(asset, signal);
    signal.throwIfAborted();
    if (media.bytes.byteLength !== info.byteLength || media.mimeType !== info.mimeType) throw new ProviderError('INVALID_OUTPUT', '导出媒体内容与索引不一致');
    if (typeof asset.metadata.sha256 === 'string' && createHash('sha256').update(media.bytes).digest('hex') !== asset.metadata.sha256) {
      throw new ProviderError('INVALID_OUTPUT', '导出媒体完整性校验失败');
    }
    const directory = await (this.directory ??= mkdtemp(join(tmpdir(), 'pixel-export-')));
    signal.throwIfAborted();
    const path = join(directory, `${asset.id}.${extension}`);
    await writeFile(path, media.bytes, { flag: 'wx', mode: 0o600, signal });
    signal.throwIfAborted();
    return path;
  }

  close(): Promise<void> {
    return this.cleanup ??= this.clean();
  }

  private async clean(): Promise<void> {
    this.closed = true;
    this.controller.abort(new Error('Export session closed'));
    await Promise.allSettled(this.pending.values());
    if (!this.directory) return;
    const directory = await this.directory;
    const actual = await realpath(directory);
    const tempRoot = await realpath(resolve(tmpdir()));
    if (dirname(actual) !== tempRoot || !basename(actual).startsWith('pixel-export-')) throw new ProviderError('INVALID_OUTPUT', '临时导出目录超出了宿主范围');
    await rm(actual, { recursive: true, force: true });
  }
}
