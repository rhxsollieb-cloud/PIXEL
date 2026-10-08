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

test('默认工作区只呈现 Viewer 与 Timeline，不提前披露素材库或主题装饰', async ({ page }) => {
  await openWorkbench(page);
  await expect(page.getByTestId('viewer')).toBeVisible();
  await expect(page.getByTestId('asset-library')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByText('暂无输出', { exact: true })).toBeVisible();
  await expect(page.locator('.idle-artwork, .pixel-palette, .gesture-hints, .wordmark-version')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
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
  const surfaces = await page.evaluate(() => ({
    ink: getComputedStyle(document.documentElement).getPropertyValue('--pixel-ink').trim(),
    panels: Array.from(document.querySelectorAll('.pixel-panel')).map(element => ({
      shadow: getComputedStyle(element).boxShadow,
      radius: getComputedStyle(element).borderRadius,
    })),
  }));
  expect(surfaces.ink).toBe('#253760');
  expect(surfaces.panels.every(panel => panel.shadow === 'none' && panel.radius === '0px')).toBe(true);
  const state = await snapshot(page);
  expect(Object.keys(state.document.timelines)).toHaveLength(3);
  expect(Object.values(state.document.items).every(item => item.outputAssetId === undefined)).toBe(true);
  expect(Object.keys(state.document.assets)).toHaveLength(0);
  await page.screenshot({ path: resolve('.pixel/screenshots/frontend.png'), fullPage: true });
});

async function createTimeline(page: Page, title: string): Promise<void> {
  await page.getByTestId('timeline-workspace').click({ button: 'right', position: { x: 260, y: 16 } });
  await expect(page.getByRole('menuitem')).toHaveCount(1);
  await page.getByRole('menuitem', { name: '新建时间线', exact: true }).click();
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
  if (itemId) return itemId;
  await page.locator(`[data-testid="timeline-row"][data-timeline-id="${timeline!.id}"]`).getByTestId('timeline-track').click({ button: 'right', position: { x: 4, y: 18 } });
  await page.getByRole('menuitem', { name: '新建生成草稿', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).document.timelines[timeline!.id]?.itemIds.length).toBe(1);
  const id = (await snapshot(page)).document.timelines[timeline!.id]!.itemIds[0]!;
  await expect(page.locator(`[data-item-id="${id}"]`)).toBeVisible();
  return id;
}

test('右键经新建时间线选择模型，仅创建空 Timeline，模型没有拖拽入口', async ({ page }) => {
  await openWorkbench(page);
  const before = await snapshot(page);
  await createTimeline(page, 'Eleven v4');
  const after = await snapshot(page);
  expect(Object.keys(after.document.timelines)).toHaveLength(Object.keys(before.document.timelines).length + 1);
  const created = Object.values(after.document.timelines).find(timeline => !before.document.timelines[timeline.id]);
  expect(created?.modelId).toBe('eleven_v4');
  expect(created?.itemIds).toHaveLength(0);
  expect(Object.keys(after.document.items)).toHaveLength(Object.keys(before.document.items).length);
  expect(await page.locator('[draggable="true"]').count()).toBe(Object.keys(after.document.items).length);
});

test('无素材也可在空时间位置创建生成草稿，再进入编辑；操作不启动生成', async ({ page }) => {
  await openWorkbench(page);
  const state = await snapshot(page);
  expect(Object.keys(state.document.assets)).toHaveLength(0);
  const emptyTimeline = Object.values(state.document.timelines).find(timeline => timeline.modelId === 'eleven_v4')!;
  expect(emptyTimeline.itemIds).toHaveLength(0);
  const row = page.locator(`[data-testid="timeline-row"][data-timeline-id="${emptyTimeline.id}"]`);
  await row.locator('.timeline-label').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '新建生成草稿', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await row.getByTestId('timeline-track').click({ button: 'right', position: { x: 320, y: 18 } });
  await page.getByRole('menuitem', { name: '新建生成草稿', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).document.timelines[emptyTimeline.id]?.itemIds.length).toBe(1);
  const after = await snapshot(page);
  const draft = after.document.items[after.document.timelines[emptyTimeline.id]!.itemIds[0]!]!;
  expect(draft.startTick).toBe(10000);
  expect(draft.params.text).toBe('');
  expect(draft.outputAssetId).toBeUndefined();
  expect(draft.referenceAssetIds).toEqual([]);
  await page.locator(`[data-testid="timeline-item"][data-item-id="${draft.id}"]`).dblclick();
  await expect(page.getByRole('dialog', { name: '片段详情', exact: true })).toBeVisible();
  await expect(page.getByTestId('item-reference')).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(await (await page.request.get('/api/jobs')).json()).toEqual({ items: [] });
});

test('编辑经 Action 提交并持久化，Enter 加 blur 只提交一次，Esc 丢弃未提交草稿', async ({ page }) => {
  await openWorkbench(page);
  const id = await itemForModel(page, 'alibaba/wan-3.0');
  const requests: ActionEnvelope[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/actions')) requests.push(request.postDataJSON() as ActionEnvelope);
  });
  await page.locator(`[data-item-id="${id}"]`).dblclick();
  await expect(page.getByTestId('item-reference')).toHaveCount(0);
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
  await expect(page.getByTestId('item-reference')).toHaveCount(0);
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

async function openLibrary(page: Page): Promise<void> {
  await page.getByRole('group', { name: '作品详情', exact: true }).dblclick();
  await expect(page.getByRole('dialog', { name: '作品详情', exact: true })).toBeVisible();
  await page.getByRole('group', { name: '进入素材库', exact: true }).dblclick();
  await expect(page.getByRole('dialog', { name: '素材库', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
}

async function scopedAssetDrop(page: Page, sourceName: string, target: ReturnType<Page['locator']>, x = 12): Promise<void> {
  const source = page.getByTestId('asset-card').filter({ hasText: sourceName });
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  const sourceBox = await source.boundingBox();
  await source.dispatchEvent('dragstart', { dataTransfer: transfer, clientX: sourceBox!.x + 12, clientY: sourceBox!.y + 12 });
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  const event = { dataTransfer: transfer, clientX: box!.x + x, clientY: box!.y + 12 };
  await target.dispatchEvent('dragover', event);
  await target.dispatchEvent('drop', event);
  await source.dispatchEvent('dragend', { dataTransfer: transfer });
  await transfer.dispose();
}

test('库由对象详情进入，导入和关系拖拽在当前 Modal 内完成，背景保持隔离', async ({ page }) => {
  await openWorkbench(page);
  await openLibrary(page);
  await expect(page.locator('#root')).toHaveAttribute('inert', '');
  await page.getByTestId('timeline-workspace').dispatchEvent('contextmenu', { clientX: 300, clientY: 650 });
  await expect(page.getByRole('menu')).toHaveCount(0);
  const transfer = await page.evaluateHandle(() => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), character => character.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([png], 'reference.png', { type: 'image/png' }));
    return data;
  });
  await page.getByTestId('asset-library').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByTestId('asset-card').filter({ hasText: 'reference.png' })).toBeVisible();
  const asset = Object.values((await snapshot(page)).document.assets).find(candidate => candidate.metadata.name === 'reference.png')!;
  const wanId = await itemForModel(page, 'alibaba/wan-3.0');
  await scopedAssetDrop(page, 'reference.png', page.locator(`[data-testid="relation-reference"][data-item-id="${wanId}"]`));
  await expect.poll(async () => (await snapshot(page)).document.items[wanId]?.referenceAssetIds).toContain(asset.id);
  const duplicateTransfer = await page.evaluateHandle(() => new DataTransfer());
  const assetSource = page.getByTestId('asset-card').filter({ hasText: 'reference.png' });
  await assetSource.dispatchEvent('dragstart', { dataTransfer: duplicateTransfer });
  await expect(page.locator(`[data-testid="relation-reference"][data-item-id="${wanId}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-testid="relation-reference"][data-item-id="${(await itemForModel(page, 'eleven_v4'))}"]`)).toHaveCount(0);
  await assetSource.dispatchEvent('dragend', { dataTransfer: duplicateTransfer });
  await duplicateTransfer.dispose();
  const before = await snapshot(page);
  const timeline = Object.values(before.document.timelines).find(candidate => candidate.modelId === 'x-ai/grok-imagine-image-2.0')!;
  await scopedAssetDrop(page, 'reference.png', page.locator(`[data-testid="relation-track"][data-timeline-id="${timeline.id}"]`), 320);
  await expect.poll(async () => (await snapshot(page)).document.timelines[timeline.id]?.itemIds.length).toBe(timeline.itemIds.length + 1);
  const created = Object.values((await snapshot(page)).document.items).find(candidate => !before.document.items[candidate.id]);
  expect(created?.outputAssetId).toBe(asset.id);
  expect(created?.referenceAssetIds).toEqual([]);
  expect(created?.startTick).toBe(10000);
  const reusable = page.locator(`[data-testid="reusable-item"][data-item-id="${created!.id}"]`);
  const saveTransfer = await page.evaluateHandle(() => new DataTransfer());
  await reusable.dispatchEvent('dragstart', { dataTransfer: saveTransfer });
  await page.getByTestId('asset-library').dispatchEvent('dragover', { dataTransfer: saveTransfer });
  await page.getByTestId('asset-library').dispatchEvent('drop', { dataTransfer: saveTransfer });
  await expect.poll(async () => (await snapshot(page)).revision).toBeGreaterThan(before.revision + 1);
  expect(Object.keys((await snapshot(page)).document.assets)).toHaveLength(1);
  await saveTransfer.dispose();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '作品详情', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('asset-library')).toHaveCount(0);
});

