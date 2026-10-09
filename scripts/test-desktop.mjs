import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { FileWorkbenchRepository } from '../src/workbench.ts';
import { createWorkbenchFixture } from '../tests/workbench-fixtures.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const emptyStorage = await mkdtemp(join(tmpdir(), 'pixel-desktop-empty-'));
const storage = await mkdtemp(join(tmpdir(), 'pixel-desktop-ui-'));
const projectLocations = await mkdtemp(join(tmpdir(), 'pixel-desktop-project-'));
const droppedDirectory = join(projectLocations, '测试 空项目');
const foreignDirectory = join(projectLocations, '普通文件夹');
const diskImage = join(projectLocations, 'desktop-export.png');
const screenshots = join(root, '.pixel', 'screenshots');
const testEntry = join(root, '.pixel', 'native-test-entry.mjs');
const envFor = directory => {
  const env = { ...process.env, NODE_ENV: 'test', PIXEL_STORAGE_DIR: directory, PIXEL_TEST_APPDATA: join(directory, 'desktop-profile'), ELEVENLABS_API_KEY: '', OPENROUTER_API_KEY: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};
const snapshot = page => page.evaluate(async () => (await fetch('/api/project')).json());
const executeAction = (page, type, payload) => page.evaluate(async ({type, payload}) => {
  const state = await (await fetch('/api/project')).json();
  return (await fetch('/api/actions', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ requestId:crypto.randomUUID(), projectId:state.document.id, expectedRevision:state.revision, type, payload }) })).json();
}, {type, payload});
const launch = async directory => {
  await mkdir(join(directory, 'desktop-profile'), { recursive: true });
  const application = await _electron.launch({ args: [testEntry, '--pixel-test-storage'], cwd: root, env: envFor(directory), timeout: 30000 });
  application.process().stderr.on('data', bytes => process.stderr.write(bytes));
  application.context().setDefaultTimeout(15000);
  return application;
};
async function nativeWindowDrop(sourcePage, source, targetPage, target, x, expectedOffset) {
  const receiver = await targetPage.context().newCDPSession(targetPage);
  await sourcePage.evaluate(() => {
    window.__pixelMouseObjectToken = '';
    document.addEventListener('dragstart', event => { window.__pixelMouseObjectToken = event.dataTransfer.getData('application/x-pixel-object'); }, { once: true });
  });
  try {
    const sourceBox = await source.boundingBox(); assert.ok(sourceBox);
    await sourcePage.bringToFront();
    await sourcePage.mouse.move(sourceBox.x + 12, sourceBox.y + 12);
    await sourcePage.mouse.down();
    await sourcePage.mouse.move(sourceBox.x + 40, sourceBox.y + 12, { steps: 5 });
    const token = await sourcePage.evaluate(() => window.__pixelMouseObjectToken);
    assert.ok(token, 'A real mouse dragstart must put the opaque session in DataTransfer');
    if (expectedOffset !== undefined) assert.equal(await sourcePage.evaluate(token => window.pixelDesktop.resolveObjectDrag(token)?.offsetTicks, token), expectedOffset);
    await expect(target).toBeVisible();
    // A detail section can exist below its scrollable viewport. Native CDP drops
    // use viewport coordinates, so expose the actual target before dispatching.
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox(); assert.ok(box);
    assert.equal(await target.evaluate((element, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return hit !== null && element.contains(hit);
    }, {x:box.x+x,y:box.y+12}), true, 'The native drop point must hit the intended target inside its viewport');
    const before = await snapshot(targetPage);
    const unrelated = await targetPage.evaluateHandle(() => new DataTransfer());
    await target.dispatchEvent('drop', {dataTransfer:unrelated,clientX:box.x+x,clientY:box.y+12});
    await unrelated.dispose();
    assert.deepEqual(await snapshot(targetPage), before);
    assert.ok(await targetPage.evaluate(token => window.pixelDesktop.resolveObjectDrag(token), token));
    const data = { items: [{ mimeType: 'application/x-pixel-object', data: token }], dragOperationsMask: 17 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await receiver.send('Input.dispatchDragEvent', { type, x: box.x + x, y: box.y + 12, data });
    }
    assert.equal(await targetPage.evaluate(token => window.pixelDesktop.finishObjectDrag(token), token), undefined);
  } finally {
    await sourcePage.mouse.up().catch(() => {});
    await receiver.detach();
  }
}
async function nativeFileDrop(page, target, file, position) {
  const receiver = await page.context().newCDPSession(page);
  try {
    await page.bringToFront();
    const box = await target.boundingBox(); assert.ok(box);
    const data = { items: [], files: [file], dragOperationsMask: 17 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await receiver.send('Input.dispatchDragEvent', { type, x: box.x + (position?.x ?? box.width / 2), y: box.y + (position?.y ?? box.height / 2), data });
    }
  } finally { await receiver.detach(); }
}
async function mouseViewerExport(page, expectedCount) {
  const viewer = page.getByTestId('viewer');
  await expect(viewer).toHaveAttribute('draggable', 'true');
  const box = await viewer.boundingBox(); assert.ok(box);
  await page.bringToFront();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  try {
    await page.mouse.move(box.x + 90, box.y + 50, { steps: 6 });
    await expect.poll(() => desktop.evaluate(() => globalThis.__pixelNativeDrags.length)).toBe(expectedCount);
  } finally { await page.mouse.up(); }
}
async function openLibraryWindow(page) {
  const opened = desktop.waitForEvent('window');
  await page.getByTestId('viewer').click({ button: 'right', position: { x: 120, y: 120 } });
  await page.getByRole('menuitem', { name: '素材库', exact: true }).click();
  const library = await opened;
  await expect(library.getByTestId('library-window')).toBeVisible();
  return library;
}
let desktop;
try {
  await mkdir(droppedDirectory);
  await mkdir(foreignDirectory);
  await writeFile(join(foreignDirectory, 'unrelated.txt'), 'Original unrelated file');
  await writeFile(diskImage, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
  await mkdir(screenshots, { recursive: true });
  // Keep native screenshot assertions independent of the test host's GPU driver.
  await writeFile(testEntry, "import { app } from 'electron';\nif (!process.env.PIXEL_TEST_APPDATA) throw new Error('Isolated test profile required');\napp.disableHardwareAcceleration();\napp.setPath('appData', process.env.PIXEL_TEST_APPDATA);\nawait import('../electron/main.mjs');\n");
  desktop = await launch(emptyStorage);
  const emptyWorkspace = await desktop.firstWindow();
  await expect(emptyWorkspace.getByRole('group', { name: '作品详情', exact: true })).toContainText('未命名作品');
  const emptyProject = await snapshot(emptyWorkspace);
  assert.deepEqual(emptyProject.document.timelines, {});
  assert.deepEqual(emptyProject.document.items, {});
  assert.deepEqual(emptyProject.document.assets, {});
  await expect(emptyWorkspace.getByTestId('timeline-row')).toHaveCount(0);
  await expect(emptyWorkspace.getByTestId('timeline-item')).toHaveCount(0);
  await expect(emptyWorkspace.getByTestId('asset-library')).toHaveCount(0);
  await expect(emptyWorkspace.getByTestId('viewer')).toHaveText('暂无输出');
  await expect(emptyWorkspace.getByTestId('viewer')).toHaveAttribute('draggable', 'false');
  await expect(emptyWorkspace.locator('.viewer-meta')).toHaveCount(0);
  await emptyWorkspace.evaluate(() => document.fonts.ready);
  const emptyCapture = await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => !candidate.getParentWindow());
    return (await window.webContents.capturePage()).toPNG().toString('base64');
  });
  await writeFile(join(screenshots, 'desktop-empty.png'), Buffer.from(emptyCapture, 'base64'));
  console.log('PIXEL_NATIVE_EMPTY_OK');

  const emptyLibraryWindow = desktop.waitForEvent('window');
  await emptyWorkspace.getByTestId('viewer').click({ button: 'right', position: { x: 120, y: 120 } });
  await expect(emptyWorkspace.getByRole('menuitem')).toHaveCount(1);
  await emptyWorkspace.getByRole('menuitem', { name: '素材库', exact: true }).click();
  const emptyLibrary = await emptyLibraryWindow;
  await expect(emptyLibrary.getByTestId('library-window')).toBeVisible();
  await expect(emptyLibrary.getByTestId('asset-library')).toContainText('拖入素材');
  assert.equal(new URL(emptyLibrary.url()).searchParams.get('window'), 'library');
  assert.deepEqual(await snapshot(emptyLibrary), emptyProject);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    return windows.length === 2 && windows.every(window => !window.isModal() && !window.getParentWindow() && window.isEnabled());
  }), true);
  await emptyWorkspace.getByTestId('viewer').dispatchEvent('contextmenu', { clientX: 200, clientY: 200 });
  await expect(emptyWorkspace.getByRole('menuitem', { name: '素材库', exact: true })).toBeVisible();
  await emptyWorkspace.keyboard.press('Escape');
  const emptyLibraryClosed = emptyLibrary.waitForEvent('close');
  await emptyLibrary.keyboard.press('Escape').catch(error => { if (!emptyLibrary.isClosed()) throw error; });
  await emptyLibraryClosed;
  assert.deepEqual(await snapshot(emptyWorkspace), emptyProject);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.getParentWindow()).isEnabled()), true);
  assert.equal(await emptyWorkspace.evaluate(async () => {
    try { await window.pixelDesktop.openDetails({ object: { kind: 'project', projectId: 'pixel-project' }, view: 'unsupported' }); return false; }
    catch { return true; }
  }), true);
  console.log('PIXEL_NATIVE_VIEWER_LIBRARY_OK');

  await emptyWorkspace.getByTestId('timeline-workspace').click({ button: 'right', position: { x: 260, y: 16 } });
  await emptyWorkspace.getByRole('menuitem', { name: '新建时间线', exact: true }).click();
  await emptyWorkspace.getByRole('menuitem', { name: 'Alibaba: Wan 3.0', exact: true }).click();
  await expect(emptyWorkspace.getByTestId('timeline-row')).toHaveCount(1);
  await expect(emptyWorkspace.getByTestId('timeline-item')).toHaveCount(0);
  const timelineOnly = await snapshot(emptyWorkspace);
  const emptyTimeline = Object.values(timelineOnly.document.timelines)[0];
  assert.equal(emptyTimeline.modelId, 'alibaba/wan-3.0');
  assert.deepEqual(emptyTimeline.itemIds, []);
  assert.deepEqual(timelineOnly.document.items, {});
  await emptyWorkspace.getByTestId('timeline-track').click({ button: 'right', position: { x: 320, y: 18 } });
  await emptyWorkspace.getByRole('menuitem', { name: '新建生成草稿', exact: true }).click();
  await expect(emptyWorkspace.getByTestId('timeline-item')).toHaveCount(1);
  const draftProject = await snapshot(emptyWorkspace);
  const draft = Object.values(draftProject.document.items)[0];
  assert.equal(draft.params.prompt, '');
  assert.equal(draft.outputAssetId, undefined);
  assert.deepEqual(draft.referenceAssetIds, []);
  assert.equal(draft.startTick, 10000);
  assert.deepEqual(draftProject.document.assets, {});
  const draftWindow = desktop.waitForEvent('window');
  await emptyWorkspace.getByTestId('timeline-item').dblclick({ position: { x: 70, y: 24 } });
  const draftDetail = await draftWindow;
  await expect(draftDetail.getByRole('dialog', { name: '片段详情', exact: true })).toBeVisible();
  await expect(draftDetail.getByLabel('画面与风格描述')).toHaveValue('');
  const firstPrompt = '从空项目创建的第一条草稿，仅编辑，不提交生成';
  await draftDetail.getByLabel('画面与风格描述').fill(firstPrompt);
  await draftDetail.getByLabel('画面与风格描述').press('Control+Enter');
  await expect(emptyWorkspace.getByTestId('timeline-item')).toContainText(firstPrompt);
  assert.equal((await snapshot(draftDetail)).document.items[draft.id].params.prompt, firstPrompt);
  assert.deepEqual(await emptyWorkspace.evaluate(async () => (await fetch('/api/jobs')).json()), { items: [] });
  const savedDraft = JSON.parse(await readFile(join(emptyStorage, 'project.json'), 'utf8'));
  assert.equal(savedDraft.snapshot.document.items[draft.id].params.prompt, firstPrompt);
  await draftDetail.getByRole('button', { name: '最小化', exact: true }).click();
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const parent = windows.find(window => !window.getParentWindow());
    const child = windows.find(window => window.getParentWindow());
    return windows.length === 2 && child.isMinimized() && !parent.isEnabled();
  })).toBe(true);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getParentWindow()).restore());
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const parent = windows.find(window => !window.getParentWindow());
    const child = windows.find(window => window.getParentWindow());
    return !parent.isMinimized() && !parent.isEnabled() && !child.isMinimized() && child.isVisible();
  })).toBe(true);
  console.log('PIXEL_NATIVE_FIRST_DRAFT_OK');
  const draftClosed = draftDetail.waitForEvent('close');
  await draftDetail.getByRole('button', { name: '关闭窗口', exact: true }).click().catch(error => { if (!draftDetail.isClosed()) throw error; });
  await draftClosed;
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.getParentWindow()).isEnabled()), true);
  await emptyWorkspace.getByTestId('timeline-track').click({ button: 'right', position: { x: 32, y: 18 } });
  await expect(emptyWorkspace.getByRole('menuitem', { name: '新建生成草稿', exact: true })).toBeVisible();
  await emptyWorkspace.keyboard.press('Escape');
  await desktop.close();
  desktop = undefined;

  await FileWorkbenchRepository.open(storage, createWorkbenchFixture());
  desktop = await launch(storage);
  const workspace = await desktop.firstWindow();
  await expect(workspace.getByTestId('timeline-item')).toHaveCount(3);
  await expect(workspace.getByTestId('asset-library')).toHaveCount(0);
  assert.equal(await workspace.evaluate(() => typeof window.require), 'undefined');
  await workspace.getByRole('button', { name: '最大化', exact: true }).click();
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.getParentWindow()).isMaximized())).toBe(true);
  const firstItem = workspace.getByTestId('timeline-item').first();
  const itemId = await firstItem.getAttribute('data-item-id');
  const childPromise = desktop.waitForEvent('window');
  await firstItem.dblclick({ position: { x: 70, y: 24 } });
  const detail = await childPromise;
  await expect(detail.getByRole('dialog', { name: '片段详情' })).toBeVisible();
  await expect(detail.locator('.pixel-modal--standalone')).toHaveCount(1);
  await expect(detail.getByLabel('画面与风格描述')).toBeVisible();
  await workspace.evaluate(() => document.fonts.ready);
  await detail.evaluate(() => document.fonts.ready);
  const captures = await desktop.evaluate(async ({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const capture = async window => (await window.webContents.capturePage()).toPNG().toString('base64');
    return { workspace: await capture(windows.find(window => !window.getParentWindow())), detail: await capture(windows.find(window => window.getParentWindow())) };
  });
  await writeFile(join(screenshots, 'desktop.png'), Buffer.from(captures.workspace, 'base64'));
  await writeFile(join(screenshots, 'desktop-detail.png'), Buffer.from(captures.detail, 'base64'));
  assert.equal(await detail.evaluate(() => window.pixelDesktop.isDetailWindow), true);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    return windows.length === 2 && windows.some(window => window.isModal() && window.getParentWindow());
  }), true);
  assert.equal(await detail.evaluate(async () => {
    try { await window.pixelDesktop.openDetails({ object: { kind: 'project', projectId: 'pixel-project' } }); return false; }
    catch { return true; }
  }), true);
  const prompt = '桌面弹窗同步验证：清晨山谷与柔和的像素光线';
  await detail.getByLabel('画面与风格描述').fill(prompt);
  await detail.getByLabel('画面与风格描述').press('Control+Enter');
  await expect(firstItem).toContainText(prompt);
  await expect(detail.getByLabel('画面与风格描述')).toHaveValue(prompt);
  const saved = JSON.parse(await readFile(join(storage, 'project.json'), 'utf8'));
  assert.equal(saved.snapshot.document.items[itemId].params.prompt, prompt);
  await expect(detail.getByText('模型与画面设置', { exact: true })).toHaveCount(0);
  const closed = detail.waitForEvent('close');
  await detail.keyboard.press('Escape').catch(error => { if (!detail.isClosed()) throw error; });
  await closed;
  await expect(workspace.getByRole('dialog')).toHaveCount(0);
  const defaultsWindow = desktop.waitForEvent('window');
  await workspace.getByTestId('timeline-label').first().click();
  const defaults = await defaultsWindow;
  await expect(defaults.getByRole('dialog', { name: '时间线默认配置' })).toBeVisible();
  await expect(defaults.getByRole('dialog')).toHaveCount(1);
  assert.equal(desktop.windows().length, 2);
  const defaultsClosed = defaults.waitForEvent('close');
  await defaults.keyboard.press('Escape').catch(error => { if (!defaults.isClosed()) throw error; });
  await defaultsClosed;
  const nextChild = desktop.waitForEvent('window');
  await firstItem.dblclick({ position: { x: 70, y: 24 } });
  const reopened = await nextChild;
  await expect(reopened.getByLabel('画面与风格描述')).toHaveValue(prompt);
  await reopened.getByRole('button', { name: '最小化', exact: true }).click();
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const parent = windows.find(window => !window.getParentWindow());
    const child = windows.find(window => window.getParentWindow());
    return child.isMinimized() && parent.isMaximized() && !parent.isMinimized() && !parent.isEnabled();
  })).toBe(true);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getParentWindow()).restore());
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const parent = windows.find(window => !window.getParentWindow());
    const child = windows.find(window => window.getParentWindow());
    return parent.isMaximized() && !parent.isMinimized() && !parent.isEnabled() && !child.isMinimized() && child.isVisible();
  })).toBe(true);
  const reopenedClosed = reopened.waitForEvent('close');
  await reopened.getByRole('button', { name: '关闭窗口', exact: true }).click().catch(error => { if (!reopened.isClosed()) throw error; });
  await reopenedClosed;
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.getParentWindow()).isEnabled()), true);
  await workspace.getByRole('button', { name: '还原窗口', exact: true }).click();
  const libraryWindow = desktop.waitForEvent('window');
  await workspace.getByTestId('viewer').click({ button: 'right', position: { x: 120, y: 120 } });
  await workspace.getByRole('menuitem', { name: '素材库', exact: true }).click();
  const libraryPage = await libraryWindow;
  await expect(libraryPage.getByTestId('library-window')).toBeVisible();
  await expect(libraryPage.getByRole('dialog')).toHaveCount(0);
  assert.equal(desktop.windows().length, 2);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isModal() && !window.getParentWindow() && window.isEnabled())), true);
  await libraryPage.getByRole('button', { name: '最小化', exact: true }).click();
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => new URL(window.webContents.getURL()).searchParams.get('window') === 'library').isMinimized())).toBe(true);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !new URL(window.webContents.getURL()).searchParams.has('window')).isEnabled()), true);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => new URL(window.webContents.getURL()).searchParams.get('window') === 'library').restore());
  await workspace.getByTestId('timeline-workspace').dispatchEvent('contextmenu', { clientX: 400, clientY: 800 });
  await expect(workspace.getByRole('menuitem', { name: '新建时间线', exact: true })).toBeVisible();
  await workspace.keyboard.press('Escape');
  await expect(workspace.getByTestId('asset-library')).toHaveCount(0);
  await nativeFileDrop(libraryPage, libraryPage.getByTestId('asset-library'), diskImage);
  const source = libraryPage.getByTestId('asset-card').filter({ hasText: 'desktop-export.png' });
  await expect(source).toBeVisible();
  const beforePlacement = await snapshot(libraryPage);
  const importedAsset = Object.values(beforePlacement.document.assets).find(asset => asset.metadata.name === 'desktop-export.png');
  assert.ok(importedAsset);
  const assetId = importedAsset.id;
  const grokTimeline = Object.values(beforePlacement.document.timelines).find(timeline => timeline.modelId === 'x-ai/grok-imagine-image-2.0');
  assert.ok(grokTimeline);
  const staleSession = await libraryPage.evaluate(assetId => window.pixelDesktop.beginObjectDrag({role:'asset',payload:{object:{kind:'asset',projectId:'pixel-project',id:assetId}}},0), assetId);
  assert.ok(staleSession);
  assert.ok(await workspace.evaluate(token => window.pixelDesktop.resolveObjectDrag(token), staleSession));
  await libraryPage.reload();
  await expect(source).toBeVisible();
  assert.equal(await workspace.evaluate(token => window.pixelDesktop.resolveObjectDrag(token), staleSession), undefined);
  assert.equal(await workspace.evaluate(token => window.pixelDesktop.finishObjectDrag(token), staleSession), undefined);
  await source.dblclick();
  await expect(libraryPage.getByRole('dialog', { name: '素材详情', exact: true })).toBeVisible();
  await expect(libraryPage.getByTestId('library-window')).toHaveAttribute('inert', '');
  await workspace.getByTestId('timeline-ruler').click({ position: { x: 64, y: 8 } });
  await expect(workspace.getByTestId('timeline-ruler')).toHaveAttribute('aria-valuenow', '2000');
  await libraryPage.keyboard.press('Escape');
  await expect(libraryPage.getByRole('dialog')).toHaveCount(0);
  const libraryCapture = await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => new URL(candidate.webContents.getURL()).searchParams.get('window') === 'library');
    return (await window.webContents.capturePage()).toPNG().toString('base64');
  });
  await writeFile(join(screenshots, 'desktop-library.png'), Buffer.from(libraryCapture, 'base64'));
  const target = workspace.locator(`[data-testid="timeline-row"][data-timeline-id="${grokTimeline.id}"]`).getByTestId('timeline-track');
  await nativeWindowDrop(libraryPage, source, workspace, target, 320);
  await expect.poll(async () => (await snapshot(libraryPage)).document.timelines[grokTimeline.id].itemIds.length).toBe(grokTimeline.itemIds.length + 1);
  const afterPlacement = await snapshot(libraryPage);
  const outputItem = Object.values(afterPlacement.document.items).find(item => !beforePlacement.document.items[item.id]);
  assert.ok(outputItem);
  assert.equal(outputItem.outputAssetId, assetId);
  assert.deepEqual(outputItem.referenceAssetIds, []);
  assert.equal(outputItem.startTick, 10000);
  await expect(libraryPage.getByRole('dialog')).toHaveCount(0);
  assert.equal(desktop.windows().length, 2);
  const mainItem = workspace.locator(`[data-testid="timeline-item"][data-item-id="${outputItem.id}"]`);
  // Keep a result at library-local time zero to catch accidental Viewer export
  // preparation from libraryMode, and exercise a tiny item's minimum hit area.
  const resized = await executeAction(workspace, 'item.resize', {itemId:outputItem.id, startTick:outputItem.startTick, durationTicks:200});
  assert.equal(resized.ok, true);
  await expect.poll(async () => (await snapshot(workspace)).document.items[outputItem.id].durationTicks).toBe(200);
  const beforeReuse = await snapshot(workspace);
  await nativeWindowDrop(workspace, mainItem, libraryPage, libraryPage.getByTestId('asset-library'), 12, 200);
  await expect.poll(async () => (await snapshot(workspace)).revision).toBe(beforeReuse.revision + 1);
  assert.equal((await executeAction(workspace, 'item.delete', {itemId:grokTimeline.itemIds[0]})).ok, true);
  const restored = await executeAction(workspace, 'item.resize', {itemId:outputItem.id, startTick:0, durationTicks:outputItem.durationTicks});
  assert.equal(restored.ok, true);
  await expect.poll(async () => (await snapshot(libraryPage)).document.items[outputItem.id].startTick).toBe(0);
  await expect(libraryPage.getByText('输出文件尚未准备好', {exact:true})).toHaveCount(0);
  const backToPlacement = await executeAction(workspace, 'item.resize', {itemId:outputItem.id, startTick:outputItem.startTick, durationTicks:outputItem.durationTicks});
  assert.equal(backToPlacement.ok, true);
  const wanTimeline = Object.values(beforeReuse.document.timelines).find(t => t.modelId === 'alibaba/wan-3.0');
  const wanItem = workspace.locator(`[data-testid="timeline-item"][data-item-id="${wanTimeline.itemIds[0]}"]`);
  await nativeWindowDrop(libraryPage, source, workspace, wanItem.getByTestId('item-reference-drop'), 12);
  await expect.poll(async () => (await snapshot(workspace)).document.items[wanTimeline.itemIds[0]].referenceAssetIds).toContain(assetId);
  assert.equal((await executeAction(workspace, 'item.reference.remove', {itemId:wanTimeline.itemIds[0],assetId})).ok, true);
  await expect.poll(async () => (await snapshot(workspace)).document.items[wanTimeline.itemIds[0]].referenceAssetIds).toEqual([]);
  const targetDetailPromise = desktop.waitForEvent('window');
  await wanItem.dblclick({position:{x:70,y:24}});
  const targetDetail = await targetDetailPromise;
  await expect(targetDetail.getByRole('dialog', {name:'片段详情',exact:true})).toBeVisible();
  await nativeWindowDrop(libraryPage, source, targetDetail, targetDetail.getByTestId('item-reference'), 12);
  await expect.poll(async () => (await snapshot(workspace)).document.items[wanTimeline.itemIds[0]].referenceAssetIds).toContain(assetId);
  const targetDetailClosed = targetDetail.waitForEvent('close');
  await targetDetail.getByRole('button', {name:'关闭窗口',exact:true}).click().catch(error => {if(!targetDetail.isClosed())throw error;});
  await targetDetailClosed;
  const beforeForgery = await snapshot(workspace);
  const forged = await workspace.evaluateHandle(() => { const data = new DataTransfer(); data.setData('application/x-pixel-object', 'forged-session'); return data; });
  const dropBox = await target.boundingBox();
  await target.dispatchEvent('drop', { dataTransfer: forged, clientX: dropBox.x + 480, clientY: dropBox.y + 12 });
  await forged.dispose();
  assert.deepEqual(await snapshot(workspace), beforeForgery);
  // Unreference before the later asset.remove export-ticket ownership regression.
  const unlink = await workspace.evaluate(async ({itemId, assetId}) => {
    const state = await (await fetch('/api/project')).json();
    return (await fetch('/api/actions', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ requestId:crypto.randomUUID(), projectId:state.document.id, expectedRevision:state.revision, type:'item.reference.remove', payload:{itemId,assetId} }) })).json();
  }, {itemId:wanTimeline.itemIds[0], assetId});
  assert.equal(unlink.ok, true);
  await expect(libraryPage.getByTestId('relation-surface')).toHaveCount(0);
  await expect(libraryPage.getByTestId('reusable-item')).toHaveCount(0);
  const libraryClosed = libraryPage.waitForEvent('close');
  await libraryPage.keyboard.press('Escape').catch(error => { if (!libraryPage.isClosed()) throw error; });
  await libraryClosed;
  await expect(workspace.getByTestId('asset-library')).toHaveCount(0);
  await desktop.evaluate(({ BrowserWindow }) => {
    globalThis.__pixelNativeDrags = [];
    const window = BrowserWindow.getAllWindows().find(window => !window.getParentWindow());
    window.webContents.startDrag = options => globalThis.__pixelNativeDrags.push(options);
  });
  await workspace.evaluate(async () => { window.pixelDesktop.startExport('forged-ticket'); await window.pixelDesktop.isMaximized(); });
  assert.equal(await desktop.evaluate(() => globalThis.__pixelNativeDrags.length), 0);
  const grant = await workspace.evaluate(assetId => window.pixelDesktop.prepareExport({ assetId }), assetId);
  assert.deepEqual(Object.keys(grant), ['ticket']);
  await workspace.evaluate(async ticket => { window.pixelDesktop.startExport(ticket); await window.pixelDesktop.isMaximized(); }, grant.ticket);
  const nativeDrags = await desktop.evaluate(() => globalThis.__pixelNativeDrags);
  assert.equal(nativeDrags.length, 1);
  assert.equal(dirname(dirname(nativeDrags[0].file)), resolve(tmpdir()));
  assert.ok(basename(dirname(nativeDrags[0].file)).startsWith('pixel-export-'));
  assert.equal((await readFile(nativeDrags[0].file)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await workspace.evaluate(async ticket => { window.pixelDesktop.startExport(ticket); await window.pixelDesktop.isMaximized(); }, grant.ticket);
  assert.equal(await desktop.evaluate(() => globalThis.__pixelNativeDrags.length), 1);
  assert.equal(await workspace.evaluate(async () => {
    try { await window.pixelDesktop.prepareExport({ assetId: 'unowned-file' }); return false; } catch { return true; }
  }), true);
  await workspace.locator(`[data-testid="timeline-item"][data-item-id="${outputItem.id}"]`).click({ position: { x: 70, y: 24 } });
  const beforeScrub = await snapshot(workspace);
  const ruler = workspace.getByTestId('timeline-ruler');
  await ruler.click({ position: { x: 352, y: 8 } });
  await expect(ruler).toHaveAttribute('aria-valuenow', '11000');
  await expect(workspace.getByTestId('viewer').locator('img')).toHaveAttribute('src', `/api/media/${assetId}`);
  const handle = await workspace.getByTestId('timeline-playhead-handle').boundingBox();
  assert.ok(handle);
  await workspace.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await workspace.mouse.down();
  await workspace.mouse.move(handle.x + handle.width / 2 + 64, handle.y + handle.height / 2, { steps: 5 });
  await workspace.mouse.up();
  await expect(ruler).toHaveAttribute('aria-valuenow', '13000');
  assert.deepEqual(await snapshot(workspace), beforeScrub);
  const viewer = workspace.getByTestId('viewer');
  // Remotion can show several tracks; Viewer details belong to the current
  // foreground Item, while the existing export checks still use its one file.
  const viewerDetailOpened = desktop.waitForEvent('window');
  await viewer.dblclick({ position: { x: 120, y: 120 } });
  const viewerDetail = await viewerDetailOpened;
  await expect(viewerDetail.getByRole('dialog', { name: '片段详情', exact: true })).toBeVisible();
  await expect(viewerDetail.getByRole('dialog', { name: '素材详情', exact: true })).toHaveCount(0);
  assert.deepEqual(await snapshot(viewerDetail), beforeScrub);
  const viewerDetailClosed = viewerDetail.waitForEvent('close');
  await viewerDetail.getByRole('button', { name: '关闭窗口', exact: true }).click().catch(error => { if (!viewerDetail.isClosed()) throw error; });
  await viewerDetailClosed;
  assert.deepEqual(await snapshot(workspace), beforeScrub);
  for (let drag = 0; drag < 2; drag++) {
    await mouseViewerExport(workspace, drag + 2);
  }
  const removedGrant = await workspace.evaluate(assetId => window.pixelDesktop.prepareExport({ assetId }), assetId);
  const deleted = await workspace.evaluate(async itemId => {
    const project = await (await fetch('/api/project')).json();
    return (await fetch('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      requestId: crypto.randomUUID(), projectId: project.document.id, expectedRevision: project.revision, type: 'item.delete', payload: { itemId },
    }) })).json();
  }, outputItem.id);
  assert.equal(deleted.ok, true);
  const removal = await workspace.evaluate(async assetId => {
    const project = await (await fetch('/api/project')).json();
    return (await fetch('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      requestId: crypto.randomUUID(), projectId: project.document.id, expectedRevision: project.revision, type: 'asset.remove', payload: { assetId },
    }) })).json();
  }, assetId);
  assert.equal(removal.ok, true);
  await workspace.evaluate(async ticket => { window.pixelDesktop.startExport(ticket); await window.pixelDesktop.isMaximized(); }, removedGrant.ticket);
  assert.equal(await desktop.evaluate(() => globalThis.__pixelNativeDrags.length), 3);
  // Project ingress uses Chromium-backed disk Files, including directories with
  // Unicode and spaces; JS-created Files cannot grant a filesystem capability.
  const beforeProjectDrop = await snapshot(workspace);
  const beforeFile = await readFile(join(storage, 'project.json'), 'utf8');
  const oldOrigin = new URL(workspace.url()).origin;
  assert.equal(await workspace.evaluate(async () => (await window.pixelDesktop.openDroppedProject(new File(['{}'], 'project.json'))).ok), false);
  assert.deepEqual(await snapshot(workspace), beforeProjectDrop);
  await nativeFileDrop(workspace, viewer, foreignDirectory);
  await expect(workspace.locator('.workspace-feedback[role="status"]')).toContainText('项目');
  assert.deepEqual(await snapshot(workspace), beforeProjectDrop);
  assert.equal(await readFile(join(foreignDirectory, 'unrelated.txt'), 'utf8'), 'Original unrelated file');
  assert.equal(await readFile(join(storage, 'project.json'), 'utf8'), beforeFile);
  const retiringLibrary = await openLibraryWindow(workspace);
  await nativeFileDrop(retiringLibrary, retiringLibrary.getByTestId('asset-library'), diskImage);
  await expect(retiringLibrary.getByTestId('asset-card').filter({ hasText: 'desktop-export.png' })).toBeVisible();
  const retiringSnapshot = await snapshot(workspace);
  const retiringAsset = Object.values(retiringSnapshot.document.assets).find(asset => asset.metadata.name === 'desktop-export.png');
  const retiringTicket = await workspace.evaluate(assetId => window.pixelDesktop.prepareExport({assetId}), retiringAsset.id);
  const retiringDrag = await retiringLibrary.evaluate(({assetId, projectId}) => window.pixelDesktop.beginObjectDrag({role:'asset',payload:{object:{kind:'asset',projectId,id:assetId}}},0), {assetId:retiringAsset.id,projectId:retiringSnapshot.document.id});
  assert.ok(retiringDrag);
  const retiringClosed = retiringLibrary.waitForEvent('close');
  // Inject one native navigation failure to prove activation rollback preserves
  // the original server, authentication and project instead of returning a
  // misleading failure after destroying the only working runtime.
  await desktop.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(window => !new URL(window.webContents.getURL()).searchParams.has('window'));
    const load = main.loadURL.bind(main);
    const previous = main.webContents.getURL();
    main.loadURL = async (url, ...rest) => {
      if (url !== previous) {
        main.loadURL = load;
        globalThis.__pixelRejectedOrigin = new URL(url).origin;
        throw new Error('Injected candidate navigation failure');
      }
      return load(url, ...rest);
    };
  });
  await nativeFileDrop(workspace, viewer, droppedDirectory);
  await expect.poll(() => desktop.evaluate(() => globalThis.__pixelRejectedOrigin)).not.toBeUndefined();
  await expect(workspace.getByTestId('timeline-row')).toHaveCount(Object.keys(retiringSnapshot.document.timelines).length);
  assert.equal(new URL(workspace.url()).origin, oldOrigin);
  assert.deepEqual(await snapshot(workspace), retiringSnapshot);
  await retiringClosed;
  const rejectedOrigin = await desktop.evaluate(() => globalThis.__pixelRejectedOrigin);
  await expect.poll(async () => { try { await fetch(`${rejectedOrigin}/api/session`); return false; } catch { return true; } }).toBe(true);
  await nativeFileDrop(workspace, viewer, droppedDirectory);
  await expect(workspace.getByRole('group', { name: '作品详情', exact: true })).toContainText(basename(droppedDirectory));
  assert.equal(desktop.windows().length, 1);
  const fresh = await snapshot(workspace);
  assert.notEqual(fresh.document.id, retiringSnapshot.document.id);
  assert.deepEqual(fresh.document.timelines, {});
  assert.deepEqual(fresh.document.items, {});
  assert.deepEqual(fresh.document.assets, {});
  assert.notEqual(new URL(workspace.url()).origin, oldOrigin);
  assert.equal(await workspace.evaluate(token => window.pixelDesktop.resolveObjectDrag(token), retiringDrag), undefined);
  await workspace.evaluate(async ticket => { window.pixelDesktop.startExport(ticket); await window.pixelDesktop.isMaximized(); }, retiringTicket.ticket);
  assert.equal(await desktop.evaluate(() => globalThis.__pixelNativeDrags.length), 3);
  await expect.poll(async () => { try { await fetch(`${oldOrigin}/api/session`); return false; } catch { return true; } }).toBe(true);
  const freshFile = JSON.parse(await readFile(join(droppedDirectory, 'project.json'), 'utf8'));
  assert.equal(freshFile.snapshot.document.id, fresh.document.id);
  await workspace.getByTestId('timeline-workspace').click({ button:'right', position:{x:260,y:16} });
  await workspace.getByRole('menuitem', {name:'新建时间线',exact:true}).click();
  await workspace.getByRole('menuitem', {name:'Grok Imagine Image 2.0',exact:true}).click();
  await expect(workspace.getByTestId('timeline-row')).toHaveCount(1);
  const freshTimeline = Object.values((await snapshot(workspace)).document.timelines)[0];
  const freshLibrary = await openLibraryWindow(workspace);
  await nativeFileDrop(freshLibrary, freshLibrary.getByTestId('asset-library'), diskImage);
  const freshSource = freshLibrary.getByTestId('asset-card').filter({hasText:'desktop-export.png'});
  await expect(freshSource).toBeVisible();
  await nativeWindowDrop(freshLibrary, freshSource, workspace, workspace.getByTestId('timeline-track'), 0);
  await expect(workspace.getByTestId('timeline-item')).toHaveCount(1);
  const editedFresh = await snapshot(workspace);
  const freshItem = Object.values(editedFresh.document.items)[0];
  assert.equal(freshItem.timelineId, freshTimeline.id);
  assert.ok(freshItem.outputAssetId);
  await expect(viewer.locator('img')).toHaveAttribute('src', `/api/media/${freshItem.outputAssetId}`);
  await mouseViewerExport(workspace, 4);
  const freshExport = await desktop.evaluate(() => globalThis.__pixelNativeDrags.at(-1));
  assert.equal(dirname(dirname(freshExport.file)), resolve(tmpdir()));
  assert.ok(basename(dirname(freshExport.file)).startsWith('pixel-export-'));
  assert.deepEqual(await readFile(freshExport.file), await readFile(diskImage));
  const freshClosed = freshLibrary.waitForEvent('close');
  await nativeFileDrop(workspace, viewer, join(storage, 'project.json'));
  await expect(workspace.getByTestId('timeline-row')).toHaveCount(Object.keys(retiringSnapshot.document.timelines).length);
  await freshClosed;
  assert.deepEqual(await snapshot(workspace), retiringSnapshot);
  await nativeFileDrop(workspace, viewer, join(droppedDirectory, 'project.json'));
  await expect(workspace.getByRole('group', {name:'作品详情',exact:true})).toContainText(basename(droppedDirectory));
  assert.deepEqual(await snapshot(workspace), editedFresh);
  await expect(viewer.locator('img')).toHaveAttribute('src', `/api/media/${freshItem.outputAssetId}`);
  await expect(workspace.getByText('输出文件尚未准备好', {exact:true})).toHaveCount(0);
  await mouseViewerExport(workspace, 5);
  await desktop.close(); desktop = undefined;
  desktop = await launch(storage);
  const remembered = await desktop.firstWindow();
  await expect(remembered.getByRole('group', {name:'作品详情',exact:true})).toContainText(basename(droppedDirectory));
  assert.deepEqual(await snapshot(remembered), editedFresh);
  // A true disk drop directly places ordinary media through the common file
  // role, without opening a project, presenting a choice or submitting a model.
  const nativeAudio = join(projectLocations,'本地音频.wav');
  const nativeVideo = join(projectLocations,'本地视频.mp4');
  const audioBytes = Buffer.alloc(44+4000);
  audioBytes.write('RIFF',0);audioBytes.writeUInt32LE(audioBytes.length-8,4);audioBytes.write('WAVEfmt ',8);audioBytes.writeUInt32LE(16,16);
  audioBytes.writeUInt16LE(1,20);audioBytes.writeUInt16LE(1,22);audioBytes.writeUInt32LE(8000,24);audioBytes.writeUInt32LE(16000,28);
  audioBytes.writeUInt16LE(2,32);audioBytes.writeUInt16LE(16,34);audioBytes.write('data',36);audioBytes.writeUInt32LE(4000,40);
  await writeFile(nativeAudio,audioBytes);
  assert.equal(dirname(resolve(nativeVideo)),resolve(projectLocations));
  await promisify(execFile)(ffmpeg,['-hide_banner','-nostdin','-f','lavfi','-i','color=c=blue:s=16x16:r=10','-t','0.5','-c:v','libx264','-pix_fmt','yuv420p','-an',nativeVideo],{windowsHide:true,timeout:15000});
  const timelineWorkspace=remembered.getByTestId('timeline-workspace');
  let count=Object.keys(editedFresh.document.timelines).length;
  for(const [file,kind] of [[diskImage,'image'],[nativeAudio,'audio'],[nativeVideo,'video']]){
    const before=await snapshot(remembered);
    await nativeFileDrop(remembered,timelineWorkspace,file,{x:260,y:4});
    await expect(remembered.getByTestId('timeline-row')).toHaveCount(++count);
    const after=await snapshot(remembered);assert.equal(after.revision,before.revision+1);
    const createdTrack=Object.values(after.document.timelines).find(track=>!before.document.timelines[track.id]);
    assert.equal(createdTrack.pluginId,`pixel.${kind}.local`);assert.equal(createdTrack.modelId,undefined);
    const media=after.document.items[createdTrack.itemIds[0]];const asset=after.document.assets[media.outputAssetId];
    assert.equal(asset.kind,kind);assert.equal(media.startTick,0);assert.equal(media.outputOrigin,'placement');
    assert.equal(media.durationTicks,kind==='audio'?250:kind==='video'?500:5000);
    assert.equal((await remembered.evaluate(async()=> (await(await fetch('/api/jobs')).json()).items)).length,0);
  }
  await timelineWorkspace.click({button:'right',position:{x:260,y:4}});
  await remembered.getByRole('menuitem',{name:'新建时间线',exact:true}).click();
  await remembered.getByRole('menuitem',{name:'纯文本时间轴',exact:true}).click();
  await expect(remembered.getByTestId('timeline-row')).toHaveCount(++count);
  const withText=await snapshot(remembered);const textTrack=Object.values(withText.document.timelines).find(track=>track.pluginId==='pixel.text');
  const textRow=remembered.locator(`[data-testid="timeline-row"][data-timeline-id="${textTrack.id}"]`);
  await textRow.scrollIntoViewIfNeeded();
  await textRow.getByTestId('timeline-track').click({button:'right',position:{x:320,y:18}});
  if(!(await remembered.getByRole('menuitem',{name:'新建文本片段',exact:true}).count())){
    await remembered.screenshot({path:join(screenshots,'desktop-text-hit.png')});
    console.log('PIXEL_TEXT_CONTEXT_DIAGNOSTIC',await remembered.getByRole('menuitem').allTextContents(),await textRow.boundingBox());
  }
  await remembered.getByRole('menuitem',{name:'新建文本片段',exact:true}).click();
  await expect(textRow.getByTestId('timeline-item')).toHaveCount(1);
  const textDetailOpened=desktop.waitForEvent('window');
  await textRow.getByTestId('timeline-item').dblclick({position:{x:70,y:24}});
  const textDetail=await textDetailOpened;
  await expect(textDetail.getByRole('dialog',{name:'片段详情',exact:true})).toBeVisible();
  await textDetail.getByLabel('文本描述',{exact:true}).fill('分镜参考：镜头在十秒后进入山谷。');
  await textDetail.getByLabel('文本描述',{exact:true}).press('Control+Enter');
  await expect(textRow.getByTestId('timeline-item')).toContainText('分镜参考');
  const read=await remembered.evaluate(async()=> (await(await fetch('/api/timeline-text')).json()));
  assert.equal(read.items.length,1);assert.equal(read.items[0].text,'分镜参考：镜头在十秒后进入山谷。');assert.equal(read.items[0].startMs,10000);
  const textClosed=textDetail.waitForEvent('close');await textDetail.keyboard.press('Escape').catch(error=>{if(!textDetail.isClosed())throw error;});await textClosed;
  await textRow.getByTestId('timeline-item').click({button:'right',position:{x:70,y:24}});
  await expect(remembered.getByRole('menuitem',{name:/生成|继续中断/})).toHaveCount(0);await remembered.keyboard.press('Escape');
  const finalState=await snapshot(remembered);
  await desktop.close();desktop=undefined;desktop=await launch(storage);
  const restarted=await desktop.firstWindow();await expect(restarted.getByTestId('timeline-row')).toHaveCount(count);
  assert.deepEqual(await snapshot(restarted),finalState);
  console.log('PIXEL_DESKTOP_UI_OK: project ingress/rollback/restart, real PNG WAV MP4 file placement into local tracks with natural durations, editable text reference through shared Actions, read-only text API, unified object relationships, real mouse Viewer file export and revoked credentials');
} finally {
  if (desktop) await desktop.close();
  for (const directory of [emptyStorage, storage, projectLocations]) {
    const checked = resolve(directory);
    assert.equal(dirname(checked), resolve(tmpdir()));
    assert.ok(basename(checked).startsWith('pixel-desktop-'));
    await rm(checked, { recursive: true, force: true });
  }
}
