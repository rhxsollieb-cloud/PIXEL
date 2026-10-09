import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ActionEnvelope, ActionResult, ProjectSnapshot } from '../src/contracts.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

async function snapshot(page: Page): Promise<ProjectSnapshot> {
  const response = await page.request.get('/api/project');
  expect(response.ok()).toBe(true);
  return response.json() as Promise<ProjectSnapshot>;
}
async function action(page: Page, type: string, payload: ActionEnvelope['payload']): Promise<ActionResult> {
  const state = await snapshot(page);
  const response = await page.request.post('/api/actions', { data: {
    requestId: randomUUID(), projectId: state.document.id, expectedRevision: state.revision, type, payload,
  } });
  expect(response.ok()).toBe(true);
  const result = await response.json() as ActionResult;
  expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
  return result;
}
async function importImage(page: Page, name: string): Promise<string> {
  const state = await snapshot(page);
  const response = await page.request.post('/api/import', {
    headers: { 'Content-Type': 'image/png', 'X-Pixel-Project-Id': state.document.id,
      'X-Pixel-Request-Id': randomUUID(), 'X-Pixel-Revision': String(state.revision), 'X-Pixel-Name': encodeURIComponent(name) },
    data: png,
  });
  expect(response.ok()).toBe(true);
  const result = await response.json() as ActionResult;
  expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
  if (!result.ok) throw new Error('Local test media import failed');
  return String(result.outcome.assetId);
}
async function protectProviderCalls(context: BrowserContext): Promise<void> {
  await context.route('**/api/actions', async route => {
    const input = route.request().postDataJSON() as ActionEnvelope;
    if (['generation.submit', 'generation.resume'].includes(input.type)) {
      await route.fulfill({ json: { ok: false, requestId: input.requestId,
        error: { code: 'NOT_APPLICABLE', message: '分组浏览器验证禁止调用供应商' } } });
    } else await route.continue();
  });
  await context.route('**/api/voices?*', route => route.fulfill({ json: { items: [] } }));
  await context.route('**/api/voice-clone', route => route.fulfill({ status: 400,
    json: { ok: false, error: { code: 'NOT_APPLICABLE', message: '分组浏览器验证禁止调用供应商' } } }));
}
async function openLibrary(page: Page): Promise<Page> {
  await page.getByTestId('viewer').click({ button: 'right' });
  const opened = page.waitForEvent('popup');
  await page.getByRole('menuitem', { name: '素材库', exact: true }).click();
  const library = await opened;
  await expect(library.getByTestId('library-window')).toBeVisible();
  await expect(library.getByTestId('asset-groups')).toBeVisible();
  return library;
}
async function createGroup(page: Page, library: Page, title: string): Promise<string> {
  await library.getByLabel('新分组名称', { exact: true }).fill(title);
  await library.getByRole('button', { name: '新建分组', exact: true }).click();
  await expect(library.getByTitle(title, { exact: true })).toBeVisible();
  await expect.poll(async () => Object.values((await snapshot(page)).document.assetGroups ?? {}).filter(group => group.title === title).length).toBe(1);
  return Object.values((await snapshot(page)).document.assetGroups ?? {}).find(group => group.title === title)!.id;
}
function card(library: Page, id: string) { return library.locator(`[data-testid="asset-card"][data-asset-id="${id}"]`); }
function navigation(library: Page) { return library.getByRole('navigation', { name: '选择素材分组', exact: true }); }
async function cleanup(page: Page, groupIds: readonly string[], assetIds: readonly string[]): Promise<void> {
  // 只清理本用例创建的对象，不改变共享测试宿主的其他 fixture。
  for (const groupId of groupIds) if ((await snapshot(page)).document.assetGroups?.[groupId]) await action(page, 'assetGroup.remove', { groupId });
  for (const assetId of assetIds) if ((await snapshot(page)).document.assets[assetId]) await action(page, 'asset.remove', { assetId });
}

