import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { AssetData, DeepReadonly, GenerationJob, JsonObject, JsonValue, ObjectRef, ProjectSnapshot, TimelineItemData } from '../src/contracts.js';
import { ActionClient, ProjectProjectionStore, type DragSource, type DragTarget } from '../src/frontend.js';
import type { ModelDeclaration } from '../src/models.js';
import type { PluginFieldDeclaration } from '../src/plugins.js';
import { HttpDesktopBridge, assetUrl } from './bridge.js';
import { createInteractionHost } from './interaction.js';
import { atPath, defaultFromSchema, FieldEditor, fieldLabel, schemaAtPath, withPath, type FieldPath } from './fields.js';
import { PixelBadge, PixelContextMenu, PixelEmpty, PixelField, PixelIcon, PixelInput, PixelModalHost, PixelPanel, PixelProgress, PixelSelect, type PixelContextMenuItem } from './ui/index.js';

const PROJECT_ID = 'pixel-project';
const MIME = 'application/x-pixel-object';
const PX_PER_SECOND = 32;
const stateTitles: Record<string,string> = {queued:'排队中',running:'正在生成',cancelRequested:'正在取消',canceled:'已取消',succeeded:'已完成',failed:'生成失败',interrupted:'等待恢复'};
function time(seconds: number): string { return `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(Math.floor(seconds % 60)).padStart(2,'0')}`; }
function shortModel(model: ModelDeclaration | undefined): string {
  if (!model) return '未知模型';
  return ({'alibaba/wan-3.0':'Wan 3.0','x-ai/grok-imagine-image-2.0':'Grok Image 2.0',music_v2_5:'Music v2.5',eleven_v4:'Eleven v4',eleven_text_to_sound_v2:'Sound Effects v2'} as Record<string,string>)[model.modelId] ?? model.title;
}
function iconFor(kind: string): string { return kind === 'video'?'frames':kind === 'image'?'image':kind.includes('speech')?'voice':'music'; }
function itemTitle(item: DeepReadonly<TimelineItemData>): string { return String(item.params.prompt || item.params.text || (item.kind.includes('speech')?'未填写的对白':'新的创作片段')); }
function MediaPreview({asset,large = false}: {asset:DeepReadonly<AssetData>;large?:boolean}) {
  const ref = useRef<HTMLMediaElement | null>(null);
  const [playing,setPlaying] = useState(false);
  const play = () => {
    const media=ref.current;
    if (!media) return;
    if(media.paused) void media.play().catch(()=>{}); else media.pause();
  };
  if(asset.kind === 'image') return <img className={large?'media-large':'media-thumb'} src={assetUrl(asset.id)} alt={String(asset.metadata.name ?? '作品图像')}/>;
  return <div className={`media-playback ${large?'media-playback--large':''}`} tabIndex={0} role="group" aria-label="媒体预览，按空格播放或暂停"
    onKeyDown={event=>{if(event.key===' '){event.preventDefault();play();}}}>
    {asset.kind === 'video' ? <video ref={element=>{ref.current=element;}} src={assetUrl(asset.id)} preload="metadata" onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)}/>
      : <><audio ref={element=>{ref.current=element;}} src={assetUrl(asset.id)} preload="metadata" onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)}/><div className="audio-art"><PixelIcon name="music"/>{Array.from({length:27},(_,i)=><i key={i} style={{height:`${12+(i*37%86)}px`}}/>)}</div></>}

  </div>;
}

