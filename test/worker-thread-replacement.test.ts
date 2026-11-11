import { fakeAdapter } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { decideWorkerReplacement, isWorkerRouteApproved, retainedWorkerFailureCause } from '../core/recovery/worker-replacement';
import { OPERATOR_WORKER_REMAP_REASON } from '../core/resolution';
import { submissionSchema, taskControlInputSchema, type Profile, type Run } from '../shared/contracts';
import type { Adapter } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';

/**
 * Spec 058 task 577: a task keeps one worker thread. A worker replacement
 * happens only for a provider failure (or an unrecoverable worker) or for an
 * approved route to a different model. Every other path continues the same
 * retained worker agent, and a refused replacement records
 * `worker_replacement_refused` naming its rule.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40);

test('decideWorkerReplacement allows a provider failure even on the same model', () => {
  const task = { completion: { providerUnavailable: true } } as never;
  const failure = retainedWorkerFailureCause({ task });
  assert.ok(failure, 'a provider-unavailable completion is a failure');
  const decision = decideWorkerReplacement({
    task: task as never,
    requestedProfileId: 'terra', requestedModel: 'terra-model', currentModel: 'terra-model',
    approved: true, failure, explicitOperatorRelay: false, freshRestart: false,
  });
  assert.equal(decision.allowed, true);
});

test('decideWorkerReplacement allows quota exhaustion even on the same model', () => {
  const task = {} as never;
  const failure = retainedWorkerFailureCause({ task, observedStatus: 'error', observedError: 'weekly usage limit exceeded' });
  assert.ok(failure && failure.kind === 'quota_exhaustion');
  const decision = decideWorkerReplacement({
    task: task as never,
    requestedProfileId: 'terra', requestedModel: 'terra-model', currentModel: 'terra-model',
    approved: true, failure, explicitOperatorRelay: false, freshRestart: true,
  });
  assert.equal(decision.allowed, true);
});

test('decideWorkerReplacement treats an inactive errored agent as unable to continue', () => {
  const task = {} as never;
  const failure = retainedWorkerFailureCause({ task, observedStatus: 'error', observedError: 'Connection error', observedActive: false, observedPermissions: false });
  assert.deepEqual(failure, { kind: 'agent_errored', detail: 'the retained worker agent errored: Connection error' });
  assert.equal(retainedWorkerFailureCause({ task, observedStatus: 'error', observedError: 'Connection error', observedActive: true, observedPermissions: false }), null);
  assert.equal(retainedWorkerFailureCause({ task, observedStatus: 'error', observedError: 'Connection error', observedActive: false, observedPermissions: true }), null);
});

test('decideWorkerReplacement refuses the same model with no failure', () => {
  const decision = decideWorkerReplacement({
    task: {} as never,
    requestedProfileId: 'terra', requestedModel: 'terra-model', currentModel: 'terra-model',
    approved: true, failure: null, explicitOperatorRelay: false, freshRestart: false,
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.rule, 'same_model_no_failure');
});

test('decideWorkerReplacement refuses a fresh restart without a cause or relay', () => {
  const decision = decideWorkerReplacement({
    task: {} as never,
    requestedProfileId: 'terra', requestedModel: 'terra-model', currentModel: 'terra-model',
    approved: true, failure: null, explicitOperatorRelay: false, freshRestart: true,
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.rule, 'fresh_without_cause_or_relay');
});

test('decideWorkerReplacement allows a fresh restart with an explicit operator relay', () => {
  const decision = decideWorkerReplacement({
    task: {} as never,
    requestedProfileId: 'terra', requestedModel: 'terra-model', currentModel: 'terra-model',
    approved: true, failure: null, explicitOperatorRelay: true, freshRestart: true,
  });
  assert.equal(decision.allowed, true);
});

test('decideWorkerReplacement refuses a route waiting on sign-off', () => {
  const decision = decideWorkerReplacement({
    task: {} as never,
    requestedProfileId: 'sol', requestedModel: 'sol-model', currentModel: 'terra-model',
    approved: false, failure: null, explicitOperatorRelay: false, freshRestart: false,
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.rule, 'signoff_pending');
});

test('decideWorkerReplacement allows an approved route to a different model', () => {
  const decision = decideWorkerReplacement({
    task: {} as never,
    requestedProfileId: 'sol', requestedModel: 'sol-model', currentModel: 'terra-model',
    approved: true, failure: null, explicitOperatorRelay: false, freshRestart: false,
  });
  assert.equal(decision.allowed, true);
});

test('isWorkerRouteApproved needs board sign-off only for by-request or above-level routes', () => {
  const pool = [
    { profileId: 'terra', enabled: true, group: 'terra', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: 'sol', enabled: true, group: 'sol', roles: ['worker'], weight: 1, scopes: ['general'], cost: 'very_high', capability: 'frontier' },
  ] as never;
  assert.equal(isWorkerRouteApproved({}, 'terra', pool, 'normal'), true, 'a within-level route needs no sign-off');
  assert.equal(isWorkerRouteApproved({}, 'sol', pool, 'normal'), false, 'a by-request route without sign-off is not approved');
  const approved = { profileRequests: { worker: { profileId: 'sol', reason: 'Board choice', required: true,
    signoff: { status: 'approved', decisionId: 'd', by: 'operator (board)', at: new Date().toISOString(), note: '' } } } };
  assert.equal(isWorkerRouteApproved(approved as never, 'sol', pool, 'normal'), true, 'a signed-off route is approved');
});

const terra = (id: string, model: string): Profile =>
  ({ id, name: id, provider: 'test', model, notes: '', available: true, problem: '', supportedThinking: [] });

function sweepFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-worker-thread-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const author = terra('author', 'terra-model');
  const sol = terra('sol', 'sol-model');
  store.setMeta('pool', [
    { profileId: 'author', enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: 'sol', enabled: true, group: 'sol', roles: ['worker'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Worker thread', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const states = new Map<string, { id: string; workspaceId: string; status: string; active: boolean; permissions: boolean; error: string; activeTurnId?: string }>();
  states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
  const created: string[] = [];
  const adapter = fakeAdapter({
    profiles: async () => [author, sol],
    validate: async () => base, verifyWorkspace: async () => {}, verifyCleanQueueWorktree: async () => {},
    createWorkspace: async () => { throw new Error('no workspace creation in worker-thread fixtures'); },
    createAgent: async (t: { profile?: { id: string } | null; workspaceId?: string | null }) => {
      const id = `agent-${created.length + 1}`;
      states.set(id, { id, workspaceId: t.workspaceId ?? 'workspace', status: 'running', active: true, permissions: false, error: '' });
      created.push(id);
      return { id, workspaceId: t.workspaceId ?? 'workspace' };
    },
    observe: async (id: string) => {
      const state = states.get(id);
      if (!state) throw new Error('Agent missing');
      return state as never;
    },
     notify: async () => {},
    findRunAgents: async () => [],
    verifyPr: async () => ({ head, url: 'https://github.com/example/repo/pull/1' }),
    verifyPrIdentity: async () => ({ head, url: 'https://github.com/example/repo/pull/1' }),
    verifyResume: async () => {},
    stopAgentTurn: async (id: string) => {
      const state = states.get(id);
      if (state) states.set(id, { ...state, active: false, status: 'idle' });
    },
    createRun: async () => { throw new Error('no run creation in worker-thread fixtures'); },
    sendRun: async () => {}, verifyReview: async () => {},
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => base,
    verifyCloseout: async () => {},
  } as unknown as Adapter & ResolutionAdapter);
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [author, sol];
  const working = (patch: Record<string, unknown> = {}) => store.update(submitted.id, {
    phase: 'working', reason: 'Working', workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker', runId: 'initial', profile: author, profileGroup: 'author',
    workerModel: author.model, workerModels: [author.model], ...patch,
  });
  return { dir, store, engine, adapter, taskId: submitted.id, working, states, created,
    current: () => store.task(submitted.id),
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a recovery remap on the same model continues the same agent', async () => {
  const f = sweepFixture(); try {
    // effigy#531 10:17: a recovery \"remap\" after a stale-run failure retired the
    // worker onto the same model with no provider failure. The guard refuses it.
    f.working({
      failoverReason: `${OPERATOR_WORKER_REMAP_REASON}. Recovery remap after a stale run`,
      replacementProfile: { profileId: 'author', reason: 'Recovery remap after a stale run' },
    });
    await f.engine.wake();
    const task = f.current();
    assert.equal(task.retiredWorkers.length, 0, 'no worker retired for the same-model remap');
    assert.equal(task.agentId, 'worker', 'the same agent continues');
    assert.equal(task.failoverReason, '', 'the refused arm is cleared');
    const refused = f.store.eventsAll(f.taskId).find(event => event.kind === 'worker_replacement_refused')!;
    assert.ok(refused, 'the refusal is recorded');
    assert.match(refused.detail, /^same_model_no_failure:/);
  } finally { await f.close(); }
});

test('an errored retained worker is replaced by an alternate profile on the same workspace and PR', async () => {
  const f = sweepFixture(); try {
    f.working({ prUrl: 'https://github.com/example/repo/pull/1', prHead: head, resumePrNumber: 1 });
    f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'error', active: false, permissions: false, error: 'Connection error' });
    await f.engine.wake();
    const waiting = f.current();
    assert.equal(waiting.agentId, 'worker', 'the first sweep keeps the retained agent while its continuation waits');
    assert.equal(waiting.retiredWorkers.length, 0);
    assert.equal(waiting.transientProviderRetry?.status, 'waiting');
    f.store.update(f.taskId, { transientProviderRetry: {
      ...waiting.transientProviderRetry!, retryAt: '2000-01-01T00:00:00.000Z',
    } });
    await f.engine.wake();
    const replaced = f.current();
    assert.equal(replaced.profile?.id, 'sol', 'do not route the failure back to the same profile');
    assert.equal(replaced.retiredWorkers.length, 1, 'the failed resume causes one replacement');
    assert.equal(replaced.retiredWorkers[0]?.agentId, 'worker');
    assert.equal(replaced.workspaceId, 'workspace');
    assert.equal(replaced.prUrl, 'https://github.com/example/repo/pull/1');
    assert.equal(replaced.resumePrNumber, 1, 'the existing PR remains bound for resume');
    assert.equal(f.created.length, 1);
    assert.equal(f.states.get(f.created[0]!)?.workspaceId, 'workspace');
    assert.ok(f.store.eventsAll(f.taskId).some(event => event.kind === 'worker_resume_failed'), 'the failed resume is recorded');
    assert.equal(f.store.runs(f.taskId).some(run => run.role === 'recovery'), false);
  } finally { await f.close(); }
});

test('an error observation with an active turn is neither replaced nor resumed', async () => {
  const f = sweepFixture(); try {
    f.working();
    f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'error', active: false, permissions: false,
      activeTurnId: 'still-active', error: 'Connection error' });
    await f.engine.wake();
    assert.equal(f.current().agentId, 'worker');
    assert.equal(f.current().retiredWorkers.length, 0);
    assert.equal(f.created.length, 0);
    assert.equal(f.current().failoverReason, '');
  } finally { await f.close(); }
});

test('an approved model change replaces once', async () => {
  const f = sweepFixture(); try {
    // effigy#531 11:48: the board-approved Sol route retires the Terra worker once.
    f.working({
      phase: 'changes_requested',
      reason: 'Owner routed the worker profile',
      failoverReason: `${OPERATOR_WORKER_REMAP_REASON}. Owner routed the worker profile`,
      replacementProfile: { profileId: 'sol', reason: 'Owner routed the worker profile' },
      profileRequests: { worker: { profileId: 'sol', reason: 'Sol is stronger', required: true } },
    });
    await f.engine.wake();
    const replaced = f.current();
    assert.equal(replaced.profile?.id, 'sol', 'the worker route moves to the approved model');
    assert.equal(replaced.retiredWorkers.length, 1, 'exactly one retirement');
    assert.equal(replaced.retiredWorkers[0]?.agentId, 'worker');
    const firstHead = replaced.version;
    await f.engine.wake();
    const settled = f.current();
    assert.equal(settled.retiredWorkers.length, 1, 'a second sweep retires nothing more');
    assert.equal(settled.version, firstHead, 'nothing further changed');
  } finally { await f.close(); }
});

test('a route waiting on sign-off records the request and replaces nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-worker-route-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const author = terra('author', 'author-model');
  const sol = terra('sol', 'sol-model');
  store.setMeta('pool', [
    { profileId: 'author', enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: 'sol', enabled: true, group: 'sol', roles: ['worker'], weight: 1, scopes: ['general'], cost: 'very_high', capability: 'frontier' },
  ]);
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Route waits', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const task = store.update(submitted.id, {
    phase: 'working', reason: 'Working', workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker', runId: 'initial', profile: author, workerModel: author.model, workerModels: [author.model],
  });
  const adapter = fakeAdapter({
    profiles: async () => [author, sol],
    validate: async () => base, verifyWorkspace: async () => {}, verifyCleanQueueWorktree: async () => {},
    createWorkspace: async () => { throw new Error('no workspace creation'); },
    createAgent: async () => { throw new Error('no agent creation'); },
    observe: async () => ({ id: 'worker', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' }) as never,
     notify: async () => {}, findRunAgents: async () => [],
    verifyPr: async () => ({ head, url: 'https://github.com/example/repo/pull/1' }),
    verifyPrIdentity: async () => ({ head, url: 'https://github.com/example/repo/pull/1' }),
    verifyResume: async () => {}, stopAgentTurn: async () => {},
    createRun: async () => { throw new Error('no run creation'); },
    sendRun: async () => {}, verifyReview: async () => {},
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => base,
    verifyCloseout: async () => {},
  } as unknown as Adapter & ResolutionAdapter);
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [author, sol];
  try {
    // effigy#531 10:30: a route to Sol awaiting sign-off fell back to automatic
    // selection and replaced the worker with another Terra agent.
    const routed = await engine.performTaskControl(taskControlInputSchema.parse({
      taskId: task.id, version: store.task(task.id).version, action: 'route',
      role: 'worker', profileId: 'sol', reason: 'Sol is stronger for the revision', caller: 'owner-thread',
    }));
    assert.equal(routed.profileRequests?.worker?.profileId, 'sol', 'the request is recorded');
    assert.equal(routed.replacementProfile, null, 'nothing is armed while sign-off is pending');
    assert.equal(routed.failoverReason, '', 'no failover is armed');
    assert.equal(routed.agentId, 'worker', 'the retained worker is untouched');
    const refused = store.eventsAll(task.id).find(event => event.kind === 'worker_replacement_refused')!;
    assert.ok(refused, 'the refusal is recorded');
    assert.match(refused.detail, /^signoff_pending:/, 'the refusal names its rule');
  } finally { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a provider failure replaces once', async () => {
  const f = sweepFixture(); try {
    f.working();
    f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'error', active: false, permissions: false,
      error: 'weekly usage limit exceeded' });
    await f.engine.wake();
    const replaced = f.current();
    assert.equal(replaced.retiredWorkers.length, 1, 'the exhausted worker retired once');
    assert.notEqual(replaced.agentId, 'worker', 'a new agent continues the task');
    const firstHead = replaced.version;
    await f.engine.wake();
    assert.equal(f.current().retiredWorkers.length, 1, 'a second sweep retires nothing more');
    assert.equal(f.current().version, firstHead, 'nothing further changed');
  } finally { await f.close(); }
});
