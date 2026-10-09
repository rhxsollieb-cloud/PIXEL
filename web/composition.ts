import { orderedTimelineIds, type DeepReadonly, type MediaKind, type ProjectDocument } from '../src/contracts.js';

export const COMPOSITION_FPS = 60;
export const COMPOSITION_WIDTH = 1280;
export const COMPOSITION_HEIGHT = 720;

export interface CompositionLayer {
  itemId: string;
  timelineId: string;
  assetId: string;
  kind: MediaKind;
  /** The first frame in [startMs,endMs), and its exclusive frame bound. */
  from: number;
  durationInFrames: number;
  /** Fractional media frames retain the original tick-based source offset. */
  trimBefore: number;
  zIndex: number;
}
export interface CompositionPlan {
  fps: number;
  durationInFrames: number;
  layers: CompositionLayer[];
  maximumConcurrentAudio: number;
}

/** One read-only projection of the timeline clocks, media outputs and explicit layer order. */
export function buildCompositionPlan(document: DeepReadonly<ProjectDocument>, fps = COMPOSITION_FPS): CompositionPlan {
  if (!Number.isSafeInteger(fps) || fps <= 0) throw new Error('Composition fps must be a positive integer');
  const timelineIds = orderedTimelineIds(document);
  const layers: CompositionLayer[] = [];
  let durationInFrames = 1;
  for (const [index, timelineId] of timelineIds.entries()) {
    const timeline = document.timelines[timelineId]!;
    for (const itemId of timeline.itemIds) {
      const item = document.items[itemId]!;
      const exactStart = item.startTick * fps / timeline.ticksPerSecond;
      const from = Math.ceil(exactStart);
      const until = Math.ceil((item.startTick + item.durationTicks) * fps / timeline.ticksPerSecond);
      // Keep the exclusive project end representable as an empty frame, including an external seek past it.
      durationInFrames = Math.max(durationInFrames, until + 1);
      const asset = item.outputAssetId ? document.assets[item.outputAssetId] : undefined;
      // Text reference items and ungenerated drafts have no media output and never enter the picture.
      if (!asset || until <= from) continue;
      layers.push({ itemId, timelineId, assetId: asset.id, kind: asset.kind,
        from, durationInFrames: until - from,
        trimBefore: item.sourceOffsetTicks * fps / timeline.ticksPerSecond + from - exactStart,
        zIndex: timelineIds.length - index,
      });
    }
  }
  // End events sort before start events, matching half-open intervals at adjoining boundaries.
  const events = layers.filter(layer => layer.kind === 'audio').flatMap(layer => [
    { frame: layer.from, change: 1 }, { frame: layer.from + layer.durationInFrames, change: -1 },
  ]).sort((left, right) => left.frame - right.frame || left.change - right.change);
  let audio = 0; let maximumConcurrentAudio = 0;
  for (const event of events) { audio += event.change; maximumConcurrentAudio = Math.max(maximumConcurrentAudio, audio); }
  return { fps, durationInFrames, layers, maximumConcurrentAudio };
}

export function activeCompositionLayers(plan: CompositionPlan, frame: number): CompositionLayer[] {
  return plan.layers.filter(layer => frame >= layer.from && frame < layer.from + layer.durationInFrames);
}

/** Seek coordinates belong to the viewport; project ticks are never rounded or rewritten. */
export function compositionFrameAtMs(plan: Pick<CompositionPlan, 'fps' | 'durationInFrames'>, milliseconds: number): number {
  if (!Number.isFinite(milliseconds)) return 0;
  return Math.max(0, Math.min(plan.durationInFrames - 1, Math.round(milliseconds * plan.fps / 1000)));
}
