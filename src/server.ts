import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat, readdir, readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { DomainError } from './backend.js';
import { createWorkbench, type Workbench, type WorkbenchOptions } from './workbench.js';
import { loadBackendConfiguration, loadSeafileConfiguration } from './backend-configuration.js';
import { SeafileArtifactStore } from './seafile-storage.js';
import { preparePixelProjectLocation as prepareLocalProjectLocation } from './project-files.js';
import { basename, dirname } from 'node:path';
import { readWorkbenchProjectFile } from './project-files.js';
import { queryTimelineText, formatTimelineText } from './timeline-text.js';
import { timelineRegistry } from './timeline-catalog.js';
import { VoiceService, VoiceServiceError } from './voices.js';
import { ElevenLabsVoiceProvider } from './providers/elevenlabs-voices.js';
import { ProviderError } from './generation.js';
import { SharedProjectCatalog, SharedJobRepository, SharedVersionedDocument, SharedProjectLease } from './shared-projects.js';
import { FileJobRepository, FileArtifactStore } from './storage.js';
import { voiceOperationSchema } from './voices.js';
import { decodeProjectPackage, exportProjectPackage, importedPackageState, MAX_PROJECT_PACKAGE_BYTES, packageAssets } from './project-package.js';
import { importLegacyProject } from './project-migration.js';
import { loadHostPortRange, listenInRange } from './host-ports.js';
export { FileArtifactStore } from './storage.js';
/** Desktop project ingress uses the same remote resource authority as the running workbench. */
export async function preparePixelProjectLocation(targetPath: string, options: { envPath?: string; artifacts?: import('./generation.js').MediaArtifactStore } = {}): Promise<import('./project-files.js').PixelProjectLocation & { projectId?: string }> {
  if (typeof targetPath !== 'string' || !isAbsolute(targetPath) || targetPath.includes('\0')) throw new DomainError('INVALID_INPUT', '项目位置必须是有效的本地绝对路径');
  const target = await realpath(targetPath);
  const info = await stat(target);
  const archive = info.isFile() && basename(target).toLowerCase().endsWith('.pixel.zip');
  if (!info.isDirectory() && (!info.isFile() || (!archive && basename(target).toLowerCase() !== 'project.json'))) throw new DomainError('INVALID_INPUT', '请拖入 Pixel 工程包、旧项目目录或 project.json');
  const directory = info.isDirectory() ? target : dirname(target);
  let legacy;
  let decoded;
  if (archive) {
    if (info.size > MAX_PROJECT_PACKAGE_BYTES) throw new DomainError('INVALID_INPUT', '工程包超过 256 MB 上限');
    decoded = decodeProjectPackage(await readFile(target));
  } else {
    try { legacy = await readWorkbenchProjectFile(directory, { validateResources: false }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!info.isDirectory() || (await readdir(directory)).length) throw new DomainError('INVALID_INPUT', '目录不是 Pixel 项目；请导入工程包或旧项目目录');
    }
  }
  const artifacts = options.artifacts ?? await SeafileArtifactStore.open(await loadSeafileConfiguration(options));
  if (!(artifacts instanceof SeafileArtifactStore)) return prepareLocalProjectLocation(targetPath, { mediaStore: artifacts });
  const projects = new SharedProjectCatalog(artifacts);
  let projectId: string;
  if (decoded) {
    for (const entry of decoded.artifacts) await artifacts.importArtifact(entry.artifact, entry.bytes);
    const state = importedPackageState(decoded.state);
    projectId = await projects.create(state.snapshot.document.title, state.snapshot.document.id, state);
  } else if (legacy) {
    projectId = await importLegacyProject(directory, artifacts, projects, legacy);
  } else projectId = await projects.create(basename(directory));
  return { directory, projectId, existing: Boolean(legacy) };
}

