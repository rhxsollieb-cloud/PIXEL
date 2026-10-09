import { FileWorkbenchRepository } from '../src/workbench.ts';
import { createWorkbenchFixture } from '../tests/workbench-fixtures.ts';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// Browser tests opt into sample objects without changing a user's fresh project.
const directory = process.env.PIXEL_STORAGE_DIR;
if (!directory) throw new Error('UI tests require an explicit PIXEL_STORAGE_DIR');
await FileWorkbenchRepository.open(directory, createWorkbenchFixture());
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'scripts/test-host.mjs'], { stdio: 'inherit', env: process.env }),
  spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js')], { stdio: 'inherit', env: process.env }),
];
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) if (!child.killed) child.kill();
  process.exitCode = code;
}
for (const child of children) { child.on('error', () => close(1)); child.on('exit', code => close(code ?? 0)); }
process.once('SIGINT', () => close()); process.once('SIGTERM', () => close());
process.once('exit', () => { for (const child of children) if (!child.killed) child.kill(); });
