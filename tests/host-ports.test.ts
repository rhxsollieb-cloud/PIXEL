import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DomainError } from '../src/backend.js';
import { listenInRange, loadHostPortRange, resolveHostPortRange } from '../src/host-ports.js';

const invalid = (error: unknown) => error instanceof DomainError && error.code === 'INVALID_INPUT';
function ownedServer(t: TestContext): Server {
  const server = createServer();
  t.after(async () => {
    if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  });
  return server;
}

test('host-wide port range accepts equivalent complete declarations and defaults to unconfigured', () => {
  assert.equal(resolveHostPortRange({}), undefined);
  assert.equal(resolveHostPortRange({ OTHER_SERVICE_SECRET: 'irrelevant' }), undefined);
  assert.deepEqual(resolveHostPortRange({ FIREWALL_OPEN_PORT_RANGE: '12000-12100', PORT_RANGE_START: '12000', PORT_RANGE_END: '12100' }), { start: 12000, end: 12100 });
  assert.deepEqual(resolveHostPortRange({ FIREWALL_OPEN_PORT_RANGE: ' 12000 - 12100 ' }), { start: 12000, end: 12100 });
  assert.deepEqual(resolveHostPortRange({ PORT_RANGE_START: '12000', PORT_RANGE_END: '12100' }), { start: 12000, end: 12100 });
  assert.deepEqual(resolveHostPortRange({ PORT_RANGE_START: '1', PORT_RANGE_END: '256' }), { start: 1, end: 256 });
  assert.deepEqual(resolveHostPortRange({ FIREWALL_OPEN_PORT_RANGE: '65535-65535' }), { start: 65535, end: 65535 });
});

test('port configuration rejects partial, divergent, oversized and noninteger ranges without echoing values', () => {
  for (const environment of [
    { PORT_RANGE_START: '12000' }, { PORT_RANGE_END: '12100' },
    { FIREWALL_OPEN_PORT_RANGE: '12000-12100', PORT_RANGE_START: '12001', PORT_RANGE_END: '12100' },
    { FIREWALL_OPEN_PORT_RANGE: '12000-12100', PORT_RANGE_START: '12000' },
    { FIREWALL_OPEN_PORT_RANGE: '0-100' }, { FIREWALL_OPEN_PORT_RANGE: '65535-65536' },
    { FIREWALL_OPEN_PORT_RANGE: '1-257' }, { FIREWALL_OPEN_PORT_RANGE: '12000-11999' },
    { PORT_RANGE_START: '12000.5', PORT_RANGE_END: '12100' },
    { FIREWALL_OPEN_PORT_RANGE: 'secret-value-that-must-not-be-echoed' },
  ]) {
    assert.throws(() => resolveHostPortRange(environment), error => invalid(error)
      && !(error as Error).message.includes('secret-value-that-must-not-be-echoed'));
  }
});

test('trusted dotenv range merges defined environment values without exposing unrelated credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pixel-host-ports-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('pixel-host-ports-'));
    await rm(root, { recursive: true, force: true });
  });
  const envPath = join(root, '.env');
  await writeFile(envPath, 'FIREWALL_OPEN_PORT_RANGE=12000-12100\nPORT_RANGE_START=12000\nPORT_RANGE_END=12100\nPRIVATE_KEY=never-return-this\n');
  assert.deepEqual(await loadHostPortRange({ envPath, environment: { PORT_RANGE_START: undefined } }), { start: 12000, end: 12100 });
  assert.deepEqual(await loadHostPortRange({ envPath, environment: { FIREWALL_OPEN_PORT_RANGE: '12500-12510', PORT_RANGE_START: '12500', PORT_RANGE_END: '12510' } }), { start: 12500, end: 12510 });
  assert.equal(await loadHostPortRange({ envPath: join(root, 'absent'), environment: {} }), undefined);
  await assert.rejects(loadHostPortRange({ envPath: root, environment: {} }), error => invalid(error) && !(error as Error).message.includes(root));
});

test('actual loopback listeners choose within the configured pool and skip an occupied preferred port', async t => {
  const occupied = ownedServer(t); const first = await listenInRange(occupied);
  const range = { start: first, end: Math.min(first + 255, 65535) };
  const server = ownedServer(t); const selected = await listenInRange(server, '127.0.0.1', range, first);
  assert.ok(selected >= range.start && selected <= range.end); assert.notEqual(selected, first);
  assert.equal((server.address() as { address: string }).address, '127.0.0.1');
  assert.equal(server.listenerCount('error'), 0); assert.equal(server.listenerCount('listening'), 0);
});

test('an exhausted pool reports the real allocation failure; explicit isolated ephemeral listeners remain available', async t => {
  const occupied = ownedServer(t); const port = await listenInRange(occupied, '127.0.0.1', undefined, 0);
  const blocked = ownedServer(t);
  await assert.rejects(listenInRange(blocked, '127.0.0.1', { start: port, end: port }), error => error instanceof DomainError && error.code === 'NOT_APPLICABLE');
  assert.equal(blocked.listening, false); assert.equal(blocked.listenerCount('error'), 0); assert.equal(blocked.listenerCount('listening'), 0);
  await assert.rejects(listenInRange(ownedServer(t), '127.0.0.1', { start: 12000, end: 12100 }, 0), invalid);
});

test('listener allocation retries only EADDRINUSE and removes temporary handlers on other failures', async () => {
  const failure = Object.assign(new Error('Access denied'), { code: 'EACCES' });
  const server = new EventEmitter() as EventEmitter & { listening: boolean; listen: () => void };
  let attempts = 0; server.listening = false;
  server.listen = () => { attempts += 1; queueMicrotask(() => server.emit('error', failure)); };
  await assert.rejects(listenInRange(server as unknown as Server, '127.0.0.1', { start: 12000, end: 12100 }), error => error === failure);
  assert.equal(attempts, 1); assert.equal(server.listenerCount('error'), 0); assert.equal(server.listenerCount('listening'), 0);
});

test('port allocation rejects public addresses and duplicate startup without mutating the live listener', async t => {
  const server = ownedServer(t);
  for (const host of ['0.0.0.0', '::', 'example.com', 'localhost']) await assert.rejects(listenInRange(server, host), invalid);
  const port = await listenInRange(server);
  await assert.rejects(listenInRange(server), error => error instanceof DomainError && error.code === 'NOT_APPLICABLE');
  assert.equal((server.address() as { port: number }).port, port);
});
