import type { ActionEnvelope, ActionResult, DeepReadonly, GenerationJob, ProjectChanged, ProjectSnapshot, Unsubscribe } from '../src/contracts.js';
import type { DesktopBridge } from '../src/frontend.js';
import type { ModelDeclaration } from '../src/models.js';

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
  models(signal?: AbortSignal): Promise<{ items: ModelDeclaration[] }> { return readJson('/api/models', signal); }
  jobs(signal?: AbortSignal): Promise<{ items: GenerationJob[] }> { return readJson('/api/jobs', signal); }
  status(signal?: AbortSignal): Promise<{ providers: { elevenlabs: boolean; openrouter: boolean } }> { return readJson('/api/status', signal); }
  async importFile(file: File, snapshot: DeepReadonly<ProjectSnapshot>, requestId: string): Promise<ActionResult> {
    const response = await fetch('/api/import', {
      method: 'POST', headers: {
        'Content-Type': file.type === 'audio/x-wav' ? 'audio/wav' : file.type || 'application/octet-stream', 'X-Pixel-Name': encodeURIComponent(file.name),
        'X-Pixel-Request-Id': requestId, 'X-Pixel-Revision': String(snapshot.revision),
      }, body: file,
    });
    if (!response.ok) throw new Error('素材导入失败');
    return response.json() as Promise<ActionResult>;
  }
}

export function assetUrl(id: string): string { return `/api/media/${encodeURIComponent(id)}`; }
