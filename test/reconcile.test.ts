import { fakeAdapter, profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, digest } from '../core/store/store';
import { Engine, INTERACTIVE_RUNNING_REASON, INTERACTIVE_WAIT_REASON } from '../core/engine';
import { createTaskDetailCache } from '../core/telemetry/task-detail';
import { submissionSchema, type Completion, type Profile, type Run } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { deriveTaskTelemetry, telemetrySnapshot } from '../core/telemetry/telemetry';
import { REPOSITORY_CONTENTION_GRACE_MS } from '../core/scheduling/repository-contention';
import { stepEngine } from './support/engine-step';
import { taskStopRecord } from '../shared/task-stop';

const head = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);


type Found = { id: string; workspaceId: string | null };

function fixture(graceMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-reconcile-')), store = new Store(join(dir, 'queue.sqlite'));
  const worker = profile('author'), reviewer = profile('reviewer'), coordinator = profile('coordinator');
  store.setMeta('paused', false);
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewer.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
    { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] },
  ]);
  const states = new Map<string, AgentObservation>();
  const idle = (id: string, workspaceId = 'workspace') => states.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '' });
  idle('worker');
  const tokens = new Map<string, string>(), creates: Run[] = [], sends: Run[] = [], reminders: string[] = [];
  const foundAgents = new Map<string, Found[]>();
  let reviewChecks = 0, currentHead = head;
  // Reconciliation scenarios use the default responsible lifecycle.
  const add = (changes: Record<string, unknown> = {}, submission: Record<string, unknown> = {}) => {
    const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin', ...submission }), 'host', 'handoff', base);
    return store.update(submitted.id, { phase: 'working', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree', agentId: 'worker', runId: `run-${submitted.id.slice(0, 8)}`, profile: worker, workerModel: worker.model, prHead: head, prUrl: 'https://github.com/example/repo/pull/1', agentActive: false, lastAgentStatus: 'idle', lastObservedAt: new Date().toISOString(), ...changes });
  };
  const task = add();
  const adapter: Adapter & ResolutionAdapter = fakeAdapter({
    profiles: async () => [worker, reviewer, coordinator], validate: async () => base, verifyWorkspace: async t => t.branch, verifyResume: async () => {},
    createWorkspace: async () => { throw new Error('fixtures do not create workspaces') }, verifyCleanQueueWorktree: async () => {},
    createAgent: async (t, token) => { tokens.set(t.runId!, token); const id = `agent-${t.runId}`; idle(id); return { id, workspaceId: t.workspaceId }; },
    findAgents: async t => foundAgents.get(t.runId!) ?? [],
    observe: async id => { const s = states.get(id); if (!s) throw new Error('Agent missing'); return s },
    verifyPr: async () => ({ head: currentHead, url: 'https://github.com/example/repo/pull/1', repository: 'example/repo', headRepository: 'example/repo' }), verifyPrIdentity: async () => ({ head: currentHead, url: 'https://github.com/example/repo/pull/1', repository: 'example/repo', headRepository: 'example/repo' }),
    createRun: async (t, r, token) => { creates.push(r); tokens.set(r.id, token); const id = `agent-${r.id}`; states.set(id, { id, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' }); return { id, workspaceId: r.workspaceId }; },
    sendRun: async (t, r, token) => { sends.push(r); tokens.set(r.id, token); states.set(r.agentId!, { ...states.get(r.agentId!)!, active: true, status: 'running' }) },
    findRunAgents: async r => foundAgents.get(r.id) ?? [],
    verifyReview: async (t, r, c) => { reviewChecks++; if (c.head !== currentHead) throw new Error('Stale PR head') },
    mergeGate: async () => ({ head: currentHead, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: true, commit: merged, head: currentHead, base: 'main' }), syncMain: async () => merged, verifyCloseout: async () => {}, notify: async (id, key) => { reminders.push(`${id}:${key}`); },
  });
  const engine = new Engine(store, adapter, graceMs); engine.profiles = [worker, reviewer, coordinator];
  const current = () => store.task(task.id);
  const run = () => store.run(current().resolution.currentRunId!)!;
  const events = (kind: string) => store.events(task.id).filter(e => e.kind === kind);
  async function report(status: Completion['status'], prNumber = 1, drain = true) {
    const r = run(); idle(r.agentId!, r.workspaceId);
    // Spec 044 (commit 9e2fcea3, 2026-10-06): a reviewer that returns an unresolved
    // outcome names who owns it. `changes_required` is an author defect, so the
    // fixture names the author rather than reporting a bare verdict.
    const input: Completion = { eventId: randomUUID(), taskId: task.id, runId: r.id, status, summary: status, head: r.head, ...(r.role === 'reviewer' ? { reviewCommentId: 1 } : {}), ...(r.role === 'reviewer' && status === 'changes_required' ? { reviewResponsibility: 'author' as const } : {}), ...(r.role === 'closeout' ? { coordinatorGeneration: r.generation } : {}), ...(r.role === 'revision' ? { prNumber } : {}) };
    engine.resolution.complete(input, tokens.get(r.id)!); await (drain ? engine.wake() : stepEngine(engine)); return input;
  }
  /** Plant the task at awaiting_review with an accepted worker completion so review flow tests start there. */
  const plantReview = (changes: Record<string, unknown> = {}) => {
    const t = store.task(task.id);
    return store.update(t.id, { phase: 'awaiting_review', lastObservedAt: new Date().toISOString(), completion: { taskId: t.id, runId: t.runId!, eventId: `initial-${t.id}`, status: 'ready_for_review', summary: 'Ready', prNumber: 1 }, ...changes });
  };
  return { store, engine, adapter, task, add, plantReview, current, run, report, states, idle, tokens, creates, sends, reminders, foundAgents, events, counts: () => ({ reviewChecks }), setHead: (h: string) => { currentHead = h; }, close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }) } };
}

function enableRecovery(f: ReturnType<typeof fixture>) {
  (f.adapter as { supportsCoordinatorRecovery?: boolean }).supportsCoordinatorRecovery = true;
  return f.reminders;
}


test('a successful worktree scan clears its temporary reason on a blocked worker task', async () => {
  const f = fixture(); try {
    const summary = 'Blocked: source gates remain unresolved';
    f.store.update(f.task.id, {
      phase: 'blocked', reason: summary,
      completion: { eventId: 'blocked-result', taskId: f.task.id, runId: f.current().runId!, status: 'blocked', summary },
    });
    let scans = 0;
    f.engine.resolution.worktreeValidationProbe = () => {
      scans++;
      return unverifiedWorktreeQa;
    };
    assert.equal(await f.engine.resolution.heavyRunAlive(f.current()), true);
    assert.match(f.current().reason, /unverified/);

    f.engine.resolution.worktreeValidationProbe = () => {
      scans++;
      return liveWorktreeQa;
    };
    assert.equal(await f.engine.resolution.heavyRunAlive(f.current()), true);
    // #993: a parked report reads as waiting for its classification, not as an operator question.
    assert.equal(f.current().reason, `Waiting for blocked-report classification: ${summary}`);
    assert.equal(f.current().resolution.stop?.reason, 'lifecycle');
    assert.equal(scans, 2, 'each observation pass re-runs the worktree scan');
  } finally { await f.close(); }
});
test('observation timestamps do not bump task versions, while observed state changes do', async () => {
  const f = fixture(); try {
    const initial = f.current();
    const observed = f.store.update(f.task.id, { lastObservedAt: new Date(Date.now() + 1000).toISOString() });
    assert.equal(observed.version, initial.version);

    const changed = f.store.update(f.task.id, {
      lastObservedAt: new Date(Date.now() + 2000).toISOString(), agentActive: true,
    });
    assert.equal(changed.version, initial.version + 1);
    assert.equal(changed.lastSubstantiveVersion, initial.lastSubstantiveVersion);

    const repeated = f.store.update(f.task.id, {
      lastObservedAt: new Date(Date.now() + 3000).toISOString(), agentActive: true,
    });
    assert.equal(repeated.version, changed.version, 'the same observed state does not churn the task version');
  } finally { await f.close(); }
});

test('a no-verb wait on progressing work is left to its producer and starts no recovery', async () => {
  // Recovery's own predicate would read each wait as gone; the loop that
  // recorded it owns the clear, so recovery must not clear and re-record it.
  for (const [reason, detail] of [['workspace_unavailable', 'The task workspace is unavailable'],
    ['provider_unavailable', 'Reviewer run r provider refusal is unverified: timeline incomplete'],
    ['route_unavailable', 'No eligible independent reviewer profile; check the profile pool']] as const) {
    const f = fixture(); try {
      enableRecovery(f);
      const stop = taskStopRecord(reason, detail, null, new Date().toISOString(), []);
      f.store.update(f.task.id, { phase: 'working', workspaceId: 'workspace', reason: detail, resolution: { ...f.current().resolution, stop } });
      assert.equal(await f.engine.resolution.recovery.route(f.current()), null, reason);
      assert.deepEqual(f.current().resolution.stop, stop, `${reason}: the wait stays`);
      assert.equal(f.current().resolution.recovery, null, `${reason}: no episode`);
      assert.equal(f.events('task_wait_cleared').length, 0, reason);
      assert.equal(f.events('telemetry_recovery').length, 0, reason);
    } finally { await f.close(); }
  }
});

test('exhaustion failover owns its provider wait: recovery neither clears it nor starts a coordinator', async () => {
  const f = fixture(); try {
    enableRecovery(f);
    // The assigned group reads available, so recovery's own check would clear
    // the wait and launch a coordinator the next sweep re-stops (5b028195).
    const stop = taskStopRecord('provider_unavailable', 'Provider exhausted; no eligible replacement until an unavailable subscription group resets', null, new Date().toISOString(), []);
    f.store.update(f.task.id, { phase: 'needs_attention', failoverReason: 'usage limit reached', reason: stop.detail, resolution: { ...f.current().resolution, attention: true, stop } });
    for (let pass = 0; pass < 3; pass++) assert.equal(await f.engine.resolution.recovery.route(f.current()), null);
    assert.deepEqual(f.current().resolution.stop, stop);
    assert.equal(f.events('task_wait_cleared').length, 0);
    assert.equal(f.events('telemetry_recovery').length, 0);
  } finally { await f.close(); }
});

test("an attention task's report text is never read as a wait", async () => {
  const f = fixture(); try {
    enableRecovery(f);
    // A worker report that happens to say "no eligible ... profile" once
    // classified as route_unavailable, which recovery then cleared every sweep.
    const report = 'Pushed the fix. Live proof stopped: no eligible profile is available on the bench host.';
    f.store.update(f.task.id, { phase: 'changes_requested', reason: report, resolution: { ...f.current().resolution, attention: true, stop: null } });
    await stepEngine(f.engine);
    assert.equal(f.current().resolution.stop?.reason, 'operator_needed');
    await stepEngine(f.engine);
    assert.equal(f.events('task_wait_cleared').length, 0, 'no clear-and-rerecord loop');
  } finally { await f.close(); }
});

test('a new recovery episode is keyed by the stop it answers, so a coordinator action can match it', async () => {
  const f = fixture(); try {
    enableRecovery(f);
    // The wait no longer holds but the task still needs attention: the cleared
    // wait is replaced by an operator_needed stop and the episode keys on it.
    const stale = taskStopRecord('workspace_unavailable', 'The task workspace is unavailable');
    f.store.update(f.task.id, { phase: 'needs_attention', workspaceId: 'workspace', reason: stale.detail, resolution: { ...f.current().resolution, attention: true, stop: stale } });
    await f.engine.resolution.recovery.route(f.current());
    const { stop, recovery } = f.current().resolution;
    assert.equal(stop?.reason, 'operator_needed');
    assert.ok(recovery, 'an episode is opened');
    assert.equal(recovery!.key, digest(`stop:${stop!.reason}:${stop!.since}`), 'the episode key matches the stop the coordinator answers');
    // A second pass sees a stop with verbs: no clear-and-rerecord oscillation.
    const version = f.current().version;
    await f.engine.resolution.recovery.route(f.current());
    assert.equal(f.store.events(f.task.id).filter(event => event.kind === 'task_wait_cleared').length, 1);
    assert.ok(f.current().version >= version);
  } finally { await f.close(); }
});


test('a newer reviewer block after move to review keeps the coordinator path, not the stale author block', async () => {
  const f = fixture(); try {
    enableRecovery(f);
    const t = f.current();
    // The author blocked first; the owner moved the task to review; the new reviewer then blocked.
    f.store.update(t.id, { completion: { eventId: 'author-block', taskId: t.id, runId: t.runId!, status: 'blocked', summary: 'Author needs the scope decision' } });
    f.store.event(t.id, 'completion_received', 'Author needs the scope decision');
    f.store.putRun({ id: 'new-review', taskId: t.id, role: 'reviewer', generation: 1, head: 'a'.repeat(40), base: 'main',
      agentId: 'reviewer-agent', workspaceId: 'workspace', profile: t.profile, status: 'finished',
      createdAt: new Date(Date.now() + 60_000).toISOString(), lastObservedAt: null, active: false, idleSince: null, released: true,
      completion: { eventId: 'review-block', taskId: t.id, runId: 'new-review', status: 'blocked', summary: 'Reviewer cannot reach the fixture' } as never });
    f.store.update(t.id, { phase: 'blocked', reason: 'Reviewer cannot reach the fixture' });
    await f.engine.resolution.recovery.route(f.current());
    assert.doesNotMatch(f.current().resolution.recovery?.summary ?? '', /needs an owner decision/, 'the stale author block is not escalated');
  } finally { await f.close(); }
});

function seedRevision(f: ReturnType<typeof fixture>, summary: string) {
  const t = f.current();
  f.store.putRun({
    id: 'revision-b', taskId: t.id, role: 'revision', generation: 1, head: t.prHead ?? 'a'.repeat(40), base: 'main',
    agentId: 'agent-closed', workspaceId: 'workspace', profile: t.profile, status: 'running', createdAt: new Date(Date.now() + 1000).toISOString(),
    lastObservedAt: null, active: false, idleSince: null, released: true,
    completion: { eventId: 'rev-b', taskId: t.id, runId: 'revision-b', status: 'blocked', summary },
  });
}


test('incident cause follows the latest accepted result, never missing_callback', async () => {
  const f = fixture(); try {
    f.store.update(f.task.id, { phase: 'blocked' });
    seedRevision(f, 'Blocked B: revision report');
    const incident = f.engine.resolution.ensureIncident(f.current(), null, 'Worker stopped without a completion callback; inspect the thread');
    assert.equal(incident.cause, 'worker_blocked');
    await f.engine.resolution.remindStoppedWorker(f.current());
    assert.equal(f.events('callback_reminder').length, 0, 'no callback reminder once a result is accepted');
  } finally { await f.close(); }
});

test('an accepted revision result from the retained worker reconciles the initial missing result', async () => {
  const f = fixture(); try {
    const runId = f.current().runId!;
    f.store.update(f.task.id, { idleSince: new Date(Date.now() - 100_000).toISOString() });
    await f.engine.resolution.remindStoppedWorker(f.current());
    assert.equal(f.events('callback_reminder').length, 1);
    assert.equal(f.current().resolution.incident?.runId, runId);
    assert.equal(createTaskDetailCache(f.store)(f.task.id).missingResult?.runId, runId);
    // The resumed revision run on the retained worker delivers its accepted blocked result.
    const revId = 'revision-supersede';
    f.store.putRun({
      id: revId, taskId: f.task.id, role: 'revision', generation: 1, head, base: 'main',
      agentId: 'worker', workspaceId: 'workspace', profile: null, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: false,
    });
    f.store.update(f.task.id, { resolution: { ...f.current().resolution, currentRunId: revId } });
    f.store.setCredential(revId, 'rev-token');
    f.engine.resolution.complete({ eventId: randomUUID(), taskId: f.task.id, runId: revId, status: 'blocked', summary: 'Blocked B: revision report' }, 'rev-token');
    // The superseded initial run reconciles: no missing result, no further reminder, no escalation.
    assert.equal(f.current().resolution.incident?.status, 'resolved');
    assert.match(f.current().resolution.incident?.detail ?? '', /Superseded by the accepted revision result/);
    assert.equal(createTaskDetailCache(f.store)(f.task.id).missingResult, null);
    await f.engine.resolution.remindStoppedWorker(f.current());
    assert.equal(f.events('callback_reminder').length, 1, 'no second reminder for the superseded run');
  } finally { await f.close(); }
});

test('idle reason names the latest revision result, not the original worker', async () => {
  const f = fixture(); try {
    seedRevision(f, 'Blocked B: revision report');
    await f.engine.scheduleTaskQuantum(f.task.id);
    assert.ok(f.current().idleSince);
    assert.equal(f.current().reason, 'Blocked B: revision report');
  } finally { await f.close(); }
});

test('an idle worker without a completion still gets the completion delivery grace note', async () => {
  const f = fixture(); try {
    await f.engine.scheduleTaskQuantum(f.task.id);
    assert.ok(f.current().idleSince, 'the first idle observation records grace');
    assert.equal(f.current().reason, 'Worker idle; allowing time for completion delivery');
  } finally { await f.close(); }
});

test('repository checkout contention waits in place and only one task escalates after grace', async () => {
  const f = fixture(); try {
    enableRecovery(f);
    const reason = 'Integration checkout is dirty; preserve it and resolve before dispatch';
    const sibling = f.add();
    f.engine.note(f.task.id, reason, 'classify', 'needs_attention');
    f.engine.note(sibling.id, reason, 'classify', 'needs_attention');
    assert.equal(f.current().phase, 'working');
    assert.equal(f.store.task(sibling.id).phase, 'working');
    assert.equal(f.current().resolution.incident, null);
    assert.equal(f.store.task(sibling.id).resolution.incident, null);

    const metaKey = `repositoryContention:${digest('/repo')}`;
    const episode = f.store.getMeta<{ taskId: string; since: string; reason: string }>(metaKey)!;
    f.store.setMeta(metaKey, { ...episode, since: new Date(Date.now() - REPOSITORY_CONTENTION_GRACE_MS - 1).toISOString() });
    f.engine.note(f.task.id, reason, 'classify', 'needs_attention');
    f.engine.note(sibling.id, reason, 'classify', 'needs_attention');
    assert.equal(f.current().phase, 'needs_attention');
    assert.equal(f.store.task(sibling.id).phase, 'working', 'a sibling never creates a second attention episode');
  } finally { await f.close(); }
});

test('a proven-absent worker creation is replaced once in the retained workspace without any coordinator', async () => {
  const f = fixture(); try {
    const oldRunId = f.current().runId!;
    f.store.setCredential(oldRunId, 'old-token');
    f.store.update(f.task.id, { agentId: null, prUrl: null, prHead: null });
    await f.engine.wake(); await f.engine.wake();
    const t = f.current();
    // Same role, same retained workspace, one fresh creation: no coordinator, no new workspace.
    // Spec 050 `restart` replays a proven-absent creation under the same run
    // identity (task 323): the launch is retried for the retained run.
    assert.equal(t.workspaceId, 'workspace'); assert.equal(t.agentIntent, true);
    assert.equal(t.runId, oldRunId, 'the proven-absent replacement keeps the retained run identity');
    assert.equal(t.agentId, `agent-${t.runId}`); assert.equal(t.phase, 'working');
    assert.equal(f.store.runs(t.id).length, 0);
    assert.throws(() => f.store.authenticate(oldRunId, 'old-token'), /Unauthorized/);
    assert.ok(f.events('absent_worker_retry').length >= 1);
    assert.equal(t.resolution.incident?.action, 'replacement');
    assert.equal(t.resolution.incident?.role, 'worker');
    assert.equal(t.resolution.incident?.cause, 'uncertain_delivery');
  } finally { await f.close(); }
});

test('a second absent worker creation escalates to the coordinator instead of another launch', async () => {
  const f = fixture(50_000); try {
    enableRecovery(f);
    f.store.update(f.task.id, { agentId: null, prUrl: null, prHead: null });
    let attempts = 0; f.adapter.createAgent = async () => { attempts++; throw new Error('lost response') };
    await f.engine.wake();
    // Age the recorded exact-lookup window so the first absence concludes and the replacement launches.
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, incident: { ...f.store.task(f.task.id).resolution.incident!, createdAt: new Date(Date.now() - 100_000).toISOString() } } });
    await f.engine.wake(); await f.engine.wake(); await f.engine.wake();
    // The replacement launch also failed: age its exact-lookup window so the second absence concludes.
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, incident: { ...f.store.task(f.task.id).resolution.incident!, createdAt: new Date(Date.now() - 100_000).toISOString() } } });
    await f.engine.wake();
    // The first absence was automatically replaced; that replacement also proved absent.
    const t = f.current();
    // The second absence reached coordinator attention without another blind launch.
    assert.equal(t.agentId, null); assert.equal(t.agentIntent, true);
    assert.equal(attempts, 1);
    assert.equal(f.creates.filter(r => r.role === 'recovery').length, 1);
  } finally { await f.close(); }
});

