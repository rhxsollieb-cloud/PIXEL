import { expect, test, type Page } from '@playwright/test';

interface MenuHarness {
  selected: string[];
  closed: number;
  update(count: number, allDisabled?: boolean): void;
}
declare global { interface Window { __pixelMenuTest?: MenuHarness; } }

/** Mount the real shared component only inside this test document; no product route or Action exists. */
async function mountMenu(page: Page, count: number, options: { x?: number; y?: number; allDisabled?: boolean } = {}) {
  await page.goto('/');
  await page.evaluate(async ({ count, x, y, allDisabled }) => {
    await document.fonts.ready;
    document.getElementById('root')!.style.display = 'none';
    const load = (url: string) => import(url);
    // Resolve Vite's own transformed imports; the optimizer cache may live outside its web root.
    const [entrySource, componentSource] = await Promise.all([fetch('/main.tsx').then(response => response.text()), fetch('/ui/components.tsx').then(response => response.text())]);
    const rootUrl = /["']([^"'\n]*\/react-dom_client\.js(?:\?[^"'\n]*)?)["']/.exec(entrySource)?.[1];
    const reactUrl = /["']([^"'\n]*\/react\.js(?:\?[^"'\n]*)?)["']/.exec(componentSource)?.[1];
    if (!rootUrl || !reactUrl) throw new Error('The dev server did not expose its existing React imports');
    const [rootModule, reactModule, { PixelContextMenu }] = await Promise.all([
      load(rootUrl), load(reactUrl), load('/ui/components.tsx'),
    ]);
    const createRoot = rootModule.createRoot ?? rootModule.default.createRoot;
    const createElement = reactModule.createElement ?? reactModule.default.createElement;
    const host = document.createElement('div'); document.body.append(host);
    const trigger = document.createElement('button'); trigger.textContent = '菜单来源'; trigger.id = 'menu-trigger';
    Object.assign(trigger.style, { position: 'fixed', left: '1px', top: '1px', width: '6px', height: '6px', padding: '0', overflow: 'hidden' });
    document.body.append(trigger); trigger.focus();
    const root = createRoot(host);
    const harness: MenuHarness = { selected: [], closed: 0, update: () => {} };
    const render = (length: number, disabled = false) => root.render(createElement(PixelContextMenu, {
      x, y, onClose: () => { harness.closed++; root.render(null); },
      items: Array.from({ length }, (_, index) => ({ id: `command-${index}`, label: index === 3 ? `命令 ${index} ${'连续长标签'.repeat(12)}` : `命令 ${index}`,
        description: index % 3 === 0 ? '较长的说明会自然换行并计入本列的实际高度，不截断参考内容。' : '命令说明',
        disabled: disabled || index % 7 === 1, onSelect: () => harness.selected.push(`command-${index}`) })),
    }));
    harness.update = render; window.__pixelMenuTest = harness; render(count, allDisabled);
  }, { count, x: options.x ?? 100, y: options.y ?? 100, allDisabled: options.allDisabled ?? false });
  await expect(page.getByRole('menu')).toBeVisible();
}

async function activeId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-pixel-menu-id') ?? null);
}
async function expectInsideViewport(page: Page) {
  const bounds = await page.getByRole('menu').boundingBox(); const viewport = page.viewportSize()!;
  expect(bounds!.x).toBeGreaterThanOrEqual(8); expect(bounds!.y).toBeGreaterThanOrEqual(8);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 8);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 8);
}

test('24 variable-height commands split near the viewport edge while preserving labels, order and pixel typography', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 640 });
  await mountMenu(page, 24, { x: 1438, y: 638 });
  await expectInsideViewport(page);
  expect(await page.locator('[data-pixel-menu-column]').count()).toBeGreaterThan(1);
  await expect(page.getByRole('menuitem')).toHaveCount(24);
  const layout = await page.getByRole('menu').evaluate(menu => ({
    ids: Array.from(menu.querySelectorAll('[role="menuitem"]')).map(item => item.getAttribute('data-pixel-menu-id')),
    sizes: [...new Set(Array.from(menu.querySelectorAll('[role="menuitem"], .pixel-description')).map(item => getComputedStyle(item).fontSize))],
    columns: Array.from(menu.querySelectorAll<HTMLElement>('[data-pixel-menu-column]')).map(column => ({ height: column.clientHeight, scrollHeight: column.scrollHeight })),
    label: menu.querySelector('[data-pixel-menu-id="command-3"] .pixel-context-menu__label')?.textContent,
  }));
  expect(layout.ids).toEqual(Array.from({ length: 24 }, (_, index) => `command-${index}`));
  expect(layout.sizes).toEqual(['12px']); expect(layout.label).toContain('连续长标签'.repeat(12));
  expect(layout.columns.every(column => column.scrollHeight <= column.height + 1)).toBe(true);
});

