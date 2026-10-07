import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActionClient, ContextActionRegistry, DragRegistry, GuiActionPathRegistry,
  ModalNavigator, ProjectProjectionStore,
} from '../src/frontend.js';
import type {
  ActionEnvelope, ActionResult, DeepReadonly, JsonObject, ProjectChanged, ProjectSnapshot,
} from '../src/contracts.js';
import type {
  ContextActionContext, DesktopBridge, DragContext, DragRoute,
} from '../src/frontend.js';

function snapshot(revision = 0): ProjectSnapshot {
  return {
    revision,
    document: {
      schemaVersion: 1, id: 'project', title: 'Pixel',
      assets: { asset: { id: 'asset', kind: 'image', fileRef: 'asset:1', metadata: {} } },
      timelines: {
        timeline: {
          id: 'timeline', pluginId: 'video', pluginVersion: 1, modelId: 'model',
          ticksPerSecond: 1000, itemIds: ['item'], settings: {},
        },
      },
      items: {
        item: {
          id: 'item', timelineId: 'timeline', kind: 'clip', startTick: 0,
          durationTicks: 1000, sourceOffsetTicks: 0, params: {},
          referenceAssetIds: [], generationToken: 'generation:1', outputAssetId: 'asset',
        },
      },
    },
  };
}

function projectView(revision = 0): DeepReadonly<ProjectSnapshot> {
  // 只转换只读视图；避免递归 JSON 的可变/只读类型展开，不跳过运行时动作校验。
  return snapshot(revision) as unknown as DeepReadonly<ProjectSnapshot>;
}

function jsonView(value: JsonObject): DeepReadonly<JsonObject> {
  return value as unknown as DeepReadonly<JsonObject>;
}

function assetDrop(project = projectView(), scopeId?: string): DragContext {
  return {
    source: { role: 'asset', payload: { object: { kind: 'asset', projectId: 'project', id: 'asset' } } },
    target: { role: 'timeline.position', object: { kind: 'timeline', projectId: 'project', id: 'timeline' }, data: jsonView({ startTick: 500 }) },
    project,
    ...(scopeId === undefined ? {} : { scopeId }),
  };
}

function registerAssetDrop(registry: DragRegistry, onBuild = () => {}): void {
  registry.register({
    sourceRole: 'asset', targetRole: 'timeline.position', actionType: 'item.createFromAsset',
    preview: () => ({ status: 'available' }),
    buildPayload: context => {
      onBuild();
      const semanticTarget = context.target as unknown as { readonly data: Readonly<JsonObject> };
      const startTick = semanticTarget.data.startTick;
      return { assetId: context.source.payload.object.id, timelineId: 'timeline', startTick: typeof startTick === 'number' ? startTick : 0 };
    },
  });
}

test('Modal 单路径：Esc 对应 pop，仅顶部作用域可交互，删除祖先会清理后续路径', () => {
  const navigator = new ModalNavigator('project');
  assert.equal(navigator.isInteractive(undefined), true);
  const first = navigator.open({ kind: 'timeline', projectId: 'project', id: 'timeline' });
  const second = navigator.push({ kind: 'item', projectId: 'project', id: 'item' });
  assert.equal(navigator.isInteractive(undefined), false);
  assert.equal(navigator.isInteractive(first.scopeId), false);
  assert.equal(navigator.isInteractive(second.scopeId), true);
  assert.throws(() => navigator.assertInteractive(first.scopeId));
  assert.equal(navigator.pop()?.scopeId, second.scopeId);
  assert.equal(navigator.current()?.scopeId, first.scopeId);
  navigator.push({ kind: 'item', projectId: 'project', id: 'item' });
  const removed = snapshot();
  delete removed.document.items.item;
  navigator.reconcile(removed as unknown as DeepReadonly<ProjectSnapshot>);
  assert.equal(navigator.getPath().length, 1);
  navigator.reset();
  assert.equal(navigator.isInteractive(undefined), true);
  assert.equal(navigator.pop(), undefined);
  assert.throws(() => navigator.open({ kind: 'asset', projectId: 'another', id: 'asset' }));
});

