import type { CallerContext, ProjectSnapshot } from '../src/contracts.js';

export function exampleProject(): ProjectSnapshot {
  return {
    revision: 0,
    document: {
      schemaVersion: 1, id: 'project_demo', title: 'Pixel 示例项目', assets: {},
      timelines: {
        timeline_video: {
          id: 'timeline_video', pluginId: 'pixel.video', pluginVersion: 1,
          modelId: 'example.video', ticksPerSecond: 1000, itemIds: ['item_1'], settings: {},
        },
      },
      items: {
        item_1: {
          id: 'item_1', timelineId: 'timeline_video', kind: 'video.clip',
          startTick: 0, durationTicks: 5000, sourceOffsetTicks: 0,
          params: { prompt: '海边日落' }, referenceAssetIds: [], generationToken: 'input_v1',
        },
      },
    },
  };
}

export const exampleCaller: CallerContext = {
  actorId: 'local-user', source: 'gui', projectIds: new Set(['project_demo']),
  permissions: new Set(['project.edit', 'generation.submit']),
};
