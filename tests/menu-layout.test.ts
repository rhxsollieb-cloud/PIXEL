import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutMenuColumns, nextMenuIndex } from '../web/ui/menu-layout.js';

test('menus pack actual variable row heights into columns and stay inside viewport margins', () => {
  const rows = Array.from({ length: 24 }, (_, index) => ({ height: index % 3 ? 36 : 68 }));
  const layout = layoutMenuColumns(rows, { width: 1200, height: 480 }, { x: 1190, y: 470 });
  assert.ok(layout.columns.length > 1);
  assert.deepEqual(layout.columns.flat(), rows.map((_, index) => index));
  assert.ok(layout.columns.every(column => column.reduce((height, index) => height + rows[index]!.height, 0) <= layout.bodyHeight));
  assert.ok(layout.x >= 8 && layout.y >= 8 && layout.x + layout.width <= 1192 && layout.y + layout.height <= 472);
});

test('narrow menus retain every row through horizontal overflow and isolate unusually tall rows', () => {
  const rows = Array.from({ length: 80 }, (_, index) => ({ height: index === 4 ? 1200 : 52 }));
  const layout = layoutMenuColumns(rows, { width: 220, height: 300 }, { x: 215, y: 295 });
  assert.equal(layout.width, 204); assert.equal(layout.columnWidth, 194);
  assert.ok(layout.columns.length > 10); assert.deepEqual(layout.columns.flat(), rows.map((_, index) => index));
  assert.ok(layout.columns.some(column => column.length === 1 && column[0] === 4));
  assert.ok(layout.y + layout.height <= 292);
});

test('menu keys skip disabled commands, wrap vertically, and preserve nearest position across columns', () => {
  const rows = [{ height: 36 }, { height: 36, disabled: true }, { height: 52 }, { height: 52, disabled: true }, { height: 36 }, { height: 68 }, { height: 36 }];
  const columns = [[0, 1, 2], [3, 4, 5], [6]];
  assert.equal(nextMenuIndex(rows, columns, 0, 'ArrowDown'), 2);
  assert.equal(nextMenuIndex(rows, columns, 2, 'ArrowDown'), 0);
  assert.equal(nextMenuIndex(rows, columns, 0, 'ArrowUp'), 2);
  assert.equal(nextMenuIndex(rows, columns, 2, 'ArrowRight'), 5);
  assert.equal(nextMenuIndex(rows, columns, 4, 'ArrowLeft'), 2);
  assert.equal(nextMenuIndex(rows, columns, 6, 'ArrowRight'), 6);
  assert.equal(nextMenuIndex(rows, columns, 4, 'Home'), 0);
  assert.equal(nextMenuIndex(rows, columns, 0, 'End'), 6);
  assert.equal(nextMenuIndex(rows.map(row => ({ ...row, disabled: true })), columns, -1, 'ArrowDown'), undefined);
});
