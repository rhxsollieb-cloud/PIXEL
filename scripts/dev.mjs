import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: root, stdio: 'inherit', env: process.env }),
  spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js')], { cwd: root, stdio: 'inherit', env: process.env }),
];
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) if (!child.killed) child.kill();
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', () => close(1));
  child.on('exit', code => close(code ?? 0));
}
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
process.on('exit', () => { for (const child of children) if (!child.killed) child.kill(); });
