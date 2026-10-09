import type { ActionEnvelope, ActionResult, DeepReadonly, GenerationJob, ProjectChanged, ProjectSnapshot, Unsubscribe } from '../src/contracts.js';
import type { DesktopBridge } from '../src/frontend.js';
import type { TimelineDeclaration } from '../src/timeline-catalog.js';
import type { VoicePage, VoiceSummary } from '../src/voice-contracts.js';

/** A project host owns one origin and one read-only projection identity. */
export interface ProjectSessionDescriptor { projectId: string; sessionId: string }

/** File metadata only routes the gesture; the backend verifies the actual bytes. */
export function mediaMimeType(file: File): string {
  const declared = file.type.toLowerCase();
  if (declared === 'audio/x-wav' || declared === 'audio/wave') return 'audio/wav';
  if (declared && declared !== 'application/octet-stream') return declared;
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4' } as Record<string, string>)[extension] ?? 'application/octet-stream';
}

export async function readVoices(query: {category:'default'|'cloned';search?:string;cursor?:string},signal?:AbortSignal):Promise<VoicePage> {
  return readJson(`/api/voices?${new URLSearchParams({limit:'20',...query})}`,signal);
}

export async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error('本地服务暂不可用');
  return response.json() as Promise<T>;
}

/** 浏览器开发宿主与 Electron preload 使用同一项目桥接契约。 */
export class HttpDesktopBridge implements DesktopBridge {
  private source: EventSource | undefined;
  private listeners = new Set<(event: DeepReadonly<ProjectChanged>) => void>();
  private jobListeners = new Set<() => void>();
  private connectionListeners = new Set<(connected: boolean) => void>();

