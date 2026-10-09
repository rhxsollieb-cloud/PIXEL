import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import type { ProjectSnapshot } from '../src/contracts.js';

interface CompositionHarness {
  seeks: number[];
  seek(milliseconds: number): void;
  update(snapshot: ProjectSnapshot): void;
}
declare global { interface Window { __pixelCompositionTest?: CompositionHarness; } }
const ids = { video: '11111111-1111-4111-8111-111111111111', image: '22222222-2222-4222-8222-222222222222', audio: '33333333-3333-4333-8333-333333333333' };
let fixtureRoot = ''; let video: Buffer; let image: Buffer; let audio: Buffer;
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string | null;

test.beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'pixel-composition-ui-'));
  if (!ffmpeg) throw new Error('Bundled media runtime unavailable');
  for (const args of [
    ['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=60:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(fixtureRoot, 'video.mp4')],
    ['-f', 'lavfi', '-i', 'color=c=blue:s=160x90', '-vf', "format=rgba,geq=r=0:g=0:b=255:a='if(lt(X,80),255,0)'", '-frames:v', '1', join(fixtureRoot, 'image.png')],
    ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-c:a', 'pcm_s16le', join(fixtureRoot, 'audio.wav')],
  ]) {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr.toString());
  }
  [video, image, audio] = await Promise.all(['video.mp4', 'image.png', 'audio.wav'].map(file => readFile(join(fixtureRoot, file)))) as [Buffer, Buffer, Buffer];
});
test.afterAll(async () => {
  if (!fixtureRoot) return;
  const path = resolve(fixtureRoot); expect(dirname(path)).toBe(resolve(tmpdir())); expect(basename(path).startsWith('pixel-composition-ui-')).toBe(true);
  await rm(path, { recursive: true, force: true });
});

function snapshot(audioCount = 2): ProjectSnapshot {
  const document: ProjectSnapshot['document'] = { id: 'test-composition', schemaVersion: 1, title: '分层预览', timelines: {}, items: {}, assets: {}, timelineOrder: ['front', 'middle', 'back', 'sound', 'notes'] };
  for (const [timelineId, kind] of [['front', 'image'], ['middle', 'video'], ['back', 'video'], ['sound', 'audio'], ['notes', 'text']] as const) {
    document.timelines[timelineId] = { id: timelineId, pluginId: `pixel.${kind}${kind === 'text' ? '' : '.local'}`, pluginVersion: 1, ticksPerSecond: 1000, itemIds: [], settings: {} };
  }
  for (const [kind, id] of Object.entries(ids)) document.assets[id] = { id, kind: kind as 'video' | 'image' | 'audio', fileRef: `pixel-asset:${id}`, metadata: {} };
  const add = (timelineId: string, id: string, start: number, duration: number, assetId?: string, offset = 0) => {
    document.items[id] = { id, timelineId, kind: assetId ? `${document.assets[assetId]!.kind}.local` : 'text.note', startTick: start, durationTicks: duration, sourceOffsetTicks: offset,
      params: assetId ? {} : { text: '仅供agent参考的文本' }, referenceAssetIds: [], generationToken: 'token', ...(assetId ? { outputAssetId: assetId, outputOrigin: 'placement' as const } : {}) };
    document.timelines[timelineId]!.itemIds.push(id);
  };
  add('front', 'overlay', 500, 1500, ids.image); add('middle', 'upper-video', 1000, 1000, ids.video, 750);
  add('back', 'lower-video', 500, 2000, ids.video, 375);
  for (let index = 0; index < audioCount; index++) add('sound', `audio-${index}`, 0, 2500, ids.audio, index * 25);
  add('notes', 'note', 0, 2500);
  return { revision: 1, document };
}

