import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DomainError } from './backend.js';
import { createWorkbench, type Workbench, type WorkbenchOptions } from './workbench.js';
import { loadBackendConfiguration } from './backend-configuration.js';

export interface ApiOptions {
  frontendPort?: number;
  apiPort?: number;
  /** Desktop hosts serve their compiled renderer from this directory. */
  frontendDirectory?: string;
  /** Trusted desktop host installs this opaque value as an HttpOnly session cookie. */
  sessionToken?: string;
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
  const server = createServer((request, response) => {
    void (async () => {
      const address = server.address();
      const apiPort = typeof address === 'object' && address ? address.port : options.apiPort ?? 4311;
      if (!trustedOrigin(request, apiPort, frontendPort)) { json(response, 403, { ok: false, error: { code: 'FORBIDDEN', message: '请求来源不在本地工作台范围内' } }); return; }
      if (!hasDesktopSession(request, options.sessionToken)) { json(response, 403, { ok: false, error: { code: 'FORBIDDEN', message: '桌面会话无效' } }); return; }
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${apiPort}`);
      if (options.frontendDirectory && (request.method === 'GET' || request.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
        if (await serveFrontend(request, response, url.pathname, options.frontendDirectory)) return;
      }
      if (request.method === 'GET' && url.pathname === '/api/project') { json(response, 200, await workbench.snapshot()); return; }
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
      if (request.method === 'GET' && url.pathname === '/api/jobs') { json(response, 200, await workbench.jobs()); return; }
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
        const mimeType = scalarHeader(request, 'content-type').split(';')[0]!.trim().toLowerCase();
        const requestId = scalarHeader(request, 'x-pixel-request-id');
        const revision = scalarHeader(request, 'x-pixel-revision');
        if (!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new DomainError('INVALID_INPUT', '项目版本无效');
        let name: string;
        try { name = decodeURIComponent(scalarHeader(request, 'x-pixel-name')); }
        catch { throw new DomainError('INVALID_INPUT', '文件名编码无效'); }
        json(response, 200, await workbench.importMedia({ bytes: await bytes(request, 256 * 1024 * 1024), mimeType, name, requestId, expectedRevision: Number(revision) })); return;
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && /^\/api\/media\/[^/]+$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.slice('/api/media/'.length));
        const asset = await workbench.mediaAsset(id);
        const path = await workbench.artifacts.resolvePath(asset);
        const size = (await stat(path)).size;
        const range = request.headers.range ? rangeOf(request.headers.range, size) : undefined;
        if (request.headers.range && !range) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return; }
        response.writeHead(range ? 206 : 200, {
          'Content-Type': String(asset.metadata.mimeType), 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=3600',
          'Content-Length': range ? range.end - range.start + 1 : size,
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(String(asset.metadata.name ?? `${asset.id}.${asset.metadata.extension}`))}`,
          ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}),
        });
        if (request.method === 'HEAD') { response.end(); return; }
        const stream = createReadStream(path, range ? { start: range.start, end: range.end } : {});
        response.on('close', () => stream.destroy());
        stream.on('error', () => response.destroy());
        stream.pipe(response); return;
      }
      json(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '接口不存在' } });
    })().catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      json(response, error instanceof DomainError && error.code === 'NOT_FOUND' ? 404 : 400, {
        ok: false, error: error instanceof DomainError ? { code: error.code, message: error.message } : { code: 'INTERNAL', message: '本地宿主处理失败' },
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
export async function startWorkbenchServer(options: WorkbenchOptions & ApiOptions & { envPath?: string } = {}): Promise<{ server: Server; workbench: Workbench }> {
  const directory = resolve(options.directory ?? process.env.PIXEL_STORAGE_DIR ?? '.pixel');
  let runner = options.runner;
  let providers = options.providers;
  if (!runner && !providers) {
    try {
      const configuration = await loadBackendConfiguration({ storageDirectory: directory, ...(options.envPath ? { envPath: options.envPath } : {}) });
      const { createModelBackend } = await import('./runtime.js');
      runner = createModelBackend(configuration);
      providers = { elevenlabs: true, openrouter: true };
    } catch { providers = { elevenlabs: false, openrouter: false }; }
  }
  const workbench = await createWorkbench({ ...options, directory, ...(runner ? { runner } : {}), ...(providers ? { providers } : {}) });
  const apiPort = options.apiPort ?? port(process.env.PIXEL_API_PORT, 4311);
  const frontendPort = options.frontendPort ?? port(process.env.PIXEL_PORT, 4310);
  const server = createApiServer(workbench, { ...options, apiPort, frontendPort });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(apiPort, '127.0.0.1', () => { server.off('error', reject); accept(); }); });
  return { server, workbench };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startWorkbenchServer().then(({ server, workbench }) => {
    const address = server.address();
    console.log(`Pixel 本地宿主已启动：http://127.0.0.1:${typeof address === 'object' && address ? address.port : 4311}`);
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      const tasks = workbench.shutdown();
      const closed = new Promise<void>(accept => server.close(() => accept()));
      server.closeAllConnections();
      await tasks; await closed;
      if (process.send) process.send({ type: 'pixel.closed' });
      if (process.connected) process.disconnect?.();
    };
    process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
    process.on('message', message => {
      if (message !== null && typeof message === 'object' && 'type' in message && message.type === 'pixel.shutdown') void shutdown();
    });
  }).catch(() => { console.error('Pixel 本地宿主启动失败，请检查端口与项目存储'); process.exitCode = 1; });
}
