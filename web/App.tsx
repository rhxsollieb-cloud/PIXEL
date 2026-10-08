import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { AssetData, DeepReadonly, GenerationJob, JsonObject, JsonValue, ObjectRef, TimelineItemData } from '../src/contracts.js';
import { ActionClient, ProjectProjectionStore, type DragSource, type DragTarget } from '../src/frontend.js';
import type { ModelDeclaration } from '../src/models.js';
import type { PluginFieldDeclaration } from '../src/plugins.js';
import { HttpDesktopBridge, assetUrl } from './bridge.js';
import { initialDetailObject, initialDetailView } from './desktop.js';
import { createInteractionHost } from './interaction.js';
import { clampPlaybackMs, itemAtPlaybackTime, playbackTimeLabel, sourcePlaybackSeconds } from './playback.js';
import { atPath, defaultFromSchema, FieldEditor, fieldLabel, schemaAtPath, withPath, type FieldPath } from './fields.js';
import { PixelBadge, PixelContextMenu, PixelEmpty, PixelField, PixelIcon, PixelInput, PixelModalHost, PixelPanel, PixelProgress, type PixelContextMenuItem } from './ui/index.js';

const PROJECT_ID = 'pixel-project';
const MIME = 'application/x-pixel-object';
const PX_PER_SECOND = 32;
const stateTitles: Record<string,string> = {queued:'排队中',running:'正在生成',cancelRequested:'正在取消',canceled:'已取消',succeeded:'已完成',failed:'生成失败',interrupted:'等待恢复'};
function time(seconds: number): string { return `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(Math.floor(seconds % 60)).padStart(2,'0')}`; }
function positionTick(clientX:number,left:number,ticksPerSecond:number,offsetTicks=0):number {
  const grid=ticksPerSecond/2;
  return Math.max(0,Math.round(((clientX-left)/PX_PER_SECOND*ticksPerSecond-offsetTicks)/grid)*grid);
}
function shortModel(model: ModelDeclaration | undefined): string {
  if (!model) return '未知模型';
  return ({'alibaba/wan-3.0':'Wan 3.0','x-ai/grok-imagine-image-2.0':'Grok Image 2.0',music_v2_5:'Music v2.5',eleven_v4:'Eleven v4',eleven_text_to_sound_v2:'Sound Effects v2'} as Record<string,string>)[model.modelId] ?? model.title;
}
function iconFor(kind: string): string { return kind === 'video'?'frames':kind === 'image'?'image':kind.includes('speech')?'voice':'music'; }
function itemTitle(item: DeepReadonly<TimelineItemData>): string { return String(item.params.prompt || item.params.text || (item.kind.includes('speech')?'未填写的对白':'新的创作片段')); }
function MediaPreview({asset,large = false,seekSeconds,scrubbing}: {asset:DeepReadonly<AssetData>;large?:boolean;seekSeconds?:number | undefined;scrubbing?:boolean | undefined}) {
  const ref = useRef<HTMLMediaElement | null>(null);
  const synchronize = () => {
    const media = ref.current;
    if (!media || seekSeconds === undefined) return;
    media.pause();
    if (media.readyState < 1) return;
    const target = Number.isFinite(media.duration) ? Math.min(seekSeconds, media.duration) : seekSeconds;
    if (Number.isFinite(target)) media.currentTime = Math.max(0, target);
  };
  useEffect(synchronize, [asset.id, seekSeconds, scrubbing]);
  const play = () => {
    const media=ref.current;
    if (!media) return;
    if(media.paused) void media.play().catch(()=>{}); else media.pause();
  };
  if(asset.kind === 'image') return <img className={large?'media-large':'media-thumb'} src={assetUrl(asset.id)} alt={String(asset.metadata.name ?? '作品图像')}/>;
  return <div className={`media-playback ${large?'media-playback--large':''}`} tabIndex={0} role="group" aria-label="媒体预览，按空格播放或暂停"
    onKeyDown={event=>{if(event.key===' '){event.preventDefault();play();}}}>
    {asset.kind === 'video' ? <video ref={element=>{ref.current=element;}} src={assetUrl(asset.id)} preload="metadata" onLoadedMetadata={synchronize}/>
      : <><audio ref={element=>{ref.current=element;}} src={assetUrl(asset.id)} preload="metadata" onLoadedMetadata={synchronize}/><PixelIcon name="music"/></>}

  </div>;
}

