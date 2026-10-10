import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import type { GenerationReference, GenerationRequest, JsonObject } from '../src/contracts.js';
import { ProviderError } from '../src/generation.js';
import { modelRegistry } from '../src/models.js';
import { createModelBackend, loadBackendConfiguration } from '../src/runtime.js';
import { loadSeafileConfiguration } from '../src/backend-configuration.js';
import { SeafileArtifactStore } from '../src/seafile-storage.js';
import { DomainError } from '../src/backend.js';
import { SharedJobRepository, SharedProjectCatalog, SharedProjectLease } from '../src/shared-projects.js';

const diagnosticProjectId = 'backend-example';

async function ensureDiagnosticProject(catalog: SharedProjectCatalog): Promise<void> {
  try { await catalog.state(diagnosticProjectId); return; }
  catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; }
  try { await catalog.create('SDK 诊断', diagnosticProjectId); }
  catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'REVISION_CONFLICT') throw error;
    // Another diagnostic host may have created the same stable project meanwhile.
    await catalog.state(diagnosticProjectId);
  }
}

async function jsonObjectFile(path: string): Promise<JsonObject> {
  if ((await stat(path)).size > 1024 * 1024) throw new ProviderError('INVALID_INPUT', '参数文件超过大小上限');
  try { return z.record(z.string(), z.json()).parse(JSON.parse(await readFile(path, 'utf8'))) as JsonObject; }
  catch { throw new ProviderError('INVALID_INPUT', '参数文件必须包含合法 JSON 对象'); }
}

async function main() {
  const { values } = parseArgs({
    options: {
      list: { type: 'boolean' }, model: { type: 'string' },
      'params-file': { type: 'string' }, 'settings-file': { type: 'string' },
      'reference-file': { type: 'string', multiple: true },
      resume: { type: 'string' },
    },
  });
  if (values.list || (!values.model && !values.resume)) {
    const page = modelRegistry.query({ limit: 5 });
    console.table(page.items.map(({ modelId, providerId, outputKind, aliases }) => ({
      modelId, providerId, outputKind, aliases: aliases.join(', '),
    })));
    return;
  }
  if (values.model && values.resume) throw new ProviderError('INVALID_INPUT', '新建任务和恢复任务不能同时指定');
  const configuration = await loadBackendConfiguration();
  const artifacts = await SeafileArtifactStore.open(await loadSeafileConfiguration());
  await ensureDiagnosticProject(new SharedProjectCatalog(artifacts));
  const lease = await SharedProjectLease.acquire(artifacts, diagnosticProjectId);
  const controller = new AbortController();
  let renewalInProgress: Promise<void> | undefined;
  const renewal = setInterval(() => {
    if (renewalInProgress) return;
    renewalInProgress = lease.renew()
      .catch(() => controller.abort(new ProviderError('CANCELED', '共享诊断项目会话已失效')))
      .finally(() => { renewalInProgress = undefined; });
  }, 30_000);
  renewal.unref();
  const expiration = setInterval(() => {
    if (Date.now() >= lease.expiresAt) controller.abort(new ProviderError('CANCELED', '共享诊断项目会话已过期'));
  }, 1000);
  expiration.unref();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const backend = createModelBackend(configuration, artifacts,
      new SharedJobRepository(artifacts, diagnosticProjectId, () => lease.assertWritable()),
      () => lease.assertWritable());
    const options = {
      signal: controller.signal,
      onJob: (job: { id: string }) => console.log(`jobId: ${job.id}`),
      onProgress: (event: { stage?: string }) => { if (event.stage) console.log(`stage: ${event.stage}`); },
    };
    let job;
    if (values.resume) {
      if (values['params-file'] || values['settings-file'] || values['reference-file']) {
        throw new ProviderError('INVALID_INPUT', '恢复任务使用原始请求快照，不能同时替换参数或引用');
      }
      job = await backend.resume(values.resume, options);
    } else {
      if (!values.model || !values['params-file']) throw new ProviderError('INVALID_INPUT', '生成需要 --model 和 --params-file');
      const descriptor = modelRegistry.resolve(values.model);
      const params = await jsonObjectFile(values['params-file']);
      const settings = values['settings-file'] ? await jsonObjectFile(values['settings-file']) : {};
      const references: GenerationReference[] = [];
      const files = values['reference-file'] ?? [];
      if (files.length > descriptor.maxReferences || (files.length && !descriptor.referenceKinds.includes('image'))) {
        throw new ProviderError('UNSUPPORTED_REFERENCE', '所选模型不支持这些引用');
      }
      for (const file of files) {
        const mimeType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' } as Record<string, string>)[extname(file).toLowerCase()];
        if (!mimeType || (await stat(file)).size > 25 * 1024 * 1024) {
          throw new ProviderError('UNSUPPORTED_REFERENCE', '引用必须为 25MiB 以内的 PNG/JPEG/WebP');
        }
        const artifact = await backend.artifacts.write({
          attemptToken: { jobId: `import_${randomUUID()}`, attempt: 1 }, kind: 'image',
          bytes: await readFile(file), metadata: { mimeType }, signal: controller.signal,
        });
        references.push(artifact.asset);
      }
      const request: GenerationRequest = {
        projectId: diagnosticProjectId, targetItemId: 'example-item', generationToken: randomUUID(),
        inputFingerprint: 'computed-by-host', providerId: descriptor.providerId, providerVersion: descriptor.providerVersion,
        modelId: values.model, params, settings, references,
      };
      job = await backend.run(request, options);
    }
    console.log(`jobId: ${job.id}\nstate: ${job.state}`);
    if (job.error) console.error(`${job.error.code}: ${job.error.message}`);
    for (const id of job.artifactIds) {
      const artifact = await backend.artifacts.get(id);
      if (artifact) console.log(artifact.asset.fileRef);
    }
    if (job.state !== 'succeeded') process.exitCode = 1;
  } finally {
    clearInterval(renewal);
    clearInterval(expiration);
    process.removeListener('SIGINT', cancel);
    await renewalInProgress;
    await lease.release().catch(() => undefined);
  }
}

main().catch(error => {
  console.error(error instanceof ProviderError ? `${error.code}: ${error.message}` : '后端执行失败，请检查命令和配置');
  process.exitCode = 1;
});