test('播放指针点击、拖动和键盘定位联动预览，不改写项目，Modal 背景不能定位', async ({ page }) => {
  await openWorkbench(page);
  const before = await snapshot(page);
  const output = Object.values(before.document.items).find(item => item.outputAssetId)!;
  const ruler = page.getByTestId('timeline-ruler');
  await ruler.click({ position: { x: 352, y: 8 } });
  await expect(ruler).toHaveAttribute('aria-valuenow', '11000');
  await expect(page.getByTestId('timeline-current-time')).toHaveText('00:11.000');
  await expect(page.getByTestId('viewer').locator('img')).toHaveAttribute('src', `/api/media/${output.outputAssetId}`);
  const handle = await page.getByTestId('timeline-playhead-handle').boundingBox();
  expect(handle).not.toBeNull();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 80, handle!.y + handle!.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(ruler).toHaveAttribute('aria-valuenow', '13500');
  await ruler.press('ArrowRight');
  await expect(ruler).toHaveAttribute('aria-valuenow', '13600');
  await ruler.press('Home');
  await expect(ruler).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByTestId('viewer')).toHaveText('暂无输出');
  const zeroHandle = await page.getByTestId('timeline-playhead-handle').boundingBox();
  expect(zeroHandle).not.toBeNull();
  // The left half of the handle must remain usable over the sticky track label.
  await page.mouse.move(zeroHandle!.x + 4, zeroHandle!.y + zeroHandle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(zeroHandle!.x + 84, zeroHandle!.y + zeroHandle!.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(ruler).toHaveAttribute('aria-valuenow', '2375');
  await ruler.press('End');
  await expect(ruler).toHaveAttribute('aria-valuenow', String(await ruler.getAttribute('aria-valuemax')));
  expect(await snapshot(page)).toEqual(before);
  await page.getByRole('group', { name: '作品详情', exact: true }).dblclick();
  await expect(page.getByRole('dialog', { name: '作品详情', exact: true })).toBeVisible();
  const isolatedTime = await ruler.getAttribute('aria-valuenow');
  await ruler.dispatchEvent('pointerdown', { button: 0, pointerId: 91, clientX: 500, clientY: 600 });
  await expect(ruler).toHaveAttribute('aria-valuenow', isolatedTime!);
  await page.keyboard.press('Escape');
  expect(await snapshot(page)).toEqual(before);
});

test('实际音频随播放指针定位素材时间，定位不会提交生成或项目编辑', async ({ page }) => {
  await openWorkbench(page);
  await openLibrary(page);
  const transfer = await page.evaluateHandle(() => {
    const dataSize = 8000 * 2 * 2;
    const bytes = new Uint8Array(44 + dataSize);
    const view = new DataView(bytes.buffer);
    const label = (at: number, text: string) => { for (let index = 0; index < text.length; index++) bytes[at + index] = text.charCodeAt(index); };
    label(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); label(8, 'WAVE'); label(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    label(36, 'data'); view.setUint32(40, dataSize, true);
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'scrub.wav', { type: 'audio/wav' }));
    return data;
  });
  await page.getByTestId('asset-library').dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
  await expect(page.getByTestId('asset-card').filter({ hasText: 'scrub.wav' })).toBeVisible();
  const before = await snapshot(page);
  const voice = Object.values(before.document.timelines).find(timeline => timeline.modelId === 'eleven_v4')!;
  await scopedAssetDrop(page, 'scrub.wav', page.locator(`[data-testid="relation-track"][data-timeline-id="${voice.id}"]`), 4);
  await expect.poll(async () => (await snapshot(page)).document.timelines[voice.id]?.itemIds.length).toBe(voice.itemIds.length + 1);
  const after = await snapshot(page);
  const placed = Object.values(after.document.items).find(item => !before.document.items[item.id])!;
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.locator(`[data-testid="timeline-item"][data-item-id="${placed.id}"]`).click();
  const audio = page.getByTestId('viewer').locator('audio');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThan(0);
  await page.getByTestId('timeline-ruler').click({ position: { x: 40, y: 8 } });
  await expect(page.getByTestId('timeline-ruler')).toHaveAttribute('aria-valuenow', '1250');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(1.25, 2);
  expect(await snapshot(page)).toEqual(after);
  expect(await (await page.request.get('/api/jobs')).json()).toEqual({ items: [] });
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