test('a run whose completion is recorded but unreleased is settled by reconciliation', async () => {
  const f = fixture(); try {
    const task = f.current();
    // The shape a transport outage leaves behind: the completion arrived and was consumed,
    // but the release step never ran, so the run still reads running, active and unreleased
    // while its agent is long closed. Every operator route then refuses.
    f.store.putRun({
      id: 'stale-recovery', taskId: task.id, role: 'recovery', generation: task.coordinatorGeneration ?? 1,
      head: task.prHead ?? base, base: 'main', agentId: 'agent-closed', workspaceId: 'workspace', profile: task.profile,
      status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null,
      completion: { eventId: 'late-1', taskId: task.id, runId: 'stale-recovery', status: 'escalate', summary: 'coordinator escalated; the release step was lost' },
      released: false,
    });
    assert.equal(f.store.runs(task.id).some(r => !r.released), true, 'the stale run starts unreleased');

    await f.engine.wake();

    const settled = f.store.run('stale-recovery');
    assert.equal(settled?.released, true, 'a recorded completion releases the run');
    assert.equal(settled?.status, 'finished');
    assert.equal(f.events('run_released_from_recorded_completion').length, 1, 'the release is recorded as its own event');
    assert.equal(f.store.runs(task.id).some(r => !r.released), false, 'no run is left holding the lane');
  } finally { await f.close(); }
});

