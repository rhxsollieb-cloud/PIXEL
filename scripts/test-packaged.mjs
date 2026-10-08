import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = join(root, 'release', 'win-unpacked', 'Pixel.exe');
const directory = await mkdtemp(join(tmpdir(), 'pixel-packaged-'));
const env = { ...process.env, PIXEL_STORAGE_DIR: directory, ELEVENLABS_API_KEY: '', OPENROUTER_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(executable, ['--pixel-smoke'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes.toString(); });
  child.stderr.on('data', bytes => { output += bytes.toString(); });
  const code = await new Promise((accept, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Packaged desktop smoke timed out')); }, 30000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); accept(code); });
  });
  if (code !== 0 || !output.includes('PIXEL_DESKTOP_SMOKE_OK')) throw new Error(`Packaged desktop smoke failed (${code}): ${output}`);
  console.log('PIXEL_PACKAGED_SMOKE_OK');
} finally { await rm(directory, { recursive: true, force: true }); }
