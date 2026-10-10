import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DeepReadonly, ProjectSnapshot } from '../src/contracts.js';
import { orderedTimelineIds } from '../src/contracts.js';
import type { SharedProjectSummary } from '../src/shared-projects.js';
import { readJson } from './bridge.js';
import { PixelInput, PixelSelect } from './ui/index.js';
import './project-manager.css';

async function post<T>(path: string, body?: BodyInit, headers?: HeadersInit): Promise<T> {
  const response = await fetch(path, { method: 'POST', ...(body ? { body } : {}), ...(headers ? { headers } : {}) });
  const result = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message ?? '项目操作未完成');
  return result;
}
export async function importProjectArchive(file: File): Promise<{ id: string; title: string }> {
  if (!file.name.toLowerCase().endsWith('.pixel.zip')) throw new Error('请选择 Pixel 导出的 .pixel.zip 工程包');
  if (file.size > 256 * 1024 * 1024) throw new Error('工程包超过 256 MB 上限');
  return post('/api/projects/import', file, { 'Content-Type': 'application/zip', 'X-Pixel-Request': crypto.randomUUID() });
}

export function ProjectManager({ snapshot, children, timelineTitle, onOpen, onRefresh, onRecovered, disabled = false }: {
  snapshot: DeepReadonly<ProjectSnapshot>; children: ReactNode; timelineTitle(id: string): string;
  onOpen(id: string): Promise<void>; onRefresh(): Promise<void>; onRecovered(): void; disabled?: boolean;
}) {
  const [projects, setProjects] = useState<SharedProjectSummary[]>([]);
  const [shared, setShared] = useState(false); const [cursor, setCursor] = useState<string | undefined>();
  const [title, setTitle] = useState(''); const [timelineId, setTimelineId] = useState('');
  const [busy, setBusy] = useState(''); const [feedback, setFeedback] = useState(''); const [failed, setFailed] = useState(false);
  const [missing, setMissing] = useState<Array<{ id: string; name: string }>>([]);
  const [mediaCheck, setMediaCheck] = useState<'loading' | 'ready' | 'error'>('loading');
  const [mediaError, setMediaError] = useState('');
  const picker = useRef<HTMLInputElement>(null); const live = useRef(true); const createId = useRef(crypto.randomUUID());
  const blocked = disabled || Boolean(busy); const document = snapshot.document;
  async function catalog(more = false) {
    const page = await readJson<{ items: SharedProjectSummary[]; shared: boolean; nextCursor?: string }>(`/api/projects${more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!live.current) return;
    setProjects(previous => more ? [...previous, ...page.items.filter(item => !previous.some(current => current.id === item.id))] : page.items);
    setShared(page.shared); setCursor(page.nextCursor);
  }
  async function health() {
    if (live.current) { setMediaCheck('loading'); setMediaError(''); }
    try {
      const result = await readJson<{ missing: Array<{ id: string; name: string }> }>('/api/project/media-status');
      if (live.current) { setMissing(result.missing); setMediaCheck('ready'); }
    } catch (error) {
      if (live.current) { setMediaCheck('error'); setMediaError(error instanceof Error ? error.message : '媒体状态未能读取'); }
      throw error;
    }
  }
  useEffect(() => { live.current = true; void Promise.all([catalog(), health()]).catch(error => { if (live.current) { setFailed(true); setFeedback(error.message); } }); return () => { live.current = false; }; }, []);
  useEffect(() => { if (timelineId && !document.timelines[timelineId]) setTimelineId(''); }, [document.timelines, timelineId]);
  async function perform(label: string, operation: () => Promise<void>) {
    if (blocked) return;
    setBusy(label); setFeedback(''); setFailed(false);
    try { await operation(); }
    catch (error) { if (live.current) { setFailed(true); setFeedback(error instanceof Error ? error.message : '项目操作未完成'); } }
    finally { if (live.current) setBusy(''); }
  }
  async function importFile(file: File) {
    await perform('正在校验并导入工程包…', async () => {
      const result = await importProjectArchive(file);
      await catalog(); if (live.current) setFeedback(`已导入「${result.title}」，可在项目列表中打开`);
    });
  }
  async function download(timeline?: string) {
    const response = await fetch(`/api/project/export${timeline ? `?timelineId=${encodeURIComponent(timeline)}` : ''}`);
    if (!response.ok) { const result = await response.json(); throw new Error(result.error?.message ?? '导出未完成'); }
    const blob = await response.blob(); if (!live.current) return;
    const url = URL.createObjectURL(blob); const anchor = globalThis.document.createElement('a');
    anchor.href = url; anchor.download = `${document.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'Pixel'}${timeline ? `-${timelineTitle(timeline)}` : ''}.pixel.zip`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setFeedback('工程包已导出，项目文档与媒体分别存放');
  }
  return <div className="project-manager" data-testid="project-manager">
    <aside className="project-manager__projects" aria-label="共享项目" onDragOver={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = shared && !blocked ? 'copy' : 'none';
    }} onDrop={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); event.stopPropagation();
      if (shared && !blocked && event.dataTransfer.files.length === 1) void importFile(event.dataTransfer.files[0]!);
    }}>
      <div className="project-manager__heading">共享项目</div>
      <div className="project-manager__hint">项目保存在 Seafile，媒体独立共享。</div>
      <div className="project-manager__project-list">
        {projects.map(project => <div key={project.id} className={`project-manager__project ${project.id === document.id ? 'is-current' : ''}`}>
          <span title={project.title}>{project.id === document.id ? document.title : project.title}</span>
          <span className="project-manager__hint">{project.id === document.id ? Object.keys(document.timelines).length : project.timelineCount} 条时间线 · {project.id === document.id ? Object.keys(document.assets).length : project.assetCount} 份媒体</span>
          <button type="button" className="manager-button" disabled={blocked || !shared || project.id === document.id} onClick={() => void perform('正在打开项目…', () => onOpen(project.id))}>{project.id === document.id ? '当前项目' : '打开项目'}</button>
        </div>)}
        {!projects.length && <p>暂无共享项目</p>}
      </div>
      {cursor && <button type="button" className="manager-button" disabled={blocked} onClick={() => void perform('正在读取更多项目…', () => catalog(true))}>更多项目</button>}
      <button type="button" className="manager-button" disabled={blocked} onClick={() => void perform('正在刷新共享项目…', async () => { await onRefresh(); await catalog(); await health(); })}>刷新项目列表与媒体状态</button>
      <form className="project-manager__new" onSubmit={event => { event.preventDefault(); void perform('正在创建项目…', async () => {
        await post('/api/projects', JSON.stringify({ title, requestId: createId.current }), { 'Content-Type': 'application/json' });
        setTitle(''); createId.current = crypto.randomUUID(); await catalog(); setFeedback('共享项目已创建，可从列表打开');
      }); }}>
        <label htmlFor="project-name">新项目名称</label>
        <PixelInput id="project-name" value={title} maxLength={200} disabled={blocked || !shared} onChange={event => { setTitle(event.target.value); createId.current = crypto.randomUUID(); }} placeholder="例如：广告分镜"/>
        <button type="submit" className="manager-button" disabled={blocked || !shared || !title.trim()}>创建共享项目</button>
      </form>
      <input ref={picker} type="file" accept=".pixel.zip" hidden aria-label="导入 Pixel 工程包" disabled={blocked || !shared} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }}/>
      <button type="button" className="manager-button" disabled={blocked || !shared} onClick={() => picker.current?.click()}>导入工程包</button>
      <span className="project-manager__hint">也可将 .pixel.zip 拖到此项目列表。导入不会启动模型生成。</span>
    </aside>
    <section className="project-manager__current" aria-label="当前项目管理">
      <div className="project-manager__heading">{document.title}</div>
      <div className="project-manager__exports">
        <button type="button" className="manager-button" disabled={blocked} onClick={() => void perform('正在打包整个项目…', () => download())}>导出整个项目</button>
        <label className="project-manager__timeline"><span>时间线</span><PixelSelect aria-label="要导出的时间线" value={timelineId} disabled={blocked} onChange={event => setTimelineId(event.target.value)}><option value="">选择时间线</option>{orderedTimelineIds(document).map(id => <option key={id} value={id}>{timelineTitle(id)}</option>)}</PixelSelect></label>
        <button type="button" className="manager-button" disabled={blocked || !timelineId} onClick={() => void perform('正在打包时间线…', () => download(timelineId))}>导出时间线</button>
      </div>
      <p className="project-manager__hint">可编辑 .pixel.zip，保留时间位置、参数、引用与媒体；单包上限 256 MB。</p>
      <div className="project-manager__recovery">
        <span data-testid="media-health" aria-live="polite" className={mediaCheck === 'error' ? 'feedback--error' : ''}>{mediaCheck === 'loading' ? '正在检查媒体位置…' : mediaCheck === 'error' ? `媒体位置检查未完成：${mediaError}` : missing.length ? `${missing.length} 份媒体需要恢复（包含编辑历史）` : '媒体位置检查正常'}</span>
        <button type="button" className="manager-button" disabled={blocked || !shared} onClick={() => void perform('正在扫描 Seafile，核对媒体哈希…', async () => {
          const result = await post<{ scanned: number; repaired: string[]; missing: string[] }>('/api/project/media-recover');
          await health(); onRecovered();
          setFeedback(`扫描 ${result.scanned} 个文件，恢复 ${result.repaired.length} 份媒体${result.missing.length ? `，${result.missing.length} 份尚未找到` : ''}`);
        })}>扫描哈希恢复媒体</button>
      </div>
      {mediaCheck === 'ready' && missing.length > 0 && <details className="project-manager__hint"><summary>查看缺失媒体</summary>{missing.map(asset => <div key={asset.id}>{asset.name}</div>)}</details>}
      {(busy || feedback) && <p role="status" className={failed ? 'feedback--error' : ''}>{busy || feedback}</p>}
      <div className="project-manager__heading">当前项目素材</div>
      {children}
    </section>
  </div>;
}
