import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeepReadonly, ProjectSnapshot } from '../src/contracts.js';
import type { ContextActionContext, DragContext } from '../src/frontend.js';
import { modelRegistry } from '../src/models.js';
import { timelineRegistry } from '../src/timeline-catalog.js';
import { createInteractionHost, declarationForTimeline } from '../web/interaction.js';

function referenceProject(modelId = 'alibaba/wan-3.0', referenceMode = 'reference'): ProjectSnapshot {
  const plugin = modelRegistry.createPlugin(modelId);
  const timeline = plugin.createTimeline({ id: 'timeline', modelId, ticksPerSecond: 1000, settings: {} });
  const item = plugin.createItem({
    timeline, id: 'item', startTick: 0, durationTicks: 5000,
    params: modelId === 'alibaba/wan-3.0' ? { referenceMode } : {}, generationToken: 'input:1',
  });
  timeline.itemIds.push(item.id);
  return {
    revision: 0,
    document: {
      schemaVersion: 1, id: 'project', title: 'Pixel',
      timelines: { timeline }, items: { item },
      assets: {
        image: { id: 'image', kind: 'image', fileRef: 'media:image', metadata: {} },
        second: { id: 'second', kind: 'image', fileRef: 'media:second', metadata: {} },
        third: { id: 'third', kind: 'image', fileRef: 'media:third', metadata: {} },
        fourth: { id: 'fourth', kind: 'image', fileRef: 'media:fourth', metadata: {} },
        audio: { id: 'audio', kind: 'audio', fileRef: 'media:audio', metadata: {} },
      },
    },
  };
}

function referenceDrop(project: ProjectSnapshot, assetId = 'image', scopeId?: string): DragContext {
  return {
    project: project as unknown as DeepReadonly<ProjectSnapshot>,
    source: { role: 'asset', payload: { object: { kind: 'asset', projectId: 'project', id: assetId } } },
    target: { role: 'item.reference', object: { kind: 'item', projectId: 'project', id: 'item' }, data: {} },
    ...(scopeId === undefined ? {} : { scopeId }),
  };
}

function interaction() {
  return createInteractionHost('project', () => timelineRegistry.query({ limit: 20 }).items, () => []);
}

test('Wan first-frame reference drag obeys the single-image limit before submitting an Action', () => {
  const host = interaction();
  const project = referenceProject('alibaba/wan-3.0', 'firstFrame');
  assert.deepEqual(host.drag.drop(referenceDrop(project)), {
    type: 'item.reference.add', payload: { assetId: 'image', itemId: 'item' },
  });
  // Hover remains a preview: it must not insert the accepted image itself.
  assert.equal(project.document.items.item!.referenceAssetIds.length, 0);
  project.document.items.item!.referenceAssetIds.push('image');
  const secondImage = referenceDrop(project, 'second');
  assert.deepEqual(host.drag.hover(secondImage), { status: 'disabled', reason: '参考素材数量已达上限' });
  assert.equal(host.drag.drop(secondImage), undefined);

  // Changing the object's mode changes the available relationship immediately.
  project.document.items.item!.params.referenceMode = 'reference';
  assert.equal(host.drag.hover(secondImage).status, 'available');
  project.document.items.item!.referenceAssetIds.push('second', 'third');
  assert.equal(host.drag.drop(referenceDrop(project, 'fourth')), undefined);
});

test('reference applicability rejects audio models, incompatible media and repeated assets', () => {
  const host = interaction();
  for (const modelId of ['eleven_v4', 'eleven_text_to_sound_v2', 'music_v2_5']) {
    const context = referenceDrop(referenceProject(modelId));
    assert.deepEqual(host.drag.hover(context), { status: 'disabled', reason: '该时间线不支持这种参考素材' });
    assert.equal(host.drag.drop(context), undefined);
  }
  const project = referenceProject('x-ai/grok-imagine-image-2.0');
  assert.equal(host.drag.hover(referenceDrop(project)).status, 'available');
  assert.equal(host.drag.drop(referenceDrop(project, 'audio')), undefined);
  project.document.items.item!.referenceAssetIds.push('image');
  assert.deepEqual(host.drag.hover(referenceDrop(project)), { status: 'disabled', reason: '素材已被引用' });
  assert.equal(host.drag.drop(referenceDrop(project)), undefined);
});

