import { ActionExecutor, ActionRegistry, MemoryProjectRepository, MoveItemHandler } from '../src/backend.js';
import { ActionClient, DragRegistry, GuiActionPathRegistry, ProjectProjectionStore, type DesktopBridge } from '../src/frontend.js';
import type { ProjectChanged } from '../src/contracts.js';
import { exampleCaller, exampleProject } from './fixture.js';

const repository = new MemoryProjectRepository([exampleProject()]);
const registry = new ActionRegistry();
registry.register(new MoveItemHandler());
const listeners = new Set<(event: ProjectChanged) => void>();
const executor = new ActionExecutor(repository, registry, event => { for (const listener of listeners) listener(event); });

// 内存 bridge 演示完整边界；生产环境由 Electron preload/main 传输并注入可信身份。
const bridge: DesktopBridge = {
  readProject: projectId => repository.read(projectId),
  dispatch: action => executor.execute(action, exampleCaller),
  subscribeProject: (_projectId, listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
const client = new ActionClient(bridge);
const projection = new ProjectProjectionStore({ projectId: 'project_demo', bridge });
await projection.start();
const project = projection.getSnapshot()!;

const drag = new DragRegistry({ paths: new GuiActionPathRegistry() });
drag.register({
  sourceRole: 'item', targetRole: 'timeline.position', actionType: 'item.move',
  preview: () => ({ status: 'available' }),
  buildPayload: context => {
    const tick = context.target.data.tick;
    if (typeof tick !== 'number') throw new Error('拖拽目标需要整数 tick');
    return { itemId: context.source.payload.object.id, startTick: tick };
  },
});
const command = drag.drop({
  source: { role: 'item', payload: { object: { kind: 'item', projectId: 'project_demo', id: 'item_1' } } },
  target: { role: 'timeline.position', object: { kind: 'timeline', projectId: 'project_demo', id: 'timeline_video' }, data: { tick: 2000 } },
  project,
});
if (!command) throw new Error('示例拖拽未产生动作');

// GUI 拖拽、CLI 命令、Agent 工具在适配层构造相同协议，调用同一个 executor。
const action = {
  requestId: 'move-demo-1', projectId: 'project_demo', expectedRevision: 0,
  ...command,
};
console.log(await client.execute(action));
console.log(await client.execute(action)); // 同一请求只提交一次。
await projection.refresh();
console.log('projected item start tick:', projection.getSnapshot()?.document.items.item_1?.startTick);
drag.dispose();
projection.dispose();
