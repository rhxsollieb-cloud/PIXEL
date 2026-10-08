import type { DeepReadonly, ProjectDocument, TimelineItemData } from '../src/contracts.js';

/** Playback position belongs to the viewport and never changes project ticks. */
export function clampPlaybackMs(positionMs: number, maximumMs: number): number {
  const maximum = Number.isFinite(maximumMs) ? Math.max(0, Math.round(maximumMs)) : 0;
  if (Number.isNaN(positionMs)) return 0;
  return Math.round(Math.min(maximum, Math.max(0, positionMs)));
}

export function playbackTimeLabel(positionMs: number): string {
  const milliseconds = Math.max(0, Math.floor(positionMs));
  return `${String(Math.floor(milliseconds / 60_000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

/** Intervals are half-open. A selected track owns its active draft as well as its output. */
export function itemAtPlaybackTime(document: DeepReadonly<ProjectDocument>, positionMs: number, preferredTimelineId?: string): DeepReadonly<TimelineItemData> | undefined {
  if (!Number.isFinite(positionMs) || positionMs < 0) return undefined;
  const atTime = (timelineId: string) => {
    const timeline = document.timelines[timelineId];
    if (!timeline || timeline.ticksPerSecond <= 0) return undefined;
    const tick = positionMs * timeline.ticksPerSecond / 1000;
    return timeline.itemIds.map(id => document.items[id]).find(item => item && tick >= item.startTick && tick < item.startTick + item.durationTicks);
  };
  const preferred = preferredTimelineId ? atTime(preferredTimelineId) : undefined;
  if (preferred) return preferred;
  for (const timeline of Object.values(document.timelines)) {
    const item = atTime(timeline.id);
    if (item?.outputAssetId && document.assets[item.outputAssetId]) return item;
  }
  return undefined;
}

/** Source offset and local time use the owning timeline's clock, independent of provider fps. */
export function sourcePlaybackSeconds(item: DeepReadonly<TimelineItemData>, ticksPerSecond: number, positionMs: number): number {
  if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) return 0;
  const localTicks = Math.max(0, Math.min(item.durationTicks, positionMs * ticksPerSecond / 1000 - item.startTick));
  return Math.max(0, (item.sourceOffsetTicks + localTicks) / ticksPerSecond);
}
