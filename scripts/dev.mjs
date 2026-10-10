import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { register } from 'tsx/esm/api';
import { createServer as createViteServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
/** One local API authority and its UI; actual listeners allocate from the trusted host pool. */
export async function startDevelopment(options = {}) {
  // Normal imports share the host's one module graph, including nominal adapter
  // checks. Separately scoped tsImport calls would duplicate those constructors.
  const unregister = register();
  let api;
  let frontend;
  try {
    const { loadHostPortRange } = await import('../src/host-ports.ts');
    const { startWorkbenchServer } = await import('../src/server.ts');
    const { createPixelViteConfig } = await import('../vite.config.ts');
    const envPath = options.envPath ?? resolve(root, '.env');
    const configuration = { envPath, ...(options.environment ? { environment: options.environment } : {}) };
    const range = await loadHostPortRange(configuration);
    const initial = await createPixelViteConfig(configuration);
    let frontendPort = initial.server.port;
    api = await startWorkbenchServer({ ...options.backendOptions, envPath, getFrontendPort: () => frontendPort });
    const address = api.server.address();
    if (!address || typeof address === 'string') throw new Error('API listener has no network port');
    const apiPort = address.port;
    const config = await createPixelViteConfig({ ...configuration, apiPort });
    const preferred = config.server.port;
    const ports = range ? Array.from({ length: range.end - range.start + 1 }, (_, index) => range.start + index) : [preferred];
    if (range) { ports.splice(ports.indexOf(preferred), 1); ports.unshift(preferred); }
    for (const port of ports.filter(port => port !== apiPort)) {
      const candidate = await createViteServer({ ...config, root: resolve(root, 'web'), configFile: false,
        server: { ...config.server, port, strictPort: true } });
      try {
        await candidate.listen();
        const address = candidate.httpServer?.address();
        if (!address || typeof address === 'string') throw new Error('Frontend listener has no network port');
        frontend = candidate; frontendPort = address.port; break;
      } catch (error) {
        await candidate.close();
        // Vite deliberately turns Node's EADDRINUSE into this bounded public error.
        if (error?.code !== 'EADDRINUSE' && error?.message !== `Port ${port} is already in use`) throw error;
      }
    }
    if (!frontend) throw new Error('No available frontend port remains in the configured host pool');
    let stopping;
    const shutdown = () => stopping ??= (async () => {
      const closed = await Promise.allSettled([frontend.close(), api.shutdown()]);
      await unregister();
      if (closed.some(result => result.status === 'rejected')) throw new Error('Development host shutdown did not complete');
    })();
    return { api, frontend, apiPort, frontendPort, shutdown };
  } catch (error) {
    await Promise.allSettled([frontend?.close(), api?.shutdown()]);
    await unregister();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let closing = false;
  const startup = startDevelopment();
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const runtime = await startup.catch(() => undefined);
    try { await runtime?.shutdown(); }
    catch { console.error('Pixel 开发环境未能完整关闭，请检查共享存储'); process.exitCode = 1; }
  };
  process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
  startup.then(async runtime => {
    if (closing) return;
    console.log(`Pixel 开发界面：http://127.0.0.1:${runtime.frontendPort}`);
    console.log(`Pixel 本地宿主：http://127.0.0.1:${runtime.apiPort}`);
  }).catch(() => {
    console.error('Pixel 开发环境启动失败，请检查开放端口范围与共享项目配置');
    process.exitCode = 1;
  });
}
