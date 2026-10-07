import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeepReadonly, GenerationArtifact, GenerationJob, JobState } from '../src/contracts.js';
import {
  assertJobTransition,
  getGenerationResultStaleness,
  isArtifactOwnedByJob,
  isGenerationResultCurrent,
  isJobAttemptCurrent,
  transitionJob,
} from '../src/generation.js';
import { exampleProject } from '../examples/fixture.js';

const createdAt = '2026-10-07T19:00:00.000Z';
const updatedAt = '2026-10-07T19:01:00.000Z';
function view<T>(value: T): DeepReadonly<T> { return value as DeepReadonly<T>; }
function queuedJob(): GenerationJob {
  return {
    id: 'job_1',
    request: {
      projectId: 'project_demo', targetItemId: 'item_1', generationToken: 'input_v1',
      inputFingerprint: 'fingerprint_v1', providerId: 'example.provider',
      providerVersion: '1', modelId: 'example.video', params: {}, references: [],
    },
    state: 'queued', attempt: 1, progress: 0, artifactIds: [], createdAt, updatedAt: createdAt,
  };
}
function succeededJob(): GenerationJob {
  return transitionJob(
    view(transitionJob(view(queuedJob()), 'running', updatedAt)),
    'succeeded', updatedAt, { artifactIds: ['artifact_1'] },
  );
}

test('取消必须先进入 cancelRequested；成功、失败、取消终态都不可重入', () => {
  const running = transitionJob(view(queuedJob()), 'running', updatedAt);
  assert.throws(() => transitionJob(view(running), 'canceled', updatedAt), /Invalid/);
  const requested = transitionJob(view(running), 'cancelRequested', updatedAt);
  assert.throws(() => transitionJob(view(requested), 'succeeded', updatedAt, { artifactIds: ['late'] }), /Invalid/);
  const canceled = transitionJob(view(requested), 'canceled', updatedAt);
  assert.equal(canceled.state, 'canceled');
  const states: JobState[] = ['queued', 'running', 'cancelRequested', 'succeeded', 'failed', 'canceled', 'interrupted'];
  for (const terminal of ['succeeded', 'failed', 'canceled'] as const) {
    for (const next of states) assert.throws(() => assertJobTransition(terminal, next), /Invalid/);
  }
  assert.equal(running.state, 'running');
  assert.equal(requested.state, 'cancelRequested');
});

test('interrupted 恢复时递增 attempt，旧运行回调和终态回调被拒绝', () => {
  const running = transitionJob(view(queuedJob()), 'running', updatedAt, {
    progress: 0.7, providerTaskId: 'remote_old', artifactIds: ['old_partial'],
  });
  const interrupted = transitionJob(view(running), 'interrupted', updatedAt);
  const recovered = transitionJob(view(interrupted), 'queued', updatedAt);
  assert.equal(recovered.attempt, 2);
  assert.equal(recovered.progress, 0);
  assert.deepEqual(recovered.artifactIds, []);
  assert.equal(recovered.providerTaskId, 'remote_old');
  const resumed = transitionJob(view(recovered), 'running', updatedAt);
  assert.equal(isJobAttemptCurrent(view(resumed), { jobId: 'job_1', attempt: 1 }), false);
  assert.equal(isJobAttemptCurrent(view(resumed), { jobId: 'job_1', attempt: 2 }), true);
  assert.equal(isJobAttemptCurrent(view(resumed), { jobId: 'other_job', attempt: 2 }), false);
  const completed = transitionJob(view(resumed), 'succeeded', updatedAt, { artifactIds: ['artifact_2'] });
  assert.equal(isJobAttemptCurrent(view(completed), { jobId: 'job_1', attempt: 2 }), false);
  assert.equal(interrupted.attempt, 1);
  assert.equal(interrupted.progress, 0.7);
});

test('生成挂载检查相关输入和 request token；无关 revision 不使结果过期', () => {
  const snapshot = exampleProject();
  const job = succeededJob();
  snapshot.revision = 42;
  assert.equal(isGenerationResultCurrent(view(snapshot), view(job), 'fingerprint_v1'), true);
  assert.equal(getGenerationResultStaleness(view(snapshot), view(job), 'fingerprint_v2'), 'INPUT_CHANGED');
  snapshot.document.items.item_1!.generationToken = 'input_v2';
  assert.equal(getGenerationResultStaleness(view(snapshot), view(job), 'fingerprint_v1'), 'REQUEST_REPLACED');
  delete snapshot.document.items.item_1;
  assert.equal(getGenerationResultStaleness(view(snapshot), view(job), 'fingerprint_v1'), 'TARGET_DELETED');
});

test('删除目标及继承属性名都不能挂载；跨项目及旧 attempt 也拒绝', () => {
  const snapshot = exampleProject();
  const job = succeededJob();
  assert.equal(getGenerationResultStaleness(view(snapshot), view(job), 'fingerprint_v1', { jobId: job.id, attempt: 0 }), 'OLD_ATTEMPT');
  const nonterminal = queuedJob();
  assert.equal(getGenerationResultStaleness(view(snapshot), view(nonterminal), 'fingerprint_v1', { jobId: nonterminal.id, attempt: 1 }), 'JOB_NOT_SUCCEEDED');
  job.request.targetItemId = 'toString';
  assert.equal(getGenerationResultStaleness(view(snapshot), view(job), 'fingerprint_v1'), 'TARGET_DELETED');
  job.request.projectId = 'different_project';
  assert.equal(getGenerationResultStaleness(view(snapshot), view(job), 'fingerprint_v1'), 'WRONG_PROJECT');
});

test('挂载产物必须属于成功任务并出现在其产物清单中', () => {
  const job = succeededJob();
  const artifact: GenerationArtifact = {
    id: 'artifact_1', jobId: job.id,
    asset: { id: 'asset_1', kind: 'video', fileRef: 'managed:asset_1', metadata: {} },
  };
  assert.equal(isArtifactOwnedByJob(view(job), view(artifact)), true);
  artifact.jobId = 'other_job';
  assert.equal(isArtifactOwnedByJob(view(job), view(artifact)), false);
  artifact.jobId = job.id;
  artifact.id = 'unlisted_artifact';
  assert.equal(isArtifactOwnedByJob(view(job), view(artifact)), false);
});

test('状态转换不接受缺少产物的成功或缺少错误的失败', () => {
  const running = transitionJob(view(queuedJob()), 'running', updatedAt);
  assert.throws(() => transitionJob(view(running), 'succeeded', updatedAt), /artifacts/);
  assert.throws(() => transitionJob(view(running), 'failed', updatedAt), /error/);
  assert.throws(() => transitionJob(view(running), 'interrupted', updatedAt, { progress: 1.1 }), /progress/);
  const failed = transitionJob(view(running), 'failed', updatedAt, {
    error: { code: 'PROVIDER_FAILED', message: 'Example failure', retryable: true },
  });
  assert.equal(failed.error?.retryable, true);
});
