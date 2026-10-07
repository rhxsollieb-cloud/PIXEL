import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { ActionEnvelope, ProjectSnapshot } from '../src/contracts.js';

/** 每个测试都阻断生成命令，浏览器验证不会产生供应商调用或费用。 */
async function openWorkbench(page: Page): Promise<void> {
  await page.route('**/api/actions', async route => {
    const request = route.request();
    const action = request.postDataJSON() as ActionEnvelope;
    if (action.type === 'generation.submit' || action.type === 'generation.resume') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, requestId: action.requestId, error: { code: 'NOT_APPLICABLE', message: '浏览器验证已阻止付费生成' } }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByTestId('timeline-workspace')).toBeVisible();
  await expect(page.getByTestId('timeline-item').first()).toBeVisible();
}

async function snapshot(page: Page): Promise<ProjectSnapshot> {
  const response = await page.request.get('/api/project');
  expect(response.ok()).toBe(true);
  return response.json() as Promise<ProjectSnapshot>;
}

test('工作台采用统一字号、真实像素字体与无常驻操作按钮布局', async ({ page }) => {
  await openWorkbench(page);
  await expect(page.getByTestId('viewer')).toBeVisible();
  await expect(page.getByTestId('asset-library')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  const typography = await page.evaluate(async () => {
    await document.fonts.ready;
    const elements = Array.from(document.querySelectorAll<HTMLElement>('#root *')).filter(element =>
      element.getClientRects().length > 0 && Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()));
    return {
      token: getComputedStyle(document.documentElement).getPropertyValue('--pixel-font-size').trim(),
      sizes: [...new Set(elements.map(element => getComputedStyle(element).fontSize))],
      pixelFontLoaded: document.fonts.check('12px "Fusion Pixel"'),
    };
  });
  expect(typography.token).toBe('12px');
  expect(typography.sizes).toEqual(['12px']);
  expect(typography.pixelFontLoaded).toBe(true);
  const state = await snapshot(page);
  expect(Object.keys(state.document.timelines)).toHaveLength(3);
  expect(Object.values(state.document.items).every(item => item.outputAssetId === undefined)).toBe(true);
  expect(Object.keys(state.document.assets)).toHaveLength(0);
  await page.screenshot({ path: resolve('.pixel/screenshots/frontend.png'), fullPage: true });
});

async function createTimeline(page: Page, title: string): Promise<void> {
  await page.getByTestId('timeline-workspace').click({ button: 'right', position: { x: 260, y: 16 } });
  await expect(page.getByRole('menuitem')).toHaveCount(5);
  await page.getByRole('menuitem', { name: title, exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('已保存');
}

async function itemForModel(page: Page, modelId: string): Promise<string> {
  const state = await snapshot(page);
  const timeline = Object.values(state.document.timelines).find(candidate => candidate.modelId === modelId);
  expect(timeline).toBeDefined();
  const itemId = timeline?.itemIds[0];
  expect(itemId).toBeDefined();
  return itemId!;
}

test('右键选择五种模型并创建首个空草稿，模型没有拖拽入口', async ({ page }) => {
  await openWorkbench(page);
  const before = await snapshot(page);
  await createTimeline(page, 'Eleven v4');
  const after = await snapshot(page);
  expect(Object.keys(after.document.timelines)).toHaveLength(Object.keys(before.document.timelines).length + 1);
  const created = Object.values(after.document.timelines).find(timeline => !before.document.timelines[timeline.id]);
  expect(created?.modelId).toBe('eleven_v4');
  expect(created?.itemIds).toHaveLength(1);
  expect(after.document.items[created!.itemIds[0]!]!.params.voiceId).toBe('');
  expect(await page.locator('[draggable="true"]').count()).toBe(Object.keys(after.document.items).length);
});

test('编辑经 Action 提交并持久化，Enter 加 blur 只提交一次，Esc 丢弃未提交草稿', async ({ page }) => {
  await openWorkbench(page);
  const id = await itemForModel(page, 'alibaba/wan-3.0');
  const requests: ActionEnvelope[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/actions')) requests.push(request.postDataJSON() as ActionEnvelope);
  });
  await page.locator(`[data-item-id="${id}"]`).dblclick();
  const prompt = page.getByLabel('画面与风格描述', { exact: true });
  const value = '镜头沿晨雾山谷缓慢推进，清晰的像素轮廓';
  await prompt.fill(value);
  await prompt.press('Control+Enter');
  await page.getByRole('heading', { name: '片段详情', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).document.items[id]?.params.prompt).toBe(value);
  expect(requests.filter(action => action.type === 'item.params')).toHaveLength(1);
  await prompt.fill('这个文本应被 Escape 丢弃');
  await prompt.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await snapshot(page)).document.items[id]?.params.prompt).toBe(value);
  await page.reload();
  await expect(page.locator(`[data-item-id="${id}"]`)).toContainText(value);
});

