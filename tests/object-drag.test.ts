import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectDragBroker, type ObjectDragPeer } from '../electron/object-drag-broker.mjs';
import { createWorkbenchFixture } from './workbench-fixtures.js';
import type { DragSource } from '../src/frontend.js';

function setup() {
  let now = 1000;
  const project = createWorkbenchFixture();
  project.document.assets.photo = { id: 'photo', kind: 'image', fileRef: 'media:photo', metadata: {} };
  const peers = new Map<number, ObjectDragPeer>([1, 2].map(id => [id, { id, projectId: project.document.id, interactive: true }]));
  const notifications: unknown[] = [];
  const broker = new ObjectDragBroker({ project: () => project, window: id => peers.get(id), notify: value => notifications.push(value), now: () => now, ttlMs: 1000, endGraceMs: 50 });
  const source: DragSource = { role: 'asset', payload: { object: { kind: 'asset', projectId: project.document.id, id: 'photo' } } };
  return { broker, project, peers, notifications, source, advance: (ms: number) => { now += ms; } };
}

test('cross-window object leases verify real peers and project objects before issuing a token', () => {
  const { broker, source } = setup();
  assert.equal(broker.begin(99, source, 0), undefined);
  assert.equal(broker.begin(1, { role: 'asset', payload: { object: { ...source.payload.object, kind: 'asset', id: 'missing' } } }, 0), undefined);
  assert.equal(broker.begin(1, { role: 'asset', payload: { object: { kind: 'asset', projectId: 'other-project', id: 'photo' } } }, 0), undefined);
  assert.equal(broker.begin(1, source, -1), undefined);
  assert.equal(broker.resolve(2, 'forged'), undefined);
  broker.clear();
});

test('hover reads do not consume a cross-window lease; a drop consumes it once', () => {
  const { broker, source, notifications } = setup();
  const token = broker.begin(2, source, 0)!;
  assert.ok(token.length >= 32);
  assert.deepEqual(broker.resolve(1, token)?.source, source);
  assert.deepEqual(broker.resolve(1, token)?.source, source);
  assert.equal(broker.finish(99, token), undefined);
  assert.deepEqual(broker.finish(1, token)?.source, source);
  assert.equal(broker.finish(1, token), undefined);
  assert.equal(broker.resolve(1, token), undefined);
  assert.equal(notifications.at(-1), undefined);
});

test('closed, deleted or expired sources cannot authorize a later drop', () => {
  for (const invalidation of ['closed', 'deleted', 'expired'] as const) {
    const { broker, source, peers, project, advance } = setup();
    const token = broker.begin(2, source, 0)!;
    if (invalidation === 'closed') { peers.delete(2); broker.destroyWindow(2); }
    if (invalidation === 'deleted') delete project.document.assets.photo;
    if (invalidation === 'expired') advance(1000);
    assert.equal(broker.finish(1, token), undefined);
    assert.equal(broker.activeFor(1), undefined);
  }
});

test('modal blocked and foreign-project recipients cannot consume another window lease', () => {
  const { broker, source, peers } = setup();
  const token = broker.begin(2, source, 0)!;
  peers.get(1)!.interactive = false;
  assert.equal(broker.finish(1, token), undefined);
  peers.get(1)!.interactive = true;
  peers.get(1)!.projectId = 'other-project';
  assert.equal(broker.finish(1, token), undefined);
  peers.get(1)!.projectId = 'pixel-project';
  assert.ok(broker.finish(1, token));
  const next = broker.begin(2, source, 0)!;
  peers.get(2)!.interactive = false;
  assert.equal(broker.finish(1, next), undefined);
});

test('source dragend has bounded drop grace; superseding drags and cancellation end old leases', () => {
  const { broker, source, advance } = setup();
  const first = broker.begin(2, source, 0)!;
  broker.end(1, first);
  advance(60);
  assert.ok(broker.resolve(1, first));
  broker.end(2, first);
  assert.ok(broker.resolve(1, first));
  advance(50);
  assert.equal(broker.finish(1, first), undefined);
  const second = broker.begin(2, source, 0)!;
  const third = broker.begin(2, source, 0)!;
  assert.equal(broker.resolve(1, second), undefined);
  assert.ok(broker.finish(1, third));
});