test('右键与拖拽共享动作路径表，重复角色路由与重复 GUI 路径均拒绝', () => {
  const paths = new GuiActionPathRegistry();
  const drag = new DragRegistry({ paths });
  const menu = new ContextActionRegistry({ paths });
  registerAssetDrop(drag);
  assert.throws(() => registerAssetDrop(drag), /已注册/);
  assert.throws(() => menu.register({
    id: 'create', title: '创建片段', actionType: 'item.createFromAsset', targetKinds: ['timeline'],
    availability: () => ({ status: 'available' }), buildPayload: () => ({ timelineId: 'timeline' }),
  }), /已绑定 GUI 路径/);
  assert.throws(() => drag.register({
    sourceRole: 'item', targetRole: 'asset-library', actionType: 'item.createFromAsset',
    preview: () => ({ status: 'available' }), buildPayload: () => ({ itemId: 'item' }),
  }), /已绑定 GUI 路径/);
  drag.dispose();
  assert.equal(paths.getPath('item.createFromAsset'), undefined);
  menu.register({
    id: 'create', title: '创建片段', actionType: 'item.createFromAsset', targetKinds: ['timeline'],
    availability: () => ({ status: 'available' }), buildPayload: () => ({ timelineId: 'timeline' }),
  });
});

test('片段本体可按目标区分移动与保存资产，手柄独立改时长，模型拖拽被拒绝', () => {
  const drag = new DragRegistry({ paths: new GuiActionPathRegistry() });
  drag.register({
    sourceRole: 'item', targetRole: 'timeline.position', actionType: 'item.move',
    preview: () => ({ status: 'available' }), buildPayload: context => ({ itemId: context.source.payload.object.id, startTick: 500 }),
  });
  drag.register({
    sourceRole: 'item', targetRole: 'asset-library', actionType: 'item.saveAsAsset',
    preview: () => ({ status: 'available' }), buildPayload: context => ({ itemId: context.source.payload.object.id }),
  });
  drag.register({
    sourceRole: 'item.duration', targetRole: 'item.edge', actionType: 'item.setDuration',
    preview: () => ({ status: 'available' }), buildPayload: context => ({ itemId: context.source.payload.object.id, edge: context.source.payload.edge, durationTicks: 500 }),
  });
  const itemSource = { role: 'item', payload: { object: { kind: 'item', projectId: 'project', id: 'item' } } } as const;
  assert.equal(drag.drop({ ...assetDrop(), source: itemSource })?.type, 'item.move');
  assert.equal(drag.drop({
    ...assetDrop(), source: itemSource,
    target: { role: 'asset-library', object: { kind: 'project', projectId: 'project' }, data: jsonView({}) },
  })?.type, 'item.saveAsAsset');
  assert.equal(drag.drop({
    ...assetDrop(),
    source: { role: 'item.duration', payload: { object: itemSource.payload.object, edge: 'end' } },
    target: { role: 'item.edge', object: itemSource.payload.object, data: jsonView({}) },
  })?.type, 'item.setDuration');
  const invalid = {
    sourceRole: 'model', targetRole: 'timeline.position', actionType: 'timeline.create',
    preview: () => ({ status: 'available' }), buildPayload: () => ({}),
  } as unknown as DragRoute<'asset', 'timeline.position'>;
  assert.throws(() => drag.register(invalid), /模型不能拖拽/);
});

test('hover 不构建命令，drop 拒绝悬空对象、其他项目与被隔离的作用域', () => {
  const navigator = new ModalNavigator('project');
  const frame = navigator.open({ kind: 'timeline', projectId: 'project', id: 'timeline' });
  const drag = new DragRegistry({ paths: new GuiActionPathRegistry(), navigator });
  let builds = 0;
  registerAssetDrop(drag, () => { builds += 1; });
  const context = assetDrop(projectView(), frame.scopeId);
  assert.equal(drag.hover(context).status, 'available');
  assert.equal(builds, 0);
  assert.equal(drag.drop(context)?.type, 'item.createFromAsset');
  assert.equal(builds, 1);
  const missing = snapshot();
  delete missing.document.assets.asset;
  assert.equal(drag.drop({ ...context, project: missing as unknown as DeepReadonly<ProjectSnapshot> }), undefined);
  assert.equal(drag.drop({
    ...context,
    source: { role: 'asset', payload: { object: { kind: 'asset', projectId: 'another', id: 'asset' } } },
  }), undefined);
  navigator.push({ kind: 'item', projectId: 'project', id: 'item' });
  assert.equal(drag.hover(context).status, 'hidden');
  assert.equal(drag.drop(context), undefined);
  assert.equal(builds, 1);
});

