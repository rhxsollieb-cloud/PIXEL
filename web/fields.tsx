import { useEffect, useId, useRef, useState } from 'react';
import type { JsonObject, JsonValue } from '../src/contracts.js';
import type { PluginFieldDeclaration } from '../src/plugins.js';
import { PixelField, PixelInput, PixelSelect, PixelTextarea, PixelIcon } from './ui/index.js';

export type FieldPath = (string | number)[];
const labels: Record<string,string> = {
  prompt:'画面与风格描述',text:'文本描述',voiceId:'声音 ID',voiceSettings:'声音设置',languageCode:'语言',
  seed:'随机种子',stability:'稳定度',similarityBoost:'相似度',outputFormat:'输出格式',
  durationSeconds:'生成时长 / 秒',promptInfluence:'提示词影响',loop:'无缝循环',generateAudio:'生成声音',
  referenceMode:'参考方式',resolution:'分辨率',aspectRatio:'画面比例',quality:'画面质量',
  compositionPlan:'分段创作计划',chunks:'音乐段落',musicLengthMs:'音乐时长 / 毫秒',
  forceInstrumental:'纯器乐',finetuneId:'音乐微调版本',durationMs:'段落时长 / 毫秒',
  positiveStyles:'期望的音乐风格',negativeStyles:'排除的音乐风格',contextAdherence:'上下文贴合程度',
};
export function fieldLabel(field: PluginFieldDeclaration): string { return labels[field.key] ?? field.label; }
export function atPath(value: unknown, path: FieldPath): JsonValue | undefined {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current as JsonValue | undefined;
}
export function withPath(value: JsonObject, path: FieldPath, replacement: JsonValue): JsonObject {
  const copy = structuredClone(value);
  let current: JsonObject | JsonValue[] = copy;
  for (const key of path.slice(0,-1)) current = (current as Record<string | number, JsonValue>)[key] as JsonObject | JsonValue[];
  (current as Record<string | number, JsonValue>)[path.at(-1)!] = replacement;
  return copy;
}
function objectSchema(schema: JsonObject): JsonObject {
  const alternatives = schema.anyOf;
  return Array.isArray(alternatives) ? alternatives.find(value => value && typeof value === 'object' && !Array.isArray(value) && value.type !== 'null') as JsonObject ?? {} : schema;
}
export function schemaAtPath(schema: JsonObject, path: FieldPath): JsonObject {
  let current = objectSchema(schema);
  for (const key of path) {
    current = typeof key === 'number' ? (current.items as JsonObject ?? {}) : ((current.properties as JsonObject | undefined)?.[key] as JsonObject ?? {});
    current = objectSchema(current);
  }
  return current;
}
export function defaultFromSchema(schema: JsonObject, nonNull = false): JsonValue {
  if (schema.default !== undefined && !(nonNull && schema.default === null)) return structuredClone(schema.default);
  const normalized = objectSchema(schema);
  if (normalized.enum && Array.isArray(normalized.enum)) return normalized.enum[0] ?? '';
  if (normalized.type === 'object') return Object.fromEntries(Object.entries((normalized.properties ?? {}) as JsonObject).map(([key,value]) => [key,defaultFromSchema(value as JsonObject)]));
  if (normalized.type === 'array') return Array.from({length:Math.min(Number(normalized.minItems ?? 0),30)},() => defaultFromSchema(normalized.items as JsonObject ?? {}));
  if (normalized.type === 'number' || normalized.type === 'integer') return Number(normalized.minimum ?? 0);
  if (normalized.type === 'boolean') return false;
  return '';
}

