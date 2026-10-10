import { defineConfig, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { DomainError } from './src/backend.js';
import { loadHostPortRange, type HostPortRange } from './src/host-ports.js';

function configuredPort(raw: string | undefined, fallback: number, range?: HostPortRange): number {
  const port = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || (range && (port < range.start || port > range.end))) {
    throw new DomainError('INVALID_INPUT', '开发服务端口必须位于配置的开放范围内');
  }
  return port;
}

/** Both the Vite CLI and composed development host consume the same trusted config. */
export async function createPixelViteConfig(options: { envPath?: string; environment?: NodeJS.ProcessEnv; apiPort?: number } = {}): Promise<UserConfig> {
  const range = await loadHostPortRange(options);
  const environment = options.environment ?? process.env;
  const apiPort = configuredPort(options.apiPort === undefined ? environment.PIXEL_API_PORT : String(options.apiPort), range?.start ?? 4311, range);
  const frontendPort = configuredPort(environment.PIXEL_PORT, range ? Math.min(range.start + 1, range.end) : 4310, range);
  return {
    root: 'web',
    // App owns disposable project/interaction services. Reload that boundary on
    // edits, while keeping CSS and ordinary component Fast Refresh available.
    plugins: [react({ exclude: [/node_modules/, /\/App\.tsx$/] })],
    envPrefix: 'PIXEL_PUBLIC_',
    server: {
      host: '127.0.0.1', port: frontendPort, strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
      fs: { allow: ['..'], deny: ['**/.env', '**/.env.*', '**/.git/**'] },
    },
    preview: { host: '127.0.0.1', port: frontendPort, strictPort: true },
    build: { outDir: '../dist', emptyOutDir: true },
  };
}

export default defineConfig(() => createPixelViteConfig());