export interface ApiOptions {
  frontendPort?: number;
  /** Trusted development host supplies its actual loopback renderer listener. */
  getFrontendPort?: () => number;
  apiPort?: number;
  /** Desktop hosts serve their compiled renderer from this directory. */
  frontendDirectory?: string;
  /** Trusted desktop host installs this opaque value as an HttpOnly session cookie. */
  sessionToken?: string;
  projects?: SharedProjectCatalog;
  projectId?: string;
}
const desktopCookie = 'pixel_desktop_session';
const staticTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
};
function hasDesktopSession(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  return (request.headers.cookie ?? '').split(';').some(cookie => cookie.trim() === `${desktopCookie}=${token}`);
}
async function serveFrontend(request: IncomingMessage, response: ServerResponse, pathname: string, directory: string): Promise<boolean> {
  const root = await realpath(resolve(directory));
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  if (decoded.includes('\0') || decoded.includes('\\')) return false;
  const candidate = resolve(root, decoded === '/' ? 'index.html' : `.${decoded}`);
  const withinRoot = (path: string) => { const local = relative(root, path); return !isAbsolute(local) && local !== '..' && !local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`); };
  if (!withinRoot(candidate)) return false;
  let path: string;
  try { path = await realpath(candidate); if (!withinRoot(path) || !(await stat(path)).isFile()) return false; }
  catch { return false; }
  const contentType = staticTypes[extname(path)];
  if (!contentType) return false;
  response.writeHead(200, {
    'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  if (request.method === 'HEAD') { response.end(); return true; }
  const stream = createReadStream(path);
  response.on('close', () => stream.destroy());
  stream.on('error', () => response.destroy());
  stream.pipe(response);
  return true;
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}
function trustedOrigin(request: IncomingMessage, apiPort: number, frontendPort: number): boolean {
  const host = request.headers.host;
  if (host !== `127.0.0.1:${apiPort}` && host !== `localhost:${apiPort}`) return false;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    if (![`http://127.0.0.1:${frontendPort}`, `http://localhost:${frontendPort}`, `http://127.0.0.1:${apiPort}`, `http://localhost:${apiPort}`].includes(origin)) return false;
  }
  return request.headers['sec-fetch-site'] !== 'cross-site';
}
async function bytes(request: IncomingMessage, maximum: number): Promise<Uint8Array> {
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new DomainError('INVALID_INPUT', '上传内容超过允许大小');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw new DomainError('INVALID_INPUT', '上传内容超过允许大小');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
function scalarHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== 'string') throw new DomainError('INVALID_INPUT', `缺少请求字段：${name}`);
  return value;
}
function queryInteger(value: string, field: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new DomainError('INVALID_INPUT', `${field} 必须为安全非负整数`);
  return Number(value);
}
function rangeOf(header: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return undefined;
  const suffix = !match[1];
  const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = suffix || !match[2] ? size - 1 : Math.min(size - 1, Number(match[2]));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return undefined;
  return { start, end };
}