interface FieldEditorProps {
  field: PluginFieldDeclaration;
  value: JsonValue | undefined;
  schema: JsonObject;
  disabled?: boolean;
  onCommit: (value: JsonValue) => Promise<boolean>;
  onOpen: () => void;
}
export function FieldEditor({field,value,schema,disabled = false,onCommit,onOpen}: FieldEditorProps) {
  const initial = value === null || value === undefined ? '' : Array.isArray(value) && !field.children ? value.join('\n') : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const [draft,setDraft] = useState(initial);
  const [error,setError] = useState('');
  const lastSubmitted = useRef(initial);
  const discard = useRef(false);
  const id = useId();
  useEffect(() => { setDraft(initial); lastSubmitted.current = initial; setError(''); },[initial]);
  async function save(raw = draft) {
    if (discard.current) { discard.current = false; return; }
    if (raw === lastSubmitted.current) return;
    if (disabled) return;
    let next: JsonValue = raw;
    if (raw === '' && field.nullable) next = null;
    else if (field.valueType === 'number') {
      next = Number(raw);
      if (!raw.trim() || !Number.isFinite(next)) { setError('请输入有效数字'); return; }
    } else if(field.valueType === 'array') next = raw.split('\n').map(line=>line.trim()).filter(Boolean);
    lastSubmitted.current = raw;
    const ok = await onCommit(next);
    if (!ok) { lastSubmitted.current = initial; setError('未保存，请检查输入'); }
    else setError('');
  }
  const keyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if(event.key === 'Escape') { discard.current=true;setDraft(initial);event.currentTarget.blur(); }
    if(event.key === 'Enter' && (event.currentTarget instanceof HTMLInputElement || event.ctrlKey || event.metaKey)) {
      event.preventDefault(); void save();
    }
  };
  const description = field.nullable ? '留空时使用模型默认值' : undefined;
  if(field.valueType === 'object' || (field.valueType === 'array' && field.children)) {
    const count = Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 0;
    return <PixelField label={fieldLabel(field)}>
      {field.nullable && <PixelSelect aria-label={`${fieldLabel(field)}模式`} disabled={disabled} value={value === null ? 'default':'custom'} onChange={event=>{void onCommit(event.target.value === 'default' ? null : defaultFromSchema(schema,true));}}>
        <option value="default">模型默认</option><option value="custom">自定义</option>
      </PixelSelect>}
      {value !== null && <div className="field-object" tabIndex={0} role="group" aria-label={`进入${fieldLabel(field)}`} onDoubleClick={onOpen} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();onOpen();}}}>
        <span><PixelIcon name="folder"/> {fieldLabel(field)}</span><span>{count} 项 · 双击进入 <PixelIcon name="chevron-right"/></span>
      </div>}
    </PixelField>;
  }
  if(field.valueType === 'boolean') return <PixelField label={fieldLabel(field)}>
    <PixelSelect aria-label={fieldLabel(field)} disabled={disabled} value={value ? 'true':'false'} onChange={event=>{void onCommit(event.target.value === 'true');}}>
      <option value="false">关闭</option><option value="true">开启</option>
    </PixelSelect>
  </PixelField>;
  if(field.valueType === 'enum') return <PixelField label={fieldLabel(field)}>
    <PixelSelect aria-label={fieldLabel(field)} disabled={disabled} value={String(value ?? '')} onChange={event=>{void onCommit(event.target.value);}}>
      {field.options?.map(option=><option key={option.value} value={option.value}>{({reference:'图片参考',firstFrame:'首帧',low:'低',medium:'中',high:'高',auto:'自动'} as Record<string,string>)[option.value] ?? option.label}</option>)}
    </PixelSelect>
  </PixelField>;
  const multiline = ['prompt','text'].includes(field.key) || field.valueType === 'array';
  const arrayValue = Array.isArray(value) && !field.children ? value.join('\n') : draft;
  return <PixelField label={fieldLabel(field)} htmlFor={id} {...(description ? {description}: {})} {...(error ? {error}: {})}>
    {multiline ? <PixelTextarea id={id} disabled={disabled} value={field.valueType === 'array' && draft === initial ? arrayValue : draft} rows={field.valueType === 'array' ? 3:5}
      placeholder={field.valueType === 'array'?'每行一种风格':'写下你希望创作的内容…'}
      onChange={event=>setDraft(event.target.value)} onBlur={()=>{void save();}} onKeyDown={keyDown}/>
      : <PixelInput id={id} disabled={disabled} type={field.valueType === 'number'?'number':'text'} step={field.valueType === 'number'?'any':undefined}
        value={draft} placeholder={field.nullable?'自动':field.key==='voiceId'?'填写账户可用的声音 ID':''}
        onChange={event=>setDraft(event.target.value)} onBlur={()=>{void save();}} onKeyDown={keyDown}/>}
  </PixelField>;
}