test('settling an escalated recovery run records the escalation and launches no second coordinator', async () => {
  const f = fixture(); try {
    enableRecovery(f);
    // The live sequence (2026-09-27): Queue sent an attention task to a coordinator, the
    // coordinator escalated a planning decision, and reconciliation released its run. The
    // recovery must then read escalated, or the next pass spends another attempt, and
    // another coordinator, on the same issue.
    for (let i = 0; i < 6 && !f.creates.some(run => run.role === 'recovery'); i++) {
      f.store.update(f.task.id, { phase: 'blocked', reason: 'Worker reported blocked: a planning decision is needed', resolution: { ...f.current().resolution, attention: true } });
      await f.engine.wake();
    }
    const launched = f.creates.find(run => run.role === 'recovery');
    assert.ok(launched, 'the fixture reaches coordinator recovery');
    const stored = f.store.run(launched.id)!;
    f.store.putRun({ ...stored, completion: { eventId: 'esc-1', taskId: f.task.id, runId: launched.id, status: 'escalate', summary: 'A planning decision is needed' } });
    f.states.set(`agent-${launched.id}`, { id: `agent-${launched.id}`, workspaceId: launched.workspaceId, status: 'running', active: true, permissions: false, error: '' });
    // Live, the coordinator agent was still active when its result was recorded, so only
    // reconciliation's settle step released the run.

    await f.engine.wake(); await f.engine.wake(); await f.engine.wake();

    const after = f.current();
    assert.equal(f.store.run(launched.id)?.released, true);
    assert.equal(after.resolution.recovery?.status, 'escalated', 'the escalation is recorded with the release');
    assert.equal(f.creates.filter(run => run.role === 'recovery').length, 1, 'no second coordinator for the same issue');
  } finally { await f.close(); }
});

