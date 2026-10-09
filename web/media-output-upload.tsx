import { useRef, useState } from 'react';
import { PixelField, PixelIcon, PixelSelect } from './ui/index.js';

export type ManualOutputProvenance = 'manual' | 'external';
export const MAX_MEDIA_UPLOAD_BYTES = 256 * 1024 * 1024;

/** Manual output belongs to the existing Item; it is never a file reference. */
export function MediaOutputUpload({disabled,hasOutput,onUpload}:{disabled:boolean;hasOutput:boolean;onUpload:(file:File,provenance:ManualOutputProvenance)=>Promise<void>}) {
  const input=useRef<HTMLInputElement>(null);
  const [provenance,setProvenance]=useState<ManualOutputProvenance>('manual');
  return <div className="media-output-upload" data-testid="media-output-upload">
    <span className="pixel-title"><PixelIcon name="frames"/> 上传生成结果</span>
    <p className="pixel-description">已有成片可以直接作为这个片段的输出，保留提示词、模型与时间位置。</p>
    <PixelField label="结果来源">
      <PixelSelect aria-label="生成结果来源" disabled={disabled} value={provenance} onChange={event=>setProvenance(event.target.value as ManualOutputProvenance)}>
        <option value="manual">人工上传</option>
        <option value="external">外部网页生成</option>
      </PixelSelect>
    </PixelField>
    {provenance==='external'&&<p className="pixel-description">在你使用的模型网页完成生成并下载 MP4，再上传到这里；此操作不调用生成 API。</p>}
    <p className="pixel-description">MP4 · 每次一个文件 · 最多 {MAX_MEDIA_UPLOAD_BYTES/1024/1024} MiB。</p>
    <p className="pixel-description">保持当前片段时长；视频较短时缩短片段。较长的视频可在时间线上调整片段边缘使用。</p>
    <p className="pixel-description">{hasOutput?'上传会替换当前输出。':''}若片段正在生成，上传后取消当前任务，旧结果不会覆盖上传的视频。</p>
    <button type="button" className="detail-action" disabled={disabled} onClick={()=>input.current?.click()}>选择并上传生成结果</button>
    <input ref={input} type="file" aria-label="生成结果文件" accept=".mp4,video/mp4" hidden disabled={disabled} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void onUpload(file,provenance);}}/>
  </div>;
}
