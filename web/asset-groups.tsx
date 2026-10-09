import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AssetData, AssetGroupData, DeepReadonly, JsonObject } from '../src/contracts.js';
import { PixelInput, PixelSelect } from './ui/index.js';
import './asset-groups.css';

export interface AssetGroupsProps {
  assets: readonly DeepReadonly<AssetData>[];
  groups: Readonly<Record<string, DeepReadonly<AssetGroupData>>>;
  disabled?: boolean;
  onAction(type: string, payload: JsonObject): Promise<boolean>;
  renderAsset(asset: DeepReadonly<AssetData>): ReactNode;
}

/** Group navigation is local; membership and names use the authoritative project Actions. */
export function AssetGroups({ assets, groups, disabled, onAction, renderAsset }: AssetGroupsProps) {
  const [selected, setSelected] = useState('all');
  const [newTitle, setNewTitle] = useState('');
  const [renameTitle, setRenameTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const orderedGroups = Object.values(groups);
  const selectedGroupId = selected.startsWith('group:') ? selected.slice(6) : undefined;
  const group = selectedGroupId === undefined ? undefined : groups[selectedGroupId];
  const memberships = useMemo(() => {
    const result = new Map<string, string>();
    for (const current of Object.values(groups)) for (const assetId of current.assetIds) result.set(assetId, current.id);
    return result;
  }, [groups]);
  const blocked = Boolean(disabled || busy);
  useEffect(() => { if (selectedGroupId !== undefined && !groups[selectedGroupId]) setSelected('all'); }, [groups, selectedGroupId]);
  useEffect(() => { setRenameTitle(group?.title ?? ''); }, [group?.id, group?.title]);
  async function apply(type: string, payload: JsonObject): Promise<boolean> {
    if (blocked) return false;
    setBusy(true);
    try { return await onAction(type, payload); } finally { setBusy(false); }
  }
  const shown = assets.filter(asset => selected === 'all' || (selected === 'ungrouped' ? !memberships.has(asset.id) : memberships.get(asset.id) === selectedGroupId));
  const count = (groupId: string) => assets.filter(asset => memberships.get(asset.id) === groupId).length;
  return <div className="asset-groups" data-testid="asset-groups">
    <aside className="asset-groups__sidebar" aria-label="素材分组">
      <div className="asset-groups__heading">分组</div>
      <nav aria-label="选择素材分组" className="asset-groups__navigation">
        <button type="button" aria-pressed={selected === 'all'} onClick={() => setSelected('all')}>全部素材 <span>{assets.length}</span></button>
        <button type="button" aria-pressed={selected === 'ungrouped'} onClick={() => setSelected('ungrouped')}>未分组 <span>{assets.filter(asset => !memberships.has(asset.id)).length}</span></button>
        {orderedGroups.map(current => <button key={current.id} type="button" aria-pressed={selectedGroupId === current.id} title={current.title} onClick={() => setSelected(`group:${current.id}`)}><span className="asset-groups__title">{current.title}</span><span>{count(current.id)}</span></button>)}
      </nav>
      <form className="asset-groups__form" onSubmit={event => {
        event.preventDefault(); const title = newTitle.trim();
        if (title) void apply('assetGroup.create', { title }).then(ok => { if (ok) setNewTitle(''); });
      }}>
        <label htmlFor="asset-group-new-title">新分组名称</label>
        <PixelInput id="asset-group-new-title" value={newTitle} maxLength={80} disabled={blocked} onChange={event => setNewTitle(event.target.value)}/>
        <button type="submit" className="asset-groups__action" disabled={blocked || !newTitle.trim()}>新建分组</button>
      </form>
      {group && <form className="asset-groups__form" onSubmit={event => {
        event.preventDefault(); const title = renameTitle.trim();
        if (title) void apply('assetGroup.rename', { groupId: group.id, title });
      }}>
        <label htmlFor="asset-group-rename-title">当前分组名称</label>
        <PixelInput id="asset-group-rename-title" value={renameTitle} maxLength={80} disabled={blocked} onChange={event => setRenameTitle(event.target.value)}/>
        <button type="submit" className="asset-groups__action" disabled={blocked || !renameTitle.trim() || renameTitle.trim() === group.title}>重命名分组</button>
        <button type="button" className="asset-groups__action" disabled={blocked} onClick={() => { void apply('assetGroup.remove', { groupId: group.id }); }}>删除分组</button>
        <p className="pixel-description">删除分组会保留全部素材。</p>
      </form>}
    </aside>
    <section className="asset-groups__content" aria-label={group ? `${group.title}中的素材` : selected === 'ungrouped' ? '未分组素材' : '全部素材'}>
      {shown.length ? <div className="asset-grid">{shown.map(asset => <div className="asset-groups__card" key={asset.id}>
        {renderAsset(asset)}
        <PixelSelect aria-label={`${String(asset.metadata.name ?? '素材')}的分组`} value={memberships.get(asset.id) ?? ''} disabled={blocked} onChange={event => {
          const groupId = event.target.value;
          void apply('assetGroup.moveAsset', { assetId: asset.id, ...(groupId ? { groupId } : {}) });
        }}>
          <option value="">未分组</option>
          {orderedGroups.map(current => <option key={current.id} value={current.id}>{current.title}</option>)}
        </PixelSelect>
      </div>)}</div> : <div className="library-empty"><p className="pixel-description">{assets.length ? '这个分组尚无素材' : '拖入素材'}</p></div>}
    </section>
  </div>;
}
