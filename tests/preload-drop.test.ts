import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

interface ProjectDropBridge {
  openDroppedProject(file: unknown): Promise<{ ok: boolean; error?: string }>;
}

function preload() {
  const filePaths = new WeakMap<object, string>();
  const calls: { channel: string; request: unknown }[] = [];
  let bridge: ProjectDropBridge | undefined;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name: string, value: ProjectDropBridge) => { bridge = value; } },
    ipcRenderer: {
      invoke: async (channel: string, request: unknown) => { calls.push({ channel, request }); return { ok: true }; },
    },
    webUtils: {
      getPathForFile: (file: unknown) => {
        if (!file || typeof file !== 'object' || !filePaths.has(file)) throw new Error('Not a native File');
        return filePaths.get(file)!;
      },
    },
  };
  runInNewContext(readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), {
    require: (module: string) => { assert.equal(module, 'electron'); return electron; },
    process: { argv: ['--pixel-window=workspace'] },
  });
  assert.ok(bridge);
  return { bridge, calls, filePaths };
}

test('project drop bridge resolves disk-backed files inside preload and does not expose paths', async () => {
  const { bridge, calls, filePaths } = preload();
  const folder = { name: '测试' };
  const project = { name: 'project.json' };
  filePaths.set(folder, 'C:\\Pixel Test\\测试');
  filePaths.set(project, 'C:\\Pixel Test\\项目\\project.json');
  assert.deepEqual(await bridge.openDroppedProject(folder), { ok: true });
  assert.deepEqual(await bridge.openDroppedProject(project), { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.channel, 'pixel:project-open-drop');
  assert.equal((calls[0]!.request as { path: string }).path, 'C:\\Pixel Test\\测试');
  assert.equal((calls[1]!.request as { path: string }).path, 'C:\\Pixel Test\\项目\\project.json');
});

test('project drop bridge rejects renderer path strings, forged objects and constructed files before IPC', async () => {
  const { bridge, calls, filePaths } = preload();
  const constructedFile = { name: 'project.json', path: 'C:\\private\\project.json' };
  filePaths.set(constructedFile, '');
  for (const file of [undefined, null, 'C:\\private\\project.json', { path: 'C:\\private\\project.json' }, constructedFile]) {
    const reply = await bridge.openDroppedProject(file);
    assert.equal(reply.ok, false);
    assert.match(reply.error!, /本机项目文件/);
  }
  assert.equal(calls.length, 0);
});
