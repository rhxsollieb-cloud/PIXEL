import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { orderedTimelineIds, type ActionResult, type JsonObject } from '../src/contracts.js';
import { createWorkbench, type Workbench } from '../src/workbench.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhUYAAAAASUVORK5CYII=', 'base64');
function success(result: ActionResult) { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error('Expected success'); return result; }
async function action(workbench: Workbench, type: string, payload: JsonObject) {
  const snapshot = await workbench.snapshot();
  return workbench.execute({ requestId: randomUUID(), projectId: workbench.projectId, expectedRevision: snapshot.revision, type, payload });
}

test('one reorder Action preserves temporal content and owns a complete durable layer order through creation, deletion and direct media placement', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-timeline-order-'));
  const workbench = await createWorkbench({ directory });
  context.after(async () => { await workbench.shutdown(); const checked = resolve(directory); assert.equal(dirname(checked), resolve(tmpdir())); assert.ok(basename(checked).startsWith('pixel-timeline-order-')); await rm(checked, { recursive: true, force: true }); });
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) ids.push(String(success(await action(workbench, 'timeline.create', { typeId: 'pixel.text' })).outcome.timelineId));
  success(await action(workbench, 'item.createDraft', { timelineId: ids[0]!, startTick: 1200 }));
  const original = await workbench.snapshot(); assert.equal(original.document.timelineOrder, undefined);
  assert.deepEqual(orderedTimelineIds(original.document), ids);
  const envelope = { requestId: randomUUID(), projectId: workbench.projectId, expectedRevision: original.revision, type: 'timeline.reorder', payload: { timelineId: ids[2]!, beforeTimelineId: ids[0]! } };
  const receipt = success(await workbench.execute(envelope));
  assert.deepEqual(await workbench.execute(envelope), receipt);
  let snapshot = await workbench.snapshot();
  assert.deepEqual(snapshot.document.timelineOrder, [ids[2], ids[0], ids[1]]);
  assert.deepEqual(snapshot.document.items, original.document.items); assert.deepEqual(snapshot.document.timelines, original.document.timelines);
  for (const payload of [{ timelineId: randomUUID() }, { timelineId: ids[0]!, beforeTimelineId: randomUUID() }, { timelineId: ids[0]!, beforeTimelineId: ids[0]! }]) {
    assert.equal((await action(workbench, 'timeline.reorder', payload)).ok, false); assert.deepEqual(await workbench.snapshot(), snapshot);
  }
  const extraId = String(success(await action(workbench, 'timeline.create', { typeId: 'pixel.audio.local' })).outcome.timelineId);
  success(await action(workbench, 'timeline.delete', { timelineId: ids[1]! }));
  snapshot = await workbench.snapshot();
  const placed = success(await workbench.placeExternalMedia({ bytes: png, mimeType: 'image/png', name: 'layer.png', requestId: randomUUID(), expectedRevision: snapshot.revision, startTick: 0 }));
  const imageId = String(placed.outcome.timelineId);
  snapshot = await workbench.snapshot(); assert.deepEqual(snapshot.document.timelineOrder, [ids[2], ids[0], extraId, imageId]);
  success(await action(workbench, 'timeline.reorder', { timelineId: ids[2]! }));
  snapshot = await workbench.snapshot(); assert.deepEqual(snapshot.document.timelineOrder, [ids[0], extraId, imageId, ids[2]]);
  await workbench.shutdown(); const reopened = await createWorkbench({ directory }); context.after(() => reopened.shutdown());
  assert.deepEqual(await reopened.snapshot(), snapshot); assert.deepEqual(await reopened.jobs(), { items: [] });
});
