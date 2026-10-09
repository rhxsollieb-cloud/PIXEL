import { useEffect, useRef, useState } from 'react';
import type { VoicePage, VoiceSummary } from '../src/voice-contracts.js';
import { mediaMimeType, readVoices } from './bridge.js';
import { PixelField, PixelInput, PixelSelect } from './ui/index.js';

const voiceStatus=(voice:VoiceSummary)=>voice.status==='verificationRequired'?'待验证':voice.status==='unavailable'?'不可用':'';

/** Provider choices enhance one string field; the field still commits one ID. */
export function ProviderVoiceField({label,value,disabled=false,refreshKey=0,onCommit}:{label:string;value:string;disabled?:boolean;refreshKey?:number;onCommit:(value:string)=>Promise<boolean>}) {
  const [source,setSource]=useState<'default'|'cloned'|'manual'>('default');
  const [search,setSearch]=useState('');
  const [page,setPage]=useState<VoicePage>({items:[]});
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const [draft,setDraft]=useState(value);
  const submitted=useRef(value);const discard=useRef(false);const active=useRef(true);const requestVersion=useRef(0);
  useEffect(()=>{active.current=true;return()=>{active.current=false;requestVersion.current++;};},[]);
  useEffect(()=>{setDraft(value);submitted.current=value;},[value]);
  useEffect(()=>{
    const version=++requestVersion.current;
    if(source==='manual'){setLoading(false);return;}
    const controller=new AbortController();
    setLoading(true);setError('');
    const timer=window.setTimeout(()=>{void readVoices({category:source,...(search.trim()?{search:search.trim()}: {})},controller.signal).then(result=>{
      if(!controller.signal.aborted&&requestVersion.current===version)setPage(result);
    }).catch(()=>{if(!controller.signal.aborted&&requestVersion.current===version){setPage({items:[]});setError('声音列表暂未读取，仍可手填声音 ID');}})
      .finally(()=>{if(!controller.signal.aborted&&requestVersion.current===version)setLoading(false);});},search?200:0);
    return()=>{controller.abort();window.clearTimeout(timer);};
  },[source,search,refreshKey]);
  const commit=async(next:string)=>{if(disabled||next===submitted.current)return;submitted.current=next;
    const ok=await onCommit(next);if(!active.current)return;if(!ok){submitted.current=value;setError('声音 ID 未保存，请检查输入');}else setError('');};
  const save=()=>{if(discard.current){discard.current=false;return;}void commit(draft);};
  const more=()=>{
    if(source==='manual'||!page.nextCursor||loading)return;
    const version=requestVersion.current;setLoading(true);
    void readVoices({category:source,cursor:page.nextCursor,...(search.trim()?{search:search.trim()}: {})}).then(result=>{
      if(active.current&&requestVersion.current===version)setPage(previous=>({items:[...previous.items,...result.items.filter(voice=>!previous.items.some(current=>current.voiceId===voice.voiceId))],...(result.nextCursor?{nextCursor:result.nextCursor}:{})}));
    }).catch(()=>{if(active.current&&requestVersion.current===version)setError('更多声音暂未读取，请稍后再试');}).finally(()=>{if(active.current&&requestVersion.current===version)setLoading(false);});
  };
  return <PixelField label={label} {...(error?{error}:{})}>
    <div className="voice-field">
      <PixelSelect aria-label="声音来源" value={source} disabled={disabled} onChange={event=>{setSource(event.target.value as typeof source);setSearch('');}}>
        <option value="default">默认声音</option><option value="cloned">我的克隆声纹</option><option value="manual">填写声音 ID</option>
      </PixelSelect>
      {source==='manual'?<PixelInput aria-label="声音 ID" value={draft} disabled={disabled} maxLength={200} onChange={event=>setDraft(event.target.value)} onBlur={save} onKeyDown={event=>{
        if(event.key==='Enter'){event.preventDefault();save();}if(event.key==='Escape'){discard.current=true;setDraft(value);event.currentTarget.blur();}
      }}/>:<>
        <PixelInput aria-label="搜索声音" placeholder="搜索声音" value={search} maxLength={100} disabled={disabled} onChange={event=>setSearch(event.target.value)}/>
        <PixelSelect aria-label="声音选择" value={value} disabled={disabled||loading} onChange={event=>{void commit(event.target.value);}}>
          <option value="">选择声音</option>
          {value&&!page.items.some(voice=>voice.voiceId===value)&&<option value={value}>当前声音 ID：{value}</option>}
          {page.items.map(voice=><option key={voice.voiceId} value={voice.voiceId} disabled={voice.status!=='ready'}>{voice.name} · {voice.voiceId}{voiceStatus(voice)?` · ${voiceStatus(voice)}`:''}</option>)}
        </PixelSelect>
        {loading&&<span className="pixel-description" role="status">正在读取声音…</span>}
        {!loading&&!error&&!page.items.length&&<span className="pixel-description">没有匹配的声音，可填写已有声音 ID。</span>}
        {page.nextCursor&&<button type="button" className="detail-action" disabled={disabled||loading} onClick={more}>更多声音</button>}
        {page.items.find(voice=>voice.voiceId===value)?.reason&&<span className="pixel-description">{page.items.find(voice=>voice.voiceId===value)?.reason}</span>}
      </>}
    </div>
  </PixelField>;
}