test('an operator may mint a worker past the automatic budget, and the budget stays at one', async () => {
  const f = fixture(50_000); try {
    enableRecovery(f);
    f.store.update(f.task.id, { agentId: null, prUrl: null, prHead: null });
    let attempts = 0; f.adapter.createAgent = async () => { attempts++; throw new Error('lost response') };
    await f.engine.wake();
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, incident: { ...f.store.task(f.task.id).resolution.incident!, createdAt: new Date(Date.now() - 100_000).toISOString() } } });
    await f.engine.wake(); await f.engine.wake(); await f.engine.wake();
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, incident: { ...f.store.task(f.task.id).resolution.incident!, createdAt: new Date(Date.now() - 100_000).toISOString() } } });
    await f.engine.wake();
    // The state the automatic budget hands back: proven absent twice, escalated, workspace retained.
    const held = f.current();
    assert.equal(held.agentId, null); assert.equal(held.agentIntent, true);
    assert.match(String(held.reason), /replacement worker creation also proved absent/i);
    const automaticRetries = f.events('absent_worker_retry').length;
    assert.equal(automaticRetries, 1, 'the automatic budget is one replacement');
    const workspace = held.workspaceId;

    // The operator route accepts that state and mints one worker in the retained workspace.
    f.adapter.createAgent = async (t, token) => { attempts++; return { id: `agent-${t.runId}`, workspaceId: t.workspaceId }; };
    f.adapter.stopAgentTurn = async () => {};
    const resumed = await f.engine.performTaskControl({ taskId: held.id, version: held.version, action: 'restart', role: 'worker', reason: 'Resume the retained worker', instruction: 'Mint the retained worker and continue the approved dossiers.' });
    assert.equal(resumed.agentId !== null || resumed.phase === 'dispatching' || resumed.phase === 'working', true, `expected a worker to be minted, saw ${resumed.phase}`);
    assert.equal(f.events('absent_worker_operator_replacement').length, 1, 'the operator replacement is recorded distinctly');
    assert.equal(f.events('absent_worker_retry').length, automaticRetries, 'the automatic budget did not move');
    assert.equal(f.current().workspaceId, workspace, 'the retained workspace is reused, not replaced');
  } finally { await f.close(); }
});

