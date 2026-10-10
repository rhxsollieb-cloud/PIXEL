import { join, resolve } from 'node:path';
import { createWorkbench as createCoreWorkbench, FileWorkbenchRepository, createInitialWorkbenchProject, type WorkbenchOptions } from '../src/workbench.js';
import { FileArtifactStore } from '../src/storage.js';
export * from '../src/workbench.js';

/** Tests deliberately select their isolated adapter; the core has no local resource fallback. */
export async function createWorkbench(options: WorkbenchOptions = {}) {
  const directory = resolve(options.directory ?? '.pixel');
  const artifacts = options.artifacts ?? options.runner?.artifacts ?? new FileArtifactStore(join(directory, 'artifacts'));
  const repository = options.repository ?? await FileWorkbenchRepository.open(directory, options.initial ?? createInitialWorkbenchProject(), artifacts);
  return createCoreWorkbench({ ...options, artifacts, repository });
}
