import { createHash, randomUUID } from 'node:crypto';
import { Zip, ZipPassThrough, unzipSync } from 'fflate';
import { z } from 'zod';
import { DomainError } from './backend.js';
import type { AssetData, GenerationArtifact, ProjectDocument } from './contracts.js';
import type { MediaArtifactStore } from './generation.js';
import { validateWorkbenchProjectFile, type WorkbenchProjectFile } from './project-files.js';
import { timelineRegistry } from './timeline-catalog.js';
import { detectMedia } from './workbench.js';

export const MAX_PROJECT_PACKAGE_BYTES = 256 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();
const manifestSchema = z.strictObject({
  version: z.literal(1), kind: z.enum(['project', 'timeline']), sourceProjectId: z.string().min(1).max(200),
  sourceRevision: z.number().int().nonnegative().safe(), timelineId: z.string().min(1).max(200).optional(),
  media: z.array(z.strictObject({ id: z.uuid(), jobId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
    path: z.string().regex(/^media\/[a-f0-9-]{36}\.(png|jpg|webp|mp3|wav|mp4)$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().positive().max(MAX_PROJECT_PACKAGE_BYTES) })).max(10_000),
});
const invalid = (message: string) => new DomainError('INVALID_INPUT', message);

/** A timeline package uses the original Timeline contract, clock, settings and item relationships. */
export function projectPackageState(source: WorkbenchProjectFile, timelineId?: string): WorkbenchProjectFile {
  const state = structuredClone(source);
  state.requests = {}; state.outbox = [];
  if (timelineId) {
    const timeline = state.snapshot.document.timelines[timelineId];
    if (!timeline) throw new DomainError('NOT_FOUND', '时间线不存在');
    timelineRegistry.forTimeline(timeline);
    const document = state.snapshot.document;
    document.title = `${document.title} · ${timelineRegistry.forTimeline(timeline).manifest.name}`;
    document.timelines = { [timelineId]: timeline }; document.timelineOrder = [timelineId];
    document.items = Object.fromEntries(timeline.itemIds.map(id => [id, document.items[id]!]));
    const ids = new Set(Object.values(document.items).flatMap(item => [...item.referenceAssetIds, ...(item.outputAssetId ? [item.outputAssetId] : [])]));
    document.assets = Object.fromEntries(Object.entries(document.assets).filter(([id]) => ids.has(id)));
    if (document.assetGroups) document.assetGroups = Object.fromEntries(Object.entries(document.assetGroups).map(([id, group]) => [id, { ...group, assetIds: group.assetIds.filter(assetId => ids.has(assetId)) }]));
    state.history = [];
  }
  // Export is data only. Import cannot replay old requests or start pending paid jobs.
  for (const document of packageDocuments(state)) for (const asset of Object.values(document.assets)) delete asset.metadata.storage;
  return validateWorkbenchProjectFile(state);
}
function packageDocuments(state: WorkbenchProjectFile): ProjectDocument[] {
  return [state.snapshot.document, ...state.history.flatMap(entry => [entry.before, entry.after])];
}
export function packageAssets(state: WorkbenchProjectFile): AssetData[] {
  const assets = new Map<string, AssetData>();
  for (const document of packageDocuments(state)) for (const asset of Object.values(document.assets)) {
    const previous = assets.get(asset.id);
    if (previous && previous.metadata.sha256 !== asset.metadata.sha256) throw invalid('历史媒体内容身份发生变化');
    assets.set(asset.id, asset);
  }
  return [...assets.values()];
}

export async function exportProjectPackage(source: WorkbenchProjectFile, media: MediaArtifactStore, signal: AbortSignal, timelineId?: string): Promise<Uint8Array> {
  const state = projectPackageState(source, timelineId);
  const inventory: z.infer<typeof manifestSchema>['media'] = [];
  const chunks: Uint8Array[] = []; let encodedLength = 0; let sourceLength = 0; let zipError: Error | undefined;
  const zip = new Zip((error, chunk) => {
    if (error) { zipError = error; return; }
    encodedLength += chunk.length;
    if (encodedLength > MAX_PROJECT_PACKAGE_BYTES) { zipError = invalid('工程包超过 256 MB 上限'); return; }
    chunks.push(chunk);
  });
  const add = (path: string, bytes: Uint8Array) => {
    sourceLength += bytes.length;
    if (sourceLength > MAX_PROJECT_PACKAGE_BYTES) throw invalid('工程包超过 256 MB 上限');
    const file = new ZipPassThrough(path); zip.add(file); file.push(bytes, true);
    if (zipError) throw zipError;
  };
  try {
    for (const asset of packageAssets(state)) {
      signal.throwIfAborted();
      const artifact = await media.get(asset.id);
      if (!artifact || artifact.asset.kind !== asset.kind) throw invalid('媒体索引缺失，请先扫描恢复');
      const stat = await media.stat(asset, signal);
      if (stat.byteLength + sourceLength > MAX_PROJECT_PACKAGE_BYTES - 1024 * 1024) throw invalid('工程包超过 256 MB 上限；可分别导出时间线');
      const content = await media.read(asset, signal);
      const sha256 = hash(content.bytes);
      if (content.bytes.length !== stat.byteLength || (asset.metadata.sha256 && sha256 !== asset.metadata.sha256)) throw invalid('媒体哈希不一致，请先扫描恢复');
      const extension = String(artifact.asset.metadata.extension);
      if (!/^(png|jpg|webp|mp3|wav|mp4)$/.test(extension)) throw invalid('媒体扩展名无效');
      const path = `media/${asset.id}.${extension}`;
      inventory.push({ id: asset.id, jobId: artifact.jobId, path, sha256, byteLength: content.bytes.length });
      for (const document of packageDocuments(state)) {
        const entry = document.assets[asset.id];
        if (entry) entry.metadata = { ...entry.metadata, sha256, byteLength: content.bytes.length, extension, mimeType: content.mimeType };
      }
      add(path, content.bytes);
    }
    const manifest = manifestSchema.parse({ version: 1, kind: timelineId ? 'timeline' : 'project', sourceProjectId: source.snapshot.document.id, sourceRevision: source.snapshot.revision, ...(timelineId ? { timelineId } : {}), media: inventory });
    const project = encoder.encode(JSON.stringify(validateWorkbenchProjectFile(state)));
    if (project.length > 16 * 1024 * 1024) throw invalid('项目文档超过 16 MB 上限');
    add('project/project.json', project);
    add('manifest.json', encoder.encode(JSON.stringify(manifest)));
    zip.end(); signal.throwIfAborted(); if (zipError) throw zipError;
    return Buffer.concat(chunks, encodedLength);
  } finally { zip.terminate(); }
}

export function decodeProjectPackage(bytes: Uint8Array): { state: WorkbenchProjectFile; artifacts: Array<{ artifact: GenerationArtifact; bytes: Uint8Array }> } {
  if (bytes.length > MAX_PROJECT_PACKAGE_BYTES) throw invalid('工程包超过 256 MB 上限');
  checkStoredZip32(bytes);
  let size = 0; const paths = new Set<string>(); let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: entry => {
      if (paths.has(entry.name) || paths.size >= 10_002 || !/^(manifest\.json|project\/project\.json|media\/[a-f0-9-]{36}\.(png|jpg|webp|mp3|wav|mp4))$/.test(entry.name)) throw invalid('工程包包含重复或不允许的文件路径');
      paths.add(entry.name); size += entry.originalSize;
      if (size > MAX_PROJECT_PACKAGE_BYTES || (entry.name === 'project/project.json' && entry.originalSize > 16 * 1024 * 1024)) throw invalid('工程包解压内容超过上限');
      return true;
    } });
  } catch (error) { if (error instanceof DomainError) throw error; throw invalid('工程包无法读取，请选择 Pixel 导出的 .pixel.zip'); }
  let manifest: z.infer<typeof manifestSchema>; let state: WorkbenchProjectFile;
  try {
    manifest = manifestSchema.parse(JSON.parse(new TextDecoder().decode(files['manifest.json'])));
    state = validateWorkbenchProjectFile(JSON.parse(new TextDecoder().decode(files['project/project.json'])));
  } catch { throw invalid('工程包项目文档或清单无效'); }
  if (state.requests && Object.keys(state.requests).length || state.outbox.length) throw invalid('工程包不能包含可执行任务或请求记录');
  if (state.snapshot.document.id !== manifest.sourceProjectId || state.snapshot.revision !== manifest.sourceRevision) throw invalid('工程包项目身份与清单不一致');
  if (manifest.kind === 'timeline' && (!manifest.timelineId || Object.keys(state.snapshot.document.timelines).length !== 1 || !state.snapshot.document.timelines[manifest.timelineId])) throw invalid('时间线工程包范围无效');
  const inventory = new Map(manifest.media.map(entry => [entry.id, entry]));
  const assets = packageAssets(state);
  if (inventory.size !== manifest.media.length || inventory.size !== assets.length || Object.keys(files).length !== assets.length + 2) throw invalid('工程包媒体清单不完整或重复');
  const artifacts = assets.map(asset => {
    const entry = inventory.get(asset.id); const content = entry ? files[entry.path] : undefined;
    if (!entry || !content || entry.path !== `media/${asset.id}.${String(asset.metadata.extension)}` || content.length !== entry.byteLength || hash(content) !== entry.sha256 || asset.metadata.sha256 !== entry.sha256 || asset.metadata.byteLength !== entry.byteLength || asset.metadata.storage !== undefined) throw invalid('工程包媒体与哈希清单不一致');
    if (detectMedia(content, String(asset.metadata.mimeType)) !== asset.kind) throw invalid('工程包媒体格式与声明不一致');
    return { artifact: { id: asset.id, jobId: entry.jobId, asset: structuredClone(asset) }, bytes: content };
  });
  return { state, artifacts };
}