test('reference creation retains one semantic route across object views and rejects a second GUI entry', () => {
  const host = interaction();
  assert.equal(host.paths.getPath('item.reference.add'), 'drag:asset->item.reference');
  assert.throws(() => host.menu.register({
    id: 'add-reference', title: '添加引用', actionType: 'item.reference.add', targetKinds: ['item'],
    availability: () => ({ status: 'available' }), buildPayload: () => ({ itemId: 'item', assetId: 'image' }),
  }), /已绑定 GUI 路径/);
  assert.throws(() => host.drag.register({
    sourceRole: 'asset', targetRole: 'field.reference', actionType: 'item.reference.add',
    preview: () => ({ status: 'available' }), buildPayload: () => ({ itemId: 'item', assetId: 'image' }),
  }), /已绑定 GUI 路径/);
  assert.deepEqual(host.drag.drop(referenceDrop(referenceProject())), {
    type: 'item.reference.add', payload: { assetId: 'image', itemId: 'item' },
  });
});

test('only the top detail scope can create a reference and background becomes available after return', () => {
  const host = interaction();
  const project = referenceProject();
  const frame = host.navigator.open({ kind: 'item', projectId: 'project', id: 'item' });
  const background = referenceDrop(project);
  const itemDetails = referenceDrop(project, 'image', frame.scopeId);
  assert.equal(host.drag.hover(background).status, 'hidden');
  assert.equal(host.drag.drop(background), undefined);
  assert.equal(host.drag.drop(itemDetails)?.type, 'item.reference.add');
  host.navigator.push({ kind: 'asset', projectId: 'project', id: 'image' });
  assert.equal(host.drag.hover(itemDetails).status, 'hidden');
  assert.equal(host.drag.drop(itemDetails), undefined);
  host.navigator.pop();
  assert.equal(host.drag.drop(itemDetails)?.type, 'item.reference.add');
  host.navigator.reset();
  assert.equal(host.drag.drop(background)?.type, 'item.reference.add');
});

test('a model-native draft can start an empty Timeline only from an explicit time-position context', () => {
  const host = interaction();
  const project = referenceProject();
  project.document.timelines.timeline!.itemIds = [];
  project.document.items = {};
  project.document.assets = {};
  const timeline: ContextActionContext = {
    project, target: { kind: 'timeline', projectId: 'project', id: 'timeline' },
  };
  assert.equal(host.menu.commandFor('item.createDraft', timeline), undefined);
  const position: ContextActionContext = { ...timeline, data: { role: 'timeline.position', startTick: 3500 } };
  assert.deepEqual(host.menu.commandFor('item.createDraft', position), {
    type: 'item.createDraft', payload: { timelineId: 'timeline', startTick: 3500 },
  });
  assert.deepEqual(project.document.items, {});
  assert.deepEqual(project.document.timelines.timeline!.itemIds, []);
  for (const data of [{ role: 'timeline.position', startTick: -1 }, { role: 'timeline.position', startTick: 1.5 }, { role: 'timeline.position', startTick: '3500' }, { role: 'timeline.settings', startTick: 3500 }]) {
    assert.equal(host.menu.commandFor('item.createDraft', { ...timeline, data }), undefined);
  }
  assert.equal(host.menu.commandFor('item.createDraft', { ...position, target: { kind: 'project', projectId: 'project' } }), undefined);
});