export function App() {
  const [models,setModels] = useState<ModelDeclaration[]>([]);
  const [jobs,setJobs] = useState<GenerationJob[]>([]);
  const modelsRef=useRef(models);modelsRef.current=models;
  const jobsRef=useRef(jobs);jobsRef.current=jobs;
  const [bridge]=useState(()=>new HttpDesktopBridge());
  const [store]=useState(()=>new ProjectProjectionStore({projectId:PROJECT_ID,bridge,onError:()=>setFeedback({text:'连接中断，等待重新读取项目',error:true})}));
  const [client]=useState(()=>new ActionClient(bridge));
  const [host]=useState(()=>createInteractionHost(PROJECT_ID,()=>modelsRef.current,()=>jobsRef.current));
  const snapshot=useSyncExternalStore(listener=>store.subscribe(listener),()=>store.getSnapshot());
  const path=useSyncExternalStore(listener=>host.navigator.subscribe(listener),()=>host.navigator.getPath());
  const [connected,setConnected]=useState(false);
  const [providers,setProviders]=useState({elevenlabs:false,openrouter:false});
  const [pending,setPending]=useState(0);
  const [feedback,setFeedback]=useState({text:'',error:false});
  const [selected,setSelected]=useState<ObjectRef | undefined>();
  const [menu,setMenu]=useState<{x:number;y:number;items:PixelContextMenuItem[]} | undefined>();
  const [filter,setFilter]=useState('all');
  const [dragging,setDragging]=useState<{source:DragSource;offsetTicks:number} | undefined>();
  const [dropHint,setDropHint]=useState<{id:string;tick:number;valid:boolean} | undefined>();
  const [resize,setResize]=useState<{id:string;startTick:number;durationTicks:number} | undefined>();
  const [fieldPaths]=useState(()=>new Map<string,FieldPath>());
  const current=path.at(-1);
  const document=snapshot?.document;
  const timelines=Object.values(document?.timelines ?? {});
  const selectedItem=selected?.kind==='item'?document?.items[selected.id]:undefined;
  const selectedAsset=selected?.kind==='asset'?document?.assets[selected.id]:selectedItem?.outputAssetId?document?.assets[selectedItem.outputAssetId]:undefined;
  const selectedModel=models.find(model=>model.modelId===document?.timelines[selectedItem?.timelineId ?? '']?.modelId);
  const latestJob=(itemId:string)=>jobs.filter(job=>job.request.targetItemId===itemId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  const selectedJob=selectedItem?latestJob(selectedItem.id):undefined;
  const allAssets=Object.values(document?.assets ?? {}).filter(asset=>asset.metadata.librarySaved===true);
  const assets=allAssets.filter(asset=>filter==='all'||asset.kind===filter);
  const activeJobs=jobs.filter(job=>['queued','running','cancelRequested'].includes(job.state));
  const seconds=Math.max(36,...Object.values(document?.items ?? {}).map(item=>(item.startTick+item.durationTicks)/(document?.timelines[item.timelineId]?.ticksPerSecond ?? 1000)+4));
  const trackWidth=Math.ceil(seconds/2)*2*PX_PER_SECOND;

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
      setConnected(value);
      if(value){
        void store.refresh().catch(()=>{});
        void bridge.models(controller.signal).then(result=>setModels(result.items)).catch(()=>{});
        void bridge.status(controller.signal).then(status=>setProviders(status.providers)).catch(()=>{});
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
    if(!selected || (selected.kind==='item'&&!Object.hasOwn(snapshot.document.items,selected.id)) || (selected.kind==='asset'&&!Object.hasOwn(snapshot.document.assets,selected.id))) {
      const first=Object.values(snapshot.document.items)[0];
      setSelected(first?{kind:'item',projectId:PROJECT_ID,id:first.id}:undefined);
    }
  },[snapshot,host,selected]);

  async function execute(type:string,payload:JsonObject,scopeId?:string):Promise<boolean> {
    const latest=store.getSnapshot();
    if(!latest || !host.navigator.isInteractive(scopeId))return false;
    setPending(value=>value+1);
    try {
      const result=await client.execute({requestId:crypto.randomUUID(),projectId:PROJECT_ID,expectedRevision:latest.revision,type,payload});
      await store.refresh();
      if(!result.ok){setFeedback({text:result.error.message,error:true});return false;}
      setFeedback({text:type==='generation.submit'?'生成任务已提交':'已保存',error:false});
      if(typeof result.outcome.itemId==='string' && type==='timeline.create')setSelected({kind:'item',projectId:PROJECT_ID,id:result.outcome.itemId});
      return true;
    }catch{setFeedback({text:'本地连接中断，修改尚未确认，请检查后端状态',error:true});return false;}
    finally{setPending(value=>value-1);}
  }
  function open(object:ObjectRef,scopeId?:string,fieldPath?:FieldPath) {
    if(!host.navigator.isInteractive(scopeId))return;
    setMenu(undefined);
    const frame=scopeId?host.navigator.push(object):host.navigator.open(object);
    if(fieldPath)fieldPaths.set(frame.scopeId,fieldPath);
  }
  function objectKeys(event:KeyboardEvent,object:ObjectRef,scopeId?:string) {
    if(event.key==='Enter'){event.preventDefault();open(object,scopeId);}
    if(event.key==='ContextMenu'||(event.key==='F10'&&event.shiftKey)){
      event.preventDefault();const box=event.currentTarget.getBoundingClientRect();contextAt(box.left+24,box.top+24,object,scopeId);
    }
  }
  function contextAt(x:number,y:number,target:ObjectRef,scopeId?:string,createOnly=false) {
    const project=store.getSnapshot();if(!project||!host.navigator.isInteractive(scopeId))return;
    const context={target,project,...(scopeId?{scopeId}: {})};
    const actions=host.menu.list(context);
    if(createOnly) {
      if(!actions.some(action=>action.id==='timeline.create'))return;
      setMenu({x,y,items:models.map(model=>({id:model.modelId,label:model.title,description:model.outputKind==='video'?'视频时间线':model.outputKind==='image'?'图像时间线':'音频时间线',onSelect:()=>{
        const command=host.menu.commandFor('timeline.create',context);if(command)void execute(command.type,{...command.payload,modelId:model.modelId},scopeId);
      }}))});return;
    }
    const items=actions.filter(action=>action.id!=='timeline.create').map(action=>({
      id:action.id,label:action.id==='generation.submit'&&document?.items['id' in target?target.id:'']?.outputAssetId?'重新生成':action.title,
      ...(action.availability.status==='disabled'?{description:action.availability.reason,disabled:true}:{}),
      onSelect:()=>{const latest=store.getSnapshot();if(!latest)return;const command=host.menu.commandFor(action.id,{...context,project:latest});if(command)void execute(command.type,command.payload as JsonObject,scopeId);},
    }));
    if(items.length)setMenu({x,y,items});
  }
  function context(event:React.MouseEvent,target:ObjectRef,scopeId?:string,createOnly=false) {
    if((event.target as HTMLElement).closest('input,textarea,select'))return;
    event.preventDefault();event.stopPropagation();contextAt(event.clientX,event.clientY,target,scopeId,createOnly);
  }
  function beginDrag(event:DragEvent,source:DragSource,ticksPerSecond=1000) {
    if(!host.navigator.isInteractive(undefined)){event.preventDefault();return;}
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
    if(availability.status==='disabled')setFeedback({text:availability.reason,error:true});
  }
  function drop(event:DragEvent,target:DragTarget,scopeId?:string) {
    event.preventDefault();event.stopPropagation();const data=dragSource(event);setDragging(undefined);setDropHint(undefined);
    if(!data)return;const ctx=dropContext(data.source,target,scopeId);if(!ctx)return;const command=host.drag.drop(ctx);
    if(command)void execute(command.type,command.payload as JsonObject,scopeId);
  }
  function targetAt(event:DragEvent,timelineId:string):DragTarget {
    const timeline=document!.timelines[timelineId]!;
    const tick=Math.max(0,Math.round(((event.clientX-event.currentTarget.getBoundingClientRect().left)/PX_PER_SECOND*timeline.ticksPerSecond-(dragging?.offsetTicks ?? 0))/(timeline.ticksPerSecond/2))*(timeline.ticksPerSecond/2));
    return {role:'timeline.position',object:{kind:'timeline',projectId:PROJECT_ID,id:timelineId},data:{startTick:tick}};
  }
  async function importFiles(event:DragEvent) {
    const files=Array.from(event.dataTransfer.files);if(!files.length)return;
    if(!host.navigator.isInteractive(undefined))return;
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

  function details() {
    if(!current||!document)return null;
    const object=current.object;const scope=current.scopeId;const nestedPath=fieldPaths.get(scope) ?? [];
    if(object.kind==='project')return <div className="details-stack">
      <PixelField label="作品名称"><TitleField title={document.title} onCommit={title=>execute('project.title',{title},scope)}/></PixelField>
      <p className="pixel-description">{timelines.length} 条时间线 · {Object.keys(document.items).length} 个片段 · {allAssets.length} 份素材</p>
      {timelines.map(timeline=><div key={timeline.id} className="detail-link" tabIndex={0} onDoubleClick={()=>open({kind:'timeline',id:timeline.id,projectId:PROJECT_ID},scope)} onKeyDown={event=>objectKeys(event,{kind:'timeline',id:timeline.id,projectId:PROJECT_ID},scope)}><PixelIcon name="timeline"/>{shortModel(models.find(model=>model.modelId===timeline.modelId))}<span><PixelIcon name="chevron"/></span></div>)}
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
        <div className={`reference-zone ${dragging?.source.role==='asset'?'reference-zone--active':''}`} data-testid="item-reference"
          onDragOver={event=>dragOver(event,refTarget(item.id),scope)} onDrop={event=>drop(event,refTarget(item.id),scope)}>
          <span className="pixel-title"><PixelIcon name="reference"/> 参考素材</span><p className="pixel-description">{model.maxReferences?`最多 ${model.maxReferences} 张`:'不接受参考素材'}</p>
          {item.referenceAssetIds.map(id=>{const asset=document.assets[id];return asset?<div key={id} className="reference-card" tabIndex={0} onDoubleClick={()=>open({kind:'asset',projectId:PROJECT_ID,id},scope)} onKeyDown={event=>objectKeys(event,{kind:'asset',projectId:PROJECT_ID,id},scope)} onContextMenu={event=>context(event,{kind:'asset',projectId:PROJECT_ID,id},scope)}><MediaPreview asset={asset}/><span>{String(asset.metadata.name ?? '参考图像')}</span></div>:null;})}
        </div>
        {item.outputAssetId && <div className="detail-link" tabIndex={0} onDoubleClick={()=>open({kind:'asset',id:item.outputAssetId!,projectId:PROJECT_ID},scope)} onKeyDown={event=>objectKeys(event,{kind:'asset',id:item.outputAssetId!,projectId:PROJECT_ID},scope)}><PixelIcon name="image"/>生成输出<span><PixelIcon name="chevron"/></span></div>}
        {latestJob(item.id) && <div className="job-detail"><PixelProgress value={latestJob(item.id)!.progress} label={stateTitles[latestJob(item.id)!.state] ?? '生成任务'}/>{latestJob(item.id)!.error&&<p className="pixel-description">{latestJob(item.id)!.error!.message}</p>}</div>}
      </>}
    </div>;
  }
  const currentObject=current?.object;
  const currentField=fieldPaths.get(current?.scopeId ?? '')?.at(-1);
  const modalTitle=currentField!==undefined?(typeof currentField==='number'?`音乐段落 ${currentField+1}`:fieldLabel({key:currentField,label:currentField,scope:'itemParams',valueType:'string'})):
    currentObject?.kind==='project'?'作品详情':currentObject?.kind==='timeline'?'时间线详情':currentObject?.kind==='asset'?'素材详情':'片段详情';

  return <div className="workbench" onDragEnd={()=>{setDragging(undefined);setDropHint(undefined);}}>
    <header className="app-header">
      <div className="wordmark"><svg width="28" height="28" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true"><path d="M0 0h7v7H0z" fill="currentColor"/><path d="M2 1h4v4H4v1H2zm1 1v2h2V2z" fill="var(--pixel-green-soft)"/></svg><strong>PIXEL</strong></div>
      <div className="project-name" tabIndex={0} role="group" aria-label="作品详情" onDoubleClick={()=>open(projectRef)} onKeyDown={event=>objectKeys(event,projectRef)}><PixelIcon name="folder"/>{document?.title ?? '正在打开作品'}</div>
      <div className="header-status"><span className={`status-dot ${connected?'status-dot--online':''}`}/><span>{connected?'本地已连接':'等待连接'}</span></div>
    </header>
    <main className="workbench-main">
      
      <div className="upper-workspace">
        <PixelPanel className="viewer-panel" title="作品预览" right={<PixelBadge tone={selectedAsset?'green':'neutral'}>{selectedAsset?'输出就绪':'等待输出'}</PixelBadge>}>
          <div className="viewer-canvas" data-testid="viewer" tabIndex={0} role="group" aria-label="作品预览" onDoubleClick={()=>{if(selectedAsset)open({kind:'asset',projectId:PROJECT_ID,id:selectedAsset.id});}} onKeyDown={event=>{if(event.key==='Enter'&&selectedAsset)open({kind:'asset',projectId:PROJECT_ID,id:selectedAsset.id});}}
            draggable={Boolean(selectedAsset)} onDragStart={event=>{if(!selectedAsset){event.preventDefault();return;}event.dataTransfer.setData('DownloadURL',`${String(selectedAsset.metadata.mimeType)}:pixel-${selectedAsset.id}.${String(selectedAsset.metadata.extension ?? 'bin')}:${location.origin}${assetUrl(selectedAsset.id)}`);event.dataTransfer.setData('text/uri-list',`${location.origin}${assetUrl(selectedAsset.id)}`);}}>
            {selectedAsset?<MediaPreview asset={selectedAsset} large/>:<div className="viewer-placeholder">
              <svg className="pixel-landscape" viewBox="0 0 320 136" aria-hidden="true" shapeRendering="crispEdges"><path d="M0 0h320v136H0z" fill="#e7e9d9"/><path d="M232 20h28v28h-28z" fill="#dcc390"/><path d="M0 88h16V72h24V56h24V40h24v16h20v16h28v24h24v40H0z" fill="#acba9f"/><path d="M176 88h16V68h20V52h20v20h24v16h24v16h40v32H176z" fill="#c5ceba"/><path d="M0 112h56V96h56v16h40v-8h32v16h64v-16h40v16h32v16H0z" fill="#7a9073"/><path d="M152 120h16v-16h16v32h-32z" fill="#e7e9d9"/></svg>
              <div className="viewer-placeholder__label"><PixelIcon name="frames"/></div>
            </div>}
            <span className="canvas-corner canvas-corner--tl"/><span className="canvas-corner canvas-corner--br"/>
          </div>
          <div className="viewer-meta"><span><span className="status-dot"/> {selectedItem?itemTitle(selectedItem).slice(0,30):selectedAsset?String(selectedAsset.metadata.name ?? '素材预览'):'未选择'}</span><span>{selectedModel?shortModel(selectedModel):'未选择片段'} <span className="meta-divider">/</span> {selectedItem?time(selectedItem.durationTicks/(document?.timelines[selectedItem.timelineId]?.ticksPerSecond ?? 1000)):'--:--'}</span></div>
          {selectedJob && <div className="viewer-job"><PixelProgress value={selectedJob.progress} label={stateTitles[selectedJob.state] ?? '生成任务'}/>{selectedJob.error&&<p className="job-error">{selectedJob.error.message}</p>}</div>}
        </PixelPanel>
        <PixelPanel className="library-panel" title="素材库" data-testid="asset-library" right={<PixelBadge>{String(allAssets.length).padStart(2,'0')}</PixelBadge>}
          onDragOver={event=>{if(event.dataTransfer.types.includes('Files')&&host.navigator.isInteractive(undefined)){event.preventDefault();event.dataTransfer.dropEffect='copy';}else dragOver(event,{role:'asset-library',object:projectRef,data:{}});}}
          onDrop={event=>{if(event.dataTransfer.files.length)void importFiles(event);else drop(event,{role:'asset-library',object:projectRef,data:{}});}}>
          <div className="library-filter"><PixelIcon name="folder"/><PixelSelect aria-label="素材类型" value={filter} onChange={event=>setFilter(event.target.value)}><option value="all">全部素材</option><option value="image">图像</option><option value="video">视频</option><option value="audio">音频</option></PixelSelect></div>
          <div className="library-content">
            {assets.length?<div className="asset-grid">{assets.map(asset=><div key={asset.id} className={`asset-card ${selected?.kind==='asset'&&selected.id===asset.id?'asset-card--selected':''}`} data-testid="asset-card" tabIndex={0} role="group" draggable
              onClick={()=>setSelected({kind:'asset',projectId:PROJECT_ID,id:asset.id})} onDoubleClick={()=>open({kind:'asset',projectId:PROJECT_ID,id:asset.id})} onKeyDown={event=>objectKeys(event,{kind:'asset',projectId:PROJECT_ID,id:asset.id})}
              onContextMenu={event=>context(event,{kind:'asset',projectId:PROJECT_ID,id:asset.id})} onDragStart={event=>beginDrag(event,{role:'asset',payload:{object:{kind:'asset',projectId:PROJECT_ID,id:asset.id}}})}>
              <div className="asset-card__preview"><MediaPreview asset={asset}/><span><PixelIcon name={iconFor(asset.kind)}/></span></div><p>{String(asset.metadata.name ?? '生成素材')}</p>
            </div>)}</div>:<div className="library-empty"><div className="library-drop-icon"><PixelIcon name="folder"/><span>+</span></div></div>}
          </div>
        </PixelPanel>
      </div>
      <PixelPanel className="timeline-panel" title="时间线" right={<span className="pixel-description">{String(timelines.length).padStart(2,'0')} 条轨道</span>}>
        <div className="timeline-scroll" data-testid="timeline-workspace" onContextMenu={event=>context(event,projectRef,undefined,true)} tabIndex={0} role="group" aria-label="时间线工作区" onKeyDown={event=>{if(event.target===event.currentTarget&&(event.key==='ContextMenu'||(event.key==='F10'&&event.shiftKey))){event.preventDefault();const box=event.currentTarget.getBoundingClientRect();contextAt(box.left+220,box.top+40,projectRef,undefined,true);}}}>
          <div className="timeline-content" style={{minWidth:trackWidth+196}}>
            <div className="timeline-ruler"><div className="timeline-label timeline-label--ruler"><PixelIcon name="timeline"/>模型 / 片段</div><div className="ruler-track" style={{width:trackWidth}}>{Array.from({length:Math.ceil(seconds/2)+1},(_,i)=><span key={i} style={{left:i*2*PX_PER_SECOND}}>{time(i*2)}</span>)}</div></div>
            {timelines.map((timeline,index)=>{
              const model=models.find(candidate=>candidate.modelId===timeline.modelId);const kind=model?.outputKind ?? 'video';const obj:ObjectRef={kind:'timeline',projectId:PROJECT_ID,id:timeline.id};
              return <div key={timeline.id} className="timeline-row" data-testid="timeline-row" data-timeline-id={timeline.id}>
                <div className="timeline-label" tabIndex={0} role="group" onDoubleClick={()=>open(obj)} onKeyDown={event=>objectKeys(event,obj)} onContextMenu={event=>context(event,obj)}>
                  <div className={`track-icon track-icon--${kind}`}><PixelIcon name={iconFor(kind)}/></div><div><strong>{shortModel(model)}</strong><span>{kind==='video'?'视频':kind==='image'?'图像':'音频'} <span className="meta-divider">/</span> {String(index+1).padStart(2,'0')}</span></div>
                </div>
                <div className="timeline-track" data-testid="timeline-track" style={{width:trackWidth}} onDragOver={event=>dragOver(event,targetAt(event,timeline.id))} onDrop={event=>drop(event,targetAt(event,timeline.id))} onDragLeave={()=>setDropHint(undefined)}>
                  {timeline.itemIds.map(id=>{const item=document!.items[id];if(!item)return null;const view=resize?.id===id?resize:item;const job=latestJob(id);const ref:ObjectRef={kind:'item',projectId:PROJECT_ID,id};
                    return <div key={id} className={`timeline-item timeline-item--${kind} ${selected?.kind==='item'&&selected.id===id?'timeline-item--selected':''}`} data-testid="timeline-item" data-item-id={id}
                      style={{left:view.startTick/timeline.ticksPerSecond*PX_PER_SECOND,width:Math.max(24,view.durationTicks/timeline.ticksPerSecond*PX_PER_SECOND)}} draggable tabIndex={0} role="group" aria-label={`片段 ${itemTitle(item)}`}
                      onClick={()=>setSelected(ref)} onDoubleClick={()=>open(ref)} onKeyDown={event=>objectKeys(event,ref)} onContextMenu={event=>context(event,ref)} onDragStart={event=>beginDrag(event,{role:'item',payload:{object:ref as {kind:'item';projectId:string;id:string}}},timeline.ticksPerSecond)}>
                      <div className="item-edge item-edge--start" data-testid="item-edge-start" onPointerDown={event=>resizeBegin(event,item,'start')}/>
                      <div className="item-body"><span className="item-title"><PixelIcon name={iconFor(kind)}/>{itemTitle(item)}</span><span className="item-caption">{time(view.durationTicks/timeline.ticksPerSecond)} <span>·</span> {job?stateTitles[job.state]:item.outputAssetId?'素材':'草稿'}</span></div>
                      <div className="item-reference" data-testid="item-reference-drop" onDragOver={event=>dragOver(event,refTarget(id))} onDrop={event=>drop(event,refTarget(id))}><PixelIcon name="reference"/><span>参考 {item.referenceAssetIds.length}</span></div>
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
    <footer className="app-footer"><span className={feedback.error?'feedback--error':''} role="status" aria-live="polite"><PixelIcon name={feedback.error?'warning':'check'}/>{pending?'正在保存…':feedback.text}</span><span>{activeJobs.length?`${activeJobs.length} 个生成任务进行中`:'没有正在运行的生成任务'}<span className="meta-divider">/</span>{providers.openrouter&&providers.elevenlabs?'模型已配置':'检查模型配置'}<span className="meta-divider">/</span>rev {snapshot?.revision ?? '--'}</span></footer>
    <PixelModalHost open={Boolean(current)} title={modalTitle} description={path.length>1?`详情路径 / ${path.map((frame,index)=>index===path.length-1?modalTitle:frame.object.kind==='item'?'片段':frame.object.kind==='timeline'?'时间线':frame.object.kind==='asset'?'素材':'作品').join(' / ')}`:undefined} depth={path.length} onBack={()=>{setMenu(undefined);host.navigator.pop();}}><div data-testid="modal-host">{details()}</div></PixelModalHost>
    {menu&&<PixelContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={()=>setMenu(undefined)}/>}
  </div>;
}

function TitleField({title,onCommit}:{title:string;onCommit:(title:string)=>Promise<boolean>}) {
  const [draft,setDraft]=useState(title);const submitted=useRef(title);const discard=useRef(false);
  useEffect(()=>{setDraft(title);submitted.current=title;},[title]);
  const save=()=>{if(discard.current){discard.current=false;return;}if(draft!==submitted.current){submitted.current=draft;void onCommit(draft).then(ok=>{if(!ok)submitted.current=title;});}};
  return <PixelInput value={draft} onChange={event=>setDraft(event.target.value)} onBlur={save} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();save();}if(event.key==='Escape'){discard.current=true;setDraft(title);event.currentTarget.blur();}}}/>;
}
