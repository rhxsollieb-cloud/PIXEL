import { join, resolve } from 'node:path';
import { createWorkbench as createCoreWorkbench, type WorkbenchOptions } from '../src/workbench.js';
import { FileArtifactStore } from '../src/storage.js';
export * from '../src/workbench.js';

/** Tests deliberately select their isolated adapter; the core has no local resource fallback. */
export function createWorkbench(options: WorkbenchOptions = {}) {
  return createCoreWorkbench({ ...options, artifacts: options.artifacts ?? options.runner?.artifacts ?? new FileArtifactStore(join(resolve(options.directory ?? '.pixel'), 'artifacts')) });
}