test('真实素材库分组可新建改名、逐素材分组和跨组移动；筛选及删除保留原始媒体', async ({ page, context }) => {
  await protectProviderCalls(context);
  await page.goto('/');
  await expect(page.getByTestId('timeline-workspace')).toBeVisible();
  const suffix = randomUUID().slice(0, 8);
  const firstName = `group-first-${suffix}.png`;
  const secondName = `group-second-${suffix}.png`;
  const assetIds: string[] = [];
  const groupIds: string[] = [];
  let library: Page | undefined;
  try {
    const first = await importImage(page, firstName); assetIds.push(first);
    const second = await importImage(page, secondName); assetIds.push(second);
    const original = await snapshot(page);
    library = await openLibrary(page);
    await expect(card(library, first)).toBeVisible();
    await expect(card(library, second)).toBeVisible();
    await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
    await expect(library.getByRole('dialog')).toHaveCount(0);

    const firstTitle = `画面组-${suffix}`;
    const secondTitle = `备用组-${suffix}`;
    const firstGroup = await createGroup(page, library, firstTitle); groupIds.push(firstGroup);
    const secondGroup = await createGroup(page, library, secondTitle); groupIds.push(secondGroup);
    await library.getByRole('combobox', { name: `${firstName}的分组`, exact: true }).selectOption(firstGroup);
    await expect.poll(async () => (await snapshot(page)).document.assetGroups?.[firstGroup]?.assetIds).toEqual([first]);
    await library.getByRole('combobox', { name: `${secondName}的分组`, exact: true }).selectOption(secondGroup);
    await expect.poll(async () => (await snapshot(page)).document.assetGroups?.[secondGroup]?.assetIds).toEqual([second]);

    await navigation(library).getByTitle(firstTitle, { exact: true }).click();
    await expect(card(library, first)).toBeVisible();
    await expect(card(library, second)).toHaveCount(0);
    const renamed = `已改名-${suffix}`;
    await library.getByLabel('当前分组名称', { exact: true }).fill(renamed);
    await library.getByRole('button', { name: '重命名分组', exact: true }).click();
    await expect(navigation(library).getByTitle(renamed, { exact: true })).toBeVisible();
    await expect(library.getByRole('region', { name: `${renamed}中的素材`, exact: true })).toBeVisible();

    await navigation(library).getByRole('button', { name: /^未分组/ }).click();
    await expect(card(library, first)).toHaveCount(0); await expect(card(library, second)).toHaveCount(0);
    await navigation(library).getByRole('button', { name: /^全部素材/ }).click();
    await expect(card(library, first)).toBeVisible(); await expect(card(library, second)).toBeVisible();
    await navigation(library).getByTitle(renamed, { exact: true }).click();
    await library.getByRole('combobox', { name: `${firstName}的分组`, exact: true }).selectOption(secondGroup);
    await expect(card(library, first)).toHaveCount(0);
    await expect(library.getByText('这个分组尚无素材', { exact: true })).toBeVisible();
    await navigation(library).getByTitle(secondTitle, { exact: true }).click();
    await expect(card(library, first)).toBeVisible(); await expect(card(library, second)).toBeVisible();
    await library.getByRole('combobox', { name: `${secondName}的分组`, exact: true }).selectOption('');
    await expect(card(library, second)).toHaveCount(0);
    await navigation(library).getByRole('button', { name: /^未分组/ }).click();
    await expect(card(library, second)).toBeVisible(); await expect(card(library, first)).toHaveCount(0);

    await navigation(library).getByTitle(secondTitle, { exact: true }).click();
    await library.getByRole('button', { name: '删除分组', exact: true }).click();
    await expect(navigation(library).getByTitle(secondTitle, { exact: true })).toHaveCount(0);
    await expect(card(library, first)).toBeVisible(); await expect(card(library, second)).toBeVisible();
    await navigation(library).getByTitle(renamed, { exact: true }).click();
    await library.getByRole('button', { name: '删除分组', exact: true }).click();
    await expect(navigation(library).getByTitle(renamed, { exact: true })).toHaveCount(0);
    const after = await snapshot(page);
    for (const id of assetIds) {
      expect(after.document.assets[id]).toEqual(original.document.assets[id]);
      const response = await page.request.get(`/api/media/${id}`);
      expect(response.ok()).toBe(true);
      expect(await response.body()).toEqual(png);
    }
  } finally {
    if (library && !library.isClosed()) await library.close();
    await cleanup(page, groupIds, assetIds);
  }
});

test('新素材库窗口加载已保存分组，并同步其他窗口的改名、成员变更和删除', async ({ page, context }) => {
  await protectProviderCalls(context);
  await page.goto('/');
  await expect(page.getByTestId('timeline-workspace')).toBeVisible();
  const suffix = randomUUID().slice(0, 8);
  const name = `group-sync-${suffix}.png`;
  const assets: string[] = [];
  const groups: string[] = [];
  let first: Page | undefined;
  let second: Page | undefined;
  try {
    const assetId = await importImage(page, name); assets.push(assetId);
    first = await openLibrary(page);
    const title = `同步组-${suffix}`;
    const groupId = await createGroup(page, first, title); groups.push(groupId);
    await first.getByRole('combobox', { name: `${name}的分组`, exact: true }).selectOption(groupId);
    await expect.poll(async () => (await snapshot(page)).document.assetGroups?.[groupId]?.assetIds).toEqual([assetId]);

    // 同源第二工作窗口使用真实 App/bridge/SSE；不挂载替代组件或伪造项目快照。
    second = await context.newPage();
    await second.goto('/?window=library');
    await expect(second.getByTestId('library-window')).toBeVisible();
    await expect(navigation(second).getByTitle(title, { exact: true })).toBeVisible();
    await navigation(second).getByTitle(title, { exact: true }).click();
    await expect(card(second, assetId)).toBeVisible();
    const renamed = `同步改名-${suffix}`;
    await second.getByLabel('当前分组名称', { exact: true }).fill(renamed);
    await second.getByRole('button', { name: '重命名分组', exact: true }).click();
    await expect(navigation(first).getByTitle(renamed, { exact: true })).toBeVisible();
    await navigation(first).getByTitle(renamed, { exact: true }).click();
    await first.getByRole('combobox', { name: `${name}的分组`, exact: true }).selectOption('');
    await expect(card(second, assetId)).toHaveCount(0);
    await expect(second.getByText('这个分组尚无素材', { exact: true })).toBeVisible();
    await second.getByRole('button', { name: '删除分组', exact: true }).click();
    await expect(navigation(first).getByTitle(renamed, { exact: true })).toHaveCount(0);
    await expect(card(first, assetId)).toBeVisible();
    await expect(card(second, assetId)).toBeVisible();
    expect(await (await page.request.get(`/api/media/${assetId}`)).body()).toEqual(png);
  } finally {
    for (const window of [first, second]) if (window && !window.isClosed()) await window.close();
    await cleanup(page, groups, assets);
  }
});
