import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { submissionSchema, type Completion, type Run, type Task } from '../shared/contracts';
import { Store } from '../core/store/store';
import { PrAdoption, prAdoptionPlan, type PrAdoptionContext } from '../core/review/pr-adoption';
import type { AgentObservation } from '../core/host/adapter';

const head = 'a'.repeat(40), base = 'b'.repeat(40);

/** A retained worker task with no PR identity and nothing running, in memory. */
function retained(store: Store, changes: Partial<Task> = {}, completion?: Omit<Completion, 'taskId'>): Task {
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Adopt a PR', repoPath: '/repo',
    planningCommit: base, handoffPath: 'docs/handoff.md', originAgentId: 'origin' }), 'host', 'brief', base);
  store.update(task.id, { agentId: 'worker', workspaceId: 'workspace', directory: '/worktree', branch: 'ns-task',
    profile: { id: 'author', name: 'author', provider: 'test', model: 'author', notes: '', available: true, problem: '', supportedThinking: [] } as Task['profile'], ...changes,
    ...(completion ? { completion: { ...completion, taskId: task.id } } : {}) });
  return store.task(task.id);
}
const idle = (overrides: Partial<AgentObservation> = {}): AgentObservation =>
  ({ id: 'worker', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', ...overrides }) as AgentObservation;

/**
 * The adoption plan is a pure reading of the task's own typed state, so every
 * shape the paths used to discover with booleans is checked here directly.
 */
test('the adoption plan reads one route from the task state', () => {
  const store = new Store(':memory:');
  try {
    const blocked = retained(store, { phase: 'blocked' }, { eventId: 'e1', runId: 'initial', status: 'blocked', summary: 'Needs the operator' });
    assert.deepEqual(prAdoptionPlan(blocked, [], 7), { kind: 'blocked_identity' });

    const working = retained(store, { phase: 'working' });
    assert.deepEqual(prAdoptionPlan(working, [], 7), { kind: 'initial_discovery' });

    // A discovered PR never adopts ready-for-review evidence for a worker block.
    const ready = retained(store, { phase: 'awaiting_review' });
    assert.equal(prAdoptionPlan(ready, [], 7).kind, 'refuse');
    assert.equal((prAdoptionPlan({ ...ready, phase: 'changes_requested' }, [], 7) as { reason: string }).reason,
      'Replacement PR adoption requires an active PR identity repair or completed replacement-PR revision');

    // A completed replacement revision on its own branch PR reconciles.
    const replacement = retained(store, { phase: 'changes_requested', resumePrNumber: 7 },
      { eventId: 'ready', runId: 'worker', status: 'ready_for_review', summary: 'PR opened', prNumber: 4 });
    const revision: Run = { id: 'revision', taskId: replacement.id, role: 'revision', head, agentId: 'worker', workspaceId: 'workspace',
      status: 'finished', released: true, generation: 1, completion: { eventId: 'revision-ready', taskId: replacement.id, runId: 'revision',
        status: 'ready_for_review', summary: 'Replacement PR', prNumber: 7 } } as Run;
    const plan = prAdoptionPlan(store.task(replacement.id), [revision], 7);
    assert.equal(plan.kind, 'replacement');
    assert.equal(plan.kind === 'replacement' && plan.revisionReconcile, true);
    // The same callback number is never a replacement for itself.
    assert.equal(prAdoptionPlan(store.task(replacement.id), [revision], 4).kind, 'refuse');
  } finally { store.close(); }
});

/** Binds one PR-adoption instance to an observed worker, recording every host read. */
function adoption(store: Store, observations: AgentObservation[], pause = false) {
  const calls: { onTaskHost: string[]; verified: number[] } = { onTaskHost: [], verified: [] };
  const context: PrAdoptionContext = {
    store,
    adapter: {
      verifyPr: async (_task, number) => { calls.verified.push(number); return { url: `https://github.com/example/repo/pull/${number}`, head,
        repository: 'example/repo', headRepository: 'example/repo' } as never; },
      findOpenBranchPr: async () => [],
      verifyResume: async () => {},
    },
    host: { observe: async () => observations.shift() ?? idle() } as PrAdoptionContext['host'],
    onTaskHost: (_owner, work) => { calls.onTaskHost.push('read'); return work(); },
    paused: () => pause,
    recordBlockedPrIdentity: async task => task,
  };
  return { adoption: new PrAdoption(context), calls };
}

test('a stopped worker\'s discovered PR is identity only, observed through the task host', async () => {
  const store = new Store(':memory:');
  try {
    const task = retained(store, { phase: 'blocked' }, { eventId: 'e1', runId: 'initial', status: 'blocked', summary: 'Blocked, no PR yet', head });
    const { adoption: prs, calls } = adoption(store, [idle(), idle()]);
    const recorded = await prs.recordBlockedPrIdentity(store.task(task.id), 7, 'Existing branch PR discovery');
    assert.equal(recorded.prHead, head);
    assert.equal(recorded.resumePrNumber, 7);
    assert.equal(recorded.phase, 'blocked', 'identity only: the authenticated block keeps its phase');
    assert.equal(store.eventsAll(task.id).at(-1)?.kind, 'blocked_pr_identity_recorded');
    assert.deepEqual(calls.onTaskHost, ['read', 'read'], 'both observations read the task\'s own host');
  } finally { store.close(); }
});

test('a worker with a pending permission is not stopped, so no identity is recorded', async () => {
  const store = new Store(':memory:');
  try {
    const task = retained(store, { phase: 'blocked' }, { eventId: 'e2', runId: 'initial', status: 'blocked', summary: 'Blocked', head });
    // The shared participant rule reads an observed pending permission as live.
    const { adoption: prs, calls } = adoption(store, [idle({ permissions: true })]);
    const unchanged = await prs.recordBlockedPrIdentity(store.task(task.id), 7, 'Existing branch PR discovery');
    assert.equal(unchanged.prUrl, null);
    assert.equal(unchanged.resumePrNumber, null);
    assert.deepEqual(calls.verified, [], 'a live worker records no PR identity at all');
    assert.equal(store.eventsAll(task.id).at(-1)?.kind, 'blocked_pr_identity_deferred');
  } finally { store.close(); }
});
