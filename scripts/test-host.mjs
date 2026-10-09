// Explicit filesystem adapter for isolated tests. Product hosts always use Seafile.
import { join } from 'node:path';
import { startWorkbenchServer } from '../src/server.ts';
import { FileArtifactStore } from '../src/storage.ts';

const directory = process.env.PIXEL_STORAGE_DIR;
if (!directory) throw new Error('Test host requires isolated storage');
const { server, workbench } = await startWorkbenchServer({ directory,
  artifacts: new FileArtifactStore(join(directory, 'artifacts')), providers: { elevenlabs: false, openrouter: false },
});
console.log('Pixel 本地宿主已启动（隔离测试）');
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const tasks = workbench.shutdown();
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await tasks; await closed;
  if (process.send) process.send({ type: 'pixel.closed' });
  if (process.connected) process.disconnect();
}
process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
process.on('message', message => { if (message?.type === 'pixel.shutdown') void shutdown(); });
