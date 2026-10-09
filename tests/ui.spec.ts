import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { ActionEnvelope, ActionResult, JsonObject, ProjectSnapshot } from '../src/contracts.js';

/** 声音目录与克隆全部使用测试响应，不读取或修改真实供应商账户。 */
test.beforeEach(async ({ page }) => {
  await page.route('**/api/voices?*', route => route.fulfill({ json: { items: [{voiceId:'default-voice',name:'默认测试声音',category:'default',status:'ready'}] } }));
  await page.route('**/api/voice-clone', route => route.fulfill({ status:400, json: {ok:false,error:{code:'NOT_APPLICABLE',message:'浏览器验证已阻止真实声纹克隆'}} }));
});

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
  await expect(page.getByRole('button')).toHaveCount(3);
  await expect(page.getByTestId('timeline-sort-handle')).toHaveCount(3);
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

test('素材库是独立非模态工作窗口，空预览与键盘入口不锁主窗口', async ({ page }) => {
  await openWorkbench(page);
  const before = await snapshot(page);
  const library = await openLibrary(page);
  await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(library.getByRole('dialog')).toHaveCount(0);
  await page.getByTestId('timeline-ruler').click({ position: { x: 64, y: 8 } });
  await expect(page.getByTestId('timeline-ruler')).toHaveAttribute('aria-valuenow', '2000');
  const closed = library.waitForEvent('close');
  await library.getByTestId('library-window').focus();
  await library.keyboard.press('Escape').catch(error => { if (!library.isClosed()) throw error; });
  await closed;
  await page.getByTestId('viewer').focus();
  const next = page.waitForEvent('popup');
  await page.getByTestId('viewer').press('Shift+F10');
  await page.getByRole('menuitem', { name: '素材库', exact: true }).click();
  const reopened = await next;
  await expect(reopened.getByTestId('library-window')).toBeVisible();
  await reopened.close();
  await page.getByRole('group', { name: '作品详情', exact: true }).dblclick();
  await expect(page.getByRole('dialog', { name: '作品详情', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: '进入素材库', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(await snapshot(page)).toEqual(before);
});

async function createTimeline(page: Page, title: string): Promise<void> {
  await page.getByTestId('timeline-workspace').evaluate(element=>{element.scrollTop=0;});
  await page.getByTestId('timeline-workspace').click({ button: 'right', position: { x: 260, y: 16 } });
  await expect(page.getByRole('menuitem')).toHaveCount(1);
  await page.getByRole('menuitem', { name: '新建时间线', exact: true }).click();
  const types=await (await page.request.get('/api/timeline-types?limit=20')).json() as {items:unknown[]};
  await expect(page.getByRole('menuitem')).toHaveCount(types.items.length);
  await page.getByRole('menuitem', { name: title, exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('.workspace-feedback')).toContainText('已保存');
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
  await expect(page.getByTestId('item-reference')).toBeVisible();
  await expect(page.getByRole('button', {name:'上传参考图片',exact:true})).toBeVisible();
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

test('左侧单击编辑稀疏默认配置，保留原片段，新草稿继承，右键显式刷新并持久化', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkbench(page);
  const beforeTimeline = await snapshot(page);
  await createTimeline(page, 'Eleven v4');
  const timeline = Object.values((await snapshot(page)).document.timelines).find(candidate => !beforeTimeline.document.timelines[candidate.id])!;
  const row = page.locator(`[data-testid="timeline-row"][data-timeline-id="${timeline.id}"]`);
  const label = row.getByTestId('timeline-label');
  const createDraft = async (x: number) => {
    const existing = (await snapshot(page)).document.timelines[timeline.id]!.itemIds;
    await row.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await row.getByTestId('timeline-track').click({ button: 'right', position: { x, y: 18 } });
    await expect(page.getByRole('menu')).toHaveCount(1);
    await expect(page.getByRole('menuitem', { name: '刷新时间轴默认配置', exact: true })).toHaveCount(0);
    await page.getByRole('menuitem', { name: '新建生成草稿', exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).document.timelines[timeline.id]?.itemIds.length).toBe(existing.length + 1);
    return (await snapshot(page)).document.timelines[timeline.id]!.itemIds.find(id => !existing.includes(id))!;
  };
  const originalId = await createDraft(320);
  const originalSnapshot = await snapshot(page);
  const original = originalSnapshot.document.items[originalId]!;
  const authored = { ...original.params, text: '这是已有片段，刷新不能改掉正文。', voiceId: 'original-voice', trimTail: false };
  const updated = await page.request.post('/api/actions', { data: { requestId: crypto.randomUUID(), projectId: originalSnapshot.document.id, expectedRevision: originalSnapshot.revision,
    type: 'item.params', payload: { itemId: originalId, params: authored } } });
  expect((await updated.json()).ok).toBe(true);
  const originalAfterEdit = (await snapshot(page)).document.items[originalId]!;
  const requests: ActionEnvelope[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/actions')) requests.push(request.postDataJSON() as ActionEnvelope); });

  await label.click();
  await expect(page.getByRole('dialog', { name: '时间线默认配置', exact: true })).toHaveCount(1);
  await expect(page.locator('#root')).toHaveAttribute('inert', '');
  await expect(page.getByText(/修改只用于新建片段/)).toBeVisible();
  await expect(page.getByRole('button', {name:'克隆声纹',exact:true})).toBeVisible();
  await page.getByRole('combobox', {name:'声音来源',exact:true}).selectOption('manual');
  const voice = page.getByLabel('声音 ID', { exact: true });
  await voice.fill('next-voice'); await voice.press('Enter');
  await expect.poll(async () => (await snapshot(page)).document.timelines[timeline.id]?.itemDefaults).toEqual({ voiceId: 'next-voice' });
  await page.getByRole('combobox', { name: '文本上下文', exact: true }).selectOption('manual');
  await expect(page.getByLabel('前文参考', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('后文参考', { exact: true })).toHaveCount(0);
  const padding = page.getByLabel('尾部余量 / 毫秒', { exact: true });
  await padding.fill('80'); await padding.press('Enter');
  await expect(page.getByRole('combobox', { name: '裁剪尾部', exact: true })).toHaveValue('true');
  await page.getByRole('combobox', { name: '声音设置模式', exact: true }).selectOption('custom');
  await page.getByRole('group', { name: '进入声音设置', exact: true }).dblclick();
  await expect(page.getByRole('dialog', { name: '声音设置', exact: true })).toHaveCount(1);
  await page.getByLabel('稳定度', { exact: true }).fill('0.66');
  await page.getByLabel('稳定度', { exact: true }).press('Enter');
  await expect.poll(async () => ((await snapshot(page)).document.timelines[timeline.id]?.itemDefaults?.voiceSettings as { stability: number })?.stability).toBe(0.66);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '时间线默认配置', exact: true })).toHaveCount(1);
  await page.screenshot({ path: resolve('.pixel/screenshots/timeline-defaults.png'), fullPage: true });
  await page.getByRole('dialog').locator('.pixel-modal__content').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: resolve('.pixel/screenshots/timeline-defaults-scrolled.png'), fullPage: true });
  await page.getByRole('dialog').locator('.pixel-modal__content').evaluate(element => { element.scrollTop = 0; });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.getByTestId('modal-host').locator('.detail-summary').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '刷新时间轴默认配置', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await snapshot(page)).document.items[originalId]).toEqual(originalAfterEdit);
  const defaults = (await snapshot(page)).document.timelines[timeline.id]!.itemDefaults!;
  expect(Object.keys(defaults).sort()).toEqual(['contextMode', 'tailPaddingMs', 'voiceId', 'voiceSettings']);
  expect(requests.filter(action => action.type === 'timeline.refreshDefaults')).toHaveLength(0);

  const newId = await createDraft(640);
  const newDraft = (await snapshot(page)).document.items[newId]!;
  expect(newDraft.params.voiceId).toBe('next-voice'); expect(newDraft.params.contextMode).toBe('manual');
  expect(newDraft.params.trimTail).toBe(true); expect(newDraft.params.tailPaddingMs).toBe(80);
  expect(newDraft.params.voiceSettings).toEqual(defaults.voiceSettings); expect(newDraft.params.text).toBe('');
  expect((await snapshot(page)).document.items[originalId]).toEqual(originalAfterEdit);

  await page.reload();
  await expect(label).toBeVisible();
  await label.focus(); await label.press('Enter');
  await expect(page.getByRole('dialog', { name: '时间线默认配置', exact: true })).toHaveCount(1);
  await page.getByRole('combobox', {name:'声音来源',exact:true}).selectOption('manual');
  await expect(page.getByLabel('声音 ID', { exact: true })).toHaveValue('next-voice');
  await expect(page.getByRole('combobox', { name: '裁剪尾部', exact: true })).toHaveValue('true');
  await page.keyboard.press('Escape');
  await label.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '刷新时间轴默认配置', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).document.items[originalId]?.params.voiceId).toBe('next-voice');
  const refreshed = (await snapshot(page)).document.items[originalId]!;
  expect(refreshed.params.text).toBe(authored.text); expect(refreshed.startTick).toBe(original.startTick);
  expect(refreshed.durationTicks).toBe(original.durationTicks); expect(refreshed.referenceAssetIds).toEqual(original.referenceAssetIds);
  expect(refreshed.params.trimTail).toBe(true); expect(refreshed.generationToken).not.toBe(originalAfterEdit.generationToken);
  expect(requests.filter(action => action.type === 'timeline.refreshDefaults')).toHaveLength(1);
  expect(await (await page.request.get('/api/jobs')).json()).toEqual({ items: [] });

  await page.locator(`[data-item-id="${newId}"]`).dblclick();
  await expect(page.getByRole('dialog', { name: '片段详情', exact: true })).toHaveCount(1);
  await expect(page.getByText('模型与画面设置', { exact: true })).toHaveCount(0);
  await page.getByLabel('前文参考', { exact: true }).fill('前一段。');
  await page.getByLabel('前文参考', { exact: true }).press('Control+Enter');
  await page.getByLabel('后文参考', { exact: true }).fill('后一段。');
  await page.getByLabel('后文参考', { exact: true }).press('Control+Enter');
  await expect.poll(async () => (await snapshot(page)).document.items[newId]?.params.previousText).toBe('前一段。');
  await expect.poll(async () => (await snapshot(page)).document.items[newId]?.params.nextText).toBe('后一段。');
  await page.keyboard.press('Escape');
});

