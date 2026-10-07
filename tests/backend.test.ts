import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { ActionExecutor, ActionRegistry, BaseActionHandler, MemoryProjectRepository, MoveItemHandler } from '../src/backend.js';
import type { ProjectDocument } from '../src/contracts.js';
import { exampleCaller, exampleProject } from '../examples/fixture.js';

function setup() {
  const repository = new MemoryProjectRepository([exampleProject()]);
  const registry = new ActionRegistry();
  registry.register(new MoveItemHandler());
  const events: unknown[] = [];
  const executor = new ActionExecutor(repository, registry, event => events.push(event));
  return { repository, registry, executor, events };
}
const move = (requestId = 'request_1', startTick = 2000) => ({
  requestId, projectId: 'project_demo', expectedRevision: 0,
  type: 'item.move', payload: { itemId: 'item_1', startTick },
});

test('相同请求重放不重复提交或通知；幂等键不能改用其他参数', async () => {
  const { executor, repository, events } = setup();
  const first = await executor.execute(move(), exampleCaller);
  assert.deepEqual(await executor.execute(move(), exampleCaller), first);
  const reused = await executor.execute(move('request_1', 3000), exampleCaller);
  assert.equal(reused.ok, false);
  if (!reused.ok) assert.equal(reused.error.code, 'REQUEST_ID_REUSED');
  assert.equal((await repository.read('project_demo')).revision, 1);
  assert.equal(repository.history('project_demo').length, 1);
  assert.equal(events.length, 1);
});

test('两个入口并发使用同一 revision，只有一次提交成功', async () => {
  const { executor, repository } = setup();
  const results = await Promise.all([executor.execute(move('gui'), exampleCaller), executor.execute(move('agent'), { ...exampleCaller, source: 'agent' })]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok)?.error.code, 'REVISION_CONFLICT');
  assert.equal((await repository.read('project_demo')).revision, 1);
});

test('授权由可信上下文提供，项目作用域及幂等重放都重新检查权限', async () => {
  const { executor } = setup();
  const unauthorizedProject = await executor.execute(move(), { ...exampleCaller, projectIds: new Set() });
  assert.equal(!unauthorizedProject.ok && unauthorizedProject.error.code, 'FORBIDDEN');
  await executor.execute(move(), exampleCaller);
  const unauthorizedReplay = await executor.execute(move(), { ...exampleCaller, permissions: new Set() });
  assert.equal(!unauthorizedReplay.ok && unauthorizedReplay.error.code, 'FORBIDDEN');
  const forged = await executor.execute({ ...move(), permissions: ['project.edit'] }, exampleCaller);
  assert.equal(!forged.ok && forged.error.code, 'INVALID_INPUT');
});

test('业务校验失败后 draft 丢弃，项目和历史保持原样', async () => {
  class BrokenHandler extends BaseActionHandler<null> {
    readonly type = 'test.broken';
    readonly permission = 'project.edit';
    readonly payloadSchema = z.null();
    protected mutate(document: ProjectDocument) {
      document.title = '不应该提交';
      document.items.item_1!.durationTicks = -1;
      return {};
    }
  }
  const { executor, registry, repository } = setup();
  registry.register(new BrokenHandler());
  const result = await executor.execute({ ...move(), type: 'test.broken', payload: null }, exampleCaller);
  assert.equal(result.ok, false);
  assert.deepEqual(await repository.read('project_demo'), exampleProject());
  assert.equal(repository.history('project_demo').length, 0);
});

test('通知失败不把成功提交变为失败；read 返回隔离副本', async () => {
  const { repository, registry } = setup();
  const executor = new ActionExecutor(repository, registry, () => { throw new Error('投影离线'); });
  assert.equal((await executor.execute(move(), exampleCaller)).ok, true);
  const copy = await repository.read('project_demo');
  copy.document.title = '外部修改';
  assert.equal((await repository.read('project_demo')).document.title, 'Pixel 示例项目');
});

test('继承属性名称不能被当成已存在的 Item ID', async () => {
  const { executor, repository } = setup();
  const action = move();
  action.payload.itemId = 'toString';
  const result = await executor.execute(action, exampleCaller);
  assert.equal(!result.ok && result.error.code, 'NOT_FOUND');
  assert.equal((await repository.read('project_demo')).revision, 0);
});