/** Pixel emits ZIP32 stored entries. Reject ZIP64/compressed formats before entering the library parser.
 * This bounds parsing and allocation even for forged size fields or compressed expansion bombs. */
function checkStoredZip32(bytes: Uint8Array): void {
  const bad = () => invalid('请选择 Pixel 导出的未压缩 ZIP32 工程包；文件结构或大小无效');
  if (bytes.length < 22) throw bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 20, true)) throw bad();
  const count = view.getUint16(end + 10, true); const offset = view.getUint32(end + 16, true); const size = view.getUint32(end + 12, true);
  if (count < 2 || count > 10_002 || count !== view.getUint16(end + 8, true) || offset === 0xffffffff || size === 0xffffffff || offset + size !== end) throw bad();
  let cursor = offset; let expanded = 0; const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw bad();
    const version = view.getUint16(cursor + 6, true); const flags = view.getUint16(cursor + 8, true);
    const compressed = view.getUint32(cursor + 20, true); const original = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true); const extraLength = view.getUint16(cursor + 30, true); const commentLength = view.getUint16(cursor + 32, true);
    const local = view.getUint32(cursor + 42, true);
    if (version > 20 || flags & ~0x808 || view.getUint16(cursor + 10, true) !== 0 || compressed !== original || original === 0xffffffff || extraLength || commentLength || view.getUint16(cursor + 34, true) || !nameLength || nameLength > 512 || cursor + 46 + nameLength > end || local + 30 > offset) throw bad();
    expanded += original; if (expanded > MAX_PROJECT_PACKAGE_BYTES) throw bad();
    if (view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 4, true) > 20 || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== 0 || view.getUint16(local + 26, true) !== nameLength || view.getUint16(local + 28, true)) throw bad();
    const data = local + 30 + nameLength; const finish = data + original + (flags & 8 ? 16 : 0);
    if (finish > offset) throw bad();
    for (let byte = 0; byte < nameLength; byte++) if (bytes[local + 30 + byte] !== bytes[cursor + 46 + byte]) throw bad();
    if (flags & 8) {
      const descriptor = data + original;
      if (view.getUint32(descriptor, true) !== 0x08074b50 || view.getUint32(descriptor + 8, true) !== compressed || view.getUint32(descriptor + 12, true) !== original || view.getUint32(descriptor + 4, true) !== view.getUint32(cursor + 16, true)) throw bad();
    } else if (view.getUint32(local + 18, true) !== compressed || view.getUint32(local + 22, true) !== original || view.getUint32(local + 14, true) !== view.getUint32(cursor + 16, true)) throw bad();
    ranges.push({ start: local, end: finish }); cursor += 46 + nameLength;
  }
  if (cursor !== end) throw bad();
  ranges.sort((a, b) => a.start - b.start);
  if (ranges[0]?.start !== 0 || ranges.at(-1)?.end !== offset || ranges.some((range, index) => index > 0 && range.start !== ranges[index - 1]!.end)) throw bad();
}

/** Import as a new project: stable asset/item IDs survive, project authority and generation tokens change. */
export function importedPackageState(source: WorkbenchProjectFile, id: string = randomUUID()): WorkbenchProjectFile {
  const state = structuredClone(source);
  for (const document of packageDocuments(state)) { document.id = id; for (const item of Object.values(document.items)) item.generationToken = randomUUID(); }
  state.requests = {}; state.outbox = []; state.snapshot.revision = 0;
  return validateWorkbenchProjectFile(state);
}