test('可见声纹上传先确认文件名称，单次克隆不改默认；声音字段选择才提交且保留旧片段', async ({page})=>{
  test.setTimeout(60_000);
  let cloneCount=0;let finishClone!:()=>void;let cloned=false;
  const voiceQueries:string[]=[];
  await page.route('**/api/voices?*',async route=>{
    const query=new URL(route.request().url()).searchParams;voiceQueries.push(query.toString());
    expect(query.get('limit')).toBe('20');
    const category=query.get('category');
    const items=category==='cloned'?[{voiceId:'pending-voice',name:'待验证声纹',category:'cloned',status:'verificationRequired',reason:'需要完成验证'},
      {voiceId:'blocked-voice',name:'不可用声纹',category:'cloned',status:'unavailable'},
      ...(cloned?[{voiceId:'my-new-voice',name:'我的对白',category:'cloned',status:'ready'}]:[])]:
      [{voiceId:query.has('cursor')?'default-next':'default-voice',name:'默认测试声音',category:'default',status:'ready'}];
    await route.fulfill({json:{items,...(category==='default'&&!query.has('cursor')?{nextCursor:'test-next'}:{})}});
  });
  await page.route('**/api/voice-clone',async route=>{
    cloneCount++;const headers=route.request().headers();
    expect(decodeURIComponent(headers['x-pixel-name']!)).toBe('sample.wav');
    expect(decodeURIComponent(headers['x-pixel-voice-name']!)).toBe('我的对白');
    expect(headers['content-type']).toBe('audio/wav');
    await new Promise<void>(resolve=>{finishClone=resolve;});cloned=true;
    await route.fulfill({json:{requestId:headers['x-pixel-request-id'],voice:{voiceId:'my-new-voice',name:'我的对白',category:'cloned',status:'ready'}}});
  });
  await openWorkbench(page);
  const state=await snapshot(page);const timeline=Object.values(state.document.timelines).find(candidate=>candidate.modelId==='eleven_v4')!;
  const id=await itemForModel(page,'eleven_v4');const original=(await snapshot(page)).document.items[id]!;
  const row=page.locator(`[data-testid="timeline-row"][data-timeline-id="${timeline.id}"]`);
  await row.getByTestId('timeline-label').click();
  await expect(page.getByTestId('voice-clone')).toBeVisible();
  await expect(page.getByTestId('input-capabilities')).toContainText('文本描述（必填）');
  await expect(page.getByTestId('input-capabilities')).toContainText('不接受文件参考');
  await expect(page.getByRole('button',{name:'上传参考图片',exact:true})).toHaveCount(0);
  await expect(page.getByRole('combobox',{name:'声音选择',exact:true})).toBeEnabled();
  const before=await snapshot(page);
  await page.getByRole('button',{name:'更多声音',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'声音选择',exact:true})).toContainText('default-next');
  await page.getByLabel('搜索声音',{exact:true}).fill('对白');
  await expect.poll(()=>voiceQueries.some(query=>new URLSearchParams(query).get('search')==='对白')).toBe(true);
  await page.getByRole('combobox',{name:'声音来源',exact:true}).selectOption('cloned');
  await expect(page.getByRole('combobox',{name:'声音选择',exact:true})).toContainText('pending-voice');
  await expect(page.locator('option[value="pending-voice"]')).toBeDisabled();
  await expect(page.locator('option[value="blocked-voice"]')).toBeDisabled();
  expect(await snapshot(page)).toEqual(before);
  await page.getByLabel('克隆音频',{exact:true}).setInputFiles({name:'sample.wav',mimeType:'audio/wav',buffer:Buffer.from('local review fixture')});
  await page.getByLabel('声纹名称',{exact:true}).fill('我的对白');
  expect(cloneCount).toBe(0);
  const clone=page.getByRole('button',{name:'克隆声纹',exact:true});
  await clone.click();await expect(clone).toBeDisabled();
  await clone.dispatchEvent('click');expect(cloneCount).toBe(1);
  await expect(page.getByTestId('voice-clone')).toContainText('正在克隆声纹');
  finishClone();
  await expect(page.getByTestId('voice-clone')).toContainText('声音 ID：my-new-voice');
  await expect(page.getByRole('combobox',{name:'声音选择',exact:true})).toContainText('my-new-voice');
  expect(await snapshot(page)).toEqual(before);
  await page.getByRole('combobox',{name:'声音选择',exact:true}).selectOption('my-new-voice');
  await expect.poll(async()=>(await snapshot(page)).document.timelines[timeline.id]?.itemDefaults?.voiceId).toBe('my-new-voice');
  expect((await snapshot(page)).document.items[id]).toEqual(original);
  await page.keyboard.press('Escape');await row.getByTestId('timeline-label').click();
  await expect(page.getByRole('combobox',{name:'声音选择',exact:true})).toHaveValue('my-new-voice');
  await expect(page.getByRole('combobox',{name:'声音选择',exact:true})).toContainText('当前声音 ID：my-new-voice');
  await page.getByRole('combobox',{name:'声音来源',exact:true}).selectOption('manual');
  const manual=page.getByLabel('声音 ID',{exact:true});await expect(manual).toHaveValue('my-new-voice');
  await manual.fill('external-unknown-id');await manual.press('Enter');
  await page.getByRole('heading',{name:'时间线默认配置',exact:true}).click();
  await expect.poll(async()=>(await snapshot(page)).document.timelines[timeline.id]?.itemDefaults?.voiceId).toBe('external-unknown-id');
  expect((await snapshot(page)).document.items[id]).toEqual(original);
  expect(cloneCount).toBe(1);await page.keyboard.press('Escape');
  expect(await(await page.request.get('/api/jobs')).json()).toEqual({items:[]});
});