async function mount(page: Page, initial = snapshot(), milliseconds = 1500) {
  await page.route('**/api/media/*', async route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    const media = id === ids.video ? { bytes: video, type: 'video/mp4' } : id === ids.image ? { bytes: image, type: 'image/png' } : id === ids.audio ? { bytes: audio, type: 'audio/wav' } : undefined;
    if (!media) return route.continue();
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0; const end = range?.[2] ? Math.min(Number(range[2]), media.bytes.length - 1) : media.bytes.length - 1;
    await route.fulfill({ status: range ? 206 : 200, contentType: media.type, body: media.bytes.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${media.bytes.length}` } : {}) } });
  });
  await page.goto('/');
  await page.evaluate(async ({ serialized, milliseconds }) => {
    const initial = JSON.parse(serialized) as ProjectSnapshot;
    document.getElementById('root')!.style.display = 'none';
    const [entrySource, componentSource] = await Promise.all([fetch('/main.tsx').then(response => response.text()), fetch('/composition-preview.tsx').then(response => response.text())]);
    const rootUrl = /["']([^"'\n]*\/react-dom_client\.js(?:\?[^"'\n]*)?)["']/.exec(entrySource)?.[1];
    const reactUrl = /["']([^"'\n]*\/react\.js(?:\?[^"'\n]*)?)["']/.exec(componentSource)?.[1];
    if (!rootUrl || !reactUrl) throw new Error('Missing Vite React import');
    const load = (url: string) => import(url);
    const [rootModule, reactModule, component] = await Promise.all([load(rootUrl), load(reactUrl), load('/composition-preview.tsx')]);
    const createRoot = rootModule.createRoot ?? rootModule.default.createRoot;
    const createElement = reactModule.createElement ?? reactModule.default.createElement;
    const host = document.createElement('div'); host.id = 'composition-fixture';
    Object.assign(host.style, { position: 'fixed', left: '20px', top: '20px', width: '640px', height: '360px' }); document.body.append(host);
    const root = createRoot(host); let state = initial; let position = milliseconds;
    const harness: CompositionHarness = { seeks: [], seek: () => {}, update: () => {} };
    const render = () => root.render(createElement(component.CompositionPreview, { snapshot: state, playheadMs: position, onSeek: (ms: number) => { harness.seeks.push(ms); position = ms; render(); } }));
    harness.seek = ms => { position = ms; render(); }; harness.update = next => { state = next; render(); };
    window.__pixelCompositionTest = harness; render();
  }, { serialized: JSON.stringify(initial), milliseconds });
  await expect(page.locator('#composition-fixture .composition-preview')).toBeVisible();
}

function pixel(png: Buffer, x: number, y: number): number[] {
  const result = spawnSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', `format=rgb24,crop=1:1:${Math.round(x)}:${Math.round(y)}`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { input: png, windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.toString()); return [...result.stdout.subarray(0, 3)];
}

test('real simultaneous layers respect top order and PNG transparency while paused media scrub retains individual source offsets', async ({ page }) => {
  await mount(page);
  const lower = page.locator('[data-composition-item="lower-video"] video');
  const upper = page.locator('[data-composition-item="upper-video"] video');
  await expect(lower).toHaveCount(1); await expect(upper).toHaveCount(1);
  await expect.poll(() => lower.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(1.375, 1);
  await expect.poll(() => upper.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(1.25, 1);
  expect(await lower.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await expect(page.locator('audio[data-composition-item]')).toHaveCount(2);
  await expect(page.locator('[data-composition-item="overlay"] img')).toHaveJSProperty('complete', true);
  await expect(page.locator('[data-composition-item="note"]')).toHaveCount(0);
  const nativeDrags = await page.locator('.composition-preview img, .composition-preview video, .composition-preview audio').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).draggable));
  expect(nativeDrags.every(value => !value)).toBe(true);
  const typography = await page.locator('.composition-player div').evaluateAll(nodes => [...new Set(nodes.map(node => getComputedStyle(node).fontSize))]);
  expect(typography).toEqual(['12px']);
  const picture = await page.locator('.composition-picture').boundingBox();
  const shot = await page.screenshot();
  const left = pixel(shot, picture!.x + picture!.width / 4, picture!.y + picture!.height / 4);
  const right = pixel(shot, picture!.x + picture!.width * 3 / 4, picture!.y + picture!.height / 4);
  expect(left[2]).toBeGreaterThan(240); expect(left[0]).toBeLessThan(20);
  expect(right[0]).toBeGreaterThan(240); expect(right[2]).toBeLessThan(20);
  const reordered = snapshot(); reordered.document.timelineOrder = ['back', 'front', 'middle', 'sound', 'notes'];
  await page.evaluate(serialized => window.__pixelCompositionTest!.update(JSON.parse(serialized) as ProjectSnapshot), JSON.stringify(reordered));
  await expect.poll(() => page.locator('[data-composition-item="lower-video"]').evaluate(node => Number(getComputedStyle(node).zIndex))).toBe(5);
  const reorderedLeft = pixel(await page.screenshot(), picture!.x + picture!.width / 4, picture!.y + picture!.height / 4);
  expect(reorderedLeft[0]).toBeGreaterThan(240); expect(reorderedLeft[2]).toBeLessThan(20);
});

test('Player controls synchronize the pointer without a feedback loop; beyond-end and exact half-open seeks show empty frames', async ({ page }) => {
  await mount(page, snapshot(), 1000);
  await page.getByRole('button', { name: 'Play video', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__pixelCompositionTest!.seeks.at(-1) ?? 0)).toBeGreaterThan(1100);
  await page.getByRole('button', { name: 'Pause video', exact: true }).click();
  const count = await page.evaluate(() => window.__pixelCompositionTest!.seeks.length);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__pixelCompositionTest!.seeks.length)).toBe(count);
  await page.evaluate(() => window.__pixelCompositionTest!.seek(2000));
  await expect(page.locator('[data-composition-item="overlay"], [data-composition-item="upper-video"]')).toHaveCount(0);
  await expect(page.locator('[data-composition-item="lower-video"]')).toHaveCount(1);
  await page.evaluate(() => window.__pixelCompositionTest!.seek(90_000));
  await expect(page.locator('[data-composition-item]')).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__pixelCompositionTest!.seeks.length)).toBe(count);
});

test('adding six concurrent audio items keeps the Player and existing media nodes alive, then seeks each independent source', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await mount(page, snapshot(), 1000);
  const lower = page.locator('[data-composition-item="lower-video"] video');
  await expect(lower).toHaveCount(1);
  await lower.evaluate(node => (node as HTMLElement).setAttribute('data-original-node', 'true'));
  await page.evaluate(serialized => window.__pixelCompositionTest!.update(JSON.parse(serialized) as ProjectSnapshot), JSON.stringify(snapshot(6)));
  await expect(page.locator('audio[data-composition-item]')).toHaveCount(6);
  await expect(lower).toHaveAttribute('data-original-node', 'true');
  await page.evaluate(() => window.__pixelCompositionTest!.seek(1500));
  for (let index = 0; index < 6; index++) {
    const node = page.locator(`audio[data-composition-item="audio-${index}"]`);
    await expect.poll(() => node.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(1.5 + index * 0.025, 1);
    expect(await node.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  }
  expect(errors).toEqual([]);
});
