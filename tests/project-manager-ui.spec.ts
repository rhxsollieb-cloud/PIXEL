import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import type { ActionEnvelope, ActionResult, JsonObject, ProjectSnapshot } from '../src/contracts.js';
import { decodeProjectPackage } from '../src/project-package.js';
import type { SharedProjectSummary } from '../src/shared-projects.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

async function snapshot(page: Page): Promise<ProjectSnapshot> {
  const response = await page.request.get('/api/project');
  expect(response.ok()).toBe(true);
  return response.json() as Promise<ProjectSnapshot>;
}
async function action(page: Page, type: string, payload: JsonObject): Promise<Extract<ActionResult, { ok: true }>> {
  const state = await snapshot(page);
  const response = await page.request.post('/api/actions', { data: {
    requestId: randomUUID(), projectId: state.document.id, expectedRevision: state.revision, type, payload,
  } });
  const result = await response.json() as ActionResult;
  expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result;
}
async function protectProviders(context: BrowserContext) {
  await context.route('**/api/actions', async route => {
    const input = route.request().postDataJSON() as ActionEnvelope;
    if (['generation.submit', 'generation.resume'].includes(input.type)) {
      await route.fulfill({ json: { ok: false, requestId: input.requestId,
        error: { code: 'NOT_APPLICABLE', message: '项目管理器浏览器验证禁止调用供应商' } } });
    } else await route.continue();
  });
  await context.route('**/api/voices?*', route => route.fulfill({ json: { items: [] } }));
  await context.route('**/api/voice-clone', route => route.fulfill({ status: 400,
    json: { ok: false, error: { code: 'NOT_APPLICABLE', message: '项目管理器浏览器验证禁止克隆声纹' } } }));
}
test.beforeEach(async ({ context }) => { await protectProviders(context); });

test('项目管理器下载可重新读取的整项目及单轨工程包，媒体与文档分开且保留原时间结构', async ({ page }) => {
  const state = await snapshot(page);
  const imported = await page.request.post('/api/import', {
    headers: { 'Content-Type': 'image/png', 'X-Pixel-Project-Id': state.document.id,
      'X-Pixel-Request-Id': randomUUID(), 'X-Pixel-Revision': String(state.revision), 'X-Pixel-Name': encodeURIComponent('工程包图片.png') },
    data: png,
  });
  const importResult = await imported.json() as ActionResult;
  expect(importResult.ok).toBe(true);
  if (!importResult.ok) throw new Error(importResult.error.message);
  const assetId = String(importResult.outcome.assetId);
  const timelineId = String((await action(page, 'timeline.create', { typeId: 'pixel.image.local' })).outcome.timelineId);
  try {
    const itemId = String((await action(page, 'item.create', { timelineId, assetId, startTick: 3500 })).outcome.itemId);
    const original = await snapshot(page);
    await page.goto('/?window=library');
    await expect(page.getByTestId('project-manager')).toBeVisible();
    const timelineExport = page.getByRole('button', { name: '导出时间线', exact: true });
    await expect(timelineExport).toBeDisabled();
    const wholeDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出整个项目', exact: true }).click();
    const whole = await wholeDownload;
    expect(whole.suggestedFilename()).toMatch(/\.pixel\.zip$/);
    const wholePath = await whole.path(); expect(wholePath).not.toBeNull();
    const wholeBytes = await readFile(wholePath!);
    const wholePackage = decodeProjectPackage(wholeBytes);
    expect(wholePackage.state.snapshot.document.timelines).toEqual(original.document.timelines);
    expect(wholePackage.state.snapshot.document.items).toEqual(original.document.items);
    expect(wholePackage.state.history.length).toBeGreaterThan(0);
    const files = unzipSync(wholeBytes);
    expect(files['project/project.json']).toBeDefined();
    expect(files[`media/${assetId}.png`]).toEqual(new Uint8Array(png));
    expect(wholePackage.state.outbox).toEqual([]);
    expect(wholePackage.state.requests).toEqual({});
    expect(wholePackage.state.snapshot.document.assets[assetId]!.metadata.storage).toBeUndefined();

    await page.getByRole('combobox', { name: '要导出的时间线', exact: true }).selectOption(timelineId);
    await expect(timelineExport).toBeEnabled();
    const trackDownload = page.waitForEvent('download'); await timelineExport.click();
    const track = await trackDownload; const trackPath = await track.path(); expect(trackPath).not.toBeNull();
    const trackPackage = decodeProjectPackage(await readFile(trackPath!));
    expect(Object.keys(trackPackage.state.snapshot.document.timelines)).toEqual([timelineId]);
    expect(trackPackage.state.snapshot.document.timelines[timelineId]).toEqual(original.document.timelines[timelineId]);
    expect(trackPackage.state.snapshot.document.items).toEqual({ [itemId]: original.document.items[itemId] });
    expect(trackPackage.artifacts.map(entry => entry.artifact.id)).toEqual([assetId]);
    expect(trackPackage.state.history).toEqual([]);
    expect(await snapshot(page)).toEqual(original);
    expect(await page.getByRole('button', { name: '导出整个项目', exact: true }).evaluate(button => getComputedStyle(button).fontSize)).toBe('12px');
    expect(await page.getByRole('combobox', { name: '要导出的时间线', exact: true }).evaluate(select => getComputedStyle(select).fontSize)).toBe('12px');
  } finally {
    if ((await snapshot(page)).document.timelines[timelineId]) await action(page, 'timeline.delete', { timelineId });
    if ((await snapshot(page)).document.assets[assetId]) await action(page, 'asset.remove', { assetId });
  }
});