/** File selection is a local draft. Only the visible command submits a clone. */
export function VoiceCloneForm({disabled=false,onClone}:{disabled?:boolean;onClone:(file:File,name:string,requestId:string)=>Promise<VoiceSummary>}) {
  const [file,setFile]=useState<File>();const [name,setName]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [voice,setVoice]=useState<VoiceSummary>();
  const submitting=useRef(false);const active=useRef(true);const request=useRef<{file:File;name:string;id:string}|undefined>(undefined);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const submit=async()=>{
    if(submitting.current||disabled||!file||!name.trim())return;
    if(!['audio/mpeg','audio/wav'].includes(mediaMimeType(file))||file.size===0||file.size>25*1024*1024){setError('请选择 25 MB 以内的 MP3 或 WAV 音频');return;}
    if(!request.current||request.current.file!==file||request.current.name!==name.trim())request.current={file,name:name.trim(),id:crypto.randomUUID()};
    submitting.current=true;setBusy(true);setError('');setVoice(undefined);
    try{const result=await onClone(file,name.trim(),request.current.id);if(active.current)setVoice(result);}
    catch(error){if(active.current)setError(error instanceof Error?error.message:'声纹克隆未完成');}
    finally{submitting.current=false;if(active.current)setBusy(false);}
  };
  return <section className="voice-clone" data-testid="voice-clone">
    <span className="pixel-title">克隆自己的声音</span>
    <p className="pixel-description">选择一个 25 MiB 以内的 MP3 / WAV 音频并确认名称后创建声纹，完成后在声音字段中选用。</p>
    <PixelField label="克隆音频"><PixelInput aria-label="克隆音频" type="file" accept=".mp3,.wav,audio/mpeg,audio/wav" disabled={disabled||busy} onChange={event=>{
      const chosen=event.target.files?.[0];setFile(chosen);setName(chosen?.name.replace(/\.[^.]+$/,'').slice(0,100)??'');setVoice(undefined);setError('');request.current=undefined;
    }}/></PixelField>
    {file&&<span className="pixel-description">{file.name} · {(file.size/1024/1024).toFixed(2)} MB</span>}
    <PixelField label="声纹名称"><PixelInput aria-label="声纹名称" value={name} maxLength={100} disabled={disabled||busy} onChange={event=>{setName(event.target.value);setVoice(undefined);}}/></PixelField>
    <button type="button" className="detail-action" disabled={disabled||busy||!file||!name.trim()||Boolean(voice)} onClick={()=>{void submit();}}>克隆声纹</button>
    {busy&&<span className="pixel-description" role="status">正在克隆声纹…</span>}
    {error&&<span className="feedback--error" role="status">{error}</span>}
    {voice&&<div className="voice-clone-result" role="status"><span>{voice.status==='ready'?'声纹已创建':voice.status==='verificationRequired'?'声纹已创建，等待验证':'声纹已创建，当前不可用'}</span><span>声音 ID：{voice.voiceId}</span>{voice.reason&&<span>{voice.reason}</span>}</div>}
  </section>;
}
