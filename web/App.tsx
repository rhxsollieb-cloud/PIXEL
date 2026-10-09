import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { AssetData, DeepReadonly, GenerationJob, JsonObject, JsonValue, MediaKind, ObjectRef, TimelineItemData } from '../src/contracts.js';
import { ActionClient, ProjectProjectionStore, type ContextActionContext, type DragSource, type DragTarget } from '../src/frontend.js';
import type { TimelineDeclaration } from '../src/timeline-catalog.js';
import type { PluginFieldDeclaration } from '../src/plugins.js';
import { HttpDesktopBridge, assetUrl, mediaMimeType, readJson, type ProjectSessionDescriptor } from './bridge.js';
import { initialDetailObject, type DesktopObjectDrag } from './desktop.js';
import { browserWindowHost } from './browser-window.js';
import { createInteractionHost, declarationForTimeline } from './interaction.js';
import { clampPlaybackMs, itemAtPlaybackTime, playbackTimeLabel, sourcePlaybackSeconds } from './playback.js';
import { atPath, defaultFromSchema, FieldEditor, fieldLabel, schemaAtPath, withPath, type FieldPath } from './fields.js';
import { PixelBadge, PixelContextMenu, PixelEmpty, PixelField, PixelIcon, PixelInput, PixelModalHost, PixelPanel, PixelProgress, PixelWindowHost, type PixelContextMenuItem } from './ui/index.js';

const MIME = 'application/x-pixel-object';
const PX_PER_SECOND = 32;
const stateTitles: Record<string,string> = {queued:'排队中',running:'正在生成',cancelRequested:'正在取消',canceled:'已取消',succeeded:'已完成',failed:'生成失败',interrupted:'等待恢复'};
function time(seconds: number): string { return `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(Math.floor(seconds % 60)).padStart(2,'0')}`; }
function positionTick(clientX:number,left:number,ticksPerSecond:number,offsetTicks=0):number {
  const grid=ticksPerSecond/2;
  return Math.max(0,Math.round(((clientX-left)/PX_PER_SECOND*ticksPerSecond-offsetTicks)/grid)*grid);
}
function shortModel(model: TimelineDeclaration | undefined): string {
  if (!model) return '未知时间线';
  return ({'alibaba/wan-3.0':'Wan 3.0','x-ai/grok-imagine-image-2.0':'Grok Image 2.0',music_v2_5:'Music v2.5',eleven_v4:'Eleven v4',eleven_text_to_sound_v2:'Sound Effects v2'} as Record<string,string>)[model.modelId ?? ''] ?? model.title;
}
function iconFor(kind: string): string { return kind === 'text'?'text':kind === 'video'?'frames':kind === 'image'?'image':kind.includes('speech')?'voice':'music'; }
function itemTitle(item: DeepReadonly<TimelineItemData>): string { return String(item.params.prompt || item.params.text || (item.kind.startsWith('text.')?'空文本片段':item.kind.includes('speech')?'未填写的对白':'新的创作片段')); }
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
  const [session,setSession]=useState<ProjectSessionDescriptor>();
  const [error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();
    let retry:number|undefined;
    const load=()=>void readJson<ProjectSessionDescriptor>('/api/session',controller.signal).then(value=>{
      if(typeof value.projectId!=='string'||!value.projectId||typeof value.sessionId!=='string'||!value.sessionId)throw new Error('项目会话无效');
      if(!controller.signal.aborted){setSession(value);setError('');}
    }).catch(()=>{if(!controller.signal.aborted){setError('项目尚未连接，正在重新读取');retry=window.setTimeout(load,1000);}});
    load();
    return()=>{controller.abort();window.clearTimeout(retry);};
  },[]);
  if(!session)return <PixelWindowHost title={<span className="project-name"><PixelIcon name="folder"/>正在打开作品</span>} controls={<WindowControls/>}
    onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='none';}}} onDrop={event=>event.preventDefault()}>
    {error&&<span className="workspace-feedback feedback--error" role="status">{error}</span>}
  </PixelWindowHost>;
  return <Workbench key={session.sessionId} session={session}/>;
}

