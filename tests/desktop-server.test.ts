import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkbenchServer } from '../src/server.js';

test('desktop renderer and API share one authenticated loopback host and static files stay within dist', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-desktop-'));
  const frontend = join(directory, 'dist');
  await mkdir(join(frontend, 'assets'), { recursive: true });
  await writeFile(join(frontend, 'index.html'), '<main>Pixel</main>');
  await writeFile(join(frontend, 'assets', 'main.js'), 'window.loaded=true;');
  await writeFile(join(directory, 'private.css'), 'SECRET');
  await writeFile(join(frontend, '.env'), 'API_KEY=SECRET');
  const { server, workbench } = await startWorkbenchServer({
    directory: join(directory, 'project'), apiPort: 0, frontendDirectory: frontend,
    sessionToken: 'trusted-session', providers: { elevenlabs: false, openrouter: false },
  });
  context.after(async () => {
    await workbench.shutdown(); server.closeAllConnections();
    await new Promise<void>(accept => server.close(() => accept()));
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Cookie: 'pixel_desktop_session=trusted-session' };
  assert.equal((await fetch(`${base}/api/project`)).status, 403);
  assert.equal((await fetch(`${base}/`, { headers: { Cookie: 'pixel_desktop_session=wrong' } })).status, 403);
  const renderer = await fetch(`${base}/`, { headers });
  assert.equal(renderer.status, 200); assert.equal(await renderer.text(), '<main>Pixel</main>');
  assert.match(renderer.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const script = await fetch(`${base}/assets/main.js`, { headers });
  assert.equal(script.status, 200); assert.match(script.headers.get('content-type')!, /javascript/);
  const snapshot = await fetch(`${base}/api/project`, { headers });
  assert.equal(snapshot.status, 200); assert.equal((await snapshot.json()).document.id, 'pixel-project');
  assert.equal((await fetch(`${base}/api/project`, { headers: { ...headers, Origin: 'https://foreign.example' } })).status, 403);
  for (const path of ['/assets/%2e%2e/%2e%2e/private.css', '/assets/..%5c..%5cprivate.css', '/.env']) {
    const response = await fetch(`${base}${path}`, { headers });
    assert.equal(response.status, 404); assert.ok(!(await response.text()).includes('SECRET'));
  }
});