test('an exact single worker match binds the creation without a replacement', async () => {
  const f = fixture(); try {
    const runId = f.current().runId!;
    f.store.update(f.task.id, { agentId: null, prUrl: null, prHead: null });
    f.foundAgents.set(runId, [{ id: 'created-worker', workspaceId: 'workspace' }]);
    await f.engine.wake();
    const t = f.current();
    assert.equal(t.agentId, 'created-worker'); assert.equal(t.phase, 'working');
    assert.equal(f.store.runs(t.id).length, 0);
    assert.equal(t.resolution.incident, null);
  } finally { await f.close(); }
});

test('an ambiguous worker lookup creates nothing and reaches the coordinator first', async () => {
  const f = fixture(); try {
    enableRecovery(f);
    const runId = f.current().runId!;
    f.store.update(f.task.id, { agentId: null, prUrl: null, prHead: null });
    f.foundAgents.set(runId, [{ id: 'a', workspaceId: 'workspace' }, { id: 'b', workspaceId: 'workspace' }]);
    await f.engine.wake();
    const t = f.current();
    assert.match(t.reason, /ambiguous/);
    assert.equal(t.agentId, null); assert.equal(t.agentIntent, true); assert.equal(t.runId, runId);
    assert.equal(f.creates.filter(r => r.role === 'recovery').length, 1);
    assert.equal(f.store.runs(t.id).filter(r => r.role === 'recovery').length, 1);
  } finally { await f.close(); }
});

