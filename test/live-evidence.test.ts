import { fakeAdapter } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { clearLiveEvidence, liveEvidenceEpisode, recordLiveEvidenceFailure } from '../core/machine/live-evidence';
import { submissionSchema, type Profile, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';

/**
 * g01.035 live-evidence fetch policy (Spec 016 rules 4-5).
 *
 * Only the rule 4 facts are read live at their decision points; a failed,
 * timed-out, refused or unavailable read is `unverified` rather than absence;
 * a persisting failure yields one notice recording the failure; ambiguity
 * escalates naming its candidates as operational uncertainty; and a stale
 * mismatch projection never forces an escalation.
 */

const base = 'b'.repeat(40), head = 'a'.repeat(40);
const worker: Profile = { id: 'worker', name: 'worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
const GRACE = 60_000;
type BranchPr = { number: number; url: string; head: string };
const pr = (number: number): BranchPr => ({ number, url: `https://github.com/example/repo/pull/${number}`, head });

function fixture(graceMs = GRACE, withNotices = false) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-live-evidence-')), store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('pool', [{ profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] }]);
  const states = new Map<string, AgentObservation>();
  const calls = { lookups: 0, observes: 0, finds: 0 };
  const notifications: { id: string; text: string }[] = [];
  let lookupBehavior: () => Promise<BranchPr[]> = async () => [];
  let observeBehavior: ((id: string, call: number) => Promise<AgentObservation>) | null = null;
  const adapter: Adapter = fakeAdapter({
    ...(withNotices ? { supportsCoordinatorRecovery: true, notify: async (_id: string, nid: string, text: string) => { notifications.push({ id: nid, text }); } } : {}),
    profiles: async () => [worker], validate: async t => t.planningCommit ?? base,
    createWorkspace: async t => ({ id: `ws-${t.id}`, directory: '/worktree' }),
    verifyWorkspace: async t => t.branch,
    createAgent: async (t, token) => { const id = `agent-${t.runId}`; states.set(id, { id, workspaceId: t.workspaceId!, status: 'running', active: true, permissions: false, error: '', labels: { 'nucleus.mcpBinding': t.runId! } }); return { id, workspaceId: t.workspaceId }; },
    findAgents: async () => { calls.finds++; return []; },
    observe: async id => { calls.observes++; if (observeBehavior) return observeBehavior(id, calls.observes); const state = states.get(id); if (!state) throw new Error('Agent missing'); return state; },
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/51', head, repository: 'example/repo', headRepository: 'example/repo' }),
    findOpenBranchPr: async () => { calls.lookups++; return lookupBehavior(); },
  });
  const engine = new Engine(store, adapter, graceMs); engine.profiles = [worker];
  if (withNotices) states.set('origin', { id: 'origin', workspaceId: 'origin-ws', status: 'idle', active: false, permissions: false, error: '' });
  const working = (changes: Partial<Task> = {}, bindingRunId?: string, status = 'idle', error = '') => {
    const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'docs/handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
    const runId = `run-${submitted.id.slice(0, 8)}`, agentId = `agent-${runId}`;
    states.set(agentId, { id: agentId, workspaceId: 'workspace', status, active: false, permissions: false, error, labels: { 'nucleus.mcpBinding': bindingRunId ?? runId } });
    return store.update(submitted.id, { phase: 'working', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree', agentId, runId,
      profile: worker, profileGroup: 'author', workerModel: worker.model, agentActive: false, lastAgentStatus: 'idle', lastObservedAt: new Date().toISOString(), ...changes });
  };
  const events = (id: string, kind: string) => store.eventsAll(id).filter(event => event.kind === kind);
  return { store, engine, states, calls, notifications, working, events,
    setLookup: (fn: () => Promise<BranchPr[]>) => { lookupBehavior = fn; },
    setObserve: (fn: (id: string, call: number) => Promise<AgentObservation>) => { observeBehavior = fn; },
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

for (const failure of ['Provider timeout after 5000ms', 'PR lookup refused: forbidden', 'Paseo unavailable: connection reset']) {
  test(`rule 5: a ${failure.split(':')[0].toLowerCase()} read is unverified, never absence`, async () => {
    const f = fixture(); try {
      // Matched binding, closed thread: the branch-PR decision point is reached
      // and the live read itself fails. A closed thread never arms the errored
      // worker's same-thread continuation (PR 858), so the read is first.
      const task = f.working({}, undefined, 'closed');
      f.setLookup(async () => { throw new Error(failure); });
      await f.engine.wake();
      const current = f.store.task(task.id);
      assert.equal(f.calls.lookups, 1, 'the live read is attempted once');
      assert.equal(f.events(task.id, 'initial_pr_lookup_unverified').length, 1, 'the failure is recorded as unverified');
      assert.match(f.events(task.id, 'initial_pr_lookup_unverified')[0].detail, /unverified, not absent/);
      // While PR existence is unverified the lane holds for the retry: the
      // worker's own error does not escalate and no absence is claimed.
      assert.doesNotMatch(current.reason, /worker boom/);
      assert.equal(current.phase, 'working');
      assert.equal(current.resolution.attention, false, 'no escalation from the unverified read');
      assert.equal(f.store.runs(task.id).filter(run => run.role === 'recovery').length, 0, 'no coordinator is spent');
      assert.equal(liveEvidenceEpisode(f.store, task.id, 'branch-pr')?.noticed, false);
    } finally { await f.close(); }
  });
}

test('rule 5: a lookup failure inside the grace is not repeated and never becomes absence', async () => {
  const f = fixture(); try {
    const task = f.working({}, undefined, 'error', 'worker boom');
    f.store.update(task.id, { prLookup: { attempts: 1, lastAt: new Date().toISOString(), outcome: 'empty' } });
    f.setLookup(async () => { throw new Error('must not be called inside the grace'); });
    await f.engine.wake();
    assert.equal(f.calls.lookups, 0, 'at most one read per fact per escalation attempt');
    assert.equal(f.events(task.id, 'initial_pr_lookup_unverified').length, 0);
    assert.equal(liveEvidenceEpisode(f.store, task.id, 'branch-pr'), null);
  } finally { await f.close(); }
});

test('rule 5: while the branch-PR read is unverified, no mismatch or fault escalates', async () => {
  const f = fixture(); try {
    // Split binding and a lookup that always fails: the next reconciliation
    // inside the grace must hold for the retry rather than escalate the
    // mismatch while PR existence is still unknown.
    const task = f.working({}, 'run-earlier');
    f.setLookup(async () => { throw new Error('Provider timeout after 5000ms'); });
    await f.engine.wake();
    await f.engine.wake();
    const current = f.store.task(task.id);
    assert.equal(f.calls.lookups, 1, 'one read per grace window');
    assert.equal(f.events(task.id, 'initial_pr_lookup_unverified').length, 1);
    assert.equal(f.events(task.id, 'reporting_binding_recheck').length, 0, 'no confirmation spent while PR existence is unverified');
    assert.equal(current.resolution.attention, false, 'the mismatch does not escalate on an unverified projection');
    assert.equal(current.phase, 'working');
    assert.equal(f.events(task.id, 'initial_pr_lookup_unverified_persists').length, 0, 'still inside the grace');
  } finally { await f.close(); }
});

test('rule 5: a persisting failure produces exactly one notice recording the failure', async () => {
  const f = fixture(0, true); try {
    const task = f.working({}, undefined, 'closed');
    f.setLookup(async () => { throw new Error('Provider timeout after 5000ms'); });
    // With no grace the first wake already holds the episode; every later
    // wake must update that episode rather than append a new one.
    await f.engine.wake();
    assert.ok(liveEvidenceEpisode(f.store, task.id, 'branch-pr'), 'the failure is held as unverified');
    await f.engine.wake();
    const escalated = f.store.task(task.id);
    assert.equal(escalated.resolution.attention, true);
    assert.equal(escalated.resolution.recovery?.status, 'escalated');
    assert.match(escalated.reason, /unverified/);
    assert.match(escalated.reason, /Provider timeout after 5000ms/);
    assert.match(escalated.reason, /rather than treating the PR as absent/);
    assert.doesNotMatch(escalated.reason, /no open PR|no PR/i);
    await f.engine.wake();
    assert.equal(f.events(task.id, 'initial_pr_lookup_unverified_persists').length, 1, 'at most one notice if it persists');
    assert.equal(f.events(task.id, 'recovery_escalated').length, 1);
    assert.equal(f.store.task(task.id).reason, escalated.reason, 'the escalation is stable');
    assert.equal(f.notifications.length, 1, 'one Chatterbox notice');
    assert.match(f.notifications[0].text, /unverified/);
    assert.equal(f.store.runs(task.id).filter(run => run.role === 'recovery').length, 0, 'no coordinator run is spent');
  } finally { await f.close(); }
});

test('rule 5: a successful retry clears the episode and repairs the lane', async () => {
  const f = fixture(0); try {
    const task = f.working({}, 'run-earlier');
    f.setLookup(async () => { throw new Error('Provider timeout after 5000ms'); });
    await f.engine.wake();
    assert.ok(liveEvidenceEpisode(f.store, task.id, 'branch-pr'), 'the unverified episode is held');
    f.setLookup(async () => [pr(51)]);
    await f.engine.wake();
    const repaired = f.store.task(task.id);
    assert.equal(repaired.phase, 'changes_requested');
    assert.equal(repaired.resumePrNumber, 51);
    assert.equal(liveEvidenceEpisode(f.store, task.id, 'branch-pr'), null, 'a successful read clears the episode');
  } finally { await f.close(); }
});

test('rule 5: an ambiguous match escalates naming its candidates as operational uncertainty', async () => {
  const f = fixture(GRACE, true); try {
    const task = f.working({}, 'run-earlier');
    f.setLookup(async () => [pr(51), pr(52)]);
    await f.engine.wake();
    const current = f.store.task(task.id);
    assert.equal(current.resolution.attention, true);
    assert.equal(current.resolution.recovery?.status, 'escalated');
    assert.match(current.reason, /#51/);
    assert.match(current.reason, /#52/);
    assert.match(current.reason, /https:\/\/github\.com\/example\/repo\/pull\/51/);
    assert.match(current.reason, /operational uncertainty/);
    assert.match(current.reason, /not coordinator judgment/);
    assert.equal(current.resumePrNumber, null, 'no PR is adopted');
    assert.equal(current.prUrl, null);
    assert.equal(f.store.runs(task.id).filter(run => run.role === 'recovery').length, 0, 'no coordinator run is spent');
    await f.engine.wake();
    assert.equal(f.events(task.id, 'recovery_escalated').length, 1, 'one escalation, updated rather than appended');
    assert.equal(f.store.task(task.id).reason, current.reason, 'the escalation survives the next pass');
    assert.equal(f.notifications.length, 1, 'one Chatterbox notice');
  } finally { await f.close(); }
});

test('rule 4 gap: a stale mismatch projection produces no escalation', async () => {
  const f = fixture(); try {
    const task = f.working({}, 'run-earlier');
    // One wake issues four observes: exhaustion scan, audit reconcile,
    // the confirmation re-read, then the task-quantum reconcile. Only the
    // confirmation sees the healed binding.
    f.setObserve(async (id, call) => {
      const state = f.states.get(id)!;
      if (call === 3) return { ...state, labels: { 'nucleus.mcpBinding': task.runId! } };
      return state;
    });
    await f.engine.wake();
    const current = f.store.task(task.id);
    assert.equal(f.events(task.id, 'reporting_binding_recheck').length, 1, 'the binding is re-read live before escalating');
    assert.equal(f.events(task.id, 'reporting_binding_reverified').length, 1);
    assert.equal(current.resolution.attention, false, 'no escalation from a stale projection');
    assert.equal(current.phase, 'working');
    assert.equal(f.calls.lookups, 1, 'the branch-PR read still ran at its own decision point');
  } finally { await f.close(); }
});

test('rule 4 gap: a worker that resumed before the escalation produces no escalation', async () => {
  const f = fixture(); try {
    const task = f.working({}, 'run-earlier');
    f.setObserve(async (id, call) => {
      const state = f.states.get(id)!;
      if (call === 3) return { ...state, active: true, status: 'running' };
      return state;
    });
    await f.engine.wake();
    const current = f.store.task(task.id);
    assert.equal(current.resolution.attention, false, 'a worker that can report is not escalated');
    assert.equal(f.events(task.id, 'reporting_binding_reverified').length, 1);
    assert.equal(f.events(task.id, 'reporting_binding_recheck').length, 1, 'one confirmation read');
  } finally { await f.close(); }
});

test('rule 4 gap: a confirmed split escalates once and spends no second confirmation read', async () => {
  const f = fixture(); try {
    const task = f.working({}, 'run-earlier');
    await f.engine.wake();
    const current = f.store.task(task.id);
    assert.equal(current.resolution.attention, true);
    assert.match(current.reason, /binding names run run-earlier but the task holds/);
    assert.equal(f.events(task.id, 'reporting_binding_recheck').length, 1);
    await f.engine.wake();
    assert.equal(f.events(task.id, 'reporting_binding_recheck').length, 1, 'at most one confirmation read per escalation attempt');
    assert.equal(f.store.task(task.id).reason, current.reason);
  } finally { await f.close(); }
});

test('rule 4 gap: a failed confirmation holds quietly inside the grace', async () => {
  const f = fixture(); try {
    const task = f.working({}, 'run-earlier');
    // Routine observations succeed; only the confirmation re-read fails.
    f.setObserve(async (id, call) => {
      const state = f.states.get(id)!;
      if (call === 3) throw new Error('observe refused: rate limited');
      return state;
    });
    await f.engine.wake();
    assert.equal(f.events(task.id, 'reporting_binding_recheck').length, 1);
    assert.equal(f.events(task.id, 'reporting_binding_unverified').length, 1, 'the failed re-read is unverified');
    assert.equal(f.store.task(task.id).resolution.attention, false, 'quiet inside the grace');
    await f.engine.wake();
    assert.equal(f.events(task.id, 'reporting_binding_recheck').length, 1, 'no second confirmation read inside the grace');
    assert.equal(f.store.task(task.id).resolution.attention, false, 'still quiet; no absence is claimed');
    assert.equal(f.events(task.id, 'reporting_binding_unverified_persists').length, 0);
  } finally { await f.close(); }
});

test('unverified hold transitions: quiet inside the grace, one notice, then settled', async () => {
  const f = fixture(); try {
    const task = f.working();
    const t0 = Date.now();
    assert.equal(recordLiveEvidenceFailure(f.store, task.id, 'branch-pr', new Error('boom'), 1000, t0), 'quiet');
    assert.equal(recordLiveEvidenceFailure(f.store, task.id, 'branch-pr', new Error('other'), 1000, t0 + 999), 'quiet');
    assert.equal(f.events(task.id, 'initial_pr_lookup_unverified').length, 1, 'coalesced per identity');
    assert.equal(liveEvidenceEpisode(f.store, task.id, 'branch-pr')?.error, 'boom', 'the first failure is pinned');
    assert.equal(recordLiveEvidenceFailure(f.store, task.id, 'branch-pr', new Error('boom'), 1000, t0 + 1000), 'notice');
    assert.equal(f.events(task.id, 'initial_pr_lookup_unverified_persists').length, 1, 'at most one notice');
    assert.equal(recordLiveEvidenceFailure(f.store, task.id, 'branch-pr', new Error('boom'), 1000, t0 + 2000), 'noticed');
    assert.equal(f.events(task.id, 'initial_pr_lookup_unverified_persists').length, 1);
    clearLiveEvidence(f.store, task.id, 'branch-pr');
    assert.equal(liveEvidenceEpisode(f.store, task.id, 'branch-pr'), null, 'a successful read clears the episode');
  } finally { await f.close(); }
});

test('budget: the reconcile path reads no fact outside rule 4', async () => {
  const f = fixture(); try {
    const task = f.working({}, 'run-earlier');
    await f.engine.wake();
    await f.engine.wake();
    assert.ok(f.calls.observes > 0, 'the binding fact is read live');
    assert.ok(f.calls.lookups > 0, 'the branch-PR fact is read live');
    assert.equal(f.calls.finds, 0, 'no exact-identity lookup is spent by this path');
    assert.equal(f.store.task(task.id).resolution.attention, true, 'the confirmed split still escalates');
  } finally { await f.close(); }
});

test('capability absent: the unavailability is recorded once and Queue decides from its own knowledge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-live-evidence-')), store = new Store(join(dir, 'queue.sqlite'));
  try {
    store.setMeta('paused', false);
    store.setMeta('pool', [{ profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] }]);
    const states = new Map<string, AgentObservation>();
    const adapter: Adapter = fakeAdapter({
      profiles: async () => [worker], validate: async t => t.planningCommit ?? base,
      createWorkspace: async t => ({ id: `ws-${t.id}`, directory: '/worktree' }),
      verifyWorkspace: async t => t.branch,
      createAgent: async t => ({ id: `agent-${t.runId}`, workspaceId: t.workspaceId }),
      observe: async id => states.get(id)!,
      verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/51', head, repository: 'example/repo', headRepository: 'example/repo' }),
      // No findOpenBranchPr capability.
    });
    const engine = new Engine(store, adapter, GRACE); engine.profiles = [worker];
    const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'docs/handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
    const runId = `run-${submitted.id.slice(0, 8)}`, agentId = `agent-${runId}`;
    states.set(agentId, { id: agentId, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', labels: { 'nucleus.mcpBinding': 'run-earlier' } });
    const task = store.update(submitted.id, { phase: 'working', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree', agentId, runId,
      profile: worker, profileGroup: 'author', workerModel: worker.model, agentActive: false, lastAgentStatus: 'idle', lastObservedAt: new Date().toISOString() });
    await engine.wake();
    const unavailability = store.eventsAll(task.id).filter(event => event.kind === 'initial_pr_lookup_unavailable');
    assert.equal(unavailability.length, 1, 'the unavailable live check is recorded');
    assert.match(store.task(task.id).reason, /binding names run run-earlier/, 'the lane still decides from its own knowledge');
    await engine.wake();
    assert.equal(store.eventsAll(task.id).filter(event => event.kind === 'initial_pr_lookup_unavailable').length, 1, 'recorded once');
    await engine.stop();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