test('离开声纹详情后完成的克隆不设置默认或重新打开窗口，待验证结果保留 ID',async({page})=>{
  let complete!:()=>void;let cloneCount=0;
  await page.route('**/api/voice-clone',async route=>{cloneCount++;await new Promise<void>(resolve=>{complete=resolve;});
    await route.fulfill({json:{requestId:route.request().headers()['x-pixel-request-id'],voice:{voiceId:'verification-id',name:'待验证',category:'cloned',status:'verificationRequired',reason:'请完成声音验证'}}});});
  await openWorkbench(page);const state=await snapshot(page);
  const timeline=Object.values(state.document.timelines).find(candidate=>candidate.modelId==='eleven_v4')!;
  const label=page.locator(`[data-timeline-id="${timeline.id}"]`).getByTestId('timeline-label');
  await label.click();await page.getByLabel('克隆音频',{exact:true}).setInputFiles({name:'sample.mp3',mimeType:'audio/mpeg',buffer:Buffer.from('review')});
  await page.getByRole('button',{name:'克隆声纹',exact:true}).click();
  await expect(page.getByTestId('voice-clone')).toContainText('正在克隆声纹');
  await page.keyboard.press('Escape');complete();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await snapshot(page)).toEqual(state);expect(cloneCount).toBe(1);
  await label.click();await expect(page.getByTestId('voice-clone')).not.toContainText('verification-id');
  expect(await snapshot(page)).toEqual(state);await page.keyboard.press('Escape');
});