test('native draft creation and existing-asset placement have separate single GUI routes', () => {
  const host = interaction();
  assert.equal(host.paths.getPath('item.createDraft'), 'context:item.createDraft');
  assert.equal(host.paths.getPath('item.create'), 'drag:asset->timeline.position');
  const project = referenceProject('x-ai/grok-imagine-image-2.0');
  assert.deepEqual(host.drag.drop({
    project,
    source: { role: 'asset', payload: { object: { kind: 'asset', projectId: 'project', id: 'image' } } },
    target: { role: 'timeline.position', object: { kind: 'timeline', projectId: 'project', id: 'timeline' }, data: { startTick: 8000 } },
  }), { type: 'item.create', payload: { assetId: 'image', timelineId: 'timeline', startTick: 8000 } });
  for (const actionType of ['item.createDraft', 'item.create']) {
    assert.throws(() => host.menu.register({
      id: `another-${actionType}`, title: '另一个入口', actionType, targetKinds: ['timeline'],
      availability: () => ({ status: 'available' }), buildPayload: () => ({ timelineId: 'timeline', startTick: 0 }),
    }), /已绑定 GUI 路径/);
  }
});

test('native draft creation rejects background and former detail scopes', () => {
  const host = interaction();
  const project = referenceProject();
  const context: ContextActionContext = {
    project, target: { kind: 'timeline', projectId: 'project', id: 'timeline' }, data: { role: 'timeline.position', startTick: 10000 },
  };
  assert.equal(host.menu.commandFor('item.createDraft', context)?.type, 'item.createDraft');
  const frame = host.navigator.open({ kind: 'timeline', projectId: 'project', id: 'timeline' });
  assert.equal(host.menu.commandFor('item.createDraft', context), undefined);
  const scoped = { ...context, scopeId: frame.scopeId };
  assert.equal(host.menu.commandFor('item.createDraft', scoped)?.type, 'item.createDraft');
  host.navigator.push({ kind: 'asset', projectId: 'project', id: 'image' });
  assert.equal(host.menu.commandFor('item.createDraft', scoped), undefined);
  host.navigator.pop();
  assert.equal(host.menu.commandFor('item.createDraft', scoped)?.type, 'item.createDraft');
  host.navigator.reset();
  assert.equal(host.menu.commandFor('item.createDraft', context)?.type, 'item.createDraft');
});

test('local text uses the same creation/edit relationships and does not acquire generation or media actions',()=>{
  const host=interaction();const project=referenceProject();
  const plugin=timelineRegistry.createPlugin('pixel.text');
  const timeline=plugin.createTimeline({id:'text',ticksPerSecond:1000,settings:{}});
  const item=plugin.createItem({timeline,id:'note',startTick:0,durationTicks:5000,params:{text:'镜头参考'},generationToken:'text:1'});
  timeline.itemIds.push(item.id);project.document.timelines[timeline.id]=timeline;project.document.items[item.id]=item;
  const context:ContextActionContext={project,target:{kind:'item',projectId:'project',id:item.id}};
  assert.deepEqual(host.menu.list(context).map(action=>action.id),['item.duplicate','item.delete']);
  const position:ContextActionContext={project,target:{kind:'timeline',projectId:'project',id:timeline.id},data:{role:'timeline.position',startTick:1500}};
  assert.equal(host.menu.commandFor('item.createDraft',position)?.type,'item.createDraft');
  assert.equal(host.menu.commandFor('timeline.refreshDefaults',{...position,data:{}}),undefined);
  assert.equal(host.drag.drop({project,source:{role:'asset',payload:{object:{kind:'asset',projectId:'project',id:'image'}}},target:{role:'timeline.position',object:position.target,data:{startTick:0}}}),undefined);
  assert.equal(host.drag.drop({project,source:{role:'item',payload:{object:{kind:'item',projectId:'project',id:item.id}}},target:{role:'asset-library',object:{kind:'project',projectId:'project'},data:{}}}),undefined);
});