test('宿主隐藏 hidden、展示 disabled 原因，并在激活时重新检查', () => {
  const registry = new ContextActionRegistry({ paths: new GuiActionPathRegistry() });
  let disabled = false;
  registry.register({
    id: 'hidden', title: '隐藏', actionType: 'hidden.action', targetKinds: ['timeline'],
    availability: () => ({ status: 'hidden' }), buildPayload: () => { throw new Error('隐藏动作不得构建命令'); },
  });
  registry.register({
    id: 'generate', title: '生成', actionType: 'generation.submit', targetKinds: ['timeline'],
    availability: () => disabled ? { status: 'disabled', reason: '缺少参数' } : { status: 'available' },
    buildPayload: () => ({ timelineId: 'timeline' }),
  });
  const context: ContextActionContext = {
    target: { kind: 'timeline', projectId: 'project', id: 'timeline' }, project: projectView(),
  };
  assert.equal(registry.list(context).length, 1);
  assert.equal(registry.commandFor('generate', context)?.type, 'generation.submit');
  disabled = true;
  assert.deepEqual(registry.list(context)[0]?.availability, { status: 'disabled', reason: '缺少参数' });
  assert.equal(registry.commandFor('generate', context), undefined);
});

test('投影订阅先于读快照，乱序响应不能倒退，dispose 取消订阅与迟到发布', async () => {
  const reads: { resolve: (value: ProjectSnapshot) => void }[] = [];
  let receive: ((event: DeepReadonly<ProjectChanged>) => void) | undefined;
  let unsubscribed = false;
  const bridge: DesktopBridge = {
    readProject: () => {
      assert.ok(receive, '初始化读取之前应先订阅');
      return new Promise(resolve => { reads.push({ resolve }); });
    },
    dispatch: async () => ({ ok: false, error: { code: 'INTERNAL', message: '未实现' } }),
    subscribeProject: (_projectId, listener) => {
      receive = listener;
      return () => { unsubscribed = true; };
    },
  };
  const store = new ProjectProjectionStore({ projectId: 'project', bridge });
  let publications = 0;
  store.subscribe(() => { publications += 1; });
  const initial = store.start();
  receive?.({ type: 'project.changed', projectId: 'project', revision: 2, requestId: 'r2' });
  reads[1]!.resolve(snapshot(2));
  await new Promise<void>(resolve => setImmediate(resolve));
  reads[0]!.resolve(snapshot(1));
  await initial;
  assert.equal(store.getSnapshot()?.revision, 2);
  assert.equal(publications, 1);
  assert.ok(Object.isFrozen(store.getSnapshot()?.document.assets));
  assert.throws(() => { (store.getSnapshot()?.document.assets.asset?.metadata as Record<string, unknown>).changed = true; });
  const late = store.refresh();
  store.dispose();
  reads[2]!.resolve(snapshot(3));
  await late;
  assert.equal(unsubscribed, true);
  assert.equal(publications, 1);
  assert.equal(store.getSnapshot()?.revision, 2);
  assert.throws(() => store.subscribe(() => {}), /dispose/);
});

test('ActionClient 保留显式身份与版本，冲突只提交一次，不自动重试', async () => {
  const sent: ActionEnvelope[] = [];
  const failure: ActionResult = { ok: false, requestId: 'request', error: { code: 'REVISION_CONFLICT', message: '请刷新项目' } };
  const bridge: DesktopBridge = {
    readProject: async () => snapshot(),
    subscribeProject: () => () => {},
    dispatch: async action => { sent.push(action); return failure; },
  };
  const result = await new ActionClient(bridge).execute({
    requestId: 'request', projectId: 'project', expectedRevision: 7,
    type: 'item.move', payload: jsonView({ itemId: 'item', startTick: 500 }),
  });
  assert.deepEqual(result, failure);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.requestId, 'request');
  assert.equal(sent[0]?.expectedRevision, 7);
  assert.deepEqual(sent[0]?.payload, { itemId: 'item', startTick: 500 });
});
