import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ExportTickets } from '../electron/export-tickets.mjs';
import type { AssetData } from '../src/contracts.js';

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-export-tickets-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'media.png');
  await writeFile(path, Buffer.from('owned media'));
  const assets = new Map<string, AssetData>([['image', { id: 'image', kind: 'image', fileRef: 'pixel-asset:owned', metadata: {} }]]);
  const workbench = {
    mediaAsset: async (id: string) => { const asset = assets.get(id); if (!asset) throw new Error('Unknown asset'); return asset; },
    artifacts: { resolvePath: async () => path },
  };
  const tickets = new ExportTickets(workbench, id => assets.get(id));
  return { assets, path, tickets, workbench };
}

test('prepared native export tickets bind the sender and consume an owned file once', async context => {
  const { tickets, path } = await fixture(context);
  const { ticket } = await tickets.prepare('image', 1);
  assert.equal(tickets.take(ticket, 2), undefined);
  assert.equal(tickets.take('forged-ticket', 1), undefined);
  assert.equal(tickets.take(ticket, 1), path);
  assert.equal(tickets.take(ticket, 1), undefined);
});

test('removed assets, replaced file handles and missing or empty files revoke export authority', async context => {
  const { tickets, assets, path } = await fixture(context);
  const original = assets.get('image')!;
  const removed = await tickets.prepare('image', 1);
  assets.delete('image');
  assert.equal(tickets.take(removed.ticket, 1), undefined);
  assets.set('image', original);
  const replaced = await tickets.prepare('image', 1);
  assets.set('image', { ...original, fileRef: 'pixel-asset:new' });
  assert.equal(tickets.take(replaced.ticket, 1), undefined);
  assets.set('image', original);
  const missing = await tickets.prepare('image', 1);
  await unlink(path);
  assert.equal(tickets.take(missing.ticket, 1), undefined);
  await writeFile(path, '');
  await assert.rejects(tickets.prepare('image', 1), /not ready/);
  await writeFile(path, 'owned media');
  const directoryReplacement = await tickets.prepare('image', 1);
  await unlink(path);
  await mkdir(path);
  assert.equal(tickets.take(directoryReplacement.ticket, 1), undefined);
  await assert.rejects(tickets.prepare('image', 1), /not ready/);
});

test('project session close invalidates current tickets and asynchronous preparations', async context => {
  const { tickets, workbench } = await fixture(context);
  const existing = await tickets.prepare('image', 1);
  let continueResolve: (() => void) | undefined;
  const resolved = new Promise<void>(accept => { continueResolve = accept; });
  const originalResolve = workbench.artifacts.resolvePath;
  workbench.artifacts.resolvePath = async () => { await resolved; return originalResolve(); };
  const pending = tickets.prepare('image', 1);
  tickets.clear();
  continueResolve!();
  await assert.rejects(pending, /session has closed/);
  assert.equal(tickets.take(existing.ticket, 1), undefined);
  await assert.rejects(tickets.prepare('image', 1), /session has closed/);
});