test('a PR identity change racing the worker lookup creates nothing', async () => {
  const f = fixture(); try {
    f.store.update(f.task.id, { agentId: null, prUrl: null, prHead: null });
    f.adapter.findAgents = async t => { f.store.update(t.id, { prHead: 'd'.repeat(40) }); return []; };
    await f.engine.wake(); await f.engine.wake();
    const t = f.current();
    assert.match(t.reason, /Absent worker replacement requires untouched initial dispatch state/);
    assert.equal(t.agentIntent, true); assert.equal(t.agentId, null);
    assert.equal(f.events('absent_worker_retry').length, 0);
  } finally { await f.close(); }
});

test('a proven-absent reviewer creation is replaced without a recovery coordinator while automatic reconciliation owns it', async () => {
  const f = fixture(50_000); try {
    enableRecovery(f);
    f.plantReview();
    let calls = 0; const create = f.adapter.createRun!;
    f.adapter.createRun = async (t, r, token) => { calls++; if (calls === 1) throw new Error('Transport lost'); return create(t, r, token); };
    await f.engine.wake();
    const reviewerRun = f.store.runs(f.task.id).find(r => r.role === 'reviewer')!;
    assert.equal(reviewerRun.agentId, null); assert.equal(reviewerRun.status, 'uncertain');
    f.adapter.createRun = create;
    const pending = f.store.runs(f.task.id).find(r => r.role === 'reviewer')!;
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, incident: { ...f.store.task(f.task.id).resolution.incident!, createdAt: new Date(Date.now() - 100_000).toISOString() } } });
    await f.engine.wake(); await f.engine.wake();
    const replacement = f.run();
    assert.equal(replacement.role, 'reviewer'); assert.notEqual(replacement.id, reviewerRun.id);
    assert.equal(f.store.run(reviewerRun.id)?.status, 'superseded');
    assert.equal(f.store.run(reviewerRun.id)?.released, true);
    assert.equal(f.creates.filter(r => r.role === 'recovery').length, 0);
    assert.equal(f.reminders.filter(r => r.includes('ns-recovery')).length, 0);
  } finally { await f.close(); }
});

test('a review prompt the provider refuses for size settles not-delivered with a receipt, never uncertain', async () => {
  const f = fixture(50_000); try {
    enableRecovery(f);
    f.plantReview();
    f.adapter.createRun = async () => { throw new Error('Input exceeds the maximum length of 1048576 characters'); };
    await f.engine.wake();
    const reviewerRun = f.store.runs(f.task.id).find(r => r.role === 'reviewer')!;
    assert.equal(reviewerRun.status, 'superseded');
    assert.equal(reviewerRun.released, true);
    assert.equal(f.events('review_prompt_refused_before_send').length, 1);
    assert.match(f.current().reason, /refused before send for size/);
    assert.equal(f.events('callback_reminder').length, 0, 'a refusal before send never arms the reminder');
  } finally { await f.close(); }
});

test('the missing-callback reminder never fires for a reviewer whose dispatch never delivered', async () => {
  const f = fixture(50_000); try {
    enableRecovery(f);
    f.plantReview();
    await f.engine.wake();
    const reviewer = f.run(); const agentId = reviewer.agentId!;
    f.idle(agentId, reviewer.workspaceId);
    // A complete page with no dispatch message: delivery provably failed.
    f.adapter.agentTimelinePage = async () => ({ entries: [], hasOlder: false, gap: false });
    await f.engine.resolution.remindStoppedRun(f.current(), reviewer);
    assert.equal(f.reminders.length, 0, 'no reminder to a reviewer that never received the review');
    assert.equal(f.events('callback_reminder').length, 0);
    assert.equal(f.events('callback_reminder_skipped').length, 1);
    assert.match(f.current().reason, /without a delivered dispatch/);
  } finally { await f.close(); }
});

