import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DeepReadonly, GenerationArtifact } from './contracts.js';
import { ProviderError, type MediaArtifactStore } from './generation.js';
import { FileArtifactStore } from './storage.js';
import { readWorkbenchProjectFile } from './project-files.js';

export interface LegacyArtifactDestination extends MediaArtifactStore {
  importArtifact(artifact: DeepReadonly<GenerationArtifact>, bytes: Uint8Array): Promise<GenerationArtifact>;
}

/** Preserve UUID handles, project revisions, history and the originals. No local media writes. */
export async function migrateLegacyArtifacts(directory: string, destination: LegacyArtifactDestination): Promise<{ migrated: number }> {
  const root = resolve(directory);
  const local = new FileArtifactStore(join(root, 'artifacts'));
  let files: string[];
  try {
    await readWorkbenchProjectFile(root, { validateResources: false });
    const actualRoot = await realpath(root);
    const actualMedia = await realpath(join(root, 'artifacts'));
    const within = relative(actualRoot, actualMedia);
    if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) throw new ProviderError('INVALID_OUTPUT', '旧素材目录超出了项目范围');
    files = await readdir(actualMedia);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { migrated: 0 };
    throw error;
  }
  let migrated = 0;
  for (const name of files) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
    const existing = await destination.get(name.slice(0, -5));
    if (existing) await destination.stat(existing.asset);
    let artifact: DeepReadonly<GenerationArtifact> | undefined;
    let media: { bytes: Uint8Array; mimeType: string };
    try {
      artifact = await local.get(name.slice(0, -5));
      if (!artifact) throw new ProviderError('INVALID_OUTPUT', '旧素材索引无法读取');
      media = await local.read(artifact.asset, new AbortController().signal);
    } catch (error) {
      if (existing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!artifact) throw new ProviderError('INVALID_OUTPUT', '旧素材索引无法读取');
    await destination.importArtifact(artifact, media.bytes);
    if (!existing) migrated += 1;
  }
  return { migrated };
}
