import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import './create-desktop-icon.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({
  entryPoints: [join(root, 'src/server.ts')], outfile: join(root, 'electron/backend.mjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  // The package resolves its platform binary beside its own module at runtime.
  external: ['ffmpeg-static'],
  banner: { js: "import { createRequire as pixelCreateRequire } from 'node:module'; const require = pixelCreateRequire(import.meta.url);" },
  sourcemap: false, legalComments: 'none',
});
