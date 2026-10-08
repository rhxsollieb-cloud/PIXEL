import { FileWorkbenchRepository } from '../src/workbench.ts';
import { createWorkbenchFixture } from '../tests/workbench-fixtures.ts';

// Browser tests opt into sample objects without changing a user's fresh project.
const directory = process.env.PIXEL_STORAGE_DIR;
if (!directory) throw new Error('UI tests require an explicit PIXEL_STORAGE_DIR');
await FileWorkbenchRepository.open(directory, createWorkbenchFixture());
await import('./dev.mjs');