export function App() {
  const desktop = window.pixelDesktop;
  const detailMode = desktop?.isDetailWindow === true;
  const [models,setModels] = useState<ModelDeclaration[]>([]);
  const [jobs,setJobs] = useState<GenerationJob[]>([]);
  const modelsRef=useRef(models);modelsRef.current=models;
  const jobsRef=useRef(jobs);jobsRef.current=jobs;
  const [bridge]=useState(()=>new HttpDesktopBridge());
  const [store]=useState(()=>new ProjectProjectionStore({projectId:PROJECT_ID,bridge,onError:()=>setFeedback({text:'连接中断，等待重新读取项目',error:true})}));
  const [client]=useState(()=>new ActionClient(bridge));
  const [host]=useState(()=>{
    const interaction = createInteractionHost(PROJECT_ID,()=>modelsRef.current,()=>jobsRef.current);
    const object = initialDetailObject();
    if (object) interaction.navigator.open(object);
    return interaction;
  });
  const snapshot=useSyncExternalStore(listener=>store.subscribe(listener),()=>store.getSnapshot());
  const path=useSyncExternalStore(listener=>host.navigator.subscribe(listener),()=>host.navigator.getPath());
  const [pending,setPending]=useState(0);
  const [feedback,setFeedback]=useState({text:'',error:false});
  const [selected,setSelected]=useState<ObjectRef | undefined>();
  const [playheadMs,setPlayheadMs]=useState(0);
  const [scrubbing,setScrubbing]=useState(false);
  const rulerRef=useRef<HTMLDivElement | null>(null);
  const finishScrub=useRef<(()=>void) | undefined>(undefined);
  const [menu,setMenu]=useState<{x:number;y:number;items:PixelContextMenuItem[]} | undefined>();
  const [dragging,setDragging]=useState<{source:DragSource;offsetTicks:number} | undefined>();
  const [dropHint,setDropHint]=useState<{id:string;tick:number;valid:boolean} | undefined>();
  const [resize,setResize]=useState<{id:string;startTick:number;durationTicks:number} | undefined>();
  const [exportTicket,setExportTicket]=useState<{assetId:string;ticket:string} | undefined>();
  const [exportRefresh,setExportRefresh]=useState(0);
  const [fieldPaths]=useState(()=>{
    const paths=new Map<string,FieldPath>();
    const frame=host.navigator.current();
    if(frame && initialDetailView()==='library')paths.set(frame.scopeId,['$library']);
    return paths;
  });
  const current=path.at(-1);
  const document=snapshot?.document;
  const timelines=Object.values(document?.timelines ?? {});
  const selectedItem=selected?.kind==='item'?document?.items[selected.id]:undefined;
  const preferredTimelineId=selectedItem?.timelineId ?? (selected?.kind==='timeline'?selected.id:undefined);
  const previewItem=document?itemAtPlaybackTime(document,playheadMs,preferredTimelineId):undefined;
  const selectedAsset=previewItem?.outputAssetId?document?.assets[previewItem.outputAssetId]:undefined;
  const previewSeconds=previewItem?sourcePlaybackSeconds(previewItem,document?.timelines[previewItem.timelineId]?.ticksPerSecond ?? 1000,playheadMs):undefined;
  const latestJob=(itemId:string)=>jobs.filter(job=>job.request.targetItemId===itemId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  const selectedJob=selectedItem?latestJob(selectedItem.id):undefined;
  const allAssets=Object.values(document?.assets ?? {}).filter(asset=>asset.metadata.librarySaved===true);
  const seconds=Math.max(36,...Object.values(document?.items ?? {}).map(item=>(item.startTick+item.durationTicks)/(document?.timelines[item.timelineId]?.ticksPerSecond ?? 1000)+4));
  const trackWidth=Math.ceil(seconds/2)*2*PX_PER_SECOND;
  const maximumPlaybackMs=trackWidth/PX_PER_SECOND*1000;

  useEffect(()=>{setPlayheadMs(position=>clampPlaybackMs(position,maximumPlaybackMs));},[maximumPlaybackMs]);
  useEffect(()=>{if(path.length)finishScrub.current?.();},[path.length]);
  useEffect(()=>()=>{finishScrub.current?.();},[]);

  useEffect(()=>{
    if(!feedback.text || feedback.error)return;
    const timeout=window.setTimeout(()=>setFeedback({text:'',error:false}),2400);
    return ()=>window.clearTimeout(timeout);
  },[feedback]);

  useEffect(()=>{
    if (!desktop || detailMode) return;
    return desktop.onDetailsClosed(()=>{ host.navigator.reset(); setMenu(undefined); });
  },[desktop,detailMode,host]);
  useEffect(()=>{
    if (detailMode && !path.length) desktop?.close();
  },[desktop,detailMode,path.length]);
  useEffect(()=>{
    if (!desktop || detailMode || !selectedAsset) { setExportTicket(undefined); return; }
    let active = true;
    const assetId = selectedAsset.id;
    setExportTicket(undefined);
    const prepare = () => {
      void desktop.prepareExport({assetId}).then(({ticket})=>{if(active)setExportTicket({assetId,ticket});}).catch(()=>{
        if(active){setExportTicket(undefined);setFeedback({text:'输出文件尚未准备好',error:true});}
      });
    };
    prepare();
    const refresh = window.setInterval(prepare, 45_000);
    return ()=>{active=false;window.clearInterval(refresh);};
  },[desktop,detailMode,selectedAsset?.id,exportRefresh]);

  useEffect(()=>{
    const controller=new AbortController();
    let readingJobs=false;let jobsNeedRefresh=false;
    const loadJobs=async()=>{
      if(controller.signal.aborted)return;
      if(readingJobs){jobsNeedRefresh=true;return;}
      readingJobs=true;
      try{do{jobsNeedRefresh=false;const result=await bridge.jobs(controller.signal);if(!controller.signal.aborted)setJobs(result.items);}while(jobsNeedRefresh&&!controller.signal.aborted);}
      catch{}finally{readingJobs=false;}
    };
    const offJobs=bridge.onJobs(()=>{void loadJobs();});
    const offConnection=bridge.onConnection(value=>{
      if(value){
        void store.refresh().catch(()=>{});
        void bridge.models(controller.signal).then(result=>setModels(result.items)).catch(()=>{});
        setFeedback(previous=>previous.text.includes('连接')?{text:'',error:false}:previous);
      }
    });
    void store.start().catch(()=>setFeedback({text:'后端尚未连接，请使用 npm run dev 启动工作台',error:true}));
    void bridge.models(controller.signal).then(result=>setModels(result.items)).catch(()=>{});
    void loadJobs();
    return ()=>{controller.abort();offJobs();offConnection();store.dispose();bridge.close();host.menu.dispose();host.drag.dispose();};
  },[bridge,store,host]);
  useEffect(()=>{
    if(!snapshot)return;
    host.navigator.reconcile(snapshot);
    if(selected && ((selected.kind==='item'&&!Object.hasOwn(snapshot.document.items,selected.id)) || (selected.kind==='asset'&&!Object.hasOwn(snapshot.document.assets,selected.id))))setSelected(undefined);
  },[snapshot,host,selected]);

  function seekPlayback(positionMs:number) {
    if(!host.navigator.isInteractive(undefined))return;
    setPlayheadMs(clampPlaybackMs(positionMs,maximumPlaybackMs));
  }
  function scrubBegin(event:PointerEvent) {
    if(event.button!==0 || !host.navigator.isInteractive(undefined))return;
    event.preventDefault();event.stopPropagation();setMenu(undefined);
    finishScrub.current?.();
    const pointerId=event.pointerId;
    const target=event.currentTarget;
    target.setPointerCapture(pointerId);
    rulerRef.current?.focus();
    const position=(clientX:number)=>{
      const left=rulerRef.current?.getBoundingClientRect().left;
      if(left!==undefined)seekPlayback((clientX-left)/PX_PER_SECOND*1000);
    };
    const move=(moveEvent:globalThis.PointerEvent)=>{if(moveEvent.pointerId===pointerId)position(moveEvent.clientX);};
    const stop=()=>{
      window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',stop);
      if(target.hasPointerCapture(pointerId))target.releasePointerCapture(pointerId);
      finishScrub.current=undefined;setScrubbing(false);
    };
    const up=(upEvent:globalThis.PointerEvent)=>{if(upEvent.pointerId===pointerId){position(upEvent.clientX);stop();}};
    const cancel=(cancelEvent:globalThis.PointerEvent)=>{if(cancelEvent.pointerId===pointerId)stop();};
    finishScrub.current=stop;setScrubbing(true);position(event.clientX);
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);window.addEventListener('blur',stop);
  }
  function playbackKeys(event:KeyboardEvent) {
    if(!host.navigator.isInteractive(undefined))return;
    const next=event.key==='Home'?0:event.key==='End'?maximumPlaybackMs:event.key==='ArrowLeft'?playheadMs-100:event.key==='ArrowRight'?playheadMs+100:undefined;
    if(next!==undefined){event.preventDefault();event.stopPropagation();seekPlayback(next);}
  }

  async function execute(type:string,payload:JsonObject,scopeId?:string):Promise<boolean> {
    const latest=store.getSnapshot();
    if(!latest || !host.navigator.isInteractive(scopeId))return false;
    setPending(value=>value+1);
    try {
      const result=await client.execute({requestId:crypto.randomUUID(),projectId:PROJECT_ID,expectedRevision:latest.revision,type,payload});
      await store.refresh();
      if(!result.ok){setFeedback({text:result.error.message,error:true});return false;}
      setFeedback({text:type==='generation.submit'?'生成任务已提交':'已保存',error:false});
      return true;
    }catch{setFeedback({text:'本地连接中断，修改尚未确认，请检查后端状态',error:true});return false;}
    finally{setPending(value=>value-1);}
  }
  function open(object:ObjectRef,scopeId?:string,fieldPath?:FieldPath) {
    if(!host.navigator.isInteractive(scopeId))return;
    setMenu(undefined);
    const frame=scopeId?host.navigator.push(object):host.navigator.open(object);
    if(fieldPath)fieldPaths.set(frame.scopeId,fieldPath);
    if (desktop && !detailMode && !scopeId) void desktop.openDetails({object,...(fieldPath?.[0]==='$library'?{view:'library' as const}:{})}).catch(()=>{
      host.navigator.reset(); setFeedback({text:'详情窗口未能打开',error:true});
    });
  }
  function objectKeys(event:KeyboardEvent,object:ObjectRef,scopeId?:string) {
    if(event.key==='Enter'){event.preventDefault();open(object,scopeId);}
    if(event.key==='ContextMenu'||(event.key==='F10'&&event.shiftKey)){
      event.preventDefault();const box=event.currentTarget.getBoundingClientRect();contextAt(box.left+24,box.top+24,object,scopeId);
    }
  }
  function contextAt(x:number,y:number,target:ObjectRef,scopeId?:string,createOnly=false,data?:JsonObject) {
    const project=store.getSnapshot();if(!project||!host.navigator.isInteractive(scopeId))return;
    const context={target,project,...(scopeId?{scopeId}: {}),...(data?{data}:{})};
    const actions=host.menu.list(context);
    if(createOnly) {
      if(!actions.some(action=>action.id==='timeline.create'))return;
      setMenu({x,y,items:[{id:'timeline.create',label:'新建时间线',onSelect:()=>{
        setMenu({x,y,items:models.map(model=>({id:model.modelId,label:model.title,description:model.outputKind==='video'?'视频时间线':model.outputKind==='image'?'图像时间线':'音频时间线',onSelect:()=>{
          const latest=store.getSnapshot();if(!latest)return;
          const command=host.menu.commandFor('timeline.create',{...context,project:latest});if(command)void execute(command.type,{...command.payload,modelId:model.modelId},scopeId);
        }}))});
      }}]});return;
    }
    const items=actions.filter(action=>action.id!=='timeline.create').map(action=>({
      id:action.id,label:action.id==='generation.submit'&&document?.items['id' in target?target.id:'']?.outputAssetId?'重新生成':action.title,
      ...(action.availability.status==='disabled'?{description:action.availability.reason,disabled:true}:{}),
      onSelect:()=>{const latest=store.getSnapshot();if(!latest)return;const command=host.menu.commandFor(action.id,{...context,project:latest});if(command)void execute(command.type,command.payload as JsonObject,scopeId);},
    }));
    if(items.length)setMenu({x,y,items});
  }
  function context(event:React.MouseEvent,target:ObjectRef,scopeId?:string,createOnly=false,data?:JsonObject) {
    if((event.target as HTMLElement).closest('input,textarea,select'))return;
    event.preventDefault();event.stopPropagation();contextAt(event.clientX,event.clientY,target,scopeId,createOnly,data);
  }
  function viewerMenuAt(x:number,y:number) {
    if(!store.getSnapshot() || !host.navigator.isInteractive(undefined))return;
    setMenu({x,y,items:[{id:'navigate.library',label:'素材库',onSelect:()=>open(projectRef,undefined,['$library'])}]});
  }
  function beginDrag(event:DragEvent,source:DragSource,ticksPerSecond=1000,scopeId?:string) {
    if(!host.navigator.isInteractive(scopeId)){event.preventDefault();return;}
    const offsetTicks=source.role==='item'?Math.round((event.clientX-event.currentTarget.getBoundingClientRect().left)/PX_PER_SECOND*ticksPerSecond):0;
    const data={source,offsetTicks};event.dataTransfer.setData(MIME,JSON.stringify(data));event.dataTransfer.effectAllowed='copyMove';setDragging(data);setMenu(undefined);
  }
  function dragSource(event:DragEvent):{source:DragSource;offsetTicks:number}|undefined {
    if(dragging)return dragging;
    try{return JSON.parse(event.dataTransfer.getData(MIME)) as {source:DragSource;offsetTicks:number};}catch{return undefined;}
  }
  function dropContext(source:DragSource,target:DragTarget,scopeId?:string) {
    const project=store.getSnapshot();return project?{source,target,project,...(scopeId?{scopeId}: {})}:undefined;
  }
  function dragOver(event:DragEvent,target:DragTarget,scopeId?:string) {
    const source=dragging?.source;if(!source)return;
    const ctx=dropContext(source,target,scopeId);if(!ctx)return;
    const availability=host.drag.hover(ctx);
    if(availability.status==='available'){event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=source.role==='item'?'move':'copy';}
    if(target.role==='timeline.position')setDropHint({id:'id' in target.object?target.object.id:'',tick:Number(target.data.startTick),valid:availability.status==='available'});
  }
  function drop(event:DragEvent,target:DragTarget,scopeId?:string) {
    event.preventDefault();event.stopPropagation();const data=dragSource(event);setDragging(undefined);setDropHint(undefined);
    if(!data)return;const ctx=dropContext(data.source,target,scopeId);if(!ctx)return;const command=host.drag.drop(ctx);
    if(command)void execute(command.type,command.payload as JsonObject,scopeId);
  }
  function targetAt(event:DragEvent,timelineId:string):DragTarget {
    const timeline=document!.timelines[timelineId]!;
    const tick=positionTick(event.clientX,event.currentTarget.getBoundingClientRect().left,timeline.ticksPerSecond,dragging?.offsetTicks ?? 0);
    return {role:'timeline.position',object:{kind:'timeline',projectId:PROJECT_ID,id:timelineId},data:{startTick:tick}};
  }
  async function importFiles(event:DragEvent,scopeId?:string) {
    const files=Array.from(event.dataTransfer.files);if(!files.length)return;
    if(!host.navigator.isInteractive(scopeId))return;
    event.preventDefault();event.stopPropagation();setPending(value=>value+1);
    try{
      for(const file of files){const current=store.getSnapshot();if(!current)break;const result=await bridge.importFile(file,current,crypto.randomUUID());await store.refresh();
        if(!result.ok){setFeedback({text:result.error.message,error:true});break;}
        setFeedback({text:`已导入 ${file.name}`,error:false});
      }
    }catch{setFeedback({text:'素材导入未完成，请检查文件格式与本地服务',error:true});}finally{setPending(value=>value-1);}
  }
  function resizeBegin(event:PointerEvent,item:DeepReadonly<TimelineItemData>,edge:'start'|'end') {
    if(!host.navigator.isInteractive(undefined))return;
    event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);
    const origin=event.clientX;const ticks=document!.timelines[item.timelineId]!.ticksPerSecond;let preview={id:item.id,startTick:item.startTick,durationTicks:item.durationTicks};
    const move=(moveEvent:globalThis.PointerEvent)=>{
      const delta=Math.round((moveEvent.clientX-origin)/PX_PER_SECOND*2)*ticks/2;
      if(edge==='end')preview={...preview,durationTicks:Math.max(ticks/2,item.durationTicks+delta)};
      else{const start=Math.max(0,Math.min(item.startTick+item.durationTicks-ticks/2,item.startTick+delta));preview={...preview,startTick:start,durationTicks:item.startTick+item.durationTicks-start};}
      setResize(preview);
    };
    const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);setResize(undefined);
      const ctx=dropContext({role:'item.duration',payload:{object:{kind:'item',projectId:PROJECT_ID,id:item.id},edge}},{role:'item.edge',object:{kind:'item',projectId:PROJECT_ID,id:item.id},data:{startTick:preview.startTick,durationTicks:preview.durationTicks}});
      const command=ctx?host.drag.drop(ctx):undefined;if(command&&(preview.startTick!==item.startTick||preview.durationTicks!==item.durationTicks))void execute(command.type,command.payload as JsonObject);
    };
    const cancel=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);setResize(undefined);};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});window.addEventListener('pointercancel',cancel,{once:true});
  }
  const refTarget=(itemId:string):DragTarget=>({role:'item.reference',object:{kind:'item',projectId:PROJECT_ID,id:itemId},data:{}});
  const projectRef:ObjectRef={kind:'project',projectId:PROJECT_ID};

  function canReferenceDrop(itemId:string,scopeId?:string) {
    const source=dragging?.source;if(source?.role!=='asset')return false;
    const ctx=dropContext(source,refTarget(itemId),scopeId);
    return Boolean(ctx && host.drag.hover(ctx).status==='available');
  }
  function hasReferenceContext(item:DeepReadonly<TimelineItemData>,model:ModelDeclaration|undefined,scopeId?:string) {
    return Boolean(model && model.maxReferences>0 && (item.referenceAssetIds.length>0 || canReferenceDrop(item.id,scopeId)));
  }

  function library(scope:string) {
    if(!document)return null;
    const source=dragging?.source;
    const draggedAsset=source?.role==='asset'?document.assets[source.payload.object.id]:undefined;
    const outputs=Object.values(document.items).filter(item=>item.outputAssetId && document.assets[item.outputAssetId]);
    const relationTimelines=draggedAsset?timelines.filter(timeline=>{
      const model=models.find(candidate=>candidate.modelId===timeline.modelId);
      if(model?.outputKind===draggedAsset.kind)return true;
      return timeline.itemIds.some(id=>{
        const ctx=dropContext(source!,refTarget(id),scope);
        return ctx&&host.drag.hover(ctx).status==='available';
      });
    }):[];
    return <div className="details-stack" onDragEnd={()=>{setDragging(undefined);setDropHint(undefined);}}>
      <div className={`context-library ${source?.role==='item'?'context-library--target':''}`} data-testid="asset-library" data-scope-id={scope}
        onDragOver={event=>{if(event.dataTransfer.types.includes('Files')&&host.navigator.isInteractive(scope)){event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';}else dragOver(event,{role:'asset-library',object:projectRef,data:{}},scope);}}
        onDrop={event=>{if(event.dataTransfer.files.length)void importFiles(event,scope);else drop(event,{role:'asset-library',object:projectRef,data:{}},scope);}}>
        {allAssets.length?<div className="asset-grid">{allAssets.map(asset=>{
          const object:ObjectRef={kind:'asset',projectId:PROJECT_ID,id:asset.id};
          return <div key={asset.id} className="asset-card" data-testid="asset-card" data-asset-id={asset.id} tabIndex={0} role="group" draggable aria-label={String(asset.metadata.name ?? '素材')}
            onDoubleClick={()=>open(object,scope)} onKeyDown={event=>objectKeys(event,object,scope)} onContextMenu={event=>context(event,object,scope)}
            onDragStart={event=>beginDrag(event,{role:'asset',payload:{object:{kind:'asset',projectId:PROJECT_ID,id:asset.id}}},1000,scope)}>
            <div className="asset-card__preview"><MediaPreview asset={asset}/></div><p>{String(asset.metadata.name ?? '素材')}</p>
          </div>;
        })}</div>:<div className="library-empty"><p className="pixel-description">拖入素材</p></div>}
      </div>
      {draggedAsset&&relationTimelines.length>0&&<div className="relation-surface" aria-label="素材关系" data-testid="relation-surface" data-scope-id={scope}>
        {relationTimelines.map(timeline=>{
          const model=models.find(candidate=>candidate.modelId===timeline.modelId);const compatible=model?.outputKind===draggedAsset.kind;
          const timelineRef:ObjectRef={kind:'timeline',projectId:PROJECT_ID,id:timeline.id};
          return <div key={timeline.id} className="relation-row">
            <div className="relation-title" tabIndex={0} role="group" onDoubleClick={()=>open(timelineRef,scope)} onKeyDown={event=>objectKeys(event,timelineRef,scope)}>{shortModel(model)}</div>
            <div className="relation-scroll"><div className={`relation-track ${compatible?'relation-track--target':''}`} style={{width:trackWidth}} data-testid="relation-track" data-timeline-id={timeline.id} data-scope-id={scope} aria-label={`${shortModel(model)} 时间位置`} aria-disabled={!compatible}
              onDragOver={event=>{event.stopPropagation();if(compatible)dragOver(event,targetAt(event,timeline.id),scope);}}
              onDrop={event=>{event.preventDefault();event.stopPropagation();if(compatible)drop(event,targetAt(event,timeline.id),scope);}}
              onDragLeave={()=>setDropHint(undefined)}>
              <div className="relation-ruler" aria-hidden="true">{Array.from({length:Math.ceil(seconds/4)+1},(_,i)=><span key={i} style={{left:i*4*PX_PER_SECOND}}>{time(i*4)}</span>)}</div>
              {timeline.itemIds.map(id=>{
                const item=document.items[id];if(!item)return null;const itemRef:ObjectRef={kind:'item',projectId:PROJECT_ID,id};
                const acceptsReference=canReferenceDrop(id,scope);
                return <div key={id} className={`relation-item timeline-item--${model?.outputKind ?? 'video'}`} data-testid="relation-item" data-item-id={id}
                  style={{left:item.startTick/timeline.ticksPerSecond*PX_PER_SECOND,width:Math.max(48,item.durationTicks/timeline.ticksPerSecond*PX_PER_SECOND)}} tabIndex={0} role="group" aria-label={`片段 ${itemTitle(item)}`}
                  onDoubleClick={()=>open(itemRef,scope)} onKeyDown={event=>objectKeys(event,itemRef,scope)} onContextMenu={event=>context(event,itemRef,scope)}
                  onDragOver={event=>{event.stopPropagation();event.dataTransfer.dropEffect='none';}} onDrop={event=>{event.preventDefault();event.stopPropagation();}}>
                  <span className="relation-item-title">{itemTitle(item)}</span>
                  {acceptsReference&&<div className="relation-reference" data-testid="relation-reference" data-item-id={id} data-scope-id={scope} aria-label="参考素材"
                    onDragOver={event=>dragOver(event,refTarget(id),scope)} onDrop={event=>drop(event,refTarget(id),scope)}><PixelIcon name="reference"/><span>{item.referenceAssetIds.length||'参考'}</span></div>}
                  {!acceptsReference&&item.referenceAssetIds.length>0&&model&&model.maxReferences>0&&<span className="item-caption"><PixelIcon name="reference"/>{item.referenceAssetIds.length}</span>}
                </div>;
              })}
              {dropHint?.id===timeline.id&&<div className={`drop-marker ${!dropHint.valid?'drop-marker--invalid':''}`} style={{left:dropHint.tick/timeline.ticksPerSecond*PX_PER_SECOND}}/>}
            </div></div>
          </div>;
        })}
      </div>}
      {!draggedAsset&&outputs.length>0&&<div className="library-outputs"><p className="pixel-description">片段输出</p>{outputs.map(item=>{
        const object:{kind:'item';projectId:string;id:string}={kind:'item',projectId:PROJECT_ID,id:item.id};const asset=document.assets[item.outputAssetId!]!;
        return <div key={item.id} className="library-output" data-testid="reusable-item" data-item-id={item.id} tabIndex={0} role="group" draggable
          onDoubleClick={()=>open(object,scope)} onKeyDown={event=>objectKeys(event,object,scope)} onContextMenu={event=>context(event,object,scope)}
          onDragStart={event=>beginDrag(event,{role:'item',payload:{object}},document.timelines[item.timelineId]?.ticksPerSecond ?? 1000,scope)}>
          <div className="library-output-preview"><MediaPreview asset={asset}/></div><span>{itemTitle(item)}</span>
        </div>;
      })}</div>}
    </div>;
  }

  function details() {
    if(!current||!document)return null;
    const object=current.object;const scope=current.scopeId;const nestedPath=fieldPaths.get(scope) ?? [];
    if(object.kind==='project'&&nestedPath[0]==='$library')return library(scope);
    if(object.kind==='project')return <div className="details-stack">
      <PixelField label="作品名称"><TitleField title={document.title} onCommit={title=>execute('project.title',{title},scope)}/></PixelField>
    </div>;
    if(object.kind==='asset'){
      const asset=document.assets[object.id];if(!asset)return null;
      return <div className="details-stack" onContextMenu={event=>context(event,object,scope)}><MediaPreview asset={asset} large/>
        <dl className="detail-data"><dt>素材名称</dt><dd>{String(asset.metadata.name ?? '生成素材')}</dd><dt>媒体类型</dt><dd>{asset.kind==='video'?'视频':asset.kind==='image'?'图像':'音频'}</dd><dt>文件大小</dt><dd>{(Number(asset.metadata.byteLength ?? 0)/1024/1024).toFixed(2)} MB</dd></dl>
      </div>;
    }
    const item=object.kind==='item'?document.items[object.id]:undefined;
    const timeline=document.timelines[item?.timelineId ?? object.id];if(!timeline)return null;
    const model=models.find(candidate=>candidate.modelId===timeline.modelId);if(!model)return null;
    const values=(item?item.params:timeline.settings) as JsonObject;
    const schema=item?model.paramsJsonSchema:model.settingsJsonSchema;
    const fields=model.fields.filter(field=>field.scope===(item?'itemParams':'settings'));
    const commit=(replacement:JsonObject)=>execute(item?'item.params':'timeline.settings',item?{itemId:item.id,params:replacement}:{timelineId:timeline.id,settings:replacement},scope);
    const openField=(fieldPath:FieldPath)=>open(object as ObjectRef,scope,fieldPath);
    let visibleFields=fields;let prefix:FieldPath=[];let arrayField:PluginFieldDeclaration|undefined;
    for(const segment of nestedPath){
      if(typeof segment==='number'){prefix.push(segment);continue;}
      const declaration=visibleFields.find(field=>field.key===segment);if(!declaration)break;
      if(declaration.valueType==='array')arrayField=declaration;
      visibleFields=[...(declaration.children ?? [])];prefix.push(segment);
    }
    const nestedValue=atPath(values,nestedPath);
    if(Array.isArray(nestedValue) && arrayField?.children) {
      const array=nestedValue;
      const updateArray=(replacement:JsonValue[])=>commit(withPath(values,nestedPath,replacement));
      const recordSchema=schemaAtPath(schema,[...nestedPath,0]);
      const rowMenu=(event:React.MouseEvent,index?:number)=>{
        event.preventDefault();event.stopPropagation();if(!host.navigator.isInteractive(scope))return;
        setMenu({x:event.clientX,y:event.clientY,items:[
          {id:'append',label:'新增音乐段落',onSelect:()=>{void updateArray([...array,defaultFromSchema(recordSchema)]);}},
          ...(index!==undefined?[{id:'remove',label:'移除这个段落',disabled:array.length<=1,...(array.length<=1?{description:'计划至少保留一个段落'}:{}),onSelect:()=>{void updateArray(array.filter((_,i)=>i!==index));}}]:[]),
        ]});
      };
      return <div className="details-stack" onContextMenu={event=>rowMenu(event)}>{array.map((record,index)=><div key={index} className="detail-link" tabIndex={0} onDoubleClick={()=>openField([...nestedPath,index])} onKeyDown={event=>{if(event.key==='Enter')openField([...nestedPath,index]);}} onContextMenu={event=>rowMenu(event,index)}><PixelBadge>段落 {String(index+1).padStart(2,'0')}</PixelBadge><span>{record && typeof record==='object'&&!Array.isArray(record)?`${Number(record.durationMs ?? 0)/1000} 秒 · ${String(record.text || '无歌词')}`:''}</span><PixelIcon name="chevron"/></div>)}</div>;
    }
    return <div className="details-stack" onContextMenu={event=>context(event,object as ObjectRef,scope)}>
      {!nestedPath.length && <>
        <div className="detail-summary"><PixelBadge tone="green">{shortModel(model)}</PixelBadge><span className="pixel-description">{item?'片段参数':'时间线设置'}</span></div>
        {item && <div className="detail-link" tabIndex={0} onDoubleClick={()=>open({kind:'timeline',projectId:PROJECT_ID,id:timeline.id},scope)} onKeyDown={event=>objectKeys(event,{kind:'timeline',projectId:PROJECT_ID,id:timeline.id},scope)}><PixelIcon name="grid"/>模型与画面设置<span><PixelIcon name="chevron"/></span></div>}
      </>}
      {visibleFields.filter(field=>!field.visibleWhen||JSON.stringify(values[field.visibleWhen.field])===JSON.stringify(field.visibleWhen.equals)).map(field=>{
        const fieldPath=[...prefix,field.key];
        return <FieldEditor key={`${scope}:${field.key}`} field={field} value={atPath(values,fieldPath)} schema={schemaAtPath(schema,fieldPath)} disabled={pending>0}
          onCommit={value=>commit(withPath(values,fieldPath,value))} onOpen={()=>openField(fieldPath)}/>;
      })}
      {!visibleFields.length && <PixelEmpty title="无需额外设置" description="模型使用时间线的默认设置"/>}
      {item && !nestedPath.length && <>
        {hasReferenceContext(item,model,scope)&&<div className={`reference-zone ${canReferenceDrop(item.id,scope)?'reference-zone--active':''}`} data-testid="item-reference"
          onDragOver={event=>dragOver(event,refTarget(item.id),scope)} onDrop={event=>drop(event,refTarget(item.id),scope)}>
          <span className="pixel-title"><PixelIcon name="reference"/> 参考素材</span>
          {item.referenceAssetIds.map(id=>{const asset=document.assets[id];return asset?<div key={id} className="reference-card" tabIndex={0} onDoubleClick={()=>open({kind:'asset',projectId:PROJECT_ID,id},scope)} onKeyDown={event=>objectKeys(event,{kind:'asset',projectId:PROJECT_ID,id},scope)} onContextMenu={event=>context(event,{kind:'asset',projectId:PROJECT_ID,id},scope)}><MediaPreview asset={asset}/><span>{String(asset.metadata.name ?? '参考图像')}</span></div>:null;})}
        </div>}
        {item.outputAssetId && <div className="detail-link" tabIndex={0} onDoubleClick={()=>open({kind:'asset',id:item.outputAssetId!,projectId:PROJECT_ID},scope)} onKeyDown={event=>objectKeys(event,{kind:'asset',id:item.outputAssetId!,projectId:PROJECT_ID},scope)}><PixelIcon name="image"/>生成输出<span><PixelIcon name="chevron"/></span></div>}
        {latestJob(item.id) && <div className="job-detail"><PixelProgress value={latestJob(item.id)!.progress} label={stateTitles[latestJob(item.id)!.state] ?? '生成任务'}/>{latestJob(item.id)!.error&&<p className="pixel-description">{latestJob(item.id)!.error!.message}</p>}</div>}
      </>}
    </div>;
  }
  const currentObject=current?.object;
  const currentField=fieldPaths.get(current?.scopeId ?? '')?.at(-1);
  const modalTitle=currentField==='$library'?'素材库':currentField!==undefined?(typeof currentField==='number'?`音乐段落 ${currentField+1}`:fieldLabel({key:currentField,label:currentField,scope:'itemParams',valueType:'string'})):
    currentObject?.kind==='project'?'作品详情':currentObject?.kind==='timeline'?'时间线详情':currentObject?.kind==='asset'?'素材详情':'片段详情';

  const modal = <PixelModalHost standalone={detailMode} windowControls={detailMode ? <WindowControls /> : undefined} open={Boolean(current)} title={modalTitle} depth={path.length}
    description={path.length>1?path.map((frame,index)=>index===path.length-1?modalTitle:fieldPaths.get(frame.scopeId)?.[0]==='$library'?'素材库':frame.object.kind==='item'?'片段':frame.object.kind==='timeline'?'时间线':frame.object.kind==='asset'?'素材':'作品').join(' / '):undefined}
    onBack={()=>{setMenu(undefined);setDragging(undefined);setDropHint(undefined);host.navigator.pop();}}><div data-testid="modal-host">{details()}</div></PixelModalHost>;
  if (detailMode) return <div className="detail-window" onDragEnd={()=>{setDragging(undefined);setDropHint(undefined);}}>
    {modal}
    {(pending>0||feedback.text)&&<span className={`detail-feedback ${feedback.error?'feedback--error':''}`} role="status" aria-live="polite">{pending?'正在保存…':feedback.text}</span>}
    {menu&&<PixelContextMenu key={menu.items[0]?.id} x={menu.x} y={menu.y} items={menu.items} onClose={()=>setMenu(undefined)}/>}
  </div>;

  return <div className="workbench" onDragEnd={()=>{setDragging(undefined);setDropHint(undefined);}}>
    <header className="app-header">
      <div className="project-name" tabIndex={0} role="group" aria-label="作品详情" onDoubleClick={()=>open(projectRef)} onKeyDown={event=>objectKeys(event,projectRef)}><PixelIcon name="folder"/>{document?.title ?? '正在打开作品'}</div>
      <WindowControls/>
    </header>
    <main className="workbench-main">
      
      <div className="upper-workspace">
        <PixelPanel className="viewer-panel">
          <div className="viewer-canvas" data-testid="viewer" tabIndex={0} role="group" aria-label="作品预览" onDoubleClick={()=>{if(selectedAsset)open({kind:'asset',projectId:PROJECT_ID,id:selectedAsset.id});}}
            onContextMenu={event=>{event.preventDefault();event.stopPropagation();viewerMenuAt(event.clientX,event.clientY);}}
            onKeyDown={event=>{
              if(event.key==='Enter'&&selectedAsset){event.preventDefault();open({kind:'asset',projectId:PROJECT_ID,id:selectedAsset.id});}
              else if(event.key==='ContextMenu'||(event.key==='F10'&&event.shiftKey)){event.preventDefault();event.stopPropagation();const box=event.currentTarget.getBoundingClientRect();viewerMenuAt(box.left+24,box.top+24);}
            }}
            draggable={Boolean(selectedAsset&&(!desktop||exportTicket?.assetId===selectedAsset.id))} onDragStart={event=>{
              if(!selectedAsset){event.preventDefault();return;}
              if(desktop){event.preventDefault();if(exportTicket?.assetId===selectedAsset.id){desktop.startExport(exportTicket.ticket);setExportTicket(undefined);setExportRefresh(value=>value+1);}return;}
              event.dataTransfer.setData('DownloadURL',`${String(selectedAsset.metadata.mimeType)}:pixel-${selectedAsset.id}.${String(selectedAsset.metadata.extension ?? 'bin')}:${location.origin}${assetUrl(selectedAsset.id)}`);
              event.dataTransfer.setData('text/uri-list',`${location.origin}${assetUrl(selectedAsset.id)}`);
            }}>
            {selectedAsset?<MediaPreview key={selectedAsset.id} asset={selectedAsset} large seekSeconds={previewSeconds} scrubbing={scrubbing}/>:<span className="viewer-empty pixel-description">暂无输出</span>}
            {selectedAsset&&desktop&&exportTicket?.assetId!==selectedAsset.id&&<span className="viewer-preparing" role="status">正在准备输出…</span>}
          </div>
          {previewItem&&<div className="viewer-meta"><span className="viewer-time">{playbackTimeLabel(playheadMs)}</span><span className="viewer-selection">{itemTitle(previewItem)}</span><span>{time(previewItem.durationTicks/(document?.timelines[previewItem.timelineId]?.ticksPerSecond ?? 1000))}</span></div>}
          {selectedJob && (['queued','running','cancelRequested'].includes(selectedJob.state)||selectedJob.error) && <div className="viewer-job"><PixelProgress value={selectedJob.progress} label={stateTitles[selectedJob.state] ?? '生成任务'}/>{selectedJob.error&&<p className="job-error">{selectedJob.error.message}</p>}</div>}
        </PixelPanel>
      </div>
      <PixelPanel className="timeline-panel">
        <div className="timeline-scroll" data-testid="timeline-workspace" onContextMenu={event=>context(event,projectRef,undefined,true)} tabIndex={0} role="group" aria-label="时间线工作区" onKeyDown={event=>{if(event.target===event.currentTarget&&(event.key==='ContextMenu'||(event.key==='F10'&&event.shiftKey))){event.preventDefault();const box=event.currentTarget.getBoundingClientRect();contextAt(box.left+220,box.top+40,projectRef,undefined,true);}}}>
          <div className="timeline-content" style={{minWidth:trackWidth+196}}>
            <div className={`timeline-playhead ${scrubbing?'timeline-playhead--scrubbing':''}`} data-testid="timeline-playhead" aria-hidden="true" style={{left:196+playheadMs/1000*PX_PER_SECOND}}><div className="timeline-playhead-handle" data-testid="timeline-playhead-handle" onPointerDown={scrubBegin}/></div>
            <div className="timeline-ruler"><div className="timeline-label timeline-label--ruler"><span className="ruler-time" data-testid="timeline-current-time">{playbackTimeLabel(playheadMs)}</span><PixelIcon name="timeline"/></div><div ref={rulerRef} className="ruler-track" data-testid="timeline-ruler" style={{width:trackWidth}} tabIndex={0} role="slider" aria-label="播放位置" aria-valuemin={0} aria-valuemax={maximumPlaybackMs} aria-valuenow={playheadMs} aria-valuetext={playbackTimeLabel(playheadMs)} aria-disabled={Boolean(current)} onPointerDown={scrubBegin} onKeyDown={playbackKeys}>{Array.from({length:Math.ceil(seconds/4)+1},(_,i)=><span key={i} style={{left:i*4*PX_PER_SECOND}}>{time(i*4)}</span>)}</div></div>
            {timelines.map((timeline,index)=>{
              const model=models.find(candidate=>candidate.modelId===timeline.modelId);const kind=model?.outputKind ?? 'video';const obj:ObjectRef={kind:'timeline',projectId:PROJECT_ID,id:timeline.id};
              return <div key={timeline.id} className="timeline-row" data-testid="timeline-row" data-timeline-id={timeline.id}>
                <div className="timeline-label" tabIndex={0} role="group" onClick={()=>{if(host.navigator.isInteractive(undefined))setSelected(obj);}} onDoubleClick={()=>open(obj)} onKeyDown={event=>objectKeys(event,obj)} onContextMenu={event=>context(event,obj)}>
                  <div className={`track-icon track-icon--${kind}`}>{kind==='video'?'V':kind==='image'?'I':'A'}{index+1}</div><strong>{shortModel(model)}</strong>
                </div>
                <div className="timeline-track" data-testid="timeline-track" style={{width:trackWidth}} onContextMenu={event=>context(event,obj,undefined,false,{role:'timeline.position',startTick:positionTick(event.clientX,event.currentTarget.getBoundingClientRect().left,timeline.ticksPerSecond)})} onDragOver={event=>dragOver(event,targetAt(event,timeline.id))} onDrop={event=>drop(event,targetAt(event,timeline.id))} onDragLeave={()=>setDropHint(undefined)}>
                  {timeline.itemIds.map(id=>{const item=document!.items[id];if(!item)return null;const view=resize?.id===id?resize:item;const job=latestJob(id);const ref:ObjectRef={kind:'item',projectId:PROJECT_ID,id};
                    return <div key={id} className={`timeline-item timeline-item--${kind} ${selected?.kind==='item'&&selected.id===id?'timeline-item--selected':''}`} data-testid="timeline-item" data-item-id={id}
                      style={{left:view.startTick/timeline.ticksPerSecond*PX_PER_SECOND,width:Math.max(24,view.durationTicks/timeline.ticksPerSecond*PX_PER_SECOND)}} draggable tabIndex={0} role="group" aria-label={`片段 ${itemTitle(item)}`}
                      onClick={()=>{if(host.navigator.isInteractive(undefined)){setSelected(ref);seekPlayback(item.startTick/timeline.ticksPerSecond*1000);}}} onDoubleClick={()=>open(ref)} onKeyDown={event=>objectKeys(event,ref)} onContextMenu={event=>context(event,ref)} onDragStart={event=>beginDrag(event,{role:'item',payload:{object:ref as {kind:'item';projectId:string;id:string}}},timeline.ticksPerSecond)}>
                      <div className="item-edge item-edge--start" data-testid="item-edge-start" onPointerDown={event=>resizeBegin(event,item,'start')}/>
                      <div className="item-body"><span className="item-title"><PixelIcon name={iconFor(kind)}/>{itemTitle(item)}</span><span className="item-caption">{time(view.durationTicks/timeline.ticksPerSecond)} <span>·</span> {job?stateTitles[job.state]:item.outputAssetId?'就绪':'草稿'}</span></div>
                      {hasReferenceContext(item,model)&&<div className="item-reference" title="参考素材" data-testid="item-reference-drop" onDragOver={event=>dragOver(event,refTarget(id))} onDrop={event=>drop(event,refTarget(id))}><PixelIcon name="reference"/><span>{item.referenceAssetIds.length}</span></div>}
                      <div className="item-edge item-edge--end" data-testid="item-edge-end" onPointerDown={event=>resizeBegin(event,item,'end')}/>
                      {job&&['running','queued'].includes(job.state)&&<div className="item-progress" style={{width:`${job.progress*100}%`}}/>}
                    </div>;
                  })}
                  {dropHint?.id===timeline.id&&<div className={`drop-marker ${!dropHint.valid?'drop-marker--invalid':''}`} style={{left:dropHint.tick/timeline.ticksPerSecond*PX_PER_SECOND}}/>}
                </div>
              </div>;
            })}
            
          </div>
        </div>
        
      </PixelPanel>
    </main>
    {(pending>0||feedback.text)&&<div className={`workspace-feedback ${feedback.error?'feedback--error':''}`} role="status" aria-live="polite">{pending?'正在保存…':feedback.text}</div>}
    {!desktop&&modal}
    {menu&&<PixelContextMenu key={menu.items[0]?.id} x={menu.x} y={menu.y} items={menu.items} onClose={()=>setMenu(undefined)}/>}
  </div>;
}

function WindowControls() {
  const desktop = window.pixelDesktop;
  const [maximized, setMaximized] = useState(false);
  useEffect(()=>{
    if (!desktop) return;
    void desktop.isMaximized().then(setMaximized);
    return desktop.onMaximizedChanged(setMaximized);
  },[desktop]);
  if (!desktop) return null;
  return <div className="window-controls" aria-label="窗口控制">
    <button type="button" aria-label="最小化" onClick={()=>desktop.minimize()}><svg viewBox="0 0 12 12" shapeRendering="crispEdges"><path d="M2 9h8v1H2z"/></svg></button>
    {!desktop.isDetailWindow&&<button type="button" aria-label={maximized?'还原窗口':'最大化'} onClick={()=>desktop.toggleMaximize()}><svg viewBox="0 0 12 12" shapeRendering="crispEdges"><path d={maximized?'M4 1h7v7H9V3H4zM1 4h7v7H1zm1 2v4h5V6z':'M1 1h10v10H1zm1 2v7h8V3z'}/></svg></button>}
    <button type="button" className="window-close" aria-label="关闭窗口" onClick={()=>desktop.close()}><svg viewBox="0 0 12 12" shapeRendering="crispEdges"><path d="M2 1h1v1h1v1h1v1h2V3h1V2h1V1h1v2H9v1H8v1H7v2h1v1h1v1h1v2H9v-1H8V9H7V8H5v1H4v1H3v1H2V9h1V8h1V7h1V5H4V4H3V3H2z"/></svg></button>
  </div>;
}

function TitleField({title,onCommit}:{title:string;onCommit:(title:string)=>Promise<boolean>}) {
  const [draft,setDraft]=useState(title);const submitted=useRef(title);const discard=useRef(false);
  useEffect(()=>{setDraft(title);submitted.current=title;},[title]);
  const save=()=>{if(discard.current){discard.current=false;return;}if(draft!==submitted.current){submitted.current=draft;void onCommit(draft).then(ok=>{if(!ok)submitted.current=title;});}};
  return <PixelInput aria-label="作品名称" value={draft} onChange={event=>setDraft(event.target.value)} onBlur={save} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();save();}if(event.key==='Escape'){discard.current=true;setDraft(title);event.currentTarget.blur();}}}/>;
}