test('媒体检查在等待和失败时不会显示正常，刷新成功后恢复状态；隔离适配器关闭共享写入口', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let checks = 0;
  await page.route('**/api/project/media-status', async route => {
    checks++;
    if (checks === 1) {
      await pending;
      await route.fulfill({ status: 503, json: { error: { message: '共享存储暂时无法连接' } } });
    } else await route.fulfill({ json: { missing: [] } });
  });
  await page.goto('/?window=library');
  const health = page.getByTestId('media-health');
  await expect(health).toHaveText('正在检查媒体位置…');
  await expect(page.getByText('媒体位置检查正常', { exact: true })).toHaveCount(0);
  release();
  await expect(health).toHaveText('媒体位置检查未完成：共享存储暂时无法连接');
  await expect(health).toHaveClass('feedback--error');
  await expect(page.getByRole('button', { name: '创建共享项目', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '导入工程包', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '扫描哈希恢复媒体', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '刷新项目列表与媒体状态', exact: true }).click();
  await expect(health).toHaveText('媒体位置检查正常');
  await expect(health).not.toHaveClass('feedback--error');
});

test('共享项目可见控件提交创建、工程包导入和哈希恢复，并通过桌面宿主打开项目', async ({ page, context }) => {
  const initial = await snapshot(page);
  const originalPackage = await (await page.request.get('/api/project/export')).body();
  const otherId = randomUUID(); const createdId = randomUUID();
  const projects: SharedProjectSummary[] = [
    { id: initial.document.id, title: initial.document.title, revision: initial.revision, timelineCount: Object.keys(initial.document.timelines).length, assetCount: Object.keys(initial.document.assets).length },
    { id: otherId, title: '团队另一个项目', revision: 2, timelineCount: 1, assetCount: 0 },
  ];
  let creates = 0; let imports = 0; let scans = 0; let needsRepair = true;
  // These responses test UI/host contracts only. Real shared storage and repairs are covered by backend tests.
  await context.route('**/api/projects', async route => {
    if (route.request().method() === 'POST') {
      creates++; const input = route.request().postDataJSON() as { title: string; requestId: string };
      expect(input.title).toBe('团队分镜'); expect(input.requestId).toMatch(/^[a-f0-9-]{36}$/);
      projects.push({ id: createdId, title: input.title, revision: 0, timelineCount: 0, assetCount: 0 });
      await route.fulfill({ json: { id: createdId, title: input.title } });
    } else await route.fulfill({ json: { items: projects, shared: true } });
  });
  await context.route('**/api/projects/import', async route => {
    imports++; expect(route.request().headers()['x-pixel-request']).toMatch(/^[a-f0-9-]{36}$/);
    expect(route.request().postDataBuffer()).toEqual(originalPackage);
    const id = randomUUID(); const title = imports === 1 ? '导入分镜' : '拖入分镜';
    projects.push({ id, title, revision: 0, timelineCount: 1, assetCount: 0 });
    await route.fulfill({ json: { id, title } });
  });
  await context.route('**/api/project/media-status', route => route.fulfill({ json: {
    missing: needsRepair ? [{ id: randomUUID(), name: '已移动的镜头.mp4' }] : [],
  } }));
  await context.route('**/api/project/media-recover', async route => {
    scans++; expect(route.request().method()).toBe('POST'); needsRepair = false;
    await route.fulfill({ json: { scanned: 7, repaired: [randomUUID()], missing: [] } });
  });
  await page.addInitScript(() => {
    const host = window as unknown as Window & { managerOpenRequests: string[]; managerRecovered: number };
    host.managerOpenRequests = []; host.managerRecovered = 0;
    window.addEventListener('pixel:media-recovered', () => { host.managerRecovered++; });
    Object.defineProperty(window, 'pixelDesktop', { value: {
      isDetailWindow: false, isLibraryWindow: true, onObjectDrag: () => () => {},
      isMaximized: async () => false, onMaximizedChanged: () => () => {}, close: () => {}, minimize: () => {}, toggleMaximize: () => {},
      openSharedProject: async (id: string) => { host.managerOpenRequests.push(id); return { ok: false, error: '该项目正由另一台电脑编辑' }; },
    } });
  });
  await page.goto('/?window=library'); await expect(page.getByTestId('project-manager')).toBeVisible();
  await expect(page.getByRole('button', { name: '当前项目', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '打开项目', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('该项目正由另一台电脑编辑');
  expect(await page.evaluate(() => (window as unknown as Window & { managerOpenRequests: string[] }).managerOpenRequests)).toEqual([otherId]);
  await page.getByLabel('新项目名称', { exact: true }).fill('团队分镜');
  await page.getByRole('button', { name: '创建共享项目', exact: true }).click();
  await expect(page.getByText('团队分镜', { exact: true })).toBeVisible();
  await expect(page.getByLabel('新项目名称', { exact: true })).toHaveValue(''); expect(creates).toBe(1);

  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入工程包', exact: true }).click();
  const chooser = await choosing;
  await expect(page.getByLabel('导入 Pixel 工程包', { exact: true })).toHaveAttribute('accept', '.pixel.zip');
  await chooser.setFiles({ name: '分镜.pixel.zip', mimeType: 'application/zip', buffer: originalPackage });
  await expect(page.getByText('导入分镜', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('已导入「导入分镜」，可在项目列表中打开');
  expect(imports).toBe(1);
  expect(await page.evaluate(() => (window as unknown as Window & { managerOpenRequests: string[] }).managerOpenRequests)).toEqual([otherId]);

  const dropped = await page.evaluateHandle(bytes => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], '拖入分镜.pixel.zip', { type: 'application/zip' }));
    return transfer;
  }, [...originalPackage]);
  try {
    await page.getByRole('complementary', { name: '共享项目', exact: true }).dispatchEvent('drop', { dataTransfer: dropped });
    await expect(page.getByText('拖入分镜', { exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('已导入「拖入分镜」，可在项目列表中打开');
    expect(imports).toBe(2);
    expect(await page.evaluate(() => (window as unknown as Window & { managerOpenRequests: string[] }).managerOpenRequests)).toEqual([otherId]);
  } finally { await dropped.dispose(); }

  await expect(page.getByTestId('media-health')).toContainText('1 份媒体需要恢复');
  await page.getByText('查看缺失媒体', { exact: true }).click();
  await expect(page.getByText('已移动的镜头.mp4', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '扫描哈希恢复媒体', exact: true }).click();
  await expect(page.getByTestId('media-health')).toHaveText('媒体位置检查正常');
  await expect(page.getByRole('status')).toContainText('扫描 7 个文件，恢复 1 份媒体');
  expect(scans).toBe(1);
  expect(await page.evaluate(() => (window as unknown as Window & { managerRecovered: number }).managerRecovered)).toBe(1);
  expect(await snapshot(page)).toEqual(initial);
});