test('单 Modal 路径逐层进入嵌套字段，背景隔离，菜单 Esc 优先于详情返回', async ({ page }) => {
  await openWorkbench(page);
  if (!Object.values((await snapshot(page)).document.timelines).some(timeline => timeline.modelId === 'eleven_v4')) await createTimeline(page, 'Eleven v4');
  const id = await itemForModel(page, 'eleven_v4');
  await page.locator(`[data-item-id="${id}"]`).dblclick();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.locator('#root')).toHaveAttribute('inert', '');
  await page.getByTestId('timeline-workspace').dispatchEvent('contextmenu', { clientX: 400, clientY: 800 });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByRole('combobox', { name: '声音设置模式' }).selectOption('custom');
  await expect.poll(async () => (await snapshot(page)).document.items[id]?.params.voiceSettings).not.toBeNull();
  await page.getByRole('group', { name: '进入声音设置' }).dblclick();
  await expect(page.getByRole('dialog', { name: /声音设置/ })).toHaveCount(1);
  await page.getByLabel('稳定度', { exact: true }).fill('0.7');
  await page.getByLabel('稳定度', { exact: true }).press('Enter');
  await expect.poll(async () => ((await snapshot(page)).document.items[id]?.params.voiceSettings as { stability: number })?.stability).toBe(0.7);
  await page.getByRole('heading', { name: '声音设置', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '片段详情', exact: true })).toBeVisible();
  await page.getByTestId('modal-host').locator('.detail-summary').click({ button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
});

test('片段本体拖动位置，边缘独立调整区间，模型参数保持原语义', async ({ page }) => {
  await openWorkbench(page);
  const id = await itemForModel(page, 'alibaba/wan-3.0');
  const initial = (await snapshot(page)).document.items[id]!;
  const item = page.locator(`[data-item-id="${id}"]`);
  const row = page.locator(`[data-timeline-id="${initial.timelineId}"]`);
  await item.dragTo(row.getByTestId('timeline-track'), { sourcePosition: { x: 32, y: 18 }, targetPosition: { x: 224, y: 18 } });
  await expect.poll(async () => (await snapshot(page)).document.items[id]?.startTick).toBe(6000);
  const edge = await item.getByTestId('item-edge-end').boundingBox();
  expect(edge).not.toBeNull();
  const x = edge!.x + edge!.width / 2;
  const y = edge!.y + edge!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 32, y, { steps: 4 });
  expect((await snapshot(page)).document.items[id]?.durationTicks).toBe(initial.durationTicks);
  await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).document.items[id]?.durationTicks).toBe(initial.durationTicks + 1000);
  expect((await snapshot(page)).document.items[id]?.params.durationSeconds).toBe(initial.params.durationSeconds);
});

test('外部文件拖入素材库，素材拖入时间线与引用区分别执行唯一语义', async ({ page }) => {
  await openWorkbench(page);
  const transfer = await page.evaluateHandle(() => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), character => character.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([png], 'reference.png', { type: 'image/png' }));
    return data;
  });
  await page.getByTestId('asset-library').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByTestId('asset-card').filter({ hasText: 'reference.png' })).toBeVisible();
  const asset = Object.values((await snapshot(page)).document.assets).find(candidate => candidate.metadata.name === 'reference.png')!;
  const source = page.getByTestId('asset-card').filter({ hasText: 'reference.png' });
  const wanId = await itemForModel(page, 'alibaba/wan-3.0');
  await source.dragTo(page.locator(`[data-item-id="${wanId}"]`).getByTestId('item-reference-drop'));
  await expect.poll(async () => (await snapshot(page)).document.items[wanId]?.referenceAssetIds).toContain(asset.id);
  const before = await snapshot(page);
  const timeline = Object.values(before.document.timelines).find(candidate => candidate.modelId === 'x-ai/grok-imagine-image-2.0')!;
  await source.dragTo(page.locator(`[data-timeline-id="${timeline.id}"]`).getByTestId('timeline-track'), { targetPosition: { x: 320, y: 18 } });
  await expect.poll(async () => (await snapshot(page)).document.timelines[timeline.id]?.itemIds.length).toBe(timeline.itemIds.length + 1);
  const created = Object.values((await snapshot(page)).document.items).find(candidate => !before.document.items[candidate.id]);
  expect(created?.outputAssetId).toBe(asset.id);
  expect(created?.referenceAssetIds).toEqual([]);
  expect(created?.startTick).toBe(10000);
});

test('生成只经 Item 右键触发，测试隔离拦截后不出现假产物', async ({ page }) => {
  await openWorkbench(page);
  const id = await itemForModel(page, 'x-ai/grok-imagine-image-2.0');
  const before = await snapshot(page);
  await page.locator(`[data-item-id="${id}"]`).focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: '生成片段', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '生成片段', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('浏览器验证已阻止付费生成');
  const after = await snapshot(page);
  expect(after.document.items[id]?.outputAssetId).toBeUndefined();
  expect(after.revision).toBe(before.revision);
  const jobsResponse = await page.request.get('/api/jobs');
  expect(await jobsResponse.json()).toEqual({ items: [] });
});

test('720px 工作台保持可读且时间线在容器内滚动', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 1000 });
  await openWorkbench(page);
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  await page.getByTestId('timeline-item').first().dblclick();
  await expect(page.getByRole('dialog')).toBeVisible();
  const box = await page.getByRole('dialog').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(720);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: resolve('.pixel/screenshots/frontend-720.png'), fullPage: true });
});