test('参考输入始终可见，模式决定数量上下限；上传原子导入并引用，满额禁用',async({page})=>{
  test.setTimeout(60_000);await openWorkbench(page);
  const before=await snapshot(page);await createTimeline(page,'Alibaba: Wan 3.0');
  const timeline=Object.values((await snapshot(page)).document.timelines).find(candidate=>!before.document.timelines[candidate.id])!;
  const row=page.locator(`[data-testid="timeline-row"][data-timeline-id="${timeline.id}"]`);await row.scrollIntoViewIfNeeded();
  await row.getByTestId('timeline-track').click({button:'right',position:{x:320,y:18}});
  await page.getByRole('menuitem',{name:'新建生成草稿',exact:true}).click();
  await expect.poll(async()=>(await snapshot(page)).document.timelines[timeline.id]!.itemIds.length).toBe(1);
  const id=(await snapshot(page)).document.timelines[timeline.id]!.itemIds[0]!;await page.locator(`[data-item-id="${id}"]`).dblclick();
  await expect(page.getByTestId('item-reference')).toBeVisible();
  const mode=page.getByRole('combobox',{name:'参考方式',exact:true});await mode.selectOption('firstFrame');
  await expect(page.getByTestId('input-capabilities')).toContainText('需要 1 个');
  await expect(page.getByTestId('input-capabilities')).toContainText('PNG、JPEG、WebP');
  await expect(page.getByTestId('input-capabilities')).toContainText('单文件最多 25 MiB');
  let imports=0;let references=0;page.on('request',request=>{if(request.url().endsWith('/api/import'))imports++;if(request.url().endsWith('/api/media-reference'))references++;});
  const upload=page.getByRole('button',{name:'上传参考图片',exact:true});
  const beforeOversize=await snapshot(page);const oversizedChooser=page.waitForEvent('filechooser');await upload.click();
  await(await oversizedChooser).setFiles({name:'too-large.png',mimeType:'image/png',buffer:Buffer.alloc(25*1024*1024+1)});
  await expect(page.locator('.workspace-feedback')).toContainText('单文件最多 25 MiB');
  expect(await snapshot(page)).toEqual(beforeOversize);expect(references).toBe(0);
  const uploadFile=async(name:string)=>{const chooser=page.waitForEvent('filechooser');await upload.click();await(await chooser).setFiles({name,mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')});};
  const first=(await snapshot(page)).revision;await uploadFile('first-frame.png');
  await expect.poll(async()=>(await snapshot(page)).document.items[id]?.referenceAssetIds.length).toBe(1);
  expect((await snapshot(page)).revision).toBe(first+1);
  await expect(upload).toBeDisabled();await expect(page.getByTestId('item-reference')).toContainText('已达到当前参考上限');
  await mode.selectOption('reference');await expect(upload).toBeEnabled();await expect(page.getByTestId('input-capabilities')).toContainText('最多 3 个');
  await uploadFile('capability-second.png');await expect.poll(async()=>(await snapshot(page)).document.items[id]?.referenceAssetIds.length).toBe(2);
  await uploadFile('capability-third.png');await expect.poll(async()=>(await snapshot(page)).document.items[id]?.referenceAssetIds.length).toBe(3);
  await expect(upload).toBeDisabled();expect(imports).toBe(0);expect(references).toBe(3);
  expect((await snapshot(page)).document.items[id]?.outputAssetId).toBeUndefined();
  await page.keyboard.press('Escape');expect(await(await page.request.get('/api/jobs')).json()).toEqual({items:[]});
});

test('时间线画面默认设置保留既有片段快照，刷新才应用到旧片段', async ({ page }) => {
  await openWorkbench(page);
  const before = await snapshot(page);
  await createTimeline(page, 'Alibaba: Wan 3.0');
  const timeline = Object.values((await snapshot(page)).document.timelines).find(candidate => !before.document.timelines[candidate.id])!;
  const row = page.locator(`[data-testid="timeline-row"][data-timeline-id="${timeline.id}"]`);
  await row.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await row.getByTestId('timeline-track').click({ button: 'right', position: { x: 320, y: 18 } });
  await page.getByRole('menuitem', { name: '新建生成草稿', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).document.timelines[timeline.id]?.itemIds.length).toBe(1);
  const itemId = (await snapshot(page)).document.timelines[timeline.id]!.itemIds[0]!;
  const original = (await snapshot(page)).document.items[itemId]!;
  await row.getByTestId('timeline-label').click();
  await expect(page.getByRole('dialog', { name: '时间线默认配置', exact: true })).toHaveCount(1);
  await page.getByRole('combobox', { name: '分辨率', exact: true }).selectOption('1080p');
  await expect.poll(async () => (await snapshot(page)).document.timelines[timeline.id]?.settings.resolution).toBe('1080p');
  const retained = (await snapshot(page)).document.items[itemId]!;
  expect(retained.generationSettings?.resolution).toBe('720p');
  expect(retained.generationToken).toBe(original.generationToken);
  expect(retained.params).toEqual(original.params); expect(retained.outputAssetId).toBe(original.outputAssetId);
  await page.keyboard.press('Escape');
  await row.getByTestId('timeline-track').click({ button: 'right', position: { x: 640, y: 18 } });
  await page.getByRole('menuitem', { name: '新建生成草稿', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).document.timelines[timeline.id]?.itemIds.length).toBe(2);
  const newItemId = (await snapshot(page)).document.timelines[timeline.id]!.itemIds.find(id => id !== itemId)!;
  expect((await snapshot(page)).document.items[newItemId]?.generationSettings?.resolution).toBe('1080p');
  await row.getByTestId('timeline-label').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '刷新时间轴默认配置', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).document.items[itemId]?.generationSettings?.resolution).toBe('1080p');
  expect((await snapshot(page)).document.items[itemId]?.generationToken).not.toBe(original.generationToken);
  expect(await (await page.request.get('/api/jobs')).json()).toEqual({ items: [] });
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

async function openLibrary(page: Page): Promise<Page> {
  await page.getByTestId('viewer').click({ button: 'right' });
  await expect(page.getByRole('menuitem')).toHaveCount(1);
  const popup = page.waitForEvent('popup');
  await page.getByRole('menuitem', { name: '素材库', exact: true }).click();
  const library = await popup;
  await expect(library.getByTestId('library-window')).toBeVisible();
  await expect(library.getByTestId('asset-library')).toBeVisible();
  return library;
}

async function windowDrop(sourcePage: Page, source: ReturnType<Page['locator']>, targetPage: Page, target: ReturnType<Page['locator']>, x = 12): Promise<string> {
  const transfer = await sourcePage.evaluateHandle(() => new DataTransfer());
  const box = await source.boundingBox();
  expect(box).not.toBeNull();
  await source.dispatchEvent('dragstart', { dataTransfer: transfer, clientX: box!.x + 12, clientY: box!.y + 12 });
  const token = await sourcePage.evaluate(data => data.getData('application/x-pixel-object'), transfer);
  expect(token).toBeTruthy();
  await expect(target).toBeVisible();
  const targetData = await targetPage.evaluateHandle(value => {
    const data = new DataTransfer(); data.setData('application/x-pixel-object', value); return data;
  }, token);
  const targetBox = await target.boundingBox();
  expect(targetBox).not.toBeNull();
  const event = { dataTransfer: targetData, clientX: targetBox!.x + x, clientY: targetBox!.y + 12 };
  const before = await snapshot(targetPage);
  const unrelated = await targetPage.evaluateHandle(() => new DataTransfer());
  await target.dispatchEvent('drop', {...event,dataTransfer:unrelated});
  await unrelated.dispose();
  expect(await snapshot(targetPage)).toEqual(before);
  await target.dispatchEvent('dragover', event);
  await target.dispatchEvent('drop', event);
  await source.dispatchEvent('dragend', { dataTransfer: transfer });
  await transfer.dispose(); await targetData.dispose();
  return token;
}

test('真实工作窗口双向拖拽放置、引用和复用，局部详情只隔离所属窗口', async ({ page }) => {
  await openWorkbench(page);
  const library = await openLibrary(page);
  const transfer = await library.evaluateHandle(() => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([png], 'reference.png', { type: 'image/png' })); return data;
  });
  await library.getByTestId('asset-library').dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
  const source = library.getByTestId('asset-card').filter({ hasText: 'reference.png' });
  await expect(source).toBeVisible();
  const afterImport = await snapshot(page);
  const asset = Object.values(afterImport.document.assets).find(candidate => candidate.metadata.name === 'reference.png')!;
  await source.dblclick();
  await expect(library.getByRole('dialog', { name: '素材详情', exact: true })).toBeVisible();
  await expect(library.getByTestId('library-window')).toHaveAttribute('inert', '');
  await library.getByRole('dialog').focus();
  await library.keyboard.press('Shift+Tab');
  await expect(library.getByRole('dialog').getByRole('button', { name: '关闭窗口', exact: true })).toBeFocused();
  await library.keyboard.press('Tab');
  await expect(library.getByRole('dialog').getByRole('button', { name: '关闭窗口', exact: true })).toBeFocused();
  await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
  await page.getByTestId('timeline-ruler').click({ position: { x: 96, y: 8 } });
  await expect(page.getByTestId('timeline-ruler')).toHaveAttribute('aria-valuenow', '3000');
  await library.keyboard.press('Escape');
  await expect(library.getByRole('dialog')).toHaveCount(0);
  expect(await snapshot(page)).toEqual(afterImport);
  const wanId = await itemForModel(page, 'alibaba/wan-3.0');
  await windowDrop(library, source, page, page.locator(`[data-testid="timeline-item"][data-item-id="${wanId}"]`).getByTestId('item-reference-drop'));
  await expect.poll(async () => (await snapshot(page)).document.items[wanId]?.referenceAssetIds).toContain(asset.id);
  const referenced = await snapshot(page);
  const unreference = await page.request.post('/api/actions', { data: { requestId: crypto.randomUUID(), projectId: referenced.document.id, expectedRevision: referenced.revision,
    type:'item.reference.remove', payload:{itemId:wanId,assetId:asset.id} } });
  expect((await unreference.json()).ok).toBe(true);
  await expect.poll(async () => (await snapshot(page)).document.items[wanId]?.referenceAssetIds).toEqual([]);
  await page.locator(`[data-testid="timeline-item"][data-item-id="${wanId}"]`).dblclick({position:{x:70,y:24}});
  await expect(page.getByRole('dialog', {name:'片段详情',exact:true})).toBeVisible();
  await windowDrop(library, source, page, page.getByRole('dialog').getByTestId('item-reference'));
  await expect.poll(async () => (await snapshot(page)).document.items[wanId]?.referenceAssetIds).toContain(asset.id);
  await page.keyboard.press('Escape');
  const before = await snapshot(page);
  const timeline = Object.values(before.document.timelines).find(t => t.modelId === 'x-ai/grok-imagine-image-2.0')!;
  const track = page.locator(`[data-testid="timeline-row"][data-timeline-id="${timeline.id}"]`).getByTestId('timeline-track');
  const token = await windowDrop(library, source, page, track, 320);
  await expect.poll(async () => (await snapshot(page)).document.timelines[timeline.id]?.itemIds.length).toBe(timeline.itemIds.length + 1);
  const placed = await snapshot(page);
  const item = Object.values(placed.document.items).find(candidate => !before.document.items[candidate.id])!;
  expect(item.outputAssetId).toBe(asset.id); expect(item.startTick).toBe(10000);
  const itemView = page.locator(`[data-testid="timeline-item"][data-item-id="${item.id}"]`);
  // A 200ms item occupies 6.4px of time but keeps a 24px hit area. Dragging
  // its visible body must clamp the grip offset to its real duration.
  const short = await page.request.post('/api/actions', { data: { requestId: crypto.randomUUID(), projectId: placed.document.id, expectedRevision: placed.revision,
    type: 'item.resize', payload: { itemId: item.id, startTick: item.startTick, durationTicks: 200 } } });
  expect((await short.json()).ok).toBe(true);
  await expect.poll(async () => (await snapshot(page)).document.items[item.id]?.durationTicks).toBe(200);
  const beforeReuse = await snapshot(page);
  await windowDrop(page, itemView, library, library.getByTestId('asset-library'));
  await expect.poll(async () => (await snapshot(page)).revision).toBe(beforeReuse.revision + 1);
  const saved = await snapshot(page);
  const forged = await page.evaluateHandle(value => { const data = new DataTransfer(); data.setData('application/x-pixel-object', value); return data; }, token);
  const trackBox = await track.boundingBox();
  await track.dispatchEvent('drop', { dataTransfer: forged, clientX: trackBox!.x + 400, clientY: trackBox!.y + 12 });
  await forged.dispose();
  expect(await snapshot(page)).toEqual(saved);
  const restore = await page.request.post('/api/actions', { data: { requestId: crypto.randomUUID(), projectId: saved.document.id, expectedRevision: saved.revision,
    type:'item.resize', payload:{itemId:item.id,startTick:item.startTick,durationTicks:item.durationTicks} } });
  expect((await restore.json()).ok).toBe(true);
  await expect.poll(async () => (await snapshot(page)).document.items[item.id]?.durationTicks).toBe(item.durationTicks);
  await expect(library.getByTestId('relation-surface')).toHaveCount(0);
  await expect(library.getByTestId('reusable-item')).toHaveCount(0);
  await itemView.click();
  await expect(page.getByTestId('viewer').locator('img')).toHaveAttribute('src', `/api/media/${asset.id}`);
  await library.close();
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
  await expect(page.getByTestId('viewer')).toContainText('暂无输出');
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
  const library = await openLibrary(page);
  const transfer = await library.evaluateHandle(() => {
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
  await library.getByTestId('asset-library').dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
  await expect(library.getByTestId('asset-card').filter({ hasText: 'scrub.wav' })).toBeVisible();
  const before = await snapshot(page);
  const voice = Object.values(before.document.timelines).find(timeline => timeline.modelId === 'eleven_v4')!;
  await windowDrop(library, library.getByTestId('asset-card').filter({ hasText: 'scrub.wav' }), page, page.locator(`[data-testid="timeline-row"][data-timeline-id="${voice.id}"]`).getByTestId('timeline-track'), 4);
  await expect.poll(async () => (await snapshot(page)).document.timelines[voice.id]?.itemIds.length).toBe(voice.itemIds.length + 1);
  const after = await snapshot(page);
  const placed = Object.values(after.document.items).find(item => !before.document.items[item.id])!;
  await library.close();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator(`[data-testid="timeline-item"][data-item-id="${placed.id}"]`).click();
  const audio = page.getByTestId('viewer').locator(`audio[src$="/api/media/${placed.outputAssetId}"]`);
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
  await expect(page.locator('.workspace-feedback')).toContainText('浏览器验证已阻止付费生成');
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

test('系统文件拖入主窗口走项目入口，浏览器开发版阻止误导入与页面跳转', async ({ page }) => {
  await openWorkbench(page);
  const before = await snapshot(page);
  let imports = 0;
  await page.route('**/api/import', async route => { imports++; await route.abort(); });
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File([''], '测试', { type: 'application/octet-stream' }));
    return data;
  });
  // Nested timeline handlers cannot reinterpret an OS file drop as item placement.
  await page.getByTestId('timeline-track').first().dispatchEvent('dragover', { dataTransfer: transfer });
  await page.getByTestId('timeline-track').first().dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.locator('.workspace-feedback')).toContainText('请使用桌面版拖入项目文件或文件夹');
  expect(page.url()).toBe('http://127.0.0.1:4320/');
  expect(imports).toBe(0);
  expect(await snapshot(page)).toEqual(before);
  await transfer.dispose();
});

test('系统目录拖入素材库明确拒绝，不上传空目录或打开项目', async ({ page }) => {
  await openWorkbench(page);
  const before = await snapshot(page);
  const library = await openLibrary(page);
  let imports = 0;
  await library.route('**/api/import', async route => { imports++; await route.abort(); });
  const transfer = await library.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File([''], '测试', { type: 'application/octet-stream' }));
    // Chromium returns fresh DataTransferItem wrappers when reading the list.
    Object.defineProperty(DataTransferItem.prototype, 'webkitGetAsEntry', { configurable: true, value: () => ({ isDirectory: true }) });
    return data;
  });
  await library.getByTestId('asset-library').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(library.getByRole('status')).toContainText('项目文件夹请拖入主窗口');
  expect(imports).toBe(0);
  expect(await snapshot(page)).toEqual(before);
  await transfer.dispose();
  await library.close();
});

