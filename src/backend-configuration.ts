import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { ProviderError } from './generation.js';

export interface SeafileConfiguration {
  serverUrl: string;
  token?: string;
  username?: string;
  password?: string;
  repoId?: string;
  libraryName: string;
  rootPath: string;
  allowedFileOrigins: readonly string[];
  timeoutMs: number;
  maxBytes: number;
}

async function readEnvironment(options: { envPath?: string; environment?: NodeJS.ProcessEnv }): Promise<Record<string, string | undefined>> {
  let file: Record<string, string> = {};
  try { file = parseEnv(await readFile(resolve(options.envPath ?? '.env'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const merged: Record<string, string | undefined> = { ...file };
  for (const [key, value] of Object.entries(options.environment ?? process.env)) if (value !== undefined) merged[key] = value;
  return merged;
}

/** Credentials remain in the backend; media handles never contain a URL or a token. */
export async function loadSeafileConfiguration(options: { envPath?: string; environment?: NodeJS.ProcessEnv } = {}): Promise<SeafileConfiguration> {
  const env = await readEnvironment(options);
  const field = (name: string) => (env[name] ?? '').trim();
  const rawUrl = field('SEAFILE_URL');
  const token = field('SEAFILE_TOKEN');
  const username = field('SEAFILE_USERNAME') || field('SEAFILE_ADMIN_EMAIL');
  const password = field('SEAFILE_PASSWORD') || field('SEAFILE_ADMIN_PASSWORD');
  if (!rawUrl || (!token && (!username || !password))) {
    throw new ProviderError('AUTHENTICATION', 'Seafile 需要 SEAFILE_URL 及账户凭证或 SEAFILE_TOKEN');
  }
  try {
    const server = new URL(rawUrl);
    if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.search || server.hash) throw new Error();
    const port = field('SEAFILE_PORT');
    if (port) {
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error();
      if (!server.port) server.port = port;
    }
    server.pathname = `${server.pathname.replace(/\/+$/, '')}/`;
    const repoId = field('SEAFILE_REPO_ID');
    if (repoId && !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(repoId)) throw new Error();
    const libraryName = field('SEAFILE_LIBRARY_NAME') || 'Pixel';
    if (libraryName.length > 100 || /[\x00-\x1f]/.test(libraryName)) throw new Error();
    const rootPath = field('SEAFILE_ROOT_PATH') || '/pixel';
    if (!rootPath.startsWith('/') || /[\\\x00-\x1f]/.test(rootPath) || rootPath.split('/').some(part => part === '.' || part === '..') || rootPath.length > 500) throw new Error();
    const allowedFileOrigins = new Set([server.origin]);
    for (const value of [field('SEAFILE_FILE_SERVER_URL'), ...field('SEAFILE_ALLOWED_FILE_ORIGINS').split(',')].filter(Boolean)) {
      const origin = new URL(value);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new Error();
      if (server.protocol === 'https:' && origin.protocol !== 'https:') throw new Error();
      allowedFileOrigins.add(origin.origin);
    }
    const integer = (name: string, fallback: number, maximum: number) => {
      const raw = field(name); const value = raw ? Number(raw) : fallback;
      if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error();
      return value;
    };
    return { serverUrl: server.href, ...(token ? { token } : { username, password }), ...(repoId ? { repoId } : {}), libraryName,
      rootPath: rootPath.replace(/\/+$/, '') || '/', allowedFileOrigins: [...allowedFileOrigins],
      timeoutMs: integer('SEAFILE_TIMEOUT_MS', 60_000, 300_000), maxBytes: integer('SEAFILE_MAX_BYTES', 512 * 1024 * 1024, 1024 * 1024 * 1024) };
  } catch { throw new ProviderError('INVALID_INPUT', 'Seafile 服务地址、资料库、目录或传输配置无效'); }
}

export interface BackendConfiguration {
  elevenlabsApiKey: string;
  openrouterApiKey: string;
  storageDirectory: string;
}

/** Read credentials without loading either SDK into a host that has no configured provider. */
export async function loadBackendConfiguration(options: {
  envPath?: string;
  environment?: NodeJS.ProcessEnv;
  storageDirectory?: string;
} = {}): Promise<BackendConfiguration> {
  const environment = await readEnvironment(options);
  const elevenlabsApiKey = (environment.ELEVENLABS_API_KEY ?? '').trim();
  const openrouterApiKey = (environment.OPENROUTER_API_KEY ?? '').trim();
  if (!elevenlabsApiKey || !openrouterApiKey) {
    throw new ProviderError('AUTHENTICATION', '后端配置需要 ELEVENLABS_API_KEY 和 OPENROUTER_API_KEY');
  }
  return { elevenlabsApiKey, openrouterApiKey, storageDirectory: resolve(options.storageDirectory ?? '.pixel') };
}