test('the missing-callback reminder still fires when the dispatch is positively in the timeline', async () => {
  const f = fixture(50_000); try {
    enableRecovery(f);
    f.plantReview();
    await f.engine.wake();
    const reviewer = f.run(); const agentId = reviewer.agentId!;
    f.idle(agentId, reviewer.workspaceId);
    f.adapter.agentTimelinePage = async () => ({ entries: [{ timestamp: new Date().toISOString(), turnId: 'turn-1',
      item: { type: 'user_message', messageId: `ns-run-${reviewer.id}` } }], hasOlder: false, gap: false });
    await f.engine.resolution.remindStoppedRun(f.current(), reviewer);
    assert.deepEqual(f.reminders, [`${agentId}:ns-reminder-${reviewer.id}`]);
    assert.equal(f.events('callback_reminder').length, 1);
  } finally { await f.close(); }
});



const liveWorktreeQa = { state: 'alive' as const, command: 'effigy qa:changed', pid: 69306 };
const unverifiedWorktreeQa = { state: 'unverified' as const, reason: 'process listing failed' };

test('a live worktree QA process withholds the missing-callback reminder', async () => {
  const f = fixture(50_000); try {
    enableRecovery(f);
    f.engine.resolution.worktreeValidationProbe = () => liveWorktreeQa;
    await f.engine.wake(); await f.engine.wake(); await f.engine.wake();
    f.idle('worker');
    f.store.update(f.task.id, { idleSince: new Date(Date.now() - 100_000).toISOString() });
    await f.engine.wake();
    assert.equal(f.reminders.filter(r => r.includes('ns-reminder-')).length, 0);
    assert.equal(f.events('callback_reminder').length, 0);
    assert.equal(f.creates.filter(r => r.role === 'recovery').length, 0);
    assert.match(f.current().reason, /still running in the worktree/);
  } finally { await f.close(); }
});


test('an unverified worktree QA scan withholds the missing-callback reminder', async () => {
  const f = fixture(50_000); try {
    enableRecovery(f);
    f.engine.resolution.worktreeValidationProbe = () => unverifiedWorktreeQa;
    await f.engine.wake(); await f.engine.wake(); await f.engine.wake();
    f.idle('worker');
    f.store.update(f.task.id, { idleSince: new Date(Date.now() - 100_000).toISOString() });
    await f.engine.wake();
    assert.equal(f.reminders.filter(r => r.includes('ns-reminder-')).length, 0);
    assert.equal(f.events('callback_reminder').length, 0);
    assert.equal(f.creates.filter(r => r.role === 'recovery').length, 0);
    assert.match(f.current().reason, /unverified/);
    assert.doesNotMatch(f.current().reason, /reminder expired/);
  } finally { await f.close(); }
});


test('a stopped worker receives one callback reminder and a late authenticated result continues the task', async () => {
  const f = fixture(50_000); try {
    await f.engine.wake(); await f.engine.wake(); await f.engine.wake();
    // Worker running: no reminders while active.
    assert.equal(f.reminders.length, 0);
    f.idle('worker');
    f.store.update(f.task.id, { idleSince: new Date(Date.now() - 100_000).toISOString() });
    await f.engine.wake();
    assert.equal(f.reminders.filter(r => r.includes('ns-reminder-')).length, 1);
    const runId = f.current().runId!;
    assert.equal(createTaskDetailCache(f.store)(f.task.id).missingResult?.runId, runId);
    assert.equal(createTaskDetailCache(f.store)(f.task.id).missingResult?.role, 'worker');
    // Late worker callback: accepted from the retained worker, attention cleared, task advances.
    f.store.setCredential(runId, 'worker-token');
    await f.engine.complete({ eventId: 'late-worker', taskId: f.task.id, runId, status: 'ready_for_review', summary: 'Finished late', prNumber: 1 }, 'worker-token');
    await f.engine.wake();
    assert.ok(['awaiting_review','reviewing'].includes(f.current().phase), 'the exact task wake may already have launched independent review');
    assert.equal(f.current().resolution.attention, false);
    assert.equal(f.current().resolution.incident?.status, 'resolved');
  } finally { await f.close(); }
});

test('an interactive task waits on the operator, never reminds or recovers, and reviews once the worker submits', async () => {
  const f = fixture(); try {
    enableRecovery(f);
    f.store.update(f.task.id, { interactive: true, prHead: null, prUrl: null });
    // The worker finished its first tranche and ended its turn without reporting.
    for (let pass = 0; pass < 3; pass++) await f.engine.wake();
    assert.equal(f.current().phase, 'working');
    assert.equal(f.current().resolution.stop?.reason, 'interactive');
    assert.deepEqual(f.current().resolution.stop?.suggestedVerbs, []);
    assert.equal(f.current().reason, INTERACTIVE_WAIT_REASON);
    assert.equal(f.current().idleSince, null, 'no completion-delivery grace runs');
    assert.equal(f.reminders.length, 0, 'no callback reminder');
    assert.equal(f.events('callback_reminder').length, 0);
    assert.equal(f.events('telemetry_recovery').length, 0, 'no coordinator');
    assert.equal(f.current().resolution.incident, null);
    // The operator works with it in the thread.
    f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    await f.engine.wake();
    assert.equal(f.current().reason, INTERACTIVE_RUNNING_REASON);
    assert.equal(f.current().resolution.stop?.reason, 'lifecycle');
    // The operator says submit: the worker opens the PR and reports; ordinary review follows.
    f.idle('worker');
    const runId = f.current().runId!;
    f.store.setCredential(runId, 'worker-token');
    await f.engine.complete({ eventId: 'interactive-submit', taskId: f.task.id, runId, status: 'ready_for_review', summary: 'Submitted after the session', prNumber: 1 }, 'worker-token');
    await f.engine.wake();
    assert.ok(['awaiting_review', 'reviewing'].includes(f.current().phase), f.current().phase);
  } finally { await f.close(); }
});