/** 仅绑定 loopback；请求身份由宿主注入，renderer 无法自称 internal。 */
export function createApiServer(workbench: Workbench, options: ApiOptions = {}): Server {
  const frontendPort = options.frontendPort ?? 4310;
  const sessionId = randomUUID();
  const server = createServer((request, response) => {
    void (async () => {
      const address = server.address();
      const apiPort = typeof address === 'object' && address ? address.port : options.apiPort ?? 4311;
      if (!trustedOrigin(request, apiPort, options.getFrontendPort?.() ?? frontendPort)) { json(response, 403, { ok: false, error: { code: 'FORBIDDEN', message: '请求来源不在本地工作台范围内' } }); return; }
      if (!hasDesktopSession(request, options.sessionToken)) { json(response, 403, { ok: false, error: { code: 'FORBIDDEN', message: '桌面会话无效' } }); return; }
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${apiPort}`);
      if (request.method === 'GET' && url.pathname === '/api/session') {
        json(response, 200, { projectId: workbench.projectId, sessionId }); return;
      }
      if (options.frontendDirectory && (request.method === 'GET' || request.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
        if (await serveFrontend(request, response, url.pathname, options.frontendDirectory)) return;
      }
      if (request.method === 'GET' && url.pathname === '/api/project') { json(response, 200, await workbench.snapshot()); return; }
      if (request.method === 'GET' && url.pathname === '/api/projects') {
        if (options.projects) json(response, 200, { ...await options.projects.list({ ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}), limit: 20 }), shared: true });
        else { const snapshot = await workbench.snapshot(); json(response, 200, { shared: false, items: [{ id: workbench.projectId, title: snapshot.document.title, revision: snapshot.revision, timelineCount: Object.keys(snapshot.document.timelines).length, assetCount: Object.keys(snapshot.document.assets).length }] }); }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/projects') {
        if (!options.projects) throw new DomainError('NOT_APPLICABLE', '当前测试宿主未连接共享项目目录');
        const input = JSON.parse(new TextDecoder().decode(await bytes(request, 4096))) as { title?: unknown; requestId?: unknown };
        if (typeof input.title !== 'string' || typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) throw new DomainError('INVALID_INPUT', '项目名称或请求编号无效');
        try { await options.projects.create(input.title, input.requestId); }
        catch (error) {
          if (!(error instanceof DomainError && error.code === 'REVISION_CONFLICT')) throw error;
          const existing = await options.projects.state(input.requestId);
          if (existing.snapshot.document.title !== input.title.trim()) throw error;
        }
        json(response, 200, { id: input.requestId }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/project/export') {
        const controller = new AbortController(); response.once('close', () => controller.abort());
        const timelineId = url.searchParams.get('timelineId') ?? undefined;
        const archive = await exportProjectPackage(await workbench.repository.exportState(), workbench.artifacts, controller.signal, timelineId);
        response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archive.length, 'Content-Disposition': `attachment; filename="${timelineId ? 'timeline' : 'project'}.pixel.zip"`, 'Cache-Control': 'no-store' });
        response.end(archive); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/projects/import') {
        if (!options.projects || !(workbench.artifacts instanceof SeafileArtifactStore)) throw new DomainError('NOT_APPLICABLE', '工程包导入需要共享存储');
        const controller = new AbortController(); response.once('close', () => controller.abort());
        const archive = await bytes(request, MAX_PROJECT_PACKAGE_BYTES);
        const decoded = decodeProjectPackage(archive);
        const id = scalarHeader(request, 'x-pixel-request');
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new DomainError('INVALID_INPUT', '工程包请求编号无效');
        const sha256 = createHash('sha256').update(archive).digest('hex');
        const claim = new SharedVersionedDocument(workbench.artifacts, `operations/import-${id}`, value => {
          const record = value as { sha256: string; projectId: string };
          if (typeof record?.sha256 !== 'string' || record.projectId !== id) throw new DomainError('INVALID_INPUT', '工程包导入记录无效');
          return record;
        });
        let claimed = await claim.read();
        if (!claimed) {
          try { await claim.publish(undefined, { sha256, projectId: id }); }
          catch (error) { claimed = await claim.read(); if (!claimed) throw error; }
          claimed ??= await claim.read();
        }
        if (claimed?.value.sha256 !== sha256) throw new DomainError('REQUEST_ID_REUSED', '同一请求编号不能用于不同工程包');
        try { const existing = await options.projects.state(id); json(response, 200, { id, title: existing.snapshot.document.title }); return; }
        catch (error) { if (!(error instanceof DomainError && error.code === 'NOT_FOUND')) throw error; }
        for (const entry of decoded.artifacts) await workbench.artifacts.importArtifact(entry.artifact, entry.bytes, controller.signal);
        const state = importedPackageState(decoded.state, id);
        try { await options.projects.create(state.snapshot.document.title, id, state); }
        catch (error) { if (!(error instanceof DomainError && error.code === 'REVISION_CONFLICT')) throw error; await options.projects.state(id); }
        json(response, 200, { id, title: state.snapshot.document.title }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/project/media-status') {
        const missing: Array<{ id: string; name: string }> = [];
        const state = await workbench.repository.exportState();
        for (const asset of packageAssets(state)) {
          try { await workbench.artifacts.stat(asset); }
          catch (error) {
            if (!(error instanceof ProviderError && ['INVALID_OUTPUT', 'UNSUPPORTED_REFERENCE'].includes(error.code))) throw error;
            missing.push({ id: asset.id, name: String(asset.metadata.name ?? asset.id) });
          }
        }
        json(response, 200, { missing }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/project/media-recover') {
        if (!(workbench.artifacts instanceof SeafileArtifactStore)) throw new DomainError('NOT_APPLICABLE', '媒体扫描需要 Seafile 共享存储');
        const controller = new AbortController(); response.once('close', () => controller.abort());
        const state = await workbench.repository.exportState();
        json(response, 200, await workbench.artifacts.recoverMedia(packageAssets(state), controller.signal)); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/models') {
        const query = url.searchParams;
        json(response, 200, workbench.models({
          ...(query.has('search') ? { search: query.get('search')! } : {}),
          ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}),
          ...(query.has('limit') ? { limit: Number(query.get('limit')) } : {}),
          ...(query.has('providerId') ? { providerId: query.get('providerId')! } : {}),
          ...(query.has('outputKind') ? { outputKind: query.get('outputKind') as 'image' | 'audio' | 'video' } : {}),
          exclude: query.getAll('exclude'),
        })); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/timeline-types') {
        const query = url.searchParams;
        const allowed = new Set(['limit','cursor','exclude','mode','providerId','outputKind','search']);
        if ([...query.keys()].some(key => !allowed.has(key))) throw new DomainError('INVALID_INPUT', '时间线目录查询包含未知字段');
        json(response, 200, workbench.timelineTypes({
          ...(query.has('limit') ? { limit: queryInteger(query.get('limit')!, 'limit') } : {}),
          ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}), exclude: query.getAll('exclude'),
          ...Object.fromEntries(['mode','providerId','outputKind','search'].filter(key => query.has(key)).map(key => [key,query.get(key)!])),
        })); return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/timeline-types/')) {
        let typeId: string;
        try { typeId = decodeURIComponent(url.pathname.slice('/api/timeline-types/'.length)); }
        catch { throw new DomainError('INVALID_INPUT', '时间线类型编码无效'); }
        if (!typeId.length || typeId.length > 200 || typeId.includes('\0')) throw new DomainError('INVALID_INPUT', '时间线类型标识无效');
        try { json(response, 200, timelineRegistry.describe(typeId)); }
        catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('NOT_FOUND', '时间线类型不存在'); }
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/timeline-text') {
        const query = url.searchParams;
        const allowed = new Set(['timelineId','fromMs','toMs','search','includeGenerated','limit','maxCharacters','cursor','format']);
        if ([...query.keys()].some(key => !allowed.has(key))) throw new DomainError('INVALID_INPUT', '文本查询包含未知字段');
        if (query.has('includeGenerated') && !['true','false'].includes(query.get('includeGenerated')!)) throw new DomainError('INVALID_INPUT', 'includeGenerated 必须为 true 或 false');
        const format = query.get('format') ?? 'json';
        if (!['json','text'].includes(format)) throw new DomainError('INVALID_INPUT', '文本格式必须为 json 或 text');
        const page = queryTimelineText(await workbench.snapshot(), {
          includeGenerated: query.get('includeGenerated') === 'true',
          ...Object.fromEntries(['timelineId','search','cursor'].filter(key => query.has(key)).map(key => [key,query.get(key)!])),
          ...Object.fromEntries(['fromMs','toMs','limit','maxCharacters'].filter(key => query.has(key)).map(key => [key,queryInteger(query.get(key)!, key)])),
        });
        if (format === 'json') { json(response, 200, page); return; }
        response.writeHead(200, { 'Content-Type':'text/plain; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
        response.end(formatTimelineText(page)); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/jobs') { json(response, 200, await workbench.jobs()); return; }
      if (request.method === 'GET' && url.pathname === '/api/voices') {
        const query = url.searchParams;
        if ([...query.keys()].some(key => !['category', 'limit', 'cursor', 'search'].includes(key))) throw new DomainError('INVALID_INPUT', '声音查询包含未知字段');
        const category = query.get('category') ?? 'default';
        if (!['default', 'cloned'].includes(category)) throw new DomainError('INVALID_INPUT', '声音分类无效');
        json(response, 200, await workbench.queryVoices({ category: category as 'default' | 'cloned',
          ...(query.has('limit') ? { limit: queryInteger(query.get('limit')!, 'limit') } : {}),
          ...Object.fromEntries(['cursor', 'search'].filter(key => query.has(key)).map(key => [key, query.get(key)!])),
        })); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/status') { json(response, 200, { providers: workbench.providers }); return; }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write(': connected\n\n');
        const unsubscribe = workbench.subscribe(event => { response.write(`data: ${JSON.stringify(event)}\n\n`); });
        const heartbeat = setInterval(() => { response.write(': heartbeat\n\n'); }, 15000);
        heartbeat.unref();
        response.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/actions') {
        if (!request.headers['content-type']?.startsWith('application/json')) throw new DomainError('INVALID_INPUT', 'Action 请求必须使用 JSON');
        let value: unknown;
        try { value = JSON.parse(Buffer.from(await bytes(request, 1024 * 1024)).toString('utf8')); }
        catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('INVALID_INPUT', 'Action JSON 无效'); }
        json(response, 200, await workbench.execute(value)); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/import') {
        if (request.headers['x-pixel-project-id'] !== undefined && request.headers['x-pixel-project-id'] !== workbench.projectId) {
          throw new DomainError('FORBIDDEN', '素材导入不属于当前项目');
        }
        const mimeType = scalarHeader(request, 'content-type').split(';')[0]!.trim().toLowerCase();
        const requestId = scalarHeader(request, 'x-pixel-request-id');
        const revision = scalarHeader(request, 'x-pixel-revision');
        if (!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new DomainError('INVALID_INPUT', '项目版本无效');
        let name: string;
        try { name = decodeURIComponent(scalarHeader(request, 'x-pixel-name')); }
        catch { throw new DomainError('INVALID_INPUT', '文件名编码无效'); }
        json(response, 200, await workbench.importMedia({ bytes: await bytes(request, 256 * 1024 * 1024), mimeType, name, requestId, expectedRevision: Number(revision) })); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/media-place') {
        if (scalarHeader(request, 'x-pixel-project-id') !== workbench.projectId) throw new DomainError('FORBIDDEN', '媒体放置不属于当前项目');
        const mimeType = scalarHeader(request, 'content-type').split(';')[0]!.trim().toLowerCase();
        const requestId = scalarHeader(request, 'x-pixel-request-id');
        const expectedRevision = queryInteger(scalarHeader(request, 'x-pixel-revision'), '项目版本');
        const startTick = queryInteger(scalarHeader(request, 'x-pixel-start-tick'), '放置位置');
        let name: string;
        try { name = decodeURIComponent(scalarHeader(request, 'x-pixel-name')); }
        catch { throw new DomainError('INVALID_INPUT', '文件名编码无效'); }
        const timelineId = request.headers['x-pixel-timeline-id'];
        if (timelineId !== undefined && (typeof timelineId !== 'string' || !timelineId.length || timelineId.length > 200)) throw new DomainError('INVALID_INPUT', '媒体时间线标识无效');
        json(response, 200, await workbench.placeExternalMedia({ bytes: await bytes(request, 256 * 1024 * 1024), mimeType, name, requestId, expectedRevision, startTick,
          ...(timelineId === undefined ? {} : { timelineId }) })); return;
      }
      if (request.method === 'POST' && ['/api/media-reference', '/api/media-output', '/api/voice-clone'].includes(url.pathname)) {
        if (scalarHeader(request, 'x-pixel-project-id') !== workbench.projectId) throw new DomainError('FORBIDDEN', '上传不属于当前项目');
        const mimeType = scalarHeader(request, 'content-type').split(';')[0]!.trim().toLowerCase();
        const requestId = scalarHeader(request, 'x-pixel-request-id');
        const expectedRevision = queryInteger(scalarHeader(request, 'x-pixel-revision'), '项目版本');
        let name: string;
        try { name = decodeURIComponent(scalarHeader(request, 'x-pixel-name')); }
        catch { throw new DomainError('INVALID_INPUT', '文件名编码无效'); }
        if (url.pathname === '/api/media-reference') {
          const itemId = scalarHeader(request, 'x-pixel-item-id');
          json(response, 200, await workbench.importReferenceMedia({ bytes: await bytes(request, 256 * 1024 * 1024), mimeType, name, requestId, expectedRevision, itemId })); return;
        }
        if (url.pathname === '/api/media-output') {
          const itemId = scalarHeader(request, 'x-pixel-item-id');
          const provenance = scalarHeader(request, 'x-pixel-output-provenance');
          if (provenance !== 'manual' && provenance !== 'external') throw new DomainError('INVALID_INPUT', '请选择人工上传或外部网页生成的来源');
          json(response, 200, await workbench.importOutputMedia({ bytes: await bytes(request, 256 * 1024 * 1024), mimeType, name, requestId, expectedRevision, itemId, provenance })); return;
        }
        const timelineId = scalarHeader(request, 'x-pixel-timeline-id');
        let voiceName: string;
        try { voiceName = decodeURIComponent(scalarHeader(request, 'x-pixel-voice-name')); }
        catch { throw new DomainError('INVALID_INPUT', '声音名称编码无效'); }
        json(response, 200, await workbench.cloneVoice({ bytes: await bytes(request, 25 * 1024 * 1024), mimeType, fileName: name, name: voiceName,
          requestId, expectedRevision, timelineId, projectId: workbench.projectId })); return;
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && /^\/api\/media\/[^/]+$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.slice('/api/media/'.length));
        const asset = await workbench.mediaAsset(id);
        const controller = new AbortController();
        response.on('close', () => controller.abort());
        const info = await workbench.artifacts.stat(asset, controller.signal);
        const size = info.byteLength;
        const range = request.headers.range ? rangeOf(request.headers.range, size) : undefined;
        if (request.headers.range && !range) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return; }
        const media = request.method === 'HEAD' ? undefined : range
          ? await workbench.artifacts.readRange(asset, range, controller.signal)
          : await workbench.artifacts.read(asset, controller.signal);
        response.writeHead(range ? 206 : 200, {
          'Content-Type': info.mimeType, 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=3600',
          'Content-Length': range ? range.end - range.start + 1 : size,
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(String(asset.metadata.name ?? `${asset.id}.${asset.metadata.extension}`))}`,
          ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}),
        });
        if (request.method === 'HEAD') { response.end(); return; }
        response.end(media!.bytes); return;
      }
      json(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '接口不存在' } });
    })().catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      json(response, error instanceof DomainError && error.code === 'NOT_FOUND' ? 404 : 400, {
        ok: false, error: error instanceof DomainError || error instanceof VoiceServiceError || error instanceof ProviderError ? { code: error.code, message: error.message } : { code: 'INTERNAL', message: '本地宿主处理失败' },
      });
    });
  });
  server.on('close', () => workbench.close());
  return server;
}

