import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { ProviderError } from './generation.js';

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
  let file: Record<string, string> = {};
  try { file = parseEnv(await readFile(resolve(options.envPath ?? '.env'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const environment = options.environment ?? process.env;
  const elevenlabsApiKey = (environment.ELEVENLABS_API_KEY ?? file.ELEVENLABS_API_KEY ?? '').trim();
  const openrouterApiKey = (environment.OPENROUTER_API_KEY ?? file.OPENROUTER_API_KEY ?? '').trim();
  if (!elevenlabsApiKey || !openrouterApiKey) {
    throw new ProviderError('AUTHENTICATION', '后端配置需要 ELEVENLABS_API_KEY 和 OPENROUTER_API_KEY');
  }
  return { elevenlabsApiKey, openrouterApiKey, storageDirectory: resolve(options.storageDirectory ?? '.pixel') };
}
