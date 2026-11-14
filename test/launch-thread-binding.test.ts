import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskSchema, type Profile, type Run, type Task } from '../shared/contracts';
import type { LaunchThreadContext } from '../core/dispatch/launch';
import { retainedThreadBinding, type LaunchSourceFacts } from '../core/dispatch/run-launch/thread-binding';

const base = 'a'.repeat(40), head = 'b'.repeat(40);
const profile = (id: string, model = `${id}-model`): Profile => ({
  id, name: id, provider: 'prov', model, thinkingOptionId: '', notes: '', available: true, problem: '', supportedThinking: [],
} as Profile);
const worker = profile('worker'), reviewer = profile('reviewer'), coordinator = profile('coordinator');
const pool = ['worker', 'reviewer', 'coordinator', 'executor'].map(profileId => ({
  profileId, enabled: true, group: `${profileId}-group`, roles: [], weight: 1, scopes: ['general'], capability: 'medium', cost: 'low',
}));

const task = (overrides: Partial<Task> = {}): Task => taskSchema.parse({
  submissionId: 's', title: 'T', repoPath: '/repo', planningCommit: base, handoffPath: 'h.md', originAgentId: 'o',
  id: 'task-1', hostId: 'host', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1, phase: 'queued', reason: '', held: false, handoffText: '', planningBase: base,
  workspaceId: 'ws', directory: '/worktree', branch: 'ns-task-1', agentId: 'worker-agent', runId: null,
  profile: worker, workspaceIntent: false, agentIntent: false, lastAgentStatus: null, idleSince: null,
  completion: null, agentActive: null, lastObservedAt: null, prUrl: null, prHead: head, coordinatorGeneration: 1,
  coordinatorAgentId: 'coordinator-agent',
  resolution: { reviewerAgentId: 'reviewer-agent', reviewerProfile: reviewer },
  ...overrides,
});

const run = (overrides: Partial<Run>): Run => ({
  id: 'run-1', taskId: 'task-1', role: 'executor', generation: 1, head, base, agentId: 'executor-agent',
  workspaceId: 'ws', profile: profile('executor'), status: 'finished', createdAt: '2026-01-01T00:00:00.000Z',
  lastObservedAt: '2026-01-01T00:00:00.000Z', active: false, idleSince: null, completion: null, released: true,
  ...overrides,
} as Run);

const source: LaunchSourceFacts = {
  firstReviewEntryWorker: false, firstWorkerSelection: null, prePrWorkerResume: false,
  retainedPrePrHead: null, resumingUnpublished: false,
};

function context(runs: Run[]): LaunchThreadContext {
  return { store: { runs: () => runs, pool: () => pool } } as unknown as LaunchThreadContext;
}

test('a launched role starts from its own retained binding', () => {
  const ctx = context([
    run({ id: 'old', released: false }),
    run({ id: 'new', agentId: 'executor-agent' }),
    run({ id: 'coordinator-run', role: 'reviewer', agentId: 'coordinator-agent', profile: worker }),
  ]);
  const target = task();

  const revision = retainedThreadBinding(ctx, target, 'revision', {}, source);
  assert.deepEqual([revision.agentId, revision.profile?.id], ['worker-agent', 'worker'], 'a revision resumes its own worker');
  assert.equal(revision.priorExecutor, null, 'only an executor launch reads the executor runs');

  const reviewerBinding = retainedThreadBinding(ctx, target, 'reviewer', {}, source);
  assert.deepEqual([reviewerBinding.agentId, reviewerBinding.profile?.id], ['reviewer-agent', 'reviewer'],
    'a reviewer keeps its retained thread and profile');

  const explicit = retainedThreadBinding(ctx, target, 'reviewer', { profile: profile('other') }, source);
  assert.deepEqual([explicit.agentId, explicit.profile?.id, explicit.group], [null, 'other', null],
    'an explicitly selected reviewer never reuses the retained agent, and an unknown profile has no group');

  const coordinatorBinding = retainedThreadBinding(ctx, target, 'closeout', {}, source);
  assert.deepEqual([coordinatorBinding.agentId, coordinatorBinding.profile?.id], ['coordinator-agent', 'worker'],
    'a coordinator keeps its sticky thread and the last profile that agent ran');
});

test('a proof executor binding follows the last released executor, not another role', () => {
  const ctx = context([
    run({ id: 'live', released: false, agentId: 'live-agent' }),
    run({ id: 'other-role', role: 'reviewer', agentId: 'reviewer-agent', profile: reviewer }),
    run({ id: 'released', released: true, agentId: 'executor-agent', profile: profile('executor') }),
  ]);
  const binding = retainedThreadBinding(ctx, task(), 'executor', {}, source);
  assert.deepEqual([binding.agentId, binding.profile?.id, binding.group], ['executor-agent', 'executor', 'executor-group'],
    'the released executor thread is retained with its pinned profile and its group');
  assert.equal(binding.priorExecutor?.id, 'released', 'the launch carries the run whose state it will observe');
});

test('a first revision worker selection replaces the retained worker profile', () => {
  const firstWorkerSelection = { profile: profile('fresh'), entry: { profileId: 'fresh', group: 'worker-group' } };
  const ctx = context([]);
  const binding = retainedThreadBinding(ctx, task(), 'revision', {},
    { ...source, firstReviewEntryWorker: true, firstWorkerSelection: firstWorkerSelection as LaunchSourceFacts['firstWorkerSelection'] });
  assert.deepEqual([binding.agentId, binding.profile?.id, binding.group], ['worker-agent', 'fresh', 'worker-group'],
    'the selected profile and its group win, while the retained agent binding stays for the reservation to read');
});