test('打开非默认 ID 的项目后，窗口投影、详情和命令使用宿主项目身份', async ({ page }) => {
  const state = await snapshot(page);
  const projectId = 'opened-project-测试';
  const opened = structuredClone(state);
  opened.document.id = projectId;
  opened.document.title = '拖入的项目';
  await page.route('**/api/session', route => route.fulfill({ json: { projectId, sessionId: 'opened-project-session' } }));
  await page.route('**/api/project', route => route.fulfill({ json: opened }));
  let lastAction: ActionEnvelope | undefined;
  await page.route('**/api/actions', async route => {
    lastAction = route.request().postDataJSON() as ActionEnvelope;
    await route.fulfill({ json: { ok: false, requestId: lastAction.requestId, error: { code: 'NOT_APPLICABLE', message: '当前项目命令已捕获' } } });
  });
  await page.goto('/');
  await expect(page.getByRole('group', { name: '作品详情', exact: true })).toHaveText('拖入的项目');
  await page.getByRole('group', { name: '作品详情', exact: true }).dblclick();
  await expect(page.getByRole('dialog', { name: '作品详情', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '作品名称', exact: true }).fill('新名称');
  await page.getByRole('textbox', { name: '作品名称', exact: true }).press('Enter');
  await expect.poll(() => lastAction?.projectId).toBe(projectId);
  expect(lastAction?.type).toBe('project.title');
  expect(lastAction?.payload).toEqual({ title: '新名称' });
});

async function pictureTransfer(page:Page):Promise<Awaited<ReturnType<Page['evaluateHandle']>>> {
  return page.evaluateHandle(()=>{
    const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0));
    const data=new DataTransfer();data.items.add(new File([png],'direct-picture.png',{type:'image/png'}));return data;
  });
}