test('an interactive worker whose thread errors is handled as an ordinary stopped worker', async () => {
  const f = fixture(); try {
    f.store.update(f.task.id, { interactive: true, prHead: null, prUrl: null });
    f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'error', active: false, permissions: false, error: 'Agent crashed' });
    await f.engine.wake();
    assert.notEqual(f.current().resolution.stop?.reason, 'interactive');
  } finally { await f.close(); }
});

test('a cleanly closed initial worker gets one resumable callback reminder before coordinator recovery', async () => {
  const f = fixture(50_000); try {
    enableRecovery(f);
    f.store.update(f.task.id, { prHead: null, prUrl: null });
    f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'closed', active: false, permissions: false, error: '' });
    await f.engine.wake();
    assert.deepEqual(f.reminders, [`worker:ns-reminder-${f.current().runId}`]);
    assert.equal(f.current().resolution.incident?.action, 'callback_reminder');
    assert.equal(f.current().resolution.recovery?.runId ?? null, null);
    assert.doesNotMatch(f.current().reason, /coordinator attention required/);
    await f.engine.wake();
    assert.equal(f.reminders.length, 1);
    assert.equal(f.creates.filter(run => run.role === 'recovery').length, 0);
  } finally { await f.close(); }
});



test('repeated observations update one incident and never append another escalation', async () => {
  const f = fixture(); try {
    enableRecovery(f);
    const runId = f.current().runId!;
    f.store.update(f.task.id, { agentId: null, prUrl: null, prHead: null });
    f.foundAgents.set(runId, [{ id: 'a', workspaceId: 'workspace' }, { id: 'b', workspaceId: 'workspace' }]);
    await f.engine.wake();
    const incidentId = f.current().resolution.incident!.id;
    // Repeated observations of the same fault keep the same incident identity.
    f.engine.resolution.attention(f.current(), 'Worker creation lookup is ambiguous (2 matching agents); no resource was created');
    f.engine.resolution.attention(f.current(), 'Worker creation lookup is ambiguous (2 matching agents); no resource was created');
    assert.equal(f.events('incident').length, 1);
    assert.equal(f.current().resolution.incident!.id, incidentId);
    // Escalating the same incident twice appends exactly one escalation event.
    const before = f.events('recovery_escalated').length;
    f.engine.resolution.recovery.escalate(f.current(), 'Coordinator judgment required');
    f.engine.resolution.recovery.escalate(f.current(), 'Coordinator judgment required with more evidence');
    assert.equal(f.events('recovery_escalated').length - before, 1);
    assert.equal(f.current().resolution.recovery?.status, 'escalated');
    assert.equal(f.current().resolution.incident!.status, 'escalated');
  } finally { await f.close(); }
});

test('an idle worker with unpushed commits gets one push continuation, and a second idle escalates without looping (papercut 8eedf758)', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  // Real shape: a worktree git repo with synthetic ids, not hand-made fields.
  const repo = mkdtempSync(join(tmpdir(), 'ns-push-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'work.txt'), 'unpushed work\n');
  execFileSync('git', ['add', 'work.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'unpushed commit'], { cwd: repo });
  const workHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const f = fixture();
  const continuations: Array<{ taskId: string; intentId: string; text: string }> = [];
  (f.adapter as unknown as Record<string, unknown>).continueWorker = async (task: { id: string }, intentId: string, text: string) => {
    continuations.push({ taskId: task.id, intentId, text });
  };
  try {
    // Unpushed commits on the task branch: PR still at the base, worktree ahead, no report.
    f.store.update(f.task.id, { directory: repo, planningBase: base, prHead: base, idleSince: new Date(Date.now() - 100_000).toISOString() });
    await f.engine.resolution.remindStoppedWorker(f.current());
    assert.equal(continuations.length, 1, 'one push-and-report continuation is sent');
    assert.match(continuations[0]!.text, /Push the branch/);
    assert.match(continuations[0]!.text, new RegExp(workHead.slice(0, 12)));
    assert.ok(f.events('worker_push_continuation').some(event => event.detail.includes(workHead)), 'the continuation is recorded with the worktree head');
    assert.equal(f.events('callback_reminder').length, 0, 'the continuation replaces the ordinary reminder for this shape');
    // A second idle with no new commit does not loop: no second continuation.
    await f.engine.resolution.remindStoppedWorker(f.current());
    assert.equal(continuations.length, 1, 'no second continuation without a new commit');
    assert.ok(f.events('callback_reminder').length >= 1 || f.current().resolution.incident, 'the second idle falls through to the ordinary path');
  } finally { await f.close(); }
});

test('terminal tasks keep telemetry attribution while skipping routine reconciliation', async () => {
  const f = fixture(); try {
    const done = f.add({ phase: 'done', finishedAt: new Date().toISOString(), agentId: null, agentIntent: false, resolution: { mergedCommit: merged, syncedCommit: merged, mechanicalVerification: null, incident: null, revisionRuns: 0 } });
    const events = f.store.eventsAll(done.id);
    const telemetry = deriveTaskTelemetry(f.store.task(done.id), events, [], [], []);
    assert.equal(telemetry.currentStage, 'complete');
    const snapshot = telemetrySnapshot(f.store, { window: 'all' });
    assert.ok(snapshot.groups[0].taskCount >= 2);
  } finally { await f.close(); }
});
