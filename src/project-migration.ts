import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DomainError } from './backend.js';
import { SharedProjectCatalog, SharedProjectLease, SharedJobRepository, SharedVersionedDocument } from './shared-projects.js';
import { readWorkbenchProjectFile, validateWorkbenchProjectFile, type WorkbenchProjectFile } from './project-files.js';
import { FileJobRepository } from './storage.js';
import { migrateLegacyArtifacts } from './resource-migration.js';
import { generationInputFingerprint } from './generation-fingerprint.js';
import { SeafileArtifactStore } from './seafile-storage.js';
import type { GenerationJob } from './contracts.js';
import { migrateLegacyVoiceOperations } from './voice-operation-migration.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const claimSchema = z.strictObject({ sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), destinationId: z.uuid() });

/** Read-only ingress. A source snapshot has one remote destination; active old commands never auto-run. */
export async function importLegacyProject(directory: string, artifacts: SeafileArtifactStore, projects: SharedProjectCatalog, source?: WorkbenchProjectFile): Promise<string> {
  const root = await realpath(resolve(directory));
  const legacy = source ?? await readWorkbenchProjectFile(root, { validateResources: false });
  const sourceJobs = await new FileJobRepository(resolve(root, 'jobs')).list(['queued', 'running', 'cancelRequested', 'succeeded', 'failed', 'canceled', 'interrupted']);
  sourceJobs.sort((left, right) => left.id.localeCompare(right.id));
  const sourceDigest = createHash('sha256').update(canonical({ project: legacy, jobs: sourceJobs })).digest('hex');
  await migrateLegacyVoiceOperations(root, artifacts);
  const key = createHash('sha256').update(`${root.toLowerCase()}\0${sourceDigest}`).digest('hex');
  const claim = new SharedVersionedDocument(artifacts, `operations/migration-${key}`, value => claimSchema.parse(value));
  let record = await claim.read();
  if (!record) {
    try { await claim.publish(undefined, { sourceDigest, destinationId: randomUUID() }); }
    catch (error) { record = await claim.read(); if (!record) throw error; }
    record ??= await claim.read();
  }
  if (!record || record.value.sourceDigest !== sourceDigest) throw new DomainError('INVALID_INPUT', '旧项目迁移记录不一致');
  const id = record.value.destinationId;
  try { await projects.state(id); return id; }
  catch (error) { if (!(error instanceof DomainError && error.code === 'NOT_FOUND')) throw error; }
  const lease = await SharedProjectLease.acquire(artifacts, id);
  let renewal: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (!renewal) renewal = lease.renew().finally(() => { renewal = undefined; });
    void renewal.catch(() => {});
  }, 20_000); heartbeat.unref();
  try {
    await migrateLegacyArtifacts(root, artifacts);
    const state = structuredClone(legacy);
    for (const document of [state.snapshot.document, ...state.history.flatMap(entry => [entry.before, entry.after])]) {
      document.id = id;
      for (const asset of Object.values(document.assets)) {
        delete asset.metadata.storage;
        const remote = await artifacts.get(asset.id);
        if (remote) for (const name of ['sha256', 'byteLength', 'mimeType', 'extension']) asset.metadata[name] = remote.asset.metadata[name]!;
      }
    }
    // Previous request receipts remain history only, not an authority to replay source-project commands.
    state.requests = {}; state.outbox = [];
    const jobs = new SharedJobRepository(artifacts, id, () => lease.assertWritable());
    for (const original of sourceJobs) {
      const job = structuredClone(original) as GenerationJob;
      job.request.projectId = id;
      job.request.references = job.request.references.map(reference => {
        const asset = state.snapshot.document.assets[reference.id];
        return asset ? { ...asset, ...(reference.role === undefined ? {} : { role: reference.role }) } : reference;
      });
      job.request.inputFingerprint = generationInputFingerprint(job.request);
      if (['queued', 'running', 'cancelRequested'].includes(job.state)) {
        job.state = 'interrupted'; job.error = { code: 'LEGACY_IMPORTED', message: job.providerTaskId ? '旧项目已导入，原远端任务可显式恢复；未自动请求生成' : '旧任务没有可恢复的远端身份；未自动请求生成', retryable: false };
        job.updatedAt = new Date().toISOString();
      }
      if (!await jobs.get(job.id)) await jobs.create(job);
    }
    await lease.assertWritable();
    await projects.create(state.snapshot.document.title, id, validateWorkbenchProjectFile(state));
    return id;
  } finally { clearInterval(heartbeat); await renewal?.catch(() => {}); await lease.release(); }
}