test('disk media import and placement use one registry, enforce local type and detail scope, and carry no File or path',()=>{
  const host=interaction();const project=referenceProject();
  const source:DragContext['source']={role:'external.media',payload:{object:{kind:'project',projectId:'project'},kind:'image'}};
  const blank:DragContext={project,source,target:{role:'timeline.position',object:{kind:'project',projectId:'project'},data:{startTick:0}}};
  assert.deepEqual(host.drag.drop(blank),{type:'media.placeExternal',payload:{startTick:0}});
  assert.equal(host.paths.getPath('media.placeExternal'),'drag:external.media->timeline.position');
  const library:DragContext={...blank,target:{role:'asset-library',object:{kind:'project',projectId:'project'},data:{}}};
  assert.deepEqual(host.drag.drop(library),{type:'asset.import',payload:{}});
  assert.equal(host.paths.getPath('asset.import'),'drag:external.media->asset-library');
  const plugin=timelineRegistry.createPlugin('pixel.image.local');
  const local=plugin.createTimeline({id:'local',ticksPerSecond:1000,settings:{}});project.document.timelines.local=local;
  const placement:DragContext={...blank,target:{role:'timeline.position',object:{kind:'timeline',projectId:'project',id:'local'},data:{startTick:5000}}};
  assert.deepEqual(host.drag.drop(placement),{type:'media.placeExternal',payload:{timelineId:'local',startTick:5000}});
  assert.equal(host.drag.drop({...placement,source:{role:'external.media',payload:{object:{kind:'project',projectId:'project'},kind:'audio'}}}),undefined);
  assert.equal(host.drag.drop({...placement,target:{...placement.target,object:{kind:'timeline',projectId:'project',id:'timeline'}}}),undefined);
  assert.equal(host.drag.drop({...blank,target:{...blank.target,data:{startTick:-1}}}),undefined);
  assert.equal(host.drag.drop({...library,source:{role:'external.media',payload:{object:{kind:'project',projectId:'foreign'},kind:'image'}}}),undefined);
  host.navigator.open({kind:'item',projectId:'project',id:'item'});
  assert.equal(host.drag.hover(blank).status,'hidden');assert.equal(host.drag.drop(library),undefined);
});

test('edge resizing accepts only its own item and a safe positive tick interval',()=>{
  const host=interaction();const project=referenceProject();
  project.document.items.other={...structuredClone(project.document.items.item!),id:'other'};
  const context:DragContext={project,source:{role:'item.duration',payload:{object:{kind:'item',projectId:'project',id:'item'},edge:'end'}},target:{role:'item.edge',object:{kind:'item',projectId:'project',id:'item'},data:{startTick:0,durationTicks:6000}}};
  assert.equal(host.drag.drop(context)?.type,'item.resize');
  assert.equal(host.drag.drop({...context,target:{...context.target,object:{kind:'item',projectId:'project',id:'other'}}}),undefined);
  for(const data of [{startTick:-1,durationTicks:6000},{startTick:0,durationTicks:0},{startTick:0.5,durationTicks:6000},{startTick:Number.MAX_SAFE_INTEGER,durationTicks:6000}])assert.equal(host.drag.drop({...context,target:{...context.target,data}}),undefined);
});

test('valid persisted model aliases resolve catalog fields without rewriting project data',()=>{
  const project=referenceProject('eleven_text_to_sound_v2');
  const timeline=project.document.timelines.timeline!;
  timeline.modelId='eleven_text_sound_v2';
  const unchanged=structuredClone(project);
  const declaration=declarationForTimeline(timelineRegistry.query({limit:20}).items,timeline);
  assert.equal(declaration?.modelId,'eleven_text_to_sound_v2');
  assert.equal(declaration?.capabilities.generation,true);
  assert.equal(declaration?.fields.some(field=>field.key==='text'),true);
  assert.equal(interaction().menu.commandFor('generation.submit',{project,target:{kind:'item',projectId:'project',id:'item'}})?.type,'generation.submit');
  assert.deepEqual(project,unchanged);
});
