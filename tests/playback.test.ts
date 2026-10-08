import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectDocument, TimelineItemData } from '../src/contracts.js';
import { clampPlaybackMs, itemAtPlaybackTime, playbackTimeLabel, sourcePlaybackSeconds } from '../web/playback.js';

function fixture(): ProjectDocument {
  const item = (id: string, timelineId: string, startTick: number, durationTicks: number, outputAssetId?: string): TimelineItemData => ({
    id, timelineId, kind: 'media', startTick, durationTicks, sourceOffsetTicks: 0,
    params: {}, referenceAssetIds: [], generationToken: id, ...(outputAssetId ? { outputAssetId } : {}),
  });
  return {
    schemaVersion: 1, id: 'project', title: '',
    timelines: {
      first: { id: 'first', pluginId: 'media', pluginVersion: 1, modelId: 'first', ticksPerSecond: 1000, itemIds: ['a', 'b'], settings: {} },
      second: { id: 'second', pluginId: 'media', pluginVersion: 1, modelId: 'second', ticksPerSecond: 2000, itemIds: ['c'], settings: {} },
      draft: { id: 'draft', pluginId: 'media', pluginVersion: 1, modelId: 'draft', ticksPerSecond: 1000, itemIds: ['d'], settings: {} },
    },
    items: { a: item('a', 'first', 1000, 2000, 'output-a'), b: item('b', 'first', 3000, 1000, 'output-b'), c: item('c', 'second', 2000, 6000, 'output-c'), d: item('d', 'draft', 1000, 3000) },
    assets: Object.fromEntries(['output-a', 'output-b', 'output-c'].map(id => [id, { id, kind: 'image' as const, fileRef: id, metadata: {} }])),
  };
}

test('playback clamps viewport positions without frame-rate assumptions', () => {
  assert.equal(clampPlaybackMs(-1, 36000), 0);
  assert.equal(clampPlaybackMs(1234.6, 36000), 1235);
  assert.equal(clampPlaybackMs(40000, 36000), 36000);
  assert.equal(clampPlaybackMs(Number.POSITIVE_INFINITY, 36000), 36000);
  assert.equal(clampPlaybackMs(Number.NaN, 36000), 0);
  assert.equal(playbackTimeLabel(61523), '01:01.523');
});

test('preview respects half-open boundaries, gaps, and each timeline clock', () => {
  const document = fixture();
  assert.equal(itemAtPlaybackTime(document, 999), undefined);
  assert.equal(itemAtPlaybackTime(document, 1000)?.id, 'a');
  assert.equal(itemAtPlaybackTime(document, 3000)?.id, 'b');
  assert.equal(itemAtPlaybackTime(document, 3000, 'second')?.id, 'c');
  assert.equal(itemAtPlaybackTime(document, 4000), undefined);
  assert.equal(itemAtPlaybackTime(document, -100), undefined);
});

test('selected track wins even for a draft; absent selection falls back only to a real output', () => {
  const document = fixture();
  assert.equal(itemAtPlaybackTime(document, 1500, 'draft')?.id, 'd');
  assert.equal(itemAtPlaybackTime(document, 1500, 'second')?.id, 'c');
  delete document.assets['output-a'];
  assert.equal(itemAtPlaybackTime(document, 1500)?.id, 'c');
  delete document.assets['output-c'];
  assert.equal(itemAtPlaybackTime(document, 1500), undefined);
});

test('media seeking adds source offset to the local position and bounds it to the clip', () => {
  const item = fixture().items.c!;
  item.sourceOffsetTicks = 3000;
  assert.equal(sourcePlaybackSeconds(item, 2000, 1500), 2);
  assert.equal(sourcePlaybackSeconds(item, 2000, 0), 1.5);
  assert.equal(sourcePlaybackSeconds(item, 2000, 6000), 4.5);
});
