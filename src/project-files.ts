import { randomUUID } from 'node:crypto';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { assertProjectInvariants, DomainError, type HistoryEntry } from './backend.js';
import { assetGroupsSchema, generationRequestSchema, timelineOrderSchema, type ActionReceipt, type AssetData, type GenerationRequest, type ProjectDocument, type ProjectSnapshot } from './contracts.js';
import { modelRegistry } from './models.js';
import { referenceLimit, timelineRegistry } from './timeline-catalog.js';
import type { MediaArtifactStore } from './generation.js';

export interface WorkbenchOutboxEntry {
  id: string;
  operation: 'start' | 'resume' | 'cancel';
  jobId: string;
  itemId: string;
  request?: GenerationRequest;
  done: boolean;
}

/** The existing on-disk envelope is the project format, including durable edits and jobs. */
export interface WorkbenchProjectFile {
  version: 1;
  snapshot: ProjectSnapshot;
  requests: Record<string, { signature: string; receipt: ActionReceipt }>;
  history: HistoryEntry[];
  outbox: WorkbenchOutboxEntry[];
}

const id = z.string().min(1).max(200);
const tick = z.number().int().nonnegative().safe();
const json = z.record(z.string(), z.json());
const assetSchema = z.strictObject({
  id: z.uuid(), kind: z.enum(['image', 'audio', 'video']),
  fileRef: z.string().regex(/^pixel-asset:[0-9a-f-]{36}$/i), metadata: json,
}).refine(asset => asset.fileRef === `pixel-asset:${asset.id}`, 'Asset handle must match its ID');
const timelineSchema = z.strictObject({
  id, pluginId: id, pluginVersion: z.number().int().positive().safe(), modelId: id.optional(),
  ticksPerSecond: z.number().int().positive().safe(), itemIds: z.array(id), settings: json, itemDefaults: json.optional(),
});
const itemSchema = z.strictObject({
  id, timelineId: id, kind: id, startTick: tick, durationTicks: z.number().int().positive().safe(),
  sourceOffsetTicks: tick, params: json, generationSettings: json.optional(),
  referenceAssetIds: z.array(z.uuid()), outputAssetId: z.uuid().optional(),
  outputOrigin: z.enum(['placement', 'generated', 'manual']).optional(), generationToken: id,
});
const documentSchema = z.strictObject({
  schemaVersion: z.literal(1), id, title: z.string().min(1).max(200),
  timelines: z.record(id, timelineSchema), items: z.record(id, itemSchema), assets: z.record(z.uuid(), assetSchema),
  assetGroups: assetGroupsSchema.optional(),
  timelineOrder: timelineOrderSchema.optional(),
});
const receiptSchema = z.strictObject({
  ok: z.literal(true), requestId: id, projectId: id, revision: tick, undoable: z.boolean(), outcome: json,
});
export const workbenchOutboxSchema = z.strictObject({
  id: z.uuid(), operation: z.enum(['start', 'resume', 'cancel']), jobId: z.uuid(), itemId: id,
  request: generationRequestSchema.optional(), done: z.boolean(),
}).refine(entry => entry.operation !== 'start' || (entry.request !== undefined && entry.request.targetItemId === entry.itemId), 'Start outbox requires its matching captured request');
const projectFileSchema = z.strictObject({
  version: z.literal(1), snapshot: z.strictObject({ revision: tick, document: documentSchema }),
  requests: z.record(z.string(), z.strictObject({ signature: z.string(), receipt: receiptSchema })),
  history: z.array(z.strictObject({ requestId: id, before: documentSchema, after: documentSchema })),
  outbox: z.array(workbenchOutboxSchema),
});
const artifactSchema = z.strictObject({ id: z.uuid(), jobId: id, asset: assetSchema });
const jobSchema = z.strictObject({
  id, request: generationRequestSchema,
  state: z.enum(['queued', 'running', 'cancelRequested', 'succeeded', 'failed', 'canceled', 'interrupted']),
  attempt: z.number().int().positive().safe(), progress: z.number().min(0).max(1),
  providerTaskId: z.string().min(1).max(500).optional(), artifactIds: z.array(z.uuid()),
  error: z.strictObject({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
const formats: Record<string, { extension: string; kind: AssetData['kind'] }> = {
  'image/png': { extension: 'png', kind: 'image' }, 'image/jpeg': { extension: 'jpg', kind: 'image' },
  'image/webp': { extension: 'webp', kind: 'image' }, 'audio/mpeg': { extension: 'mp3', kind: 'audio' },
  'audio/wav': { extension: 'wav', kind: 'audio' }, 'video/mp4': { extension: 'mp4', kind: 'video' },
};
const maximumJsonBytes = 64 * 1024 * 1024;

function inside(root: string, target: string): boolean {
  const local = relative(root, target);
  return !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`);
}

/** Only fixed project/ledger filenames are read. Dropped directories never supply credentials. */
async function checkedFile(root: string, path: string): Promise<string> {
  const actual = await realpath(path);
  const sameName = process.platform === 'win32' ? basename(actual).toLowerCase() === basename(path).toLowerCase() : basename(actual) === basename(path);
  if (!inside(root, actual) || !sameName || !(await stat(actual)).isFile()) throw new DomainError('INVALID_INPUT', '项目文件或素材超出了项目目录或指向了其他文件');
  return actual;
}
async function readJson(root: string, path: string): Promise<unknown> {
  const actual = await checkedFile(root, path);
  const handle = await open(actual, 'r');
  try {
    const info = await handle.stat();
    if (info.size <= 0 || info.size > maximumJsonBytes) throw new DomainError('INVALID_INPUT', '项目文件为空或超出了大小上限');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally { await handle.close(); }
}
function validateDocument(document: ProjectDocument): void {
  assertProjectInvariants(document);
  for (const timeline of Object.values(document.timelines)) {
    const plugin = timelineRegistry.forTimeline(timeline);
    const declaration = timelineRegistry.describe(timeline.modelId ?? timeline.pluginId);
    if (timeline.pluginId !== plugin.manifest.pluginId || timeline.pluginVersion !== plugin.manifest.schemaVersion) {
      throw new DomainError('NOT_APPLICABLE', '项目中的模型插件需要显式版本迁移；原文件已保留');
    }
    plugin.validateSettings(timeline.settings);
    plugin.validateItemDefaults(timeline.itemDefaults ?? {});
    let end = 0;
    const items = timeline.itemIds.map(itemId => document.items[itemId]!).sort((left, right) => left.startTick - right.startTick);
    for (const item of items) {
      if (item.kind !== plugin.manifest.itemKind) throw new DomainError('INVALID_INPUT', '片段类型与时间线模型不一致');
      plugin.validateItemParams(item.params);
      if (item.generationSettings !== undefined) plugin.validateSettings(item.generationSettings);
      if (!declaration.capabilities.references && item.referenceAssetIds.length > 0) throw new DomainError('INVALID_INPUT', '此时间线不支持素材引用');
      if (!declaration.capabilities.mediaPlacement && item.sourceOffsetTicks !== 0) throw new DomainError('INVALID_INPUT', '此时间线不支持媒体偏移');
      if (item.referenceAssetIds.length > referenceLimit(declaration, item.params) || item.referenceAssetIds.some(id => !declaration.referenceKinds.includes(document.assets[id]!.kind))) throw new DomainError('INVALID_INPUT', '素材引用不符合时间线语义');
      if (item.outputAssetId !== undefined && (!declaration.capabilities.mediaPlacement || document.assets[item.outputAssetId]!.kind !== declaration.outputKind)) throw new DomainError('INVALID_INPUT', '输出媒体不符合时间线语义');
      if (declaration.mode === 'local' && (item.outputOrigin === 'generated' || item.outputOrigin === 'manual' || item.generationSettings !== undefined)) throw new DomainError('INVALID_INPUT', '本地时间线不能保存生成配置或生成输出');
      if (item.outputOrigin === 'manual' && (item.outputAssetId === undefined || !declaration.capabilities.manualOutput)) throw new DomainError('INVALID_INPUT', '人工输出必须属于支持上传结果的生成片段');
      if (declaration.mode === 'local' && declaration.capabilities.mediaPlacement && (item.outputAssetId === undefined || item.outputOrigin !== 'placement')) throw new DomainError('INVALID_INPUT', '普通媒体片段必须关联真实放置的素材');
      if (plugin.manifest.overlapPolicy === 'reject' && item.startTick < end) throw new DomainError('INVALID_INPUT', '项目时间线包含重叠片段');
      end = item.startTick + item.durationTicks;
    }
  }
}

/** Strict validation also protects normal reopen, rather than creating a second import schema. */
export function validateWorkbenchProjectFile(input: unknown): WorkbenchProjectFile {
  try {
    const file = projectFileSchema.parse(input) as WorkbenchProjectFile;
    const projectId = file.snapshot.document.id;
    validateDocument(file.snapshot.document);
    for (const entry of file.history) {
      if (entry.before.id !== projectId || entry.after.id !== projectId) throw new DomainError('INVALID_INPUT', '项目历史归属无效');
      validateDocument(entry.before); validateDocument(entry.after);
    }
    for (const record of Object.values(file.requests)) {
      if (record.receipt.projectId !== projectId || record.receipt.revision > file.snapshot.revision) throw new DomainError('INVALID_INPUT', '项目回执归属或版本无效');
    }
    for (const entry of file.outbox) {
      if (entry.request) {
        if (entry.request.projectId !== projectId || entry.request.targetItemId !== entry.itemId) throw new DomainError('INVALID_INPUT', '生成记录不属于当前项目');
        modelRegistry.prepareRequest(entry.request);
        for (const reference of entry.request.references) assetSchema.parse({ id: reference.id, kind: reference.kind, fileRef: reference.fileRef, metadata: reference.metadata });
      }
    }
    return file;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('INVALID_INPUT', '不是可打开的 Pixel 项目，或项目版本、字段及模型配置不受支持；原文件已保留');
  }
}

export async function readWorkbenchProjectMetadata(directory: string): Promise<WorkbenchProjectFile> {
  const root = await realpath(resolve(directory));
  return validateWorkbenchProjectFile(await readJson(root, join(root, 'project.json')));
}

export async function readWorkbenchProjectFile(directory: string, options: { externalOpen?: boolean; mediaStore?: MediaArtifactStore; validateResources?: boolean } = {}): Promise<WorkbenchProjectFile> {
  const root = await realpath(resolve(directory));
  const file = validateWorkbenchProjectFile(await readJson(root, join(root, 'project.json')));
  if (options.externalOpen && file.outbox.some(entry => !entry.done)) throw new DomainError('NOT_APPLICABLE', '项目仍有待处理的生成任务，请先在原会话完成或取消；原文件已保留');
  const assets = new Map<string, AssetData>();
  for (const asset of Object.values(file.snapshot.document.assets)) assets.set(asset.id, asset);
  for (const entry of file.history) for (const document of [entry.before, entry.after]) for (const asset of Object.values(document.assets)) assets.set(asset.id, asset);
  for (const entry of file.outbox) for (const asset of entry.request?.references ?? []) assets.set(asset.id, asset);
  if (options.validateResources !== false) for (const asset of assets.values()) await validateAssetFiles(root, asset, options.mediaStore);
  const jobsDirectory = join(root, 'jobs');
  let jobFiles: string[];
  try {
    if (!inside(root, await realpath(jobsDirectory))) throw new DomainError('INVALID_INPUT', '任务目录超出了项目目录');
    jobFiles = await readdir(jobsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return file;
    throw error;
  }
  for (const name of jobFiles) {
    if (!name.endsWith('.json')) continue;
    if (!/^[a-zA-Z0-9_-]{1,200}\.json$/.test(name)) throw new DomainError('INVALID_INPUT', '项目任务文件名无效');
    try {
      const job = jobSchema.parse(await readJson(root, join(jobsDirectory, name)));
      if (job.id !== name.slice(0, -5) || job.request.projectId !== file.snapshot.document.id) throw new DomainError('INVALID_INPUT', '任务归属与项目不一致');
      if (options.externalOpen && ['queued', 'running', 'cancelRequested'].includes(job.state)) throw new DomainError('NOT_APPLICABLE', '项目仍有未结束的生成任务，请先在原会话完成或取消；原文件已保留');
      modelRegistry.prepareRequest(job.request as GenerationRequest);
      for (const reference of job.request.references) {
        const asset = assetSchema.parse({ id: reference.id, kind: reference.kind, fileRef: reference.fileRef, metadata: reference.metadata });
        if (options.validateResources !== false) await validateAssetFiles(root, asset, options.mediaStore);
      }
      for (const artifactId of job.artifactIds) {
        if (options.validateResources === false) continue;
        const artifact = artifactSchema.parse(options.mediaStore ? await options.mediaStore.get(artifactId) : await readJson(root, join(root, 'artifacts', `${artifactId}.json`)));
        if (artifact.id !== artifactId || artifact.jobId !== job.id) throw new DomainError('INVALID_INPUT', '任务产物归属无效');
        await validateAssetFiles(root, artifact.asset, options.mediaStore);
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('INVALID_INPUT', '项目任务或素材文件不完整；原文件已保留');
    }
  }
  return file;
}

async function validateAssetFiles(root: string, asset: AssetData, mediaStore?: MediaArtifactStore): Promise<void> {
  try {
    if (mediaStore) {
      const artifact = await mediaStore.get(asset.id);
      if (!artifact || artifact.asset.id !== asset.id || artifact.asset.kind !== asset.kind || artifact.asset.fileRef !== asset.fileRef) throw new DomainError('INVALID_INPUT', '共享素材索引与项目句柄不一致');
      const info = await mediaStore.stat(asset);
      if (info.byteLength <= 0 || info.mimeType !== asset.metadata.mimeType || (typeof asset.metadata.byteLength === 'number' && asset.metadata.byteLength !== info.byteLength)) throw new DomainError('INVALID_INPUT', '共享素材格式或大小与项目不一致');
      return;
    }
    const artifact = artifactSchema.parse(await readJson(root, join(root, 'artifacts', `${asset.id}.json`)));
    if (artifact.id !== asset.id || artifact.asset.id !== asset.id || artifact.asset.kind !== asset.kind || artifact.asset.fileRef !== asset.fileRef) throw new DomainError('INVALID_INPUT', '素材索引与句柄不一致');
    const mimeType = artifact.asset.metadata.mimeType;
    const format = typeof mimeType === 'string' && Object.hasOwn(formats, mimeType) ? formats[mimeType] : undefined;
    if (!format || format.kind !== asset.kind || artifact.asset.metadata.extension !== format.extension
        || asset.metadata.mimeType !== mimeType || asset.metadata.extension !== format.extension) throw new DomainError('INVALID_INPUT', '素材格式与索引不一致');
    const path = await checkedFile(root, join(root, 'artifacts', `${asset.id}.${format.extension}`));
    const info = await stat(path);
    if (info.size <= 0 || (typeof artifact.asset.metadata.byteLength === 'number' && info.size !== artifact.asset.metadata.byteLength)) throw new DomainError('INVALID_INPUT', '素材内容为空或已被修改');
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('INVALID_INPUT', '项目素材文件缺失或无效；原文件已保留');
  }
}

export interface PixelProjectLocation {
  directory: string;
  existing: boolean;
  /** Supplied only for an empty directory; the repository atomically creates project.json. */
  initial?: ProjectSnapshot;
}

/** A trusted desktop drop adapter supplies the path. No arbitrary JSON or file is converted in place. */
export async function preparePixelProjectLocation(targetPath: string, options: { mediaStore?: MediaArtifactStore } = {}): Promise<PixelProjectLocation> {
  if (!isAbsolute(targetPath) || targetPath.includes('\0')) throw new DomainError('INVALID_INPUT', '项目位置必须是有效的本地绝对路径');
  let actual: string;
  try { actual = await realpath(targetPath); }
  catch { throw new DomainError('NOT_FOUND', '拖入的项目位置不存在或无法读取'); }
  const info = await stat(actual);
  const directory = info.isDirectory() ? actual : dirname(actual);
  if (!info.isDirectory() && (!info.isFile() || basename(actual).toLowerCase() !== 'project.json')) throw new DomainError('INVALID_INPUT', '请拖入 Pixel 项目目录、project.json，或用于新作品的空文件夹');
  try {
    await readWorkbenchProjectFile(directory, { externalOpen: true, ...options });
    return { directory, existing: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof DomainError) throw error;
      throw new DomainError('INVALID_INPUT', '不是可打开的 Pixel 项目；原文件已保留');
    }
    // Only absence of the project file in a truly empty directory creates a work.
    if (!info.isDirectory() || (await readdir(directory)).length !== 0) throw new DomainError('INVALID_INPUT', '此文件夹不是 Pixel 项目；新作品需要空文件夹，媒体文件请拖入素材库');
    return {
      directory, existing: false,
      initial: { revision: 0, document: { schemaVersion: 1, id: randomUUID(), title: basename(directory).slice(0, 120) || '未命名作品', timelines: {}, items: {}, assets: {} } },
    };
  }
}