function port(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new DomainError('INVALID_INPUT', '本地服务端口无效');
  return parsed;
}
export async function startWorkbenchServer(options: WorkbenchOptions & ApiOptions & { envPath?: string } = {}): Promise<{ server: Server; workbench: Workbench; projects?: SharedProjectCatalog; shutdown(): Promise<void> }> {
  const portRange = options.apiPort === 0 ? undefined : await loadHostPortRange(options);
  const apiPort = options.apiPort ?? (process.env.PIXEL_API_PORT ? port(process.env.PIXEL_API_PORT, 0) : portRange ? undefined : 4311);
  if (apiPort !== undefined && (!Number.isInteger(apiPort) || apiPort < 0 || apiPort > 65535 || (portRange && (apiPort < portRange.start || apiPort > portRange.end)))) throw new DomainError('INVALID_INPUT', '宿主端口必须位于配置的开放范围内');
  const frontendPort = options.frontendPort ?? port(process.env.PIXEL_PORT, 4310);
  const directory = resolve(options.directory ?? process.env.PIXEL_STORAGE_DIR ?? '.pixel');
  let runner = options.runner;
  let providers = options.providers;
  let voices = options.voices;
  const artifacts = options.artifacts ?? runner?.artifacts ?? await SeafileArtifactStore.open(await loadSeafileConfiguration(options));
  let projects = options.projects;
  let repository = options.repository;
  let sharedJobs: SharedJobRepository | undefined;
  let lease: SharedProjectLease | undefined;
  if (artifacts instanceof SeafileArtifactStore) {
    projects ??= new SharedProjectCatalog(artifacts);
    let projectId = options.projectId;
    if (!projectId) {
      let legacy;
      try { legacy = await readWorkbenchProjectFile(directory, { validateResources: false }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (legacy) {
        projectId = await importLegacyProject(directory, artifacts, projects, legacy);
      } else if (options.initial) {
        projectId = options.initial.document.id;
        try { await projects.state(projectId); }
        catch (error) { if (!(error instanceof DomainError && error.code === 'NOT_FOUND')) throw error; await projects.create(options.initial.document.title, projectId, { version: 1, snapshot: options.initial, requests: {}, history: [], outbox: [] }); }
      } else {
        // A fresh host must still reach the manager when the first team project is occupied.
        for (const candidate of (await projects.list({ limit: 20 })).items) {
          try { lease = await SharedProjectLease.acquire(artifacts, candidate.id); projectId = candidate.id; break; }
          catch (error) { if (!(error instanceof DomainError && error.code === 'NOT_APPLICABLE')) throw error; }
        }
        projectId ??= await projects.create('未命名作品');
      }
    }
    try {
      await projects.state(projectId);
      lease ??= await SharedProjectLease.acquire(artifacts, projectId);
      repository = await projects.repository(projectId, () => lease!.assertWritable());
    } catch (error) { await lease?.release(); throw error; }
    sharedJobs = new SharedJobRepository(artifacts, projectId, () => lease!.assertWritable());
  }
  if (!runner && !providers) {
    try {
      const configuration = await loadBackendConfiguration({ storageDirectory: directory, ...(options.envPath ? { envPath: options.envPath } : {}) });
      const { createModelBackend } = await import('./runtime.js');
      const modelJobs = sharedJobs ?? (artifacts instanceof FileArtifactStore ? new FileJobRepository(resolve(directory, 'jobs')) : undefined);
      if (!modelJobs) throw new DomainError('INVALID_INPUT', '模型执行需要显式持久化任务仓库');
      runner = createModelBackend(configuration, artifacts, modelJobs, lease ? () => lease!.assertWritable() : undefined);
      providers = { elevenlabs: true, openrouter: true };
      voices ??= new VoiceService(new ElevenLabsVoiceProvider({ apiKey: configuration.elevenlabsApiKey }), resolve(directory, 'voice-operations'), artifacts instanceof SeafileArtifactStore ? {
        operations: {
          read: async key => (await new SharedVersionedDocument(artifacts, `operations/${key}`, value => voiceOperationSchema.parse(value)).read())?.value,
          save: async (key, value, createOnly) => {
            const file = new SharedVersionedDocument(artifacts, `operations/${key}`, input => voiceOperationSchema.parse(input));
            const current = await file.read();
            if (createOnly && current) return false;
            try { await file.publish(current, value); return true; }
            catch (error) { if (createOnly && error instanceof DomainError && error.code === 'REVISION_CONFLICT') return false; throw error; }
          },
        },
      } : {});
    } catch { providers = { elevenlabs: false, openrouter: false }; }
  }
  let renewing: Promise<void> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let expiryWatchdog: ReturnType<typeof setInterval> | undefined;
  const clearLeaseMonitoring = () => {
    if (heartbeat) clearInterval(heartbeat);
    if (expiryWatchdog) clearInterval(expiryWatchdog);
  };
  let workbench: Workbench;
  try {
    workbench = await createWorkbench({ ...options, directory, artifacts, ...(repository ? { repository } : {}), ...(runner ? { runner } : {}), ...(providers ? { providers } : {}), ...(voices ? { voices } : {}) }, current => {
      if (!lease) return;
      // Startup may consume a queued outbox; ownership monitoring starts before that work.
      heartbeat = setInterval(() => {
        if (renewing) return;
        renewing = lease!.renew().catch(() => { current.close(); }).finally(() => { renewing = undefined; });
      }, 20_000); heartbeat.unref();
      expiryWatchdog = setInterval(() => { if (Date.now() >= lease!.expiresAt) current.close(); }, 1000); expiryWatchdog.unref();
      if (Date.now() >= lease.expiresAt) current.close();
    });
  } catch (error) { clearLeaseMonitoring(); await renewing; await lease?.release(); throw error; }
  const server = createApiServer(workbench, { ...options, ...(projects ? { projects } : {}), ...(apiPort === undefined ? {} : { apiPort }), frontendPort });
  try { await lease?.assertWritable(); await listenInRange(server, '127.0.0.1', portRange, apiPort); }
  catch (error) { clearLeaseMonitoring(); await renewing; await workbench.shutdown(); await lease?.release(); throw error; }
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= (async () => {
    clearLeaseMonitoring();
    workbench.close();
    await renewing;
    try { await workbench.shutdown(); }
    finally { await lease?.release(); }
  })();
  server.once('close', () => { void stop().catch(() => {}); });
  const shutdown = async () => {
    const stopping = stop();
    const closed = server.listening ? new Promise<void>(accept => { server.close(() => accept()); server.closeAllConnections(); }) : Promise.resolve();
    await Promise.all([stopping, closed]);
  };
  return { server, workbench, ...(projects ? { projects } : {}), shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startWorkbenchServer().then(({ server, shutdown: stopRuntime }) => {
    const address = server.address();
    if (process.send && typeof address === 'object' && address) process.send({ type: 'pixel.ready', port: address.port });
    console.log(`Pixel 本地宿主已启动：http://127.0.0.1:${typeof address === 'object' && address ? address.port : 4311}`);
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await stopRuntime();
      if (process.send) process.send({ type: 'pixel.closed' });
      if (process.connected) process.disconnect?.();
    };
    process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
    process.on('message', message => {
      if (message !== null && typeof message === 'object' && 'type' in message && message.type === 'pixel.shutdown') void shutdown();
    });
  }).catch(() => { console.error('Pixel 本地宿主启动失败，请检查端口与项目存储'); process.exitCode = 1; });
}