function Workbench({session}:{session:ProjectSessionDescriptor}) {
  const projectId=session.projectId;
  const desktop = window.pixelDesktop;
  const libraryMode = desktop?.isLibraryWindow === true || (!desktop && new URLSearchParams(location.search).get('window') === 'library');
  const detailMode = desktop?.isDetailWindow === true && !libraryMode;
  const [models,setModels] = useState<TimelineDeclaration[]>([]);
  const [typeCursor,setTypeCursor] = useState<string | undefined>();
  const [jobs,setJobs] = useState<GenerationJob[]>([]);
  const modelsRef=useRef(models);modelsRef.current=models;
  const jobsRef=useRef(jobs);jobsRef.current=jobs;
  const [bridge]=useState(()=>new HttpDesktopBridge());
  const [store]=useState(()=>new ProjectProjectionStore({projectId:projectId,bridge,onError:()=>setFeedback({text:'连接中断，等待重新读取项目',error:true})}));
  const [client]=useState(()=>new ActionClient(bridge));
  const [host]=useState(()=>{
    const interaction = createInteractionHost(projectId,()=>modelsRef.current,()=>jobsRef.current);
    const object = libraryMode ? undefined : initialDetailObject(projectId);
    if (object) interaction.navigator.open(object);
    return interaction;
  });
  const [windows]=useState(()=>desktop ?? browserWindowHost({snapshot:()=>store.getSnapshot(),interactive:()=>host.navigator.isInteractive(undefined)}));
  const snapshot=useSyncExternalStore(listener=>store.subscribe(listener),()=>store.getSnapshot());
  const path=useSyncExternalStore(listener=>host.navigator.subscribe(listener),()=>host.navigator.getPath());
  const [pending,setPending]=useState(0);
  const [openingProject,setOpeningProject]=useState(false);
  const [feedback,setFeedback]=useState({text:'',error:false});
  const [selected,setSelected]=useState<ObjectRef | undefined>();
  const [playheadMs,setPlayheadMs]=useState(0);
  const [scrubbing,setScrubbing]=useState(false);
  const rulerRef=useRef<HTMLDivElement | null>(null);
  const finishScrub=useRef<(()=>void) | undefined>(undefined);
  const finishResize=useRef<(()=>void) | undefined>(undefined);
  const live=useRef(true);
  const [menu,setMenu]=useState<{x:number;y:number;items:PixelContextMenuItem[]} | undefined>();
  const [dragging,setDragging]=useState<DesktopObjectDrag | undefined>();
  const sourceSession=useRef<string | undefined>(undefined);
  const [dropHint,setDropHint]=useState<{id:string;tick:number;valid:boolean} | undefined>();
  const [resize,setResize]=useState<{id:string;startTick:number;durationTicks:number} | undefined>();
  const [exportTicket,setExportTicket]=useState<{assetId:string;ticket:string} | undefined>();
  const [exportRefresh,setExportRefresh]=useState(0);
  const [fieldPaths]=useState(()=>new Map<string,FieldPath>());
  const missingTypes=useRef(new Set<string>());
  const current=path.at(-1);
  const document=snapshot?.document;
  const timelines=Object.values(document?.timelines ?? {});
  const selectedItem=selected?.kind==='item'?document?.items[selected.id]:undefined;
  const selectedTimelineId=selectedItem?.timelineId ?? (selected?.kind==='timeline'?selected.id:undefined);
  const selectedType=declarationForTimeline(models,document?.timelines[selectedTimelineId ?? '']);
  const preferredTimelineId=selectedType?.capabilities.generation||selectedType?.capabilities.mediaPlacement?selectedTimelineId:undefined;
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
  useEffect(()=>{if(path.length){finishScrub.current?.();finishResize.current?.();endDrag(true);}},[path.length]);
  useEffect(()=>()=>{live.current=false;finishScrub.current?.();finishResize.current?.();endDrag(true);},[]);
  useEffect(()=>windows.onObjectDrag(value=>{setDragging(value);if(!value)setDropHint(undefined);}),[windows]);
  useEffect(()=>{if(libraryMode&&!current)globalThis.document.querySelector<HTMLElement>('[data-testid="library-window"]')?.focus();},[libraryMode,current]);

  useEffect(()=>{
    if(!feedback.text || feedback.error)return;
    const timeout=window.setTimeout(()=>setFeedback({text:'',error:false}),2400);
    return ()=>window.clearTimeout(timeout);
  },[feedback]);

  useEffect(()=>{
    if (!desktop || detailMode || libraryMode) return;
    return desktop.onDetailsClosed(()=>{ host.navigator.reset(); setMenu(undefined); });
  },[desktop,detailMode,libraryMode,host]);
  useEffect(()=>{
    if (detailMode && !path.length) desktop?.close();
  },[desktop,detailMode,path.length]);
  useEffect(()=>{
    if (!desktop || detailMode || libraryMode || !selectedAsset) { setExportTicket(undefined); return; }
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
  },[desktop,detailMode,libraryMode,selectedAsset?.id,exportRefresh]);

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
        void bridge.timelineTypes(controller.signal).then(result=>{setModels(result.items);setTypeCursor(result.nextCursor);}).catch(()=>{});
        setFeedback(previous=>previous.text.includes('连接')?{text:'',error:false}:previous);
      }
    });
    void store.start().catch(()=>setFeedback({text:'后端尚未连接，请使用 npm run dev 启动工作台',error:true}));
    void bridge.timelineTypes(controller.signal).then(result=>{setModels(result.items);setTypeCursor(result.nextCursor);}).catch(()=>{});
    void loadJobs();
    return ()=>{controller.abort();offJobs();offConnection();store.dispose();bridge.close();host.menu.dispose();host.drag.dispose();};
  },[bridge,store,host]);
  useEffect(()=>{
    if(!snapshot)return;
    host.navigator.reconcile(snapshot);
    if(selected && ((selected.kind==='item'&&!Object.hasOwn(snapshot.document.items,selected.id)) || (selected.kind==='asset'&&!Object.hasOwn(snapshot.document.assets,selected.id))))setSelected(undefined);
  },[snapshot,host,selected]);
  useEffect(()=>{
    if(!snapshot||!models.length)return;
    const controller=new AbortController();
    const missing=[...new Set(Object.values(snapshot.document.timelines).filter(timeline=>!declarationForTimeline(models,timeline)).map(timeline=>timeline.modelId ?? timeline.pluginId))]
      .filter(typeId=>!missingTypes.current.has(typeId)).slice(0,20);
    missing.forEach(typeId=>missingTypes.current.add(typeId));
    if(missing.length)void Promise.allSettled(missing.map(typeId=>bridge.timelineType(typeId,controller.signal))).then(results=>{
      if(controller.signal.aborted)return;
      const available=results.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
      if(available.length)setModels(previous=>[...previous,...available.filter(type=>!previous.some(existing=>existing.typeId===type.typeId))]);
    });
    return()=>{controller.abort();missing.forEach(typeId=>missingTypes.current.delete(typeId));};
  },[bridge,snapshot,models]);

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
    if(!live.current || !latest || !host.navigator.isInteractive(scopeId))return false;
    setPending(value=>value+1);
    try {
      const result=await client.execute({requestId:crypto.randomUUID(),projectId:projectId,expectedRevision:latest.revision,type,payload});
      if(!live.current)return false;
      await store.refresh();
      if(!live.current)return false;
      if(!result.ok){setFeedback({text:result.error.message,error:true});return false;}
      setFeedback({text:type==='generation.submit'?'生成任务已提交':type==='timeline.refreshDefaults'?'时间轴默认配置已刷新':'已保存',error:false});
      return true;
    }catch{if(live.current)setFeedback({text:'本地连接中断，修改尚未确认，请检查后端状态',error:true});return false;}
    finally{if(live.current)setPending(value=>value-1);}
  }
  function open(object:ObjectRef,scopeId?:string,fieldPath?:FieldPath) {
    if(!host.navigator.isInteractive(scopeId))return;
    setMenu(undefined);
    const frame=scopeId?host.navigator.push(object):host.navigator.open(object);
    if(fieldPath)fieldPaths.set(frame.scopeId,fieldPath);
    if (desktop && !detailMode && !libraryMode && !scopeId) void desktop.openDetails({object}).catch(()=>{
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
        setMenu({x,y,items:timelineTypeMenuItems(x,y,models.slice(0,20),typeCursor,context,scopeId)});
      }}]});return;
    }
    const items=actions.filter(action=>action.id!=='timeline.create').map(action=>({
      id:action.id,label:action.id==='generation.submit'&&document?.items['id' in target?target.id:'']?.outputAssetId?'重新生成':action.id==='item.createDraft'?(declarationForTimeline(models,document?.timelines['id' in target?target.id:''])?.draftTitle ?? action.title):action.title,
      ...(action.availability.status==='disabled'?{description:action.availability.reason,disabled:true}:{}),
      onSelect:()=>{const latest=store.getSnapshot();if(!latest)return;const command=host.menu.commandFor(action.id,{...context,project:latest});if(command)void execute(command.type,command.payload as JsonObject,scopeId);},
    }));
    if(items.length)setMenu({x,y,items});
  }
  function timelineTypeMenuItems(x:number,y:number,types:readonly TimelineDeclaration[],cursor:string|undefined,context:ContextActionContext,scopeId?:string):PixelContextMenuItem[] {
    return [
      ...types.map(model=>({id:model.typeId,label:model.title,description:model.outputKind==='video'?'视频时间线':model.outputKind==='image'?'图像时间线':model.outputKind==='audio'?'音频时间线':'文字参考时间线',onSelect:()=>{
        const latest=store.getSnapshot();if(!latest)return;
        const command=host.menu.commandFor('timeline.create',{...context,project:latest});if(command)void execute(command.type,{...command.payload,typeId:model.typeId},scopeId);
      }})),
      ...(cursor?[{id:'timeline.types.more',label:'更多时间线类型',onSelect:()=>{
        const loadingId=`timeline.types.loading:${crypto.randomUUID()}`;
        setMenu({x,y,items:[{id:loadingId,label:'正在读取时间线类型…',disabled:true,onSelect:()=>{}}]});
        void bridge.timelineTypes(undefined,cursor).then(result=>{
          if(!live.current||!host.navigator.isInteractive(scopeId))return;
          setModels(previous=>[...previous,...result.items.filter(type=>!previous.some(existing=>existing.typeId===type.typeId))]);
          setMenu(previous=>previous?.items[0]?.id===loadingId?{x,y,items:timelineTypeMenuItems(x,y,result.items,result.nextCursor,context,scopeId)}:previous);
        }).catch(()=>{if(live.current){setMenu(previous=>previous?.items[0]?.id===loadingId?undefined:previous);setFeedback({text:'时间线类型暂未读取，请稍后再试',error:true});}});
      }}]:[]),
    ];
  }
  function context(event:React.MouseEvent,target:ObjectRef,scopeId?:string,createOnly=false,data?:JsonObject) {
    if((event.target as HTMLElement).closest('input,textarea,select'))return;
    event.preventDefault();event.stopPropagation();contextAt(event.clientX,event.clientY,target,scopeId,createOnly,data);
  }
  function viewerMenuAt(x:number,y:number) {
    if(!store.getSnapshot() || !host.navigator.isInteractive(undefined))return;
    setMenu({x,y,items:[{id:'navigate.library',label:'素材库',onSelect:()=>{setMenu(undefined);void windows.openLibrary().catch(()=>setFeedback({text:'素材库窗口未能打开',error:true}));}}]});
  }
  function beginDrag(event:DragEvent,source:DragSource,ticksPerSecond=1000,scopeId?:string) {
    if(!host.navigator.isInteractive(scopeId)){event.preventDefault();return;}
    const duration=source.payload.object.kind==='item'?store.getSnapshot()?.document.items[source.payload.object.id]?.durationTicks ?? 0:0;
    const offsetTicks=source.role==='item'?Math.min(duration,Math.max(0,Math.round((event.clientX-event.currentTarget.getBoundingClientRect().left)/PX_PER_SECOND*ticksPerSecond))):0;
    const sessionId=windows.beginObjectDrag(source,offsetTicks);
    if(!sessionId){event.preventDefault();return;}
    sourceSession.current=sessionId;event.dataTransfer.setData(MIME,sessionId);event.dataTransfer.effectAllowed='copyMove';setMenu(undefined);
  }
  function endDrag(canceled=false) {
    const sessionId=sourceSession.current;sourceSession.current=undefined;
    if(sessionId)windows.endObjectDrag(sessionId,canceled);
  }
  function dragSource(event:DragEvent,preview=false):DesktopObjectDrag|undefined {
    // Chromium protects payload reads during hover. A drop can read its token
    // and must never authorize unrelated data from a previously active drag.
    const token=event.dataTransfer.getData(MIME)||(preview&&event.dataTransfer.types.includes(MIME)?dragging?.sessionId:undefined);
    return token?windows.resolveObjectDrag(token):undefined;
  }
  function dropContext(source:DragSource,target:DragTarget,scopeId?:string) {
    const project=store.getSnapshot();return project?{source,target,project,...(scopeId?{scopeId}: {})}:undefined;
  }
  function dragOver(event:DragEvent,target:DragTarget,scopeId?:string) {
    const source=dragSource(event,true)?.source;if(!source)return;
    const ctx=dropContext(source,target,scopeId);if(!ctx)return;
    const availability=host.drag.hover(ctx);
    if(availability.status==='available'){event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=source.role==='item'?'move':'copy';}
    if(target.role==='timeline.position')setDropHint({id:'id' in target.object?target.object.id:'',tick:Number(target.data.startTick),valid:availability.status==='available'});
  }
  function drop(event:DragEvent,target:DragTarget,scopeId?:string) {
    event.preventDefault();event.stopPropagation();const data=dragSource(event);setDropHint(undefined);
    if(!data)return;const ctx=dropContext(data.source,target,scopeId);if(!ctx || host.drag.hover(ctx).status!=='available')return;
    const consumed=windows.finishObjectDrag(data.sessionId);if(!consumed)return;
    const command=host.drag.drop({...ctx,source:consumed.source});
    if(command)void execute(command.type,command.payload as JsonObject,scopeId);
  }
  function targetAt(event:DragEvent,timelineId:string):DragTarget {
    const timeline=document!.timelines[timelineId]!;
    const tick=positionTick(event.clientX,event.currentTarget.getBoundingClientRect().left,timeline.ticksPerSecond,dragSource(event,event.type!=='drop')?.offsetTicks ?? 0);
    return {role:'timeline.position',object:{kind:'timeline',projectId:projectId,id:timelineId},data:{startTick:tick}};
  }
  function externalFiles(event:DragEvent):boolean {
    return event.dataTransfer.types.includes('Files')&&!event.dataTransfer.types.includes(MIME);
  }
  function projectDragOver(event:DragEvent) {
    if(!externalFiles(event))return;
    event.preventDefault();event.stopPropagation();
    const kind=fileHoverKind(event);
    const target=kind?externalMediaTarget(event):undefined;
    const context=kind&&target?dropContext({role:'external.media',payload:{object:{kind:'project',projectId},kind}},target):undefined;
    event.dataTransfer.dropEffect=host.navigator.isInteractive(undefined)&&pending===0&&(!kind||(context&&host.drag.hover(context).status==='available'))?'copy':'none';
  }
  async function projectDrop(event:DragEvent) {
    if(!externalFiles(event))return;
    event.preventDefault();event.stopPropagation();setMenu(undefined);
    if(!host.navigator.isInteractive(undefined)||pending>0){setFeedback({text:'请先完成当前编辑再拖入文件',error:true});return;}
    const files=Array.from(event.dataTransfer.files);
    if(files.length!==1){setFeedback({text:'每次请拖入一个文件或项目文件夹',error:true});return;}
    const file=files[0]!;
    const directory=Array.from(event.dataTransfer.items).some(item=>item.kind==='file'&&item.webkitGetAsEntry()?.isDirectory);
    if(!directory&&file.name.toLowerCase()!=='project.json'&&/^(audio|video|image)\//.test(mediaMimeType(file))){
      await placeMediaFile(event,file);return;
    }
    if(!desktop){setFeedback({text:'请使用桌面版拖入项目文件或文件夹；媒体请拖入素材库',error:true});return;}
    setOpeningProject(true);setPending(value=>value+1);finishScrub.current?.();finishResize.current?.();endDrag(true);
    try{
      const result=await desktop.openDroppedProject(file);
      if(live.current&&!result.ok)setFeedback({text:result.error||'项目未能打开',error:true});
    }catch{if(live.current)setFeedback({text:'项目未能打开，请检查本地服务',error:true});}
    finally{if(live.current){setOpeningProject(false);setPending(value=>value-1);}}
  }
  async function placeMediaFile(event:DragEvent,file:File) {
    const target=externalMediaTarget(event);
    if(!target){setFeedback({text:'请将媒体拖入普通媒体时间线或时间线空白处',error:true});return;}
    const latest=store.getSnapshot();if(!latest)return;
    const context=dropContext(fileSource(file),target);
    const availability=context?host.drag.hover(context):undefined;
    const command=context?host.drag.drop(context):undefined;
    if(!command){setFeedback({text:availability?.status==='disabled'?availability.reason:'当前位置不能接收媒体',error:true});return;}
    setPending(value=>value+1);finishScrub.current?.();finishResize.current?.();endDrag(true);
    try{
      const result=await bridge.placeMediaFile(file,latest,crypto.randomUUID(),Number(command.payload.startTick),typeof command.payload.timelineId==='string'?command.payload.timelineId:undefined);
      if(!live.current)return;
      await store.refresh();if(!live.current)return;
      if(!result.ok){setFeedback({text:result.error.message,error:true});return;}
      setFeedback({text:`已放置 ${file.name}`,error:false});
    }catch{if(live.current)setFeedback({text:'媒体放置未完成，请检查文件格式与本地服务',error:true});}
    finally{if(live.current)setPending(value=>value-1);}
  }
  function externalMediaTarget(event:DragEvent):DragTarget|undefined {
    const element=event.target instanceof Element?event.target:undefined;
    if(!element?.closest('[data-testid="timeline-workspace"]'))return undefined;
    const timelineId=element.closest<HTMLElement>('[data-timeline-id]')?.dataset.timelineId;
    if(!timelineId)return{role:'timeline.position',object:projectRef,data:{startTick:0}};
    const track=element.closest<HTMLElement>('[data-testid="timeline-track"]');
    const timeline=store.getSnapshot()?.document.timelines[timelineId];
    if(!track||!timeline)return undefined;
    return{role:'timeline.position',object:{kind:'timeline',projectId,id:timelineId},data:{startTick:positionTick(event.clientX,track.getBoundingClientRect().left,timeline.ticksPerSecond)}};
  }
  function fileHoverKind(event:DragEvent):MediaKind|undefined {
    const mime=Array.from(event.dataTransfer.items).find(item=>item.kind==='file')?.type;
    const kind=mime?.split('/')[0];
    return kind==='image'||kind==='video'||kind==='audio'?kind:undefined;
  }
  function fileSource(file:File):DragSource {
    return {role:'external.media',payload:{object:{kind:'project',projectId},kind:mediaMimeType(file).split('/')[0] as MediaKind}};
  }
  async function importFiles(event:DragEvent,scopeId?:string) {
    event.preventDefault();event.stopPropagation();
    if(!host.navigator.isInteractive(scopeId))return;
    const directory=Array.from(event.dataTransfer.items).some(item=>item.kind==='file'&&item.webkitGetAsEntry()?.isDirectory);
    if(directory){setFeedback({text:'素材库只接收媒体文件；项目文件夹请拖入主窗口',error:true});return;}
    const files=Array.from(event.dataTransfer.files);
    if(!files.length){setFeedback({text:'未找到可导入的媒体文件',error:true});return;}
    setPending(value=>value+1);
    try{
      for(const file of files){const current=store.getSnapshot();if(!live.current||!current)break;
        const context=dropContext(fileSource(file),{role:'asset-library',object:projectRef,data:{}},scopeId);
        if(!context||host.drag.drop(context)?.type!=='asset.import'){setFeedback({text:'素材库只接收支持的图片、音频或视频文件',error:true});break;}
        const result=await bridge.importFile(file,current,crypto.randomUUID());if(!live.current)break;await store.refresh();if(!live.current)break;
        if(!result.ok){setFeedback({text:result.error.message,error:true});break;}
        setFeedback({text:`已导入 ${file.name}`,error:false});
      }
    }catch{if(live.current)setFeedback({text:'素材导入未完成，请检查文件格式与本地服务',error:true});}finally{if(live.current)setPending(value=>value-1);}
  }
  function resizeBegin(event:PointerEvent,item:DeepReadonly<TimelineItemData>,edge:'start'|'end') {
    if(event.button!==0||!host.navigator.isInteractive(undefined))return;
    event.preventDefault();event.stopPropagation();
    finishResize.current?.();
    const pointerId=event.pointerId;const target=event.currentTarget;target.setPointerCapture(pointerId);
    const origin=event.clientX;const ticks=document!.timelines[item.timelineId]!.ticksPerSecond;let preview={id:item.id,startTick:item.startTick,durationTicks:item.durationTicks};
    const move=(moveEvent:globalThis.PointerEvent)=>{
      if(moveEvent.pointerId!==pointerId)return;
      const delta=Math.round((moveEvent.clientX-origin)/PX_PER_SECOND*2)*ticks/2;
      if(edge==='end')preview={...preview,durationTicks:Math.max(ticks/2,item.durationTicks+delta)};
      else{const start=Math.max(0,Math.min(item.startTick+item.durationTicks-ticks/2,item.startTick+delta));preview={...preview,startTick:start,durationTicks:item.startTick+item.durationTicks-start};}
      setResize(preview);
    };
    const stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',stop);if(target.hasPointerCapture(pointerId))target.releasePointerCapture(pointerId);finishResize.current=undefined;if(live.current)setResize(undefined);};
    const up=(upEvent:globalThis.PointerEvent)=>{if(upEvent.pointerId!==pointerId)return;stop();if(!live.current)return;
      const ctx=dropContext({role:'item.duration',payload:{object:{kind:'item',projectId:projectId,id:item.id},edge}},{role:'item.edge',object:{kind:'item',projectId:projectId,id:item.id},data:{startTick:preview.startTick,durationTicks:preview.durationTicks}});
      const command=ctx?host.drag.drop(ctx):undefined;if(command&&(preview.startTick!==item.startTick||preview.durationTicks!==item.durationTicks))void execute(command.type,command.payload as JsonObject);
    };
    const cancel=(cancelEvent:globalThis.PointerEvent)=>{if(cancelEvent.pointerId===pointerId)stop();};
    finishResize.current=stop;
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);window.addEventListener('blur',stop);
  }
  const refTarget=(itemId:string):DragTarget=>({role:'item.reference',object:{kind:'item',projectId:projectId,id:itemId},data:{}});
  const projectRef={kind:'project' as const,projectId:projectId};

  function canReferenceDrop(itemId:string,scopeId?:string) {
    const source=dragging?.source;if(source?.role!=='asset')return false;
    const ctx=dropContext(source,refTarget(itemId),scopeId);
    return Boolean(ctx && host.drag.hover(ctx).status==='available');
  }
  function hasReferenceContext(item:DeepReadonly<TimelineItemData>,model:TimelineDeclaration|undefined,scopeId?:string) {
    return Boolean(model?.capabilities.references && model.maxReferences>0 && (item.referenceAssetIds.length>0 || canReferenceDrop(item.id,scopeId)));
  }

  function library() {
    if(!document)return null;
    const source=dragging?.source;
    return <div className={`context-library ${source?.role==='item'?'context-library--target':''}`} data-testid="asset-library"
      onDragOver={event=>{if(externalFiles(event)){
        event.preventDefault();event.stopPropagation();const kind=fileHoverKind(event);
        const context=kind?dropContext({role:'external.media',payload:{object:projectRef,kind}},{role:'asset-library',object:projectRef,data:{}}):undefined;
        event.dataTransfer.dropEffect=host.navigator.isInteractive(undefined)&&(!kind||(context&&host.drag.hover(context).status==='available'))?'copy':'none';
      }else dragOver(event,{role:'asset-library',object:projectRef,data:{}});}}
      onDrop={event=>{if(externalFiles(event))void importFiles(event);else drop(event,{role:'asset-library',object:projectRef,data:{}});}}>
      {allAssets.length?<div className="asset-grid">{allAssets.map(asset=>{
        const object:ObjectRef={kind:'asset',projectId:projectId,id:asset.id};
        return <div key={asset.id} className="asset-card" data-testid="asset-card" data-asset-id={asset.id} tabIndex={0} role="group" draggable aria-label={String(asset.metadata.name ?? '素材')}
          onDoubleClick={()=>open(object)} onKeyDown={event=>objectKeys(event,object)} onContextMenu={event=>context(event,object)}
          onDragStart={event=>beginDrag(event,{role:'asset',payload:{object:{kind:'asset',projectId:projectId,id:asset.id}}})}>
          <div className="asset-card__preview"><MediaPreview asset={asset}/></div><p>{String(asset.metadata.name ?? '素材')}</p>
        </div>;
      })}</div>:<div className="library-empty"><p className="pixel-description">拖入素材</p></div>}
    </div>;
  }

  function details() {
    if(!current||!document)return null;
    const object=current.object;const scope=current.scopeId;const storedPath=fieldPaths.get(scope) ?? [];
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
    const model=declarationForTimeline(models,timeline);if(!model)return null;
    const editingDefaults=!item&&storedPath[0]==='itemDefaults';
    const nestedPath=editingDefaults?storedPath.slice(1):storedPath;
    const defaults={...structuredClone(model.paramsDefaults),...structuredClone(timeline.itemDefaults ?? {})} as JsonObject;
    const values=(item?item.params:editingDefaults?defaults:timeline.settings) as JsonObject;
    const schema=item||editingDefaults?model.paramsJsonSchema:model.settingsJsonSchema;
    const fields=editingDefaults?model.defaultFields:model.fields.filter(field=>field.scope===(item?'itemParams':'settings'));
    // Only the edited top-level default is persisted. Displaying built-in defaults
    // must not turn every visible field into an explicit timeline override.
    const commitDefault=(fieldPath:FieldPath,replacement:JsonValue)=>{
      const updated=withPath(defaults,fieldPath,replacement);const key=String(fieldPath[0]);
      return execute('timeline.defaults',{timelineId:timeline.id,itemDefaults:{...(structuredClone(timeline.itemDefaults ?? {}) as JsonObject),[key]:updated[key]!}},scope);
    };
    const commit=(replacement:JsonObject)=>editingDefaults?commitDefault(nestedPath,atPath(replacement,nestedPath)!):
      execute(item?'item.params':'timeline.settings',item?{itemId:item.id,params:replacement}:{timelineId:timeline.id,settings:replacement},scope);
    const openField=(fieldPath:FieldPath)=>open(object as ObjectRef,scope,editingDefaults?['itemDefaults',...fieldPath]:fieldPath);
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
        <div className="detail-summary"><PixelBadge tone="green">{shortModel(model)}</PixelBadge><span className="pixel-description">{item?'片段参数':model.capabilities.generation?'时间线默认配置':'时间线详情'}</span></div>
      </>}
      {visibleFields.filter(field=>!field.visibleWhen||JSON.stringify(values[field.visibleWhen.field])===JSON.stringify(field.visibleWhen.equals)).map(field=>{
        const fieldPath=[...prefix,field.key];
        const value=atPath(values,fieldPath);
        return <FieldEditor key={`${scope}:${field.key}`} field={field} value={editingDefaults&&value===undefined?defaultFromSchema(schemaAtPath(schema,fieldPath)):value} schema={schemaAtPath(schema,fieldPath)} disabled={pending>0}
          onCommit={value=>commit(withPath(values,fieldPath,value))} onOpen={()=>openField(fieldPath)}/>;
      })}
      {!visibleFields.length && (item||storedPath.length>0||!model.capabilities.generation) && <PixelEmpty title="无需额外设置" description={model.capabilities.generation?'模型使用时间线的默认设置':model.description}/>}
      {!item&&!storedPath.length&&model.capabilities.generation&&<>
        <p className="pixel-description">修改只用于新建片段；右键时间轴左侧选择“刷新时间轴默认配置”可应用到已有片段。</p>
        {model.defaultFields.filter(field=>!field.visibleWhen||JSON.stringify(defaults[field.visibleWhen.field])===JSON.stringify(field.visibleWhen.equals)).map(field=><FieldEditor key={`${scope}:default:${field.key}`} field={field} value={defaults[field.key]} schema={schemaAtPath(model.paramsJsonSchema,[field.key])} disabled={pending>0}
          onCommit={value=>commitDefault([field.key],value)} onOpen={()=>open(object as ObjectRef,scope,['itemDefaults',field.key])}/>)}
      </>}
      {item && !nestedPath.length && <>
        {hasReferenceContext(item,model,scope)&&<div className={`reference-zone ${canReferenceDrop(item.id,scope)?'reference-zone--active':''}`} data-testid="item-reference"
          onDragOver={event=>dragOver(event,refTarget(item.id),scope)} onDrop={event=>drop(event,refTarget(item.id),scope)}>
          <span className="pixel-title"><PixelIcon name="reference"/> 参考素材</span>
          {item.referenceAssetIds.map(id=>{const asset=document.assets[id];return asset?<div key={id} className="reference-card" tabIndex={0} onDoubleClick={()=>open({kind:'asset',projectId:projectId,id},scope)} onKeyDown={event=>objectKeys(event,{kind:'asset',projectId:projectId,id},scope)} onContextMenu={event=>context(event,{kind:'asset',projectId:projectId,id},scope)}><MediaPreview asset={asset}/><span>{String(asset.metadata.name ?? '参考图像')}</span></div>:null;})}
        </div>}
        {item.outputAssetId && <div className="detail-link" tabIndex={0} onDoubleClick={()=>open({kind:'asset',id:item.outputAssetId!,projectId:projectId},scope)} onKeyDown={event=>objectKeys(event,{kind:'asset',id:item.outputAssetId!,projectId:projectId},scope)}><PixelIcon name="image"/>{model.capabilities.generation?'生成输出':'输出媒体'}<span><PixelIcon name="chevron"/></span></div>}
        {model.capabilities.generation && latestJob(item.id) && <div className="job-detail"><PixelProgress value={latestJob(item.id)!.progress} label={stateTitles[latestJob(item.id)!.state] ?? '生成任务'}/>{latestJob(item.id)!.error&&<p className="pixel-description">{latestJob(item.id)!.error!.message}</p>}</div>}
      </>}
    </div>;
  }
  const currentObject=current?.object;
  const currentTimeline=currentObject?.kind==='timeline'?document?.timelines[currentObject.id]:undefined;
  const currentType=declarationForTimeline(models,currentTimeline);
  const currentField=fieldPaths.get(current?.scopeId ?? '')?.at(-1);
  const modalTitle=currentField!==undefined?(typeof currentField==='number'?`音乐段落 ${currentField+1}`:fieldLabel({key:currentField,label:currentField,scope:'itemParams',valueType:'string'})):
    currentObject?.kind==='project'?'作品详情':currentObject?.kind==='timeline'?(currentType?.capabilities.generation?'时间线默认配置':'时间线详情'):currentObject?.kind==='asset'?'素材详情':'片段详情';

  const modal = <PixelModalHost standalone={detailMode||libraryMode} windowControls={detailMode||libraryMode ? <WindowControls browserClose={libraryMode?()=>windows.close():undefined} /> : undefined} open={Boolean(current)} title={modalTitle} depth={path.length}
    description={path.length>1?path.map((frame,index)=>index===path.length-1?modalTitle:frame.object.kind==='item'?'片段':frame.object.kind==='timeline'?'时间线':frame.object.kind==='asset'?'素材':'作品').join(' / '):undefined}
    onBack={()=>{setMenu(undefined);setDragging(undefined);setDropHint(undefined);host.navigator.pop();}}><div data-testid="modal-host">{details()}</div></PixelModalHost>;
  if (detailMode) return <div className="detail-window" onDragEnd={()=>endDrag()}>
    {modal}
    {(pending>0||feedback.text)&&<span className={`detail-feedback ${feedback.error?'feedback--error':''}`} role="status" aria-live="polite">{pending?'正在保存…':feedback.text}</span>}
    {menu&&<PixelContextMenu key={menu.items[0]?.id} x={menu.x} y={menu.y} items={menu.items} onClose={()=>setMenu(undefined)}/>}
  </div>;
  if (libraryMode) return <>
    <PixelWindowHost kind="library" title={<span className="library-title"><PixelIcon name="folder"/>素材库</span>} controls={<WindowControls browserClose={()=>windows.close()}/>} inert={Boolean(current)} data-testid="library-window" tabIndex={0}
      onDragEnd={()=>endDrag()} onKeyDown={event=>{if(event.key==='Escape'&&!current&&!menu&&!event.defaultPrevented){event.preventDefault();windows.close();}}}>
      <main className="library-workspace">{library()}</main>
      {(pending>0||feedback.text)&&<span className={`detail-feedback ${feedback.error?'feedback--error':''}`} role="status" aria-live="polite">{pending?'正在保存…':feedback.text}</span>}
    </PixelWindowHost>
    {modal}
    {menu&&<PixelContextMenu key={menu.items[0]?.id} x={menu.x} y={menu.y} items={menu.items} onClose={()=>setMenu(undefined)}/>}
  </>;

  return <PixelWindowHost data-testid="project-workspace" onDragOverCapture={projectDragOver} onDropCapture={event=>{void projectDrop(event);}} onDragEnd={()=>endDrag()} title={<div className="project-name" tabIndex={0} role="group" aria-label="作品详情" onDoubleClick={()=>open(projectRef)} onKeyDown={event=>objectKeys(event,projectRef)}><PixelIcon name="folder"/>{document?.title ?? '正在打开作品'}</div>} controls={<WindowControls/>}>
    <main className="workbench-main">
      
      <div className="upper-workspace">
        <PixelPanel className="viewer-panel">
          <div className="viewer-canvas" data-testid="viewer" tabIndex={0} role="group" aria-label="作品预览" onDoubleClick={()=>{if(selectedAsset)open({kind:'asset',projectId:projectId,id:selectedAsset.id});}}
            onContextMenu={event=>{event.preventDefault();event.stopPropagation();viewerMenuAt(event.clientX,event.clientY);}}
            onKeyDown={event=>{
              if(event.key==='Enter'&&selectedAsset){event.preventDefault();open({kind:'asset',projectId:projectId,id:selectedAsset.id});}
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
              const model=declarationForTimeline(models,timeline);const kind=model?.outputKind ?? 'text';const obj:ObjectRef={kind:'timeline',projectId:projectId,id:timeline.id};
              return <div key={timeline.id} className="timeline-row" data-testid="timeline-row" data-timeline-id={timeline.id}>
                <div className="timeline-label" data-testid="timeline-label" tabIndex={0} role="group" aria-label={`${shortModel(model)}${model?.capabilities.generation?'时间线默认配置':'时间线详情'}`} onClick={()=>{if(host.navigator.isInteractive(undefined)){setSelected(obj);open(obj);}}} onKeyDown={event=>objectKeys(event,obj)} onContextMenu={event=>context(event,obj)}>
                  <div className={`track-icon track-icon--${kind}`}>{kind==='video'?'V':kind==='image'?'I':kind==='audio'?'A':'T'}{index+1}</div><strong>{shortModel(model)}</strong>
                </div>
                <div className="timeline-track" data-testid="timeline-track" style={{width:trackWidth}} onContextMenu={event=>context(event,obj,undefined,false,{role:'timeline.position',startTick:positionTick(event.clientX,event.currentTarget.getBoundingClientRect().left,timeline.ticksPerSecond)})} onDragOver={event=>dragOver(event,targetAt(event,timeline.id))} onDrop={event=>drop(event,targetAt(event,timeline.id))} onDragLeave={()=>setDropHint(undefined)}>
                  {timeline.itemIds.map(id=>{const item=document!.items[id];if(!item)return null;const view=resize?.id===id?resize:item;const job=latestJob(id);const ref:ObjectRef={kind:'item',projectId:projectId,id};
                    return <div key={id} className={`timeline-item timeline-item--${kind} ${selected?.kind==='item'&&selected.id===id?'timeline-item--selected':''}`} data-testid="timeline-item" data-item-id={id}
                      style={{left:view.startTick/timeline.ticksPerSecond*PX_PER_SECOND,width:Math.max(24,view.durationTicks/timeline.ticksPerSecond*PX_PER_SECOND)}} draggable tabIndex={0} role="group" aria-label={`片段 ${itemTitle(item)}`}
                      onClick={()=>{if(host.navigator.isInteractive(undefined)){setSelected(ref);seekPlayback(item.startTick/timeline.ticksPerSecond*1000);}}} onDoubleClick={()=>open(ref)} onKeyDown={event=>objectKeys(event,ref)} onContextMenu={event=>context(event,ref)} onDragStart={event=>beginDrag(event,{role:'item',payload:{object:ref as {kind:'item';projectId:string;id:string}}},timeline.ticksPerSecond)}>
                      <div className="item-edge item-edge--start" data-testid="item-edge-start" onPointerDown={event=>resizeBegin(event,item,'start')}/>
                      <div className="item-body"><span className="item-title"><PixelIcon name={iconFor(kind)}/>{itemTitle(item)}</span><span className="item-caption">{time(view.durationTicks/timeline.ticksPerSecond)} <span>·</span> {job?stateTitles[job.state]:item.outputAssetId?'就绪':model?.capabilities.generation?'草稿':'参考文本'}</span></div>
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
    {(pending>0||feedback.text)&&<div className={`workspace-feedback ${feedback.error?'feedback--error':''}`} role="status" aria-live="polite">{openingProject?'正在打开作品…':pending?'正在保存…':feedback.text}</div>}
    {!desktop&&modal}
    {menu&&<PixelContextMenu key={menu.items[0]?.id} x={menu.x} y={menu.y} items={menu.items} onClose={()=>setMenu(undefined)}/>}
  </PixelWindowHost>;
}

function WindowControls({browserClose}:{browserClose?:(()=>void)|undefined}={}) {
  const desktop = window.pixelDesktop;
  const [maximized, setMaximized] = useState(false);
  useEffect(()=>{
    if (!desktop) return;
    void desktop.isMaximized().then(setMaximized);
    return desktop.onMaximizedChanged(setMaximized);
  },[desktop]);
  if (!desktop) return browserClose?<div className="window-controls" data-pixel-window-controls><button type="button" className="window-close" aria-label="关闭窗口" onClick={browserClose}><PixelIcon name="close"/></button></div>:null;
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
