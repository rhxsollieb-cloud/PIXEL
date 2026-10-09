import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiServer } from '../src/server.js';
import { createInitialWorkbenchProject, createWorkbench, WORKBENCH_PROJECT_ID } from './local-workbench.js';
import type { ActionResult } from '../src/contracts.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhUYAAAAASUVORK5CYII=', 'base64');

test('desktop HTTP sessions expose the actual project identity, isolate server lifetimes and reject cross-project media imports before writing', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-project-session-api-test-'));
  const initial = createInitialWorkbenchProject(); initial.document.id = randomUUID(); initial.document.title = '独立作品';
  assert.notEqual(initial.document.id, WORKBENCH_PROJECT_ID);
  const workbench = await createWorkbench({ directory: join(directory, 'first'), initial });
  const secondWorkbench = await createWorkbench({ directory: join(directory, 'second'), initial });
  const token = randomUUID(); const secondToken = randomUUID();
  const firstServer = createApiServer(workbench, { sessionToken: token });
  const secondServer = createApiServer(secondWorkbench, { sessionToken: secondToken });
  context.after(async () => {
    await Promise.all([firstServer, secondServer].map(async server => {
      server.closeAllConnections();
      await new Promise<void>(accept => server.close(() => accept()));
    }));
    await Promise.all([workbench.shutdown(), secondWorkbench.shutdown()]);
    const checked = resolve(directory);
    assert.equal(dirname(checked), resolve(tmpdir()));
    assert.ok(basename(checked).startsWith('pixel-project-session-api-test-'));
    await rm(checked, { recursive: true, force: true });
  });
  await Promise.all([firstServer, secondServer].map(server => new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))));
  const firstAddress = firstServer.address(); const secondAddress = secondServer.address();
  assert.ok(firstAddress && typeof firstAddress === 'object'); assert.ok(secondAddress && typeof secondAddress === 'object');
  const base = `http://127.0.0.1:${firstAddress.port}`;
  const secondBase = `http://127.0.0.1:${secondAddress.port}`;
  const cookie = { Cookie: `pixel_desktop_session=${token}` };
  const secondCookie = { Cookie: `pixel_desktop_session=${secondToken}` };
  for (const headers of [{}, secondCookie]) {
    const denied = await fetch(`${base}/api/session`, { headers });
    assert.equal(denied.status, 403); assert.equal((await denied.json() as ActionResult).ok, false);
  }
  const response = await fetch(`${base}/api/session`, { headers: cookie }); assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const session = await response.json() as { projectId: string; sessionId: string };
  assert.deepEqual(Object.keys(session).sort(), ['projectId', 'sessionId']);
  assert.equal(session.projectId, initial.document.id); assert.match(session.sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await (await fetch(`${base}/api/session`, { headers: cookie })).json(), session);
  const other = await (await fetch(`${secondBase}/api/session`, { headers: secondCookie })).json() as typeof session;
  assert.equal(other.projectId, session.projectId); assert.notEqual(other.sessionId, session.sessionId);
  assert.equal((await fetch(`${base}/api/session`, { headers: { ...cookie, Origin: 'https://untrusted.example' } })).status, 403);

  const before = await workbench.snapshot();
  const requestId = randomUUID();
  const headers = {
    ...cookie, 'Content-Type': 'image/png', 'X-Pixel-Name': encodeURIComponent('已校验素材.png'),
    'X-Pixel-Request-Id': requestId, 'X-Pixel-Revision': String(before.revision),
  };
  for (const projectId of [WORKBENCH_PROJECT_ID, randomUUID()]) {
    const rejected = await fetch(`${base}/api/import`, { method: 'POST', headers: { ...headers, 'X-Pixel-Project-Id': projectId }, body: png });
    assert.equal(rejected.status, 400);
    const result = await rejected.json() as ActionResult;
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'FORBIDDEN');
    assert.deepEqual(await workbench.snapshot(), before);
    assert.deepEqual(await readdir(join(directory, 'first')), ['project.json']);
  }
  const upload = () => fetch(`${base}/api/import`, { method: 'POST', headers: { ...headers, 'X-Pixel-Project-Id': session.projectId }, body: png });
  const importedResponse = await upload(); assert.equal(importedResponse.status, 200);
  const imported = await importedResponse.json() as ActionResult;
  assert.equal(imported.ok, true);
  assert.equal(imported.projectId, session.projectId); assert.equal(imported.revision, before.revision + 1);
  const assetId = String(imported.outcome.assetId);
  const snapshot = await workbench.snapshot(); const asset = snapshot.document.assets[assetId]!;
  assert.equal(asset.fileRef, `pixel-asset:${assetId}`); assert.equal(asset.metadata.name, '已校验素材.png');
  assert.deepEqual((await workbench.artifacts.read(asset, new AbortController().signal)).bytes, png);
  assert.deepEqual(await (await upload()).json(), imported); // Existing import idempotency survives the identity guard.
  assert.deepEqual(await workbench.snapshot(), snapshot);
  assert.equal((await readdir(join(directory, 'first', 'artifacts'))).length, 2);
  const media = await fetch(`${base}/api/media/${assetId}`, { headers: cookie });
  assert.equal(media.status, 200); assert.equal(media.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/api/media/${assetId}`)).status, 403);
  assert.deepEqual((await secondWorkbench.snapshot()).document.assets, {});
});
