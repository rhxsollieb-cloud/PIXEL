export interface MenuRowMeasure { height: number; disabled?: boolean; }
export interface MenuViewport { width: number; height: number; left?: number; top?: number; }
export interface MenuColumnLayout {
  columns: number[][];
  columnWidth: number;
  bodyHeight: number;
  width: number;
  height: number;
  x: number;
  y: number;
}

const MARGIN = 8;
const CHROME = 10; // Two 1px borders and two 4px paddings.
const GAP = 4;
const SCROLLBAR = 8;

/** Preserve source order and whole rows; only an individually tall row needs vertical scrolling. */
export function layoutMenuColumns(rows: readonly MenuRowMeasure[], viewport: MenuViewport, anchor: { x: number; y: number }): MenuColumnLayout {
  const availableWidth = Math.max(1, Math.floor(viewport.width - MARGIN * 2));
  const availableHeight = Math.max(1, Math.floor(viewport.height - MARGIN * 2));
  const columnWidth = Math.max(1, Math.min(246, availableWidth - CHROME));
  const pack = (budget: number) => {
    const columns: number[][] = [[]];
    let height = 0; let bodyHeight = rows.length ? 0 : Math.min(36, budget);
    rows.forEach((row, index) => {
      const rowHeight = Math.min(Math.max(1, Math.ceil(row.height)), budget);
      if (height > 0 && height + rowHeight > budget) { columns.push([]); height = 0; }
      columns.at(-1)!.push(index); height += rowHeight; bodyHeight = Math.max(bodyHeight, height);
    });
    return { columns, bodyHeight, fullWidth: columns.length * columnWidth + (columns.length - 1) * GAP + CHROME };
  };
  let packed = pack(Math.max(1, availableHeight - CHROME));
  const horizontal = packed.fullWidth > availableWidth;
  if (horizontal) packed = pack(Math.max(1, availableHeight - CHROME - SCROLLBAR));
  const width = Math.min(availableWidth, packed.fullWidth);
  const height = Math.min(availableHeight, packed.bodyHeight + CHROME + (horizontal ? SCROLLBAR : 0));
  const left = (viewport.left ?? 0) + MARGIN; const top = (viewport.top ?? 0) + MARGIN;
  return { columns: packed.columns, columnWidth, bodyHeight: packed.bodyHeight, width, height,
    x: Math.round(Math.max(left, Math.min(anchor.x, left + availableWidth - width))),
    y: Math.round(Math.max(top, Math.min(anchor.y, top + availableHeight - height))) };
}

/** Arrow keys follow displayed columns; horizontal movement keeps the nearest row position. */
export function nextMenuIndex(rows: readonly MenuRowMeasure[], columns: readonly (readonly number[])[], active: number, key: string): number | undefined {
  const enabled = rows.flatMap((row, index) => row.disabled ? [] : [index]);
  if (!enabled.length) return undefined;
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled.at(-1);
  if (active < 0) return key === 'ArrowUp' ? enabled.at(-1) : enabled[0];
  const columnIndex = columns.findIndex(column => column.includes(active));
  if (columnIndex < 0) return enabled[0];
  const column = columns[columnIndex]!;
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const candidates = column.filter(index => !rows[index]!.disabled);
    const position = candidates.indexOf(active);
    return candidates[(position + (key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length];
  }
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined;
  const center = (indices: readonly number[], target: number) => {
    let top = 0;
    for (const index of indices) { const height = Math.max(1, rows[index]!.height); if (index === target) return top + height / 2; top += height; }
    return top;
  };
  const sourceCenter = center(column, active); const step = key === 'ArrowRight' ? 1 : -1;
  for (let targetColumn = columnIndex + step; targetColumn >= 0 && targetColumn < columns.length; targetColumn += step) {
    const indices = columns[targetColumn]!;
    const candidates = indices.filter(index => !rows[index]!.disabled);
    if (candidates.length) return candidates.reduce((closest, index) => Math.abs(center(indices, index) - sourceCenter) < Math.abs(center(indices, closest) - sourceCenter) ? index : closest);
  }
  return active;
}
