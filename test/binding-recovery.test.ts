import { fakeAdapter } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { ANSWERING_WINDOW_MS, waitFor } from './support/budgets';
import { answerFixturePrompt } from './support/delegated-reply';
import { submissionSchema, type Completion, type Profile, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';

/**
 * A split reporting binding stops the worker reporting the PR, and the PR is
 * what re-issues the binding, so the queue-owned branch reconciliation is the
 * repair rather than a courtesy. These tests hold the two gates that used to
 * keep that reconciliation out of reach, and the guard that keeps the repair
 * from reaching past a worker that can still report for itself. Queue #392
 * (Tom, 2026-10-24) adds the other side: a discovered PR is identity, never
 * readiness, so a blocked or errored report keeps its block.
 */

const base = 'b'.repeat(40), head = 'a'.repeat(40);
const worker: Profile = { id: 'worker', name: 'worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
const GRACE = 60_000;

function fixture(graceMs = GRACE) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-binding-')), store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('pool', [{ profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] }]);
  const states = new Map<string, AgentObservation>();
  const calls = { lookups: 0 };
  let openBranchPr: { number: number; url: string; head: string }[] = [];
  /** Runs during PR verification, so a test can act while the discovery is between its proofs. */
  const hooks: { duringVerify?: () => Promise<void> | void; headRepository?: string | null } = {};
  const adapter: Adapter = fakeAdapter({
    profiles: async () => [worker], validate: async t => t.planningCommit ?? base,
    createWorkspace: async t => ({ id: `ws-${t.id}`, directory: '/worktree' }),
    verifyWorkspace: async t => t.branch,
    createAgent: async (t, token) => { const id = `agent-${t.runId}`; states.set(id, { id, workspaceId: t.workspaceId!, status: 'running', active: true, permissions: false, error: '', labels: { 'nucleus.mcpBinding': t.runId! } }); return { id, workspaceId: t.workspaceId }; },
    observe: async id => { const state = states.get(id); if (!state) throw new Error('Agent missing'); return state; },
    verifyPr: async () => {
      await hooks.duringVerify?.();
      return { url: 'https://github.com/example/repo/pull/51', head, repository: 'example/repo',
        headRepository: hooks.headRepository === undefined ? 'example/repo' : hooks.headRepository };
    },
    findOpenBranchPr: async () => { calls.lookups++; return openBranchPr; },
  });
  const engine = new Engine(store, adapter, graceMs); engine.profiles = [worker];
  /**
   * A retained live initial worker. The binding names `bindingRunId` so a caller
   * can split it from the durable run the task holds.
   */
  const working = (changes: Partial<Task> = {}, bindingRunId?: string) => {
    const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'docs/handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
    const runId = `run-${submitted.id.slice(0, 8)}`, agentId = `agent-${runId}`;
    states.set(agentId, { id: agentId, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', labels: { 'nucleus.mcpBinding': bindingRunId ?? runId } });
    return store.update(submitted.id, { phase: 'working', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree', agentId, runId,
      profile: worker, profileGroup: 'author', workerModel: worker.model, agentActive: false, lastAgentStatus: 'idle', lastObservedAt: new Date().toISOString(), ...changes });
  };
  const events = (id: string, kind: string) => store.eventsAll(id).filter(event => event.kind === kind);
  return { store, engine, adapter, states, calls, working, events, hooks, setOpenBranchPr: (value: typeof openBranchPr) => { openBranchPr = value; },
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('rule 1: a fault that conceals its branch PR consults live state before escalation', async () => {
  const f = fixture(); try {
    // The worker stopped with a binding naming an earlier run and no idle grace
    // recorded yet: the state the old order could never leave.
    const task = f.working({}, 'run-earlier');
    assert.equal(f.store.task(task.id).idleSince, null);
    f.setOpenBranchPr([{ number: 51, url: 'https://github.com/example/repo/pull/51', head }]);
    await f.engine.wake();
    const repaired = f.store.task(task.id);
    assert.equal(f.calls.lookups, 1, 'the branch PR is consulted for a split binding without waiting for the grace');
    assert.equal(repaired.phase, 'changes_requested');
    assert.equal(repaired.resumePrNumber, 51);
    assert.equal(repaired.prUrl, 'https://github.com/example/repo/pull/51');
    assert.equal(repaired.prHead, head);
    assert.equal(repaired.runId, task.runId, 'the retained worker run identity is preserved');
    assert.equal(repaired.agentId, task.agentId);
    assert.equal(repaired.resolution.attention, false, 'a repaired lane is not left flagged');
    assert.equal(f.events(task.id, 'initial_pr_reconciled').length, 1);
    assert.equal(f.events(task.id, 'initial_pr_lookup').length, 1);
    assert.equal(f.store.runs(task.id).filter(run => run.role === 'recovery').length, 0, 'no coordinator recovery is spent');
  } finally { await f.close(); }
});

test('rule 2: an empty live result is retried after the bounded grace', async () => {
  const f = fixture(0); try {
    const task = f.working({}, 'run-earlier');
    f.store.update(task.id, { prLookup: { attempts: 1, lastAt: new Date(Date.now() - 5 * GRACE).toISOString(), outcome: 'empty' } });
    // The worker opened its PR after the queue last looked.
    f.setOpenBranchPr([{ number: 51, url: 'https://github.com/example/repo/pull/51', head }]);
    await f.engine.wake();
    assert.equal(f.calls.lookups, 1, 'an empty result does not retire the reconciliation');
    assert.equal(f.store.task(task.id).phase, 'changes_requested');
    assert.equal(f.store.task(task.id).resumePrNumber, 51);
  } finally { await f.close(); }
});

test('rule 2: a live lookup is suppressed inside the bounded grace', async () => {
  const f = fixture(GRACE); try {
    const task = f.working({}, 'run-earlier');
    f.store.update(task.id, { prLookup: { attempts: 1, lastAt: new Date().toISOString(), outcome: 'empty' } });
    f.setOpenBranchPr([{ number: 51, url: 'https://github.com/example/repo/pull/51', head }]);
    await f.engine.wake();
    assert.equal(f.calls.lookups, 0, 'a fresh attempt is not repeated inside the grace');
    const current = f.store.task(task.id);
    assert.equal(current.phase, 'needs_attention');
    assert.match(current.reason, /binding names run run-earlier but the task holds/);
  } finally { await f.close(); }
});

test('a matched binding keeps its full grace before the queue reaches for a PR', async () => {
  const f = fixture(GRACE); try {
    const task = f.working();
    f.setOpenBranchPr([{ number: 51, url: 'https://github.com/example/repo/pull/51', head }]);
    await f.engine.wake();
    const waiting = f.store.task(task.id);
    assert.equal(f.calls.lookups, 0, 'a just-idle worker that can still report is not pre-empted');
    assert.equal(waiting.phase, 'working');
    assert.equal(waiting.resolution.attention, false);
    assert.ok(waiting.idleSince, 'the idle grace is recorded on the first idle observation');
    // Once the grace expires the same reconciliation runs.
    f.store.update(task.id, { idleSince: new Date(Date.now() - 2 * GRACE).toISOString() });
    await f.engine.wake();
    assert.equal(f.calls.lookups, 1);
    assert.equal(f.store.task(task.id).phase, 'changes_requested');
    assert.equal(f.store.task(task.id).resumePrNumber, 51);
  } finally { await f.close(); }
});

test('rule 2: an hour of empty lookups leaves at most the one opening pair', async () => {
  const f = fixture(GRACE); try {
    const task = f.working();
    f.store.update(task.id, { idleSince: new Date(Date.now() - 2 * GRACE).toISOString() });
    // The backoff lands lookups at the first eligibility and after 1, 2, 5 and
    // 15 idle-grace steps; the next would wait a full hour. Ageing the task's
    // last-checked stamp stands in for the elapsed wall clock.
    for (const gracesAgo of [0, 1, 3, 8, 23]) {
      const state = f.store.task(task.id).prLookup;
      if (state) f.store.update(task.id, { prLookup: { ...state, lastAt: new Date(Date.now() - gracesAgo * GRACE).toISOString() } });
      await f.engine.wake();
    }
    assert.equal(f.calls.lookups, 5, 'the backoff paces five lookups across the hour');
    assert.equal(f.events(task.id, 'initial_pr_lookup').length, 1, 'an unchanged empty result records no further event');
    assert.equal(f.events(task.id, 'initial_pr_lookup_empty').length, 1);
    assert.equal(f.store.task(task.id).prLookup?.attempts, 5, 'the repeats are kept as a counter on the task');
    // The hour-long tail step holds the sixth lookup inside the hour.
    await f.engine.wake();
    assert.equal(f.calls.lookups, 5, 'the sixty-minute step is not spent inside the hour');
  } finally { await f.close(); }
});

test('rule 2: a PR appearing after empty lookups is found and recorded at once', async () => {
  const f = fixture(GRACE); try {
    const task = f.working();
    f.store.update(task.id, { prLookup: { attempts: 3, lastAt: new Date(Date.now() - 9 * GRACE).toISOString(), outcome: 'empty' }, idleSince: new Date(Date.now() - 9 * GRACE).toISOString() });
    await f.engine.wake();
    assert.equal(f.calls.lookups, 1);
    assert.equal(f.events(task.id, 'initial_pr_lookup').length, 0, 'the unchanged empty result records no event');
    assert.equal(f.events(task.id, 'initial_pr_lookup_empty').length, 0);
    // The worker opens its PR; the next scheduled lookup adopts it.
    f.setOpenBranchPr([{ number: 51, url: 'https://github.com/example/repo/pull/51', head }]);
    f.store.update(task.id, { prLookup: { attempts: 4, lastAt: new Date(Date.now() - 60 * GRACE).toISOString(), outcome: 'empty' } });
    await f.engine.wake();
    assert.equal(f.calls.lookups, 2, 'the changed outcome waits for its backoff step like any other');
    assert.equal(f.store.task(task.id).resumePrNumber, 51, 'the PR is adopted at the next scheduled lookup');
    assert.equal(f.events(task.id, 'initial_pr_lookup').length, 1, 'the change from empty to found is recorded');
  } finally { await f.close(); }
});

test('rule 2: new worker activity resets the lookup backoff', async () => {
  const f = fixture(GRACE); try {
    const task = f.working();
    // Two empty lookups have backed the schedule out to a two-grace wait.
    f.store.update(task.id, { prLookup: { attempts: 2, lastAt: new Date().toISOString(), outcome: 'empty' }, idleSince: new Date(Date.now() - 9 * GRACE).toISOString() });
    await f.engine.wake();
    assert.equal(f.calls.lookups, 0, 'the backed-out schedule is still waiting');
    // The worker shows new activity; when it stops again the schedule restarts.
    const agentId = task.agentId!;
    f.states.set(agentId, { ...f.states.get(agentId)!, status: 'running', active: true });
    await f.engine.wake();
    const reset = f.store.task(task.id).prLookup;
    assert.equal(reset?.attempts, 0, 'activity cleared the lookup schedule');
    assert.equal(reset?.outcome, 'empty', 'the last outcome survives the reset');
    const substantiveAfterReset = f.store.task(task.id).lastSubstantiveVersion;
    await f.engine.wake();
    assert.equal(f.store.task(task.id).lastSubstantiveVersion, substantiveAfterReset, 'a settled reset stamp is not rewritten by later activity sweeps');
    f.states.set(agentId, { ...f.states.get(agentId)!, status: 'idle', active: false });
    await f.engine.wake();
    assert.equal(f.calls.lookups, 0, 'the fresh grace still holds');
    f.store.update(task.id, { idleSince: new Date(Date.now() - 2 * GRACE).toISOString() });
    await f.engine.wake();
    assert.equal(f.calls.lookups, 1, 'the restart begins from the first step, not the backed-out wait');
    assert.equal(f.store.task(task.id).prLookup?.attempts, 1, 'the counter restarted');
    assert.equal(f.events(task.id, 'initial_pr_lookup').length, 0, 'the unchanged empty result is not logged again after the reset');
    assert.equal(f.events(task.id, 'initial_pr_lookup_empty').length, 0);
  } finally { await f.close(); }
});

/**
 * Queue #392 (Tom, 2026-10-24). The branch-PR reconciliation used to treat a
 * matching PR as permission to ask the stopped worker for an instruction-free
 * readiness confirmation, which turned a block into review readiness: Queue387
 * reported the required tsc/tsx checks unrun (exit 127) and reached
 * `awaiting_review` on the same head through an identity-only revision. A
 * matching PR is identity, never readiness.
 */

const PR_URL = 'https://github.com/example/repo/pull/51';
/** The retained worker's own authenticated report, as the workspace release leaves it. */
function reported(f: ReturnType<typeof fixture>, status: 'blocked' | 'error', report: Partial<Completion> = {}) {
  const task = f.working({ idleSince: new Date(Date.now() - 2 * GRACE).toISOString() });
  const completion: Completion = { taskId: task.id, runId: task.runId!, eventId: `worker-${status}`, status,
    summary: 'Required tsc/tsx checks unrun (exit 127); the workspace toolchain is missing', ...report };
  return f.store.update(task.id, { phase: status, reason: completion.summary, completion });
}

for (const status of ['blocked', 'error'] as const) {
  test(`Queue #392: ${status === 'error' ? 'an error' : 'a blocked'} report keeps its block when the branch PR is discovered`, async () => {
    const f = fixture(); try {
      const task = reported(f, status, { head });
      f.setOpenBranchPr([{ number: 51, url: PR_URL, head }]);
      await f.engine.wake();
      const current = f.store.task(task.id);
      assert.equal(current.phase, status, 'the authenticated block still owns the lane');
      assert.match(current.reason, /^Waiting with the planner or task owner .*: blocker escalation .* is open$/, 'the ladder wait names its open escalation (Queue #912)');
      assert.equal(current.completion?.eventId, `worker-${status}`, 'the report itself is preserved as evidence');
      assert.equal(current.completion?.summary, task.completion?.summary);
      assert.equal(current.prUrl, PR_URL, 'the discovered identity is recorded');
      assert.equal(current.resumePrNumber, 51);
      assert.equal(current.prHead, head);
      assert.equal(current.resolution.currentRunId, null);
      assert.equal(current.resolution.revisionResumeUnpublished, false, 'no identity confirmation is armed');
      assert.equal(current.resolution.attention, false);
      assert.equal(f.store.runs(task.id).length, 0, 'no identity-only revision or reviewer was dispatched');
      assert.equal(f.events(task.id, 'blocked_pr_identity_recorded').length, 1);
      assert.equal(f.events(task.id, 'initial_pr_reconciled').length, 0, 'nothing claims a readiness continuation');
      assert.equal(f.events(task.id, 'blocked_pr_identity_deferred').length, 0);
    } finally { await f.close(); }
  });
}

test('Queue #392: a branch that moved past the head the report named records no identity', async () => {
  const f = fixture(); try {
    const task = reported(f, 'blocked', { head: 'f'.repeat(40) });
    f.setOpenBranchPr([{ number: 51, url: PR_URL, head }]);
    await f.engine.wake();
    const current = f.store.task(task.id);
    assert.equal(current.phase, 'blocked');
    assert.match(current.reason, /^Waiting with the planner or task owner .*: blocker escalation .* is open$/, 'the ladder wait names its open escalation (Queue #912)');
    assert.equal(current.prUrl, null, 'a moved branch is a different identity');
    assert.equal(current.prHead, null);
    assert.equal(current.resumePrNumber, null);
    assert.equal(f.store.runs(task.id).length, 0);
    const deferred = f.events(task.id, 'blocked_pr_identity_deferred');
    assert.equal(deferred.length, 1, 'the retained cause is visible once');
    assert.match(deferred[0]!.detail, new RegExp(`the branch is at ${head}, not the head ${'f'.repeat(40)} the report named`));
  } finally { await f.close(); }
});

test('Queue #392: a same-named branch in a fork is not recorded as the task identity', async () => {
  const f = fixture(); try {
    const task = reported(f, 'blocked', { head });
    f.hooks.headRepository = 'someone-else/repo';
    f.setOpenBranchPr([{ number: 51, url: PR_URL, head }]);
    await f.engine.wake();
    const current = f.store.task(task.id);
    assert.equal(current.phase, 'blocked');
    assert.equal(current.prUrl, null);
    assert.equal(current.resumePrNumber, null);
    assert.equal(f.store.runs(task.id).length, 0);
    const deferred = f.events(task.id, 'blocked_pr_identity_deferred');
    assert.equal(deferred.length, 1);
    assert.match(deferred[0]!.detail, /comes from someone-else\/repo, not the canonical example\/repo/);
  } finally { await f.close(); }
});

test('Queue #392: an unresolved run with unknown delivery defers the identity and keeps the block', async () => {
  const f = fixture(); try {
    const task = reported(f, 'blocked', { head });
    f.store.putRun({ id: 'delivery-unknown', taskId: task.id, role: 'revision', generation: 1, head, base, agentId: task.agentId,
      workspaceId: task.workspaceId!, profile: worker, status: 'uncertain', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: false });
    f.setOpenBranchPr([{ number: 51, url: PR_URL, head }]);
    await f.engine.wake();
    const current = f.store.task(task.id);
    assert.equal(current.phase, 'blocked');
    assert.equal(current.prUrl, null, 'identity waits for the unresolved delivery');
    assert.equal(f.store.run('delivery-unknown')?.released, false, 'the unresolved run is untouched');
    assert.equal(f.events(task.id, 'blocked_pr_identity_deferred').length, 1);
    assert.match(f.events(task.id, 'blocked_pr_identity_deferred')[0]!.detail, /another task run is still unresolved/);
  } finally { await f.close(); }
});

test('Queue #392: a concurrent owner instruction wins and the discovery writes nothing', async () => {
  const f = fixture(); try {
    // The #387 shape: the blocked report names the PR, so the owner's own
    // continuation can bind it while the discovery is between its proofs.
    const task = reported(f, 'blocked', { head, prNumber: 51 });
    f.setOpenBranchPr([{ number: 51, url: PR_URL, head }]);
    const continued: { task: Task | null } = { task: null };
    f.hooks.duringVerify = async () => {
      f.hooks.duringVerify = undefined;
      continued.task = await f.engine.performTaskControl({ taskId: task.id, version: f.store.task(task.id).version,
        action: 'move', to: 'work', reason: 'Run the required validation', instruction: 'Run the required tsc/tsx checks, then report',
        caller: 'owner-thread' });
    };
    const discovered = await f.engine.resolution.adoptReplacementPr(f.store.task(task.id), 51);
    assert.equal(continued.task?.phase, 'changes_requested', "the owner's continuation owns the task");
    assert.equal(discovered.phase, 'changes_requested');
    assert.equal(discovered.resumePrNumber, 51, 'the PR is bound by the continuation, not by the discovery');
    assert.equal(discovered.prHead, head);
    assert.equal(f.events(task.id, 'blocked_pr_identity_recorded').length, 0, 'the discovery recorded nothing');
    assert.equal(f.events(task.id, 'blocked_pr_identity_deferred').length, 0);
    assert.equal(f.events(task.id, 'continued_pr_bound').length, 1);
    assert.equal(discovered.completion?.status, 'blocked', 'the block stays as history for the continuation');
    assert.equal(discovered.resolution.pendingWorkerInstruction, 'Run the required tsc/tsx checks, then report');
  } finally { await f.close(); }
});

for (const found of [false, true]) {
  test(`732: a blocked report reaches its owner once after ${found ? 'identity-only discovery' : 'an empty PR lookup'}`, async () => {
    const f = fixture();
    let asks = 0;
    try {
      const task = reported(f, 'blocked', { ...(found ? { head } : {}), cause: { kind: 'external', name: 'missing toolchain' } });
      f.engine.resolution.recordStop(task, 'operator_needed', task.reason);
      // No project planner: the existing task owner must hear the question.
      Object.assign(f.adapter, { askPlanner: async (recipient: string) => {
        asks++;
        assert.equal(recipient, 'origin');
        return new Promise<string>(() => {});
      } });
      if (found) f.setOpenBranchPr([{ number: 51, url: PR_URL, head }]);
      await f.engine.wake();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.events(task.id, found ? 'blocked_pr_identity_recorded' : 'initial_pr_lookup_empty').length, 1);
      assert.equal(f.events(task.id, 'planner_escalation').length, 1);
      assert.equal(asks, 1);
      assert.equal(f.store.task(task.id).resolution.stop?.reason, 'escalated');
      await f.engine.wake();
      assert.equal(f.events(task.id, 'planner_escalation').length, 1);
      assert.equal(asks, 1, 'later sweeps never repeat the delivery');
    } finally { await f.close(); }
  });
}

test('a live recovery episode keeps the parked report until it ends, and then the report still reaches its owner', async () => {
  const f = fixture();
  let asks = 0;
  try {
    const task = reported(f, 'blocked', { cause: { kind: 'external', name: 'missing toolchain' } });
    Object.assign(f.adapter, { askPlanner: async () => { asks++; return new Promise<string>(() => {}); } });
    f.store.update(task.id, { resolution: { ...f.store.task(task.id).resolution, recoveryActive: true } });
    await f.engine.wake();
    assert.equal(f.events(task.id, 'planner_escalation').length, 0, 'the recovery thread owns the stop while it runs');
    f.store.update(task.id, { resolution: { ...f.store.task(task.id).resolution, recoveryActive: false } });
    await f.engine.wake();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.events(task.id, 'planner_escalation').length, 1);
    assert.equal(asks, 1);
  } finally { await f.close(); }
});

test('732: with no project planner an unanswered owner is followed by the decider once', async () => {
  const f = fixture();
  let ownerAsks = 0, deciderAsks = 0;
  try {
    f.store.setMeta('pool', [{ profileId: worker.id, enabled: true, group: 'author', roles: ['worker', 'coordinator'], weight: 1, scopes: ['general'] }]);
    f.engine.resolution.delegatedAnswerWaitMs = 10;
    const task = reported(f, 'blocked', { cause: { kind: 'external', name: 'missing toolchain' } });
    Object.assign(f.adapter, {
      askPlanner: async (recipient: string, input: { prompt: string }) => {
        if (recipient === 'origin') { ownerAsks++; return null; }
        assert.equal(recipient, 'decider');
        answerFixturePrompt(f.engine.resolution, recipient, input.prompt, 'Choice: Wait until a time (put an ISO timestamp in Reason)\nReason: 2099-01-01T00:00:00Z');
        return null;
      },
      runDecider: async () => { deciderAsks++; return { agentId: 'decider', text: 'Choice: Wait until a time (put an ISO timestamp in Reason)\nReason: 2099-01-01T00:00:00Z' }; },
    });
    await f.engine.wake();
    await waitFor(() => f.events(task.id, 'planner_escalation_answered').length > 0, ANSWERING_WINDOW_MS, 'the decider answer');
    assert.equal(ownerAsks, 1);
    assert.equal(deciderAsks, 1);
    assert.equal(f.events(task.id, 'planner_escalation_answered').length, 1);
    await f.engine.wake();
    assert.equal(ownerAsks, 1);
    assert.equal(deciderAsks, 1);
  } finally { await f.close(); }
});
