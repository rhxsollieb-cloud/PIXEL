import { readFile } from 'node:fs/promises';
import type { Server } from 'node:net';
import { resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { DomainError } from './backend.js';

export interface HostPortRange { start: number; end: number }

const invalidRange = () => new DomainError('INVALID_INPUT', '开放端口范围无效：起止端口须一致，端口为 1–65535，范围最多包含 256 个端口');
function checkedRange(start: number, end: number): HostPortRange {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > 65535
    || end < start || end - start + 1 > 256) throw invalidRange();
  return { start, end };
}

/** A trusted host-wide pool for any service allocated here; no deployment or exposure policy. */
export function resolveHostPortRange(environment: Record<string, string | undefined>): HostPortRange | undefined {
  const declared = environment.FIREWALL_OPEN_PORT_RANGE?.trim() ?? '';
  const first = environment.PORT_RANGE_START?.trim() ?? '';
  const last = environment.PORT_RANGE_END?.trim() ?? '';
  if (!declared && !first && !last) return undefined;
  let range: HostPortRange | undefined;
  if (declared) {
    const parts = /^(\d+)\s*-\s*(\d+)$/.exec(declared);
    if (!parts) throw invalidRange();
    range = checkedRange(Number(parts[1]), Number(parts[2]));
  }
  if (first || last) {
    if (!/^\d+$/.test(first) || !/^\d+$/.test(last)) throw invalidRange();
    const bounds = checkedRange(Number(first), Number(last));
    if (range && (range.start !== bounds.start || range.end !== bounds.end)) throw invalidRange();
    range = bounds;
  }
  return range;
}

export async function loadHostPortRange(options: { envPath?: string; environment?: NodeJS.ProcessEnv } = {}): Promise<HostPortRange | undefined> {
  let file: Record<string, string> = {};
  try { file = parseEnv(await readFile(resolve(options.envPath ?? '.env'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DomainError('INVALID_INPUT', '无法读取宿主端口配置');
  }
  const environment: Record<string, string | undefined> = { ...file };
  for (const [key, value] of Object.entries(options.environment ?? process.env)) if (value !== undefined) environment[key] = value;
  return resolveHostPortRange(environment);
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((accept, reject) => {
    const clean = () => { server.off('error', error); server.off('listening', listening); };
    const error = (cause: Error) => { clean(); reject(cause); };
    const listening = () => {
      clean();
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new DomainError('INVALID_INPUT', '宿主服务未获得有效网络端口')); return; }
      accept(address.port);
    };
    server.once('error', error);
    server.once('listening', listening);
    try { server.listen({ host, port }); }
    catch (cause) { clean(); reject(cause); }
  });
}

/** Bind the actual service while choosing: there is no separate probe/free-port race. */
export async function listenInRange(server: Server, host = '127.0.0.1', range?: HostPortRange, preferred?: number): Promise<number> {
  if (!['127.0.0.1', '::1'].includes(host)) throw new DomainError('INVALID_INPUT', '宿主服务仅支持回环地址');
  if (server.listening) throw new DomainError('NOT_APPLICABLE', '宿主服务已经启动');
  const checked = range ? checkedRange(range.start, range.end) : undefined;
  if (preferred !== undefined && (!Number.isSafeInteger(preferred) || preferred < 0 || preferred > 65535
    || (checked && (preferred < checked.start || preferred > checked.end)))) throw invalidRange();
  if (!checked) return listen(server, host, preferred ?? 0);
  const ports = Array.from({ length: checked.end - checked.start + 1 }, (_, index) => checked.start + index);
  if (preferred !== undefined) { ports.splice(ports.indexOf(preferred), 1); ports.unshift(preferred); }
  for (const port of ports) {
    try { return await listen(server, host, port); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
  }
  throw new DomainError('NOT_APPLICABLE', '配置的开放端口范围已被占满，请关闭占用服务或调整范围');
}