test('外部图片直接拖入时间线原子创建普通媒体轨，模型轨与 Viewer 不偷偷导入', async ({page})=>{
  await openWorkbench(page);
  let imports=0;let placements=0;
  await page.route('**/api/import',async route=>{imports++;await route.continue();});
  await page.route('**/api/media-place',async route=>{placements++;await route.continue();});
  const before=await snapshot(page);
  const data=await pictureTransfer(page);
  await page.getByTestId('timeline-workspace').dispatchEvent('drop',{dataTransfer:data});
  await expect(page.locator('.workspace-feedback')).toContainText('已放置 direct-picture.png');
  const placed=await snapshot(page);
  expect(placed.revision).toBe(before.revision+1);
  const timeline=Object.values(placed.document.timelines).find(candidate=>!before.document.timelines[candidate.id])!;
  expect(timeline.pluginId).toBe('pixel.image.local');
  expect(timeline.modelId).toBeUndefined();
  const item=placed.document.items[timeline.itemIds[0]!]!;
  expect(item.startTick).toBe(0);
  expect(item.outputAssetId).toBeTruthy();
  expect(Object.keys(placed.document.assets)).toHaveLength(Object.keys(before.document.assets).length+1);
  const view=page.locator(`[data-item-id="${item.id}"]`);
  await view.click();
  await expect(page.getByTestId('viewer').locator('img')).toHaveAttribute('src',`/api/media/${item.outputAssetId}`);
  await view.click({button:'right'});
  await expect(page.getByRole('menuitem',{name:'生成片段',exact:true})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await view.dblclick();
  await expect(page.getByRole('dialog')).toContainText('输出媒体');
  await expect(page.getByRole('dialog')).not.toContainText('生成输出');
  await page.keyboard.press('Escape');
  const track=page.locator(`[data-timeline-id="${timeline.id}"]`).getByTestId('timeline-track');
  await track.scrollIntoViewIfNeeded();
  const box=await track.boundingBox();
  await track.dispatchEvent('drop',{dataTransfer:data,clientX:box!.x+320,clientY:box!.y+18});
  await expect.poll(async()=>(await snapshot(page)).document.timelines[timeline.id]?.itemIds.length).toBe(2);
  const second=await snapshot(page);
  expect(second.document.items[second.document.timelines[timeline.id]!.itemIds[1]!]!.startTick).toBe(10000);
  const generated=Object.values(second.document.timelines).find(candidate=>candidate.modelId==='x-ai/grok-imagine-image-2.0')!;
  await page.locator(`[data-timeline-id="${generated.id}"]`).getByTestId('timeline-track').dispatchEvent('drop',{dataTransfer:data});
  await expect(page.locator('.workspace-feedback')).toContainText('请将媒体拖入普通媒体时间线');
  await page.getByTestId('viewer').dispatchEvent('drop',{dataTransfer:data});
  await expect(page.locator('.workspace-feedback')).toContainText('请将媒体拖入普通媒体时间线');
  expect(await snapshot(page)).toEqual(second);
  expect(imports).toBe(0);expect(placements).toBe(2);
  expect(await(await page.request.get('/api/jobs')).json()).toEqual({items:[]});
  await data.dispose();
});

test('纯文本参考经时间线基类创建编辑移动缩放复制删除，选中不会遮蔽媒体预览', async ({page})=>{
  await openWorkbench(page);
  const picture=await pictureTransfer(page);
  await page.getByTestId('timeline-workspace').dispatchEvent('drop',{dataTransfer:picture});
  await expect(page.locator('.workspace-feedback')).toContainText('已放置 direct-picture.png');await picture.dispose();
  const before=await snapshot(page);
  await createTimeline(page,'纯文本时间轴');
  const created=await snapshot(page);
  const timeline=Object.values(created.document.timelines).find(candidate=>!before.document.timelines[candidate.id])!;
  expect(timeline.pluginId).toBe('pixel.text');expect(timeline.modelId).toBeUndefined();
  expect(timeline.itemIds).toEqual([]);
  const row=page.locator(`[data-timeline-id="${timeline.id}"]`);
  await row.getByTestId('timeline-label').click({button:'right'});
  await expect(page.getByRole('menuitem',{name:'刷新时间轴默认配置',exact:true})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await row.getByTestId('timeline-track').click({button:'right',position:{x:4,y:18}});
  await expect(page.getByRole('menuitem',{name:'新建生成草稿',exact:true})).toHaveCount(0);
  await page.getByRole('menuitem',{name:'新建文本片段',exact:true}).click();
  await expect.poll(async()=>(await snapshot(page)).document.timelines[timeline.id]?.itemIds.length).toBe(1);
  const initial=await snapshot(page);
  const id=initial.document.timelines[timeline.id]!.itemIds[0]!;
  const note=page.locator(`[data-item-id="${id}"]`);
  await note.dblclick();
  const body='镜头 1：进入车站\n提示词参考：夜色、雨滴与窗内灯光';
  const field=page.getByRole('textbox',{name:'文本描述',exact:true});
  await field.fill(body);await field.press('Control+Enter');
  await expect.poll(async()=>(await snapshot(page)).document.items[id]?.params.text).toBe(body);
  expect(await field.evaluate(element=>getComputedStyle(element).fontSize)).toBe('12px');
  await expect(page.getByTestId('item-reference')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await note.click();
  // A reference track never becomes a synthetic Viewer output or hides media.
  await expect(page.getByTestId('viewer').locator('img[src^="/api/media/"]').first()).toBeVisible();
  await expect(page.getByTestId('viewer').locator(`[data-composition-item="${id}"]`)).toHaveCount(0);
  await expect(note).toContainText('镜头 1：进入车站');
  await note.click({button:'right'});
  await expect(page.getByRole('menuitem',{name:'生成片段',exact:true})).toHaveCount(0);
  await expect(page.getByRole('menuitem',{name:'继续中断任务',exact:true})).toHaveCount(0);
  await page.keyboard.press('Escape');
  const disk=await pictureTransfer(page);
  await row.getByTestId('timeline-track').dispatchEvent('drop',{dataTransfer:disk});
  await expect(page.locator('.workspace-feedback')).toContainText('请将媒体拖入普通媒体时间线');
  expect((await snapshot(page)).revision).toBe(initial.revision+1);
  await disk.dispose();
  const transfer=await page.evaluateHandle(()=>new DataTransfer());
  const box=await note.boundingBox();
  await note.dispatchEvent('dragstart',{dataTransfer:transfer,clientX:box!.x+16,clientY:box!.y+24});
  const track=row.getByTestId('timeline-track');const trackBox=await track.boundingBox();
  await track.dispatchEvent('drop',{dataTransfer:transfer,clientX:trackBox!.x+640,clientY:trackBox!.y+24});
  await note.dispatchEvent('dragend',{dataTransfer:transfer});await transfer.dispose();
  await expect.poll(async()=>(await snapshot(page)).document.items[id]?.startTick).toBe(19500);
  await note.scrollIntoViewIfNeeded();
  const edge=await note.getByTestId('item-edge-end').boundingBox();
  await page.mouse.move(edge!.x+edge!.width/2,edge!.y+edge!.height/2);await page.mouse.down();
  await page.mouse.move(edge!.x+edge!.width/2+32,edge!.y+edge!.height/2,{steps:4});await page.mouse.up();
  await expect.poll(async()=>(await snapshot(page)).document.items[id]?.durationTicks).toBe(6000);
  await note.click({button:'right'});await page.getByRole('menuitem',{name:'复制片段',exact:true}).click();
  await expect.poll(async()=>(await snapshot(page)).document.timelines[timeline.id]?.itemIds.length).toBe(2);
  const copied=await snapshot(page);const copyId=copied.document.timelines[timeline.id]!.itemIds.find(itemId=>itemId!==id)!;
  expect(copied.document.items[copyId]?.params.text).toBe(body);
  await page.locator(`[data-item-id="${copyId}"]`).click({button:'right'});await page.getByRole('menuitem',{name:'删除片段',exact:true}).click();
  await expect.poll(async()=>(await snapshot(page)).document.timelines[timeline.id]?.itemIds.length).toBe(1);
  const final=await snapshot(page);
  expect(final.document.items[id]?.kind).toBe('text.note');
  expect(final.document.items[id]?.outputAssetId).toBeUndefined();expect(final.document.items[id]?.referenceAssetIds).toEqual([]);
  expect(Object.keys(final.document.assets)).toHaveLength(Object.keys(before.document.assets).length);
  expect(await(await page.request.get('/api/jobs')).json()).toEqual({items:[]});
  await page.reload();await expect(page.locator(`[data-item-id="${id}"]`)).toContainText('镜头 1：进入车站');
});

test('Viewer详情和信息跟随真实前景，选择下层、重排与空白时间不打开旧输出',async({page})=>{
  await openWorkbench(page);const original=await snapshot(page);const fixtures:{timelineId:string;itemId:string;assetId:string}[]=[];
  const edit=async(type:string,payload:JsonObject)=>{const state=await snapshot(page);const response=await page.request.post('/api/actions',{data:{type,payload,requestId:crypto.randomUUID(),projectId:state.document.id,expectedRevision:state.revision}});expect((await response.json() as ActionResult).ok).toBe(true);};
  const row=(id:string)=>page.locator(`[data-testid="timeline-row"][data-timeline-id="${id}"]`);const viewer=page.getByTestId('viewer');
  const checkDetail=async(assetId:string)=>{await viewer.dblclick({position:{x:60,y:60}});await expect(page.getByRole('dialog',{name:'片段详情',exact:true})).toBeVisible();
    await page.getByTestId('modal-host').locator('.detail-link').filter({hasText:'输出媒体'}).dblclick();await expect(page.getByTestId('modal-host').locator('img')).toHaveAttribute('src',`/api/media/${assetId}`);await page.keyboard.press('Escape');await page.keyboard.press('Escape');};
  try {
    for(const [index,durationTicks] of [4000,7000].entries()) {const state=await snapshot(page);const response=await page.request.post('/api/media-place',{headers:{'Content-Type':'image/png','X-Pixel-Name':encodeURIComponent(`foreground-${index}.png`),
      'X-Pixel-Project-Id':state.document.id,'X-Pixel-Request-Id':crypto.randomUUID(),'X-Pixel-Revision':String(state.revision),'X-Pixel-Start-Tick':'0'},data:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')});
      const result=await response.json() as ActionResult;expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.error.message);const fixture=result.outcome as unknown as typeof fixtures[number];fixtures.push(fixture);await edit('item.resize',{itemId:fixture.itemId,startTick:0,durationTicks});}
    const [front,back]=fixtures as [typeof fixtures[number],typeof fixtures[number]];
    const first=(original.document.timelineOrder??Object.keys(original.document.timelines))[0]!;await edit('timeline.reorder',{timelineId:front.timelineId,beforeTimelineId:first});await edit('timeline.reorder',{timelineId:back.timelineId,beforeTimelineId:first});
    const before=await snapshot(page);await page.locator(`[data-item-id="${back.itemId}"]`).click();await expect(page.locator('.viewer-meta>span:last-child')).toHaveText('00:04');await checkDetail(front.assetId);expect(await snapshot(page)).toEqual(before);
    const handle=row(back.timelineId).getByTestId('timeline-sort-handle');await handle.focus();await page.keyboard.press('Space');await expect(handle).toHaveAttribute('aria-pressed','true');await page.keyboard.press('ArrowUp');
    await expect(page.locator('[id^="DndLiveRegion"]')).toContainText(`over droppable area ${front.timelineId}`);await page.keyboard.press('Space');
    await expect.poll(async()=>(await snapshot(page)).document.timelineOrder?.[0]).toBe(back.timelineId);await expect(page.locator('.viewer-meta>span:last-child')).toHaveText('00:07');await checkDetail(back.assetId);
    const after=await snapshot(page);expect(after.revision).toBe(before.revision+1);expect(after.document.items).toEqual(before.document.items);expect(after.document.timelines).toEqual(before.document.timelines);
    const ruler=page.getByTestId('timeline-ruler');await ruler.focus();await ruler.press('End');await expect(viewer).toContainText('暂无输出');await expect(page.locator('.viewer-meta')).toHaveCount(0);
    await viewer.dblclick({position:{x:60,y:60}});await expect(page.getByRole('dialog')).toHaveCount(0);expect(await snapshot(page)).toEqual(after);
  } finally {for(const fixture of fixtures){if((await snapshot(page)).document.timelines[fixture.timelineId])await edit('timeline.delete',{timelineId:fixture.timelineId});if((await snapshot(page)).document.assets[fixture.assetId])await edit('asset.remove',{assetId:fixture.assetId});}}
});
