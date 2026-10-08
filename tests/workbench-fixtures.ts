import { randomUUID } from 'node:crypto';
import type { JsonObject, ProjectSnapshot } from '../src/contracts.js';
import { modelRegistry } from '../src/models.js';
import { createInitialWorkbenchProject } from '../src/workbench.js';

/** Explicit test data: production bootstrap never injects sample work into a project. */
export function createWorkbenchFixture(): ProjectSnapshot {
  const snapshot = createInitialWorkbenchProject();
  const examples: { model: string; params: JsonObject; duration: number }[] = [
    { model: 'alibaba/wan-3.0', params: { prompt: '晨雾中的山谷，镜头缓慢向前推进，柔和的清晨光线', durationSeconds: 5 }, duration: 5000 },
    { model: 'x-ai/grok-imagine-image-2.0', params: { prompt: '山谷的像素风格视觉草稿，层叠山峦，晨雾与柔和的暖光' }, duration: 5000 },
    { model: 'music_v2_5', params: { prompt: '轻柔的钢琴与自然氛围，适合清晨山谷镜头，无歌词', musicLengthMs: 30000, forceInstrumental: true }, duration: 30000 },
  ];
  for (const example of examples) {
    const plugin = modelRegistry.createPlugin(example.model);
    const timeline = plugin.createTimeline({ id: randomUUID(), modelId: example.model, ticksPerSecond: 1000, settings: {} });
    const item = plugin.createItem({ timeline, id: randomUUID(), startTick: 0, durationTicks: example.duration, params: example.params, generationToken: randomUUID() });
    timeline.itemIds.push(item.id);
    snapshot.document.timelines[timeline.id] = timeline;
    snapshot.document.items[item.id] = item;
  }
  return snapshot;
}