test('80 commands remain reachable in a narrow window, horizontal scrolling follows keyboard focus and resize keeps the command', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 420 });
  await mountMenu(page, 80, { x: 319, y: 419 });
  await expectInsideViewport(page); await expect(page.getByRole('menuitem')).toHaveCount(80);
  const before = await page.getByRole('menu').evaluate(menu => ({ width: menu.clientWidth, scrollWidth: menu.scrollWidth }));
  expect(before.scrollWidth).toBeGreaterThan(before.width);
  await page.keyboard.press('End'); await expect(page.locator('[data-pixel-menu-id="command-79"]')).toBeFocused();
  expect(await page.getByRole('menu').evaluate(menu => menu.scrollLeft)).toBeGreaterThan(0);
  const activeBefore = await activeId(page);
  await page.setViewportSize({ width: 760, height: 620 });
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.locator(`[data-pixel-menu-id="${activeBefore}"]`)).toBeFocused();
  await expectInsideViewport(page);
  const rects = await page.locator(`[data-pixel-menu-id="${activeBefore}"]`).evaluate(item => ({ item: item.getBoundingClientRect().toJSON(), menu: item.closest('[role="menu"]')!.getBoundingClientRect().toJSON() }));
  expect(rects.item.left).toBeGreaterThanOrEqual(rects.menu.left); expect(rects.item.right).toBeLessThanOrEqual(rects.menu.right);
  await page.keyboard.press('Enter'); await expect(page.getByRole('menu')).toHaveCount(0);
  expect(await page.evaluate(() => window.__pixelMenuTest!.selected)).toEqual(['command-79']);
  expect(await page.evaluate(() => window.__pixelMenuTest!.closed)).toBe(1);
});

test('arrows follow columns and skip disabled rows; Esc restores the originating focus without selecting', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 420 });
  await mountMenu(page, 24);
  await expect(page.locator('[data-pixel-menu-id="command-0"]')).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(page.locator('[data-pixel-menu-id="command-2"]')).toBeFocused();
  const originalColumn = await page.locator('[data-pixel-menu-id="command-2"]').evaluate(item => item.parentElement!.getAttribute('data-pixel-menu-column'));
  await page.keyboard.press('ArrowRight');
  const rightColumn = await page.evaluate(() => document.activeElement?.parentElement?.getAttribute('data-pixel-menu-column'));
  expect(Number(rightColumn)).toBeGreaterThan(Number(originalColumn));
  expect(await page.evaluate(() => (document.activeElement as HTMLButtonElement).disabled)).toBe(false);
  await page.keyboard.press('ArrowLeft');
  expect(await page.evaluate(() => document.activeElement?.parentElement?.getAttribute('data-pixel-menu-column'))).toBe(originalColumn);
  await page.keyboard.press('Home'); await expect(page.locator('[data-pixel-menu-id="command-0"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  expect(await page.evaluate(() => document.activeElement?.parentElement?.getAttribute('data-pixel-menu-column'))).toBe('0');
  expect(await activeId(page)).not.toBe('command-0');
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('#menu-trigger')).toBeFocused();
  expect(await page.evaluate(() => window.__pixelMenuTest!.selected)).toEqual([]);
});

test('disabled and empty menus stay dismissible, external clicks close, and item updates preserve a surviving focus', async ({ page }) => {
  await mountMenu(page, 24, { allDisabled: true });
  await expect(page.getByRole('menu')).toBeFocused(); await page.keyboard.press('ArrowDown'); await expect(page.getByRole('menu')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('menu')).toHaveCount(0);
  expect(await page.evaluate(() => window.__pixelMenuTest!.selected)).toEqual([]);
  await mountMenu(page, 24);
  await page.keyboard.press('ArrowDown');
  const id = await activeId(page);
  await page.evaluate(() => window.__pixelMenuTest!.update(80));
  await expect(page.locator(`[data-pixel-menu-id="${id}"]`)).toBeFocused();
  await page.mouse.click(2, 2); await expect(page.getByRole('menu')).toHaveCount(0);
  expect(await page.evaluate(() => window.__pixelMenuTest!.closed)).toBe(1);
  await mountMenu(page, 0); await expect(page.getByText('当前对象没有可用命令')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
});
