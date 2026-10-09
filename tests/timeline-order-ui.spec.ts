import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ProjectSnapshot, ActionResult, ActionEnvelope, JsonObject } from '../src/contracts.js';

async function snapshot(page: Page): Promise<ProjectSnapshot> { return (await page.request.get('/api/project')).json(); }
async function action(page: Page, type: string, payload: JsonObject) {
  const state = await snapshot(page);
  const response = await page.request.post('/api/actions', { data: { requestId: randomUUID(), projectId: state.document.id, expectedRevision: state.revision, type, payload } });
  const result = await response.json() as ActionResult;
  expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error('Action failed'); return result;
}

test('timeline sort handle uses package keyboard and pointer sorting, persists layer order and does not open details or change Items', async ({ page }) => {
  await page.goto('/'); const ids: string[] = [];
  try {
    for (let index = 0; index < 3; index++) ids.push(String((await action(page, 'timeline.create', { typeId: 'pixel.text' })).outcome.timelineId));
    const before = await snapshot(page);
    const row = (id: string) => page.locator(`[data-testid="timeline-row"][data-timeline-id="${id}"]`);
    const handle = (id: string) => row(id).getByTestId('timeline-sort-handle');
    const edits:ActionEnvelope[]=[];
    page.on('request',request=>{if(request.url().endsWith('/api/actions'))edits.push(request.postDataJSON() as ActionEnvelope);});
    await expect(handle(ids[2]!)).toBeVisible(); await handle(ids[2]!).scrollIntoViewIfNeeded(); await handle(ids[2]!).focus();
    await handle(ids[2]!).click();await expect(page.getByTestId('modal-host')).toHaveCount(0);
    await page.keyboard.press('Space'); await expect(handle(ids[2]!)).toHaveAttribute('aria-pressed','true');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[id^="DndLiveRegion"]')).toContainText(`over droppable area ${ids[1]}`);
    expect((await snapshot(page)).revision).toBe(before.revision);
    expect(edits.filter(edit=>edit.type==='timeline.reorder')).toHaveLength(0);
    await page.keyboard.press('Space');
    await expect.poll(async () => (await snapshot(page)).document.timelineOrder?.slice(-3)).toEqual([ids[0], ids[2], ids[1]]);
    expect((await snapshot(page)).revision).toBe(before.revision+1);
    await expect(page.getByTestId('modal-host')).toHaveCount(0);
    await handle(ids[0]!).scrollIntoViewIfNeeded();
    const from = await handle(ids[2]!).boundingBox(); const to = await handle(ids[0]!).boundingBox(); expect(from).toBeTruthy(); expect(to).toBeTruthy();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2); await page.mouse.down();
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 });
    await expect(handle(ids[2]!)).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('[id^="DndLiveRegion"]')).toContainText(`over droppable area ${ids[0]}`);
    expect((await snapshot(page)).revision).toBe(before.revision+1);
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page)).document.timelineOrder?.slice(-3)).toEqual([ids[2], ids[0], ids[1]]);
    const after = await snapshot(page); expect(after.document.items).toEqual(before.document.items); expect(after.document.timelines).toEqual(before.document.timelines);
    expect(after.revision).toBe(before.revision+2);
    expect(edits.filter(edit=>edit.type==='timeline.reorder')).toHaveLength(2);
    await handle(ids[1]!).scrollIntoViewIfNeeded();await handle(ids[1]!).focus();
    await page.keyboard.press('Space');await expect(handle(ids[1]!)).toHaveAttribute('aria-pressed','true');
    await page.keyboard.press('ArrowUp');await expect(page.locator('[id^="DndLiveRegion"]')).toContainText(`over droppable area ${ids[0]}`);
    await page.keyboard.press('Escape');await expect(handle(ids[1]!)).not.toHaveAttribute('aria-pressed','true');
    expect(await snapshot(page)).toEqual(after);expect(edits.filter(edit=>edit.type==='timeline.reorder')).toHaveLength(2);
    await row(ids[0]!).getByTestId('timeline-label').click();await expect(page.getByRole('dialog',{name:'时间线详情',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');await expect(page.getByTestId('modal-host')).toHaveCount(0);
    await page.reload(); await expect.poll(async () => page.getByTestId('timeline-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-timeline-id')).slice(-3))).toEqual([ids[2], ids[0], ids[1]]);
  } finally { for (const id of ids) if ((await snapshot(page)).document.timelines[id]) await action(page, 'timeline.delete', { timelineId: id }); }
});
