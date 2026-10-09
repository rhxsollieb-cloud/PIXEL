import type { DeepReadonly, GenerationJob, JsonObject, ProjectSnapshot, TimelineData } from '../src/contracts.js';
import { ContextActionRegistry, DragRegistry, GuiActionPathRegistry, ModalNavigator, type ContextActionContext } from '../src/frontend.js';
import { referenceLimit, type TimelineDeclaration } from '../src/timeline-catalog.js';

/** A local timeline has no provider model ID; both kinds use one semantic catalog. */
export function declarationForTimeline(declarations: readonly TimelineDeclaration[], timeline: DeepReadonly<TimelineData> | undefined): TimelineDeclaration | undefined {
  if (!timeline) return undefined;
  return declarations.find(declaration => declaration.mode === 'local'
    ? !timeline.modelId && declaration.pluginId === timeline.pluginId
    : Boolean(timeline.modelId) && (declaration.modelId === timeline.modelId || (declaration.aliases ?? []).includes(timeline.modelId!)));
}

export function createInteractionHost(projectId: string, getTypes: () => readonly TimelineDeclaration[], getJobs: () => readonly GenerationJob[]) {
  const navigator = new ModalNavigator(projectId);
  const paths = new GuiActionPathRegistry();
  const menu = new ContextActionRegistry({ paths, navigator });
  const drag = new DragRegistry({ paths, navigator });
  const modelFor = (snapshot: DeepReadonly<ProjectSnapshot>, itemId: string) => {
    const item = snapshot.document.items[itemId];
    return declarationForTimeline(getTypes(), snapshot.document.timelines[item?.timelineId ?? '']);
  };
  const jobFor = (itemId: string) => getJobs().filter(job => job.request.targetItemId === itemId).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
  const busy = (itemId: string) => ['queued','running','cancelRequested'].includes(jobFor(itemId)?.state ?? '');
  const parentItem = () => [...navigator.getPath()].reverse().find(frame => frame.object.kind === 'item')?.object;
  const positionTick = (context: ContextActionContext): number | undefined => {
    if (context.target.kind !== 'timeline' || context.data?.role !== 'timeline.position') return undefined;
    const tick = context.data.startTick;
    return typeof tick === 'number' && Number.isSafeInteger(tick) && tick >= 0 ? tick : undefined;
  };
  const definitions = [
    { id: 'timeline.create', title: '新建时间线', kinds: ['project'] as const, payload: () => ({}) },
    { id: 'item.createDraft', title: '新建生成草稿', kinds: ['timeline'] as const, payload: (c: ContextActionContext) => ({ timelineId: 'id' in c.target ? c.target.id : '', startTick: positionTick(c)! }) },
    { id: 'timeline.refreshDefaults', title: '刷新时间轴默认配置', kinds: ['timeline'] as const, payload: (c: ContextActionContext) => ({ timelineId: 'id' in c.target ? c.target.id : '' }) },
    { id: 'timeline.delete', title: '删除时间线', kinds: ['timeline'] as const, payload: (c: ContextActionContext) => ({ timelineId: 'id' in c.target ? c.target.id : '' }) },
    { id: 'generation.submit', title: '生成片段', kinds: ['item'] as const, payload: (c: ContextActionContext) => ({ itemId: 'id' in c.target ? c.target.id : '' }) },
    { id: 'generation.cancel', title: '取消当前生成', kinds: ['item'] as const, payload: (c: ContextActionContext) => ({ jobId: jobFor('id' in c.target ? c.target.id : '')?.id ?? '' }) },
    { id: 'generation.resume', title: '继续中断任务', kinds: ['item'] as const, payload: (c: ContextActionContext) => ({ jobId: jobFor('id' in c.target ? c.target.id : '')?.id ?? '' }) },
    { id: 'item.duplicate', title: '复制片段', kinds: ['item'] as const, payload: (c: ContextActionContext) => ({ itemId: 'id' in c.target ? c.target.id : '' }) },
    { id: 'item.delete', title: '删除片段', kinds: ['item'] as const, payload: (c: ContextActionContext) => ({ itemId: 'id' in c.target ? c.target.id : '' }) },
    { id: 'asset.remove', title: '移除素材', kinds: ['asset'] as const, payload: (c: ContextActionContext) => ({ assetId: 'id' in c.target ? c.target.id : '' }) },
    { id: 'item.reference.remove', title: '解除素材引用', kinds: ['asset'] as const, payload: (c: ContextActionContext) => ({ assetId: 'id' in c.target ? c.target.id : '', itemId: parentItem() && 'id' in parentItem()! ? (parentItem() as {id:string}).id : '' }) },
  ];
  for (const definition of definitions) menu.register({
    id: definition.id, title: definition.title, actionType: definition.id, targetKinds: definition.kinds,
    availability(context) {
      const id = 'id' in context.target ? context.target.id : '';
      const declaration = context.target.kind === 'timeline'
        ? declarationForTimeline(getTypes(), context.project.document.timelines[id])
        : context.target.kind === 'item' ? modelFor(context.project, id) : undefined;
      if (['timeline','item'].includes(context.target.kind) && !declaration?.supportedActions.includes(definition.id)) return { status: 'hidden' };
      if (definition.id === 'item.createDraft') {
        return positionTick(context) !== undefined && declaration?.supportedActions.includes(definition.id) ? { status: 'available' } : { status: 'hidden' };
      }
      if (definition.id === 'timeline.refreshDefaults') return !declaration?.supportedActions.includes(definition.id) || context.data?.role === 'timeline.position' || context.scopeId ? { status: 'hidden' } : { status: 'available' };
      if (definition.id.startsWith('generation.') && !declaration?.capabilities.generation) return { status: 'hidden' };
      if (definition.id === 'generation.cancel') return busy(id) ? { status: 'available' } : { status: 'hidden' };
      if (definition.id === 'generation.resume') return jobFor(id)?.state === 'interrupted' ? { status: 'available' } : { status: 'hidden' };
      if (definition.id === 'generation.submit' && busy(id)) return { status: 'disabled', reason: '当前片段正在生成' };
      if (definition.id === 'item.reference.remove') {
        const parent = parentItem();
        if (!parent || !('id' in parent) || !context.scopeId || !context.project.document.items[parent.id]?.referenceAssetIds.includes(id)) return { status: 'hidden' };
      }
      if (definition.id === 'asset.remove' && Object.values(context.project.document.items).some(item => item.outputAssetId === id || item.referenceAssetIds.includes(id))) return { status: 'disabled', reason: '素材仍被片段使用' };
      return { status: 'available' };
    },
    buildPayload: context => definition.payload(context) as JsonObject,
  });
  drag.register({ sourceRole: 'item', targetRole: 'timeline.position', actionType: 'item.move',
    preview: ({source,target,project}) => project.document.items[source.payload.object.id]?.timelineId === ('id' in target.object ? target.object.id : '') ? { status: 'available' } : {status:'disabled',reason:'片段只能在当前时间线内移动'},
    buildPayload: ({source,target}) => ({itemId:source.payload.object.id,startTick:Number(target.data.startTick)}),
  });
  drag.register({ sourceRole: 'item.duration', targetRole: 'item.edge', actionType: 'item.resize',
    preview: ({source,target}) => {
      const start=target.data.startTick;const duration=target.data.durationTicks;
      return source.payload.object.id === ('id' in target.object?target.object.id:'') && typeof start==='number' && Number.isSafeInteger(start) && start>=0 && typeof duration==='number' && Number.isSafeInteger(duration) && duration>0 && Number.isSafeInteger(start+duration)
        ? {status:'available'} : {status:'disabled',reason:'片段边缘与时间范围不匹配'};
    },
    buildPayload: ({source,target}) => ({itemId:source.payload.object.id,startTick:Number(target.data.startTick),durationTicks:Number(target.data.durationTicks)}),
  });
  drag.register({ sourceRole: 'asset', targetRole: 'timeline.position', actionType: 'item.create',
    preview: ({source,target,project}) => {
      const model = declarationForTimeline(getTypes(), project.document.timelines['id' in target.object ? target.object.id : '']);
      return model?.capabilities.mediaPlacement && model.outputKind === project.document.assets[source.payload.object.id]?.kind ? {status:'available'} : {status:'disabled',reason:'素材类型与时间线不兼容'};
    },
    buildPayload: ({source,target}) => ({assetId:source.payload.object.id,timelineId:'id' in target.object ? target.object.id:'',startTick:Number(target.data.startTick)}),
  });
  drag.register({ sourceRole:'asset',targetRole:'item.reference',actionType:'item.reference.add',
    preview: ({source,target,project}) => {
      const itemId = 'id' in target.object ? target.object.id : '';
      const item = project.document.items[itemId]; const asset = project.document.assets[source.payload.object.id]; const model=modelFor(project,itemId);
      if (!model?.capabilities.references || !asset || model.maxReferences < 1 || !model.referenceKinds.includes(asset.kind)) return {status:'disabled',reason:'该时间线不支持这种参考素材'};
      if (item?.referenceAssetIds.includes(asset.id)) return {status:'disabled',reason:'素材已被引用'};
      const maximum = referenceLimit(model, item?.params ?? {});
      if ((item?.referenceAssetIds.length ?? 0) >= maximum) return {status:'disabled',reason:'参考素材数量已达上限'};
      return {status:'available'};
    },
    buildPayload: ({source,target}) => ({assetId:source.payload.object.id,itemId:'id' in target.object ? target.object.id:''}),
  });
  drag.register({sourceRole:'item',targetRole:'asset-library',actionType:'asset.saveFromItem',
    preview: ({source,project}) => project.document.items[source.payload.object.id]?.outputAssetId ? {status:'available'} : {status:'disabled',reason:'片段还没有可保存的输出'},
    buildPayload: ({source}) => ({itemId:source.payload.object.id}),
  });
  drag.register({sourceRole:'external.media',targetRole:'timeline.position',actionType:'media.placeExternal',
    preview:({source,target,project})=>{
      const tick=target.data.startTick;
      if(typeof tick!=='number'||!Number.isSafeInteger(tick)||tick<0)return{status:'disabled',reason:'媒体放置位置无效'};
      if(target.object.kind==='project')return{status:'available'};
      const declaration=declarationForTimeline(getTypes(),project.document.timelines['id' in target.object?target.object.id:'']);
      if(declaration?.mode!=='local'||!declaration.capabilities.mediaPlacement)return{status:'disabled',reason:'请将媒体拖入普通媒体时间线或时间线空白处'};
      return source.role==='external.media'&&source.payload.kind===declaration.outputKind?{status:'available'}:{status:'disabled',reason:'素材类型与时间线不兼容'};
    },
    buildPayload:({target})=>({startTick:Number(target.data.startTick),...(target.object.kind==='timeline'?{timelineId:target.object.id}:{})}),
  });
  drag.register({sourceRole:'external.media',targetRole:'asset-library',actionType:'asset.import',
    preview:()=>({status:'available'}),buildPayload:()=>({}),
  });
  for(const [action,path] of [['item.params','field:item'],['timeline.settings','field:timeline'],['timeline.defaults','field:timeline-defaults'],['project.title','field:project'],['project.open','drag:external-project->workspace']]) paths.claim(action!,path!);
  return {navigator,paths,menu,drag};
}
