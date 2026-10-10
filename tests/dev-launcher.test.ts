import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DomainError } from '../src/backend.js';
import { FileArtifactStore } from '../src/storage.js';
import { createPixelViteConfig } from '../vite.config.js';

const invalid = (error: unknown) => error instanceof DomainError && error.code === 'INVALID_INPUT';
const absentEnv = 'does-not-exist.pixel-dev-test.env';

test('Vite consumes the same host port pool, preserves isolated test ports and rejects out-of-range overrides', async () => {
  const range = { FIREWALL_OPEN_PORT_RANGE: '12000-12100', PORT_RANGE_START: '12000', PORT_RANGE_END: '12100' };
  const config = await createPixelViteConfig({ envPath: absentEnv, environment: range });
  assert.equal(config.server?.host, '127.0.0.1'); assert.equal(config.server?.port, 12001); assert.equal(config.server?.strictPort, true);
  assert.deepEqual(config.preview, { host: '127.0.0.1', port: 12001, strictPort: true });
  assert.deepEqual(config.server?.proxy?.['/api'], { target: 'http://127.0.0.1:12000', changeOrigin: true });
  const actual = await createPixelViteConfig({ envPath: absentEnv, environment: range, apiPort: 12007 });
  assert.deepEqual(actual.server?.proxy?.['/api'], { target: 'http://127.0.0.1:12007', changeOrigin: true });
  const isolated = await createPixelViteConfig({ envPath: absentEnv, environment: { FIREWALL_OPEN_PORT_RANGE: '4320-4321', PORT_RANGE_START: '4320', PORT_RANGE_END: '4321', PIXEL_PORT: '4320', PIXEL_API_PORT: '4321' } });
  assert.equal(isolated.server?.port, 4320); assert.deepEqual(isolated.server?.proxy?.['/api'], { target: 'http://127.0.0.1:4321', changeOrigin: true });
  for (const environment of [{ ...range, PIXEL_PORT: '4310' }, { ...range, PIXEL_API_PORT: '4311' }, { ...range, PIXEL_PORT: 'private-invalid-value' }]) {
    await assert.rejects(createPixelViteConfig({ envPath: absentEnv, environment }), error => invalid(error)
      && !(error as Error).message.includes('private-invalid-value'));
  }
  assert.ok(config.server?.fs?.deny?.includes('**/.env'));
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pixel-dev-launcher-'));
  t.after(async () => {
    const path = resolve(root); assert.equal(dirname(path), resolve(tmpdir())); assert.ok(basename(path).startsWith('pixel-dev-launcher-'));
    await rm(path, { recursive: true, force: true });
  });
  const occupied = createServer();
  await new Promise<void>((accept, reject) => { occupied.once('error', reject); occupied.listen(0, '127.0.0.1', () => { occupied.removeAllListeners('error'); accept(); }); });
  t.after(async () => { if (occupied.listening) await new Promise<void>(accept => occupied.close(() => accept())); });
  const port = (occupied.address() as { port: number }).port;
  return { root, occupied, port };
}

test('composed development binds both actual listeners within the pool and trusts only the selected frontend origin', async t => {
  const { root, port } = await fixture(t);
  const end = Math.min(port + 15, 65535);
  assert.ok(end - port >= 2, 'The isolated ephemeral fixture requires three candidate ports');
  const envPath = join(root, '.env');
  await writeFile(envPath, `FIREWALL_OPEN_PORT_RANGE=${port}-${end}\nPORT_RANGE_START=${port}\nPORT_RANGE_END=${end}\n`);
  const specifier = '../scripts/dev.mjs'; const { startDevelopment } = await import(specifier);
  const directory = join(root, 'isolated-project');
  const runtime = await startDevelopment({ envPath, environment: {}, backendOptions: { directory, apiPort: port,
    artifacts: new FileArtifactStore(join(directory, 'artifacts')), providers: { elevenlabs: false, openrouter: false } } });
  t.after(() => runtime.shutdown());
  assert.ok(runtime.apiPort > port && runtime.apiPort <= end); assert.ok(runtime.frontendPort > port && runtime.frontendPort <= end);
  assert.notEqual(runtime.apiPort, runtime.frontendPort);
  assert.equal((runtime.api.server.address() as { address: string }).address, '127.0.0.1');
  assert.equal((runtime.frontend.httpServer.address() as { address: string }).address, '127.0.0.1');
  const frontendOrigin = `http://127.0.0.1:${runtime.frontendPort}`;
  const project = await (await fetch(`${frontendOrigin}/api/project`)).json();
  const body = JSON.stringify({ projectId: project.document.id, expectedRevision: project.revision,
    requestId: randomUUID(), type: 'project.title', payload: { title: 'Actual selected frontend' } });
  const result = await fetch(`${frontendOrigin}/api/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: frontendOrigin }, body });
  assert.equal(result.status, 200); assert.equal((await result.json()).ok, true);
  const foreign = await fetch(`${frontendOrigin}/api/project`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal(foreign.status, 403);
  assert.equal((await (await fetch(`${frontendOrigin}/api/project`)).json()).document.title, 'Actual selected frontend');
  await runtime.shutdown(); assert.equal(runtime.api.server.listening, false); assert.equal(runtime.frontend.httpServer?.listening, false);
});