  async readProject(projectId: string): Promise<ProjectSnapshot> {
    const snapshot = await readJson<ProjectSnapshot>('/api/project');
    if (snapshot.document.id !== projectId) throw new Error('项目不匹配');
    return snapshot;
  }
  async dispatch(action: ActionEnvelope): Promise<ActionResult> {
    const response = await fetch('/api/actions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action),
    });
    if (!response.ok) throw new Error('动作服务暂不可用');
    return response.json() as Promise<ActionResult>;
  }
  subscribeProject(projectId: string, listener: (event: DeepReadonly<ProjectChanged>) => void): Unsubscribe {
    const filtered = (event: DeepReadonly<ProjectChanged>) => { if (event.projectId === projectId) listener(event); };
    this.listeners.add(filtered); this.connect();
    return () => { this.listeners.delete(filtered); };
  }
  onJobs(listener: () => void): Unsubscribe { this.jobListeners.add(listener); this.connect(); return () => { this.jobListeners.delete(listener); }; }
  onConnection(listener: (connected: boolean) => void): Unsubscribe { this.connectionListeners.add(listener); this.connect(); return () => { this.connectionListeners.delete(listener); }; }
  private connect(): void {
    if (this.source) return;
    this.source = new EventSource('/api/events');
    this.source.onopen = () => { this.connectionListeners.forEach(listener => listener(true)); this.jobListeners.forEach(listener => listener()); };
    this.source.onerror = () => this.connectionListeners.forEach(listener => listener(false));
    const event = (message: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(message.data) as { type: string };
        if (payload.type === 'project.changed') this.listeners.forEach(listener => listener(payload as ProjectChanged));
        if (payload.type.startsWith('generation.') || payload.type.startsWith('job.')) this.jobListeners.forEach(listener => listener());
      } catch { /* 中断/不完整事件由重新拉取快照恢复。 */ }
    };
    this.source.onmessage = event;
    for (const name of ['project.changed', 'generation.changed', 'generation.progress', 'job.changed']) this.source.addEventListener(name, event as EventListener);
  }
  close(): void { this.source?.close(); this.source = undefined; this.listeners.clear(); this.jobListeners.clear(); this.connectionListeners.clear(); }
  timelineTypes(signal?: AbortSignal, cursor?: string): Promise<{ items: TimelineDeclaration[]; nextCursor?: string }> {
    const query = new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) });
    return readJson(`/api/timeline-types?${query}`, signal);
  }
  timelineType(typeId: string, signal?: AbortSignal): Promise<TimelineDeclaration> { return readJson(`/api/timeline-types/${encodeURIComponent(typeId)}`, signal); }
  jobs(signal?: AbortSignal): Promise<{ items: GenerationJob[] }> { return readJson('/api/jobs', signal); }
  status(signal?: AbortSignal): Promise<{ providers: { elevenlabs: boolean; openrouter: boolean } }> { return readJson('/api/status', signal); }
  async importFile(file: File, snapshot: DeepReadonly<ProjectSnapshot>, requestId: string): Promise<ActionResult> {
    const response = await fetch('/api/import', {
      method: 'POST', headers: {
        'Content-Type': mediaMimeType(file), 'X-Pixel-Name': encodeURIComponent(file.name),
        'X-Pixel-Request-Id': requestId, 'X-Pixel-Revision': String(snapshot.revision),
        'X-Pixel-Project-Id': snapshot.document.id,
      }, body: file,
    });
    if (!response.ok) throw new Error('素材导入失败');
    return response.json() as Promise<ActionResult>;
  }
  async placeMediaFile(file: File, snapshot: DeepReadonly<ProjectSnapshot>, requestId: string, startTick: number, timelineId?: string): Promise<ActionResult> {
    const response = await fetch('/api/media-place', {
      method: 'POST', headers: {
        'Content-Type': mediaMimeType(file), 'X-Pixel-Name': encodeURIComponent(file.name),
        'X-Pixel-Request-Id': requestId, 'X-Pixel-Revision': String(snapshot.revision), 'X-Pixel-Project-Id': snapshot.document.id,
        'X-Pixel-Start-Tick': String(startTick), ...(timelineId ? { 'X-Pixel-Timeline-Id': timelineId } : {}),
      }, body: file,
    });
    const result = await response.json() as ActionResult;
    if (!response.ok && result.ok !== false) throw new Error('媒体放置服务暂不可用');
    return result;
  }
  async referenceMediaFile(file:File,snapshot:DeepReadonly<ProjectSnapshot>,requestId:string,itemId:string):Promise<ActionResult> {
    const response=await fetch('/api/media-reference',{method:'POST',headers:{
      'Content-Type':mediaMimeType(file),'X-Pixel-Name':encodeURIComponent(file.name),
      'X-Pixel-Project-Id':snapshot.document.id,'X-Pixel-Revision':String(snapshot.revision),'X-Pixel-Request-Id':requestId,'X-Pixel-Item-Id':itemId,
    },body:file});
    const result=await response.json() as ActionResult;
    if(!response.ok&&result.ok!==false)throw new Error('参考文件上传服务暂不可用');
    return result;
  }
  async importOutputFile(file:File,snapshot:DeepReadonly<ProjectSnapshot>,requestId:string,itemId:string,provenance:'manual'|'external'):Promise<ActionResult> {
    const response=await fetch('/api/media-output',{method:'POST',headers:{
      'Content-Type':mediaMimeType(file),'X-Pixel-Name':encodeURIComponent(file.name),
      'X-Pixel-Project-Id':snapshot.document.id,'X-Pixel-Revision':String(snapshot.revision),'X-Pixel-Request-Id':requestId,
      'X-Pixel-Item-Id':itemId,'X-Pixel-Output-Provenance':provenance,
    },body:file});
    const result=await response.json() as ActionResult;
    if(!response.ok&&result.ok!==false)throw new Error('生成结果上传服务暂不可用');
    return result;
  }
  async cloneVoice(file:File,name:string,snapshot:DeepReadonly<ProjectSnapshot>,requestId:string,timelineId:string):Promise<VoiceSummary> {
    const response=await fetch('/api/voice-clone',{method:'POST',headers:{
      'Content-Type':mediaMimeType(file),'X-Pixel-Name':encodeURIComponent(file.name),'X-Pixel-Voice-Name':encodeURIComponent(name),
      'X-Pixel-Project-Id':snapshot.document.id,'X-Pixel-Revision':String(snapshot.revision),'X-Pixel-Request-Id':requestId,'X-Pixel-Timeline-Id':timelineId,
    },body:file});
    const result=await response.json() as {voice?:VoiceSummary;error?:{message?:string}};
    if(!response.ok||!result.voice)throw new Error(result.error?.message||'声纹克隆未完成');
    return result.voice;
  }
}

export function assetUrl(id: string): string { return `/api/media/${encodeURIComponent(id)}`; }
