/**
 * Spec 050 terminal-cleanup observed liveness (papercut b87375b0).
 *
 * End-of-task cleanup and `retry_effect` on a finished task apply the same
 * observed-liveness settlement the owner verbs use (#330): a run whose agent is
 * positively observed idle, with no active turn and no pending permission, is
 * released with its history kept, so a never-reporting run cannot hold a done
 * task's workspace archive. An unobservable agent, a run with no bound agent and
 * a live agent all still fence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { repoCommonDir } from '../core/workspaces/workspace-allocation';
import { Lifecycle } from '../core/closeout/workspace-lifecycle';
import { submissionSchema, runSchema, type Run, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';

const head = 'a'.repeat(40), base = 'b'.repeat(40);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-terminal-cleanup-'));
  const worktree = join(dir, 'worktree');
  mkdirSync(worktree);
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Done task', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
  const task = store.update(submitted.id, {
    phase: 'done', workspaceId: 'ws', directory: worktree, prHead: head, prUrl: 'https://github.com/example/repo/pull/1',
    resolution: { ...submitted.resolution, mergedCommit: head, syncedCommit: head },
  });
  const states = new Map<string, AgentObservation>();
  const observe = (id: string, state: Partial<AgentObservation> = {}) => states.set(id, { id, workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '', ...state });
  const archived: string[] = [];
  const adapter = {
    // Only a registered observation answers; anything else is unobservable.
    observe: async (id: string) => { const state = states.get(id); if (!state) throw new Error('Agent missing'); return state; },
    archiveTaskWorkspace: async (_t: Task, id: string, _dir: string, _head: string, allowed: () => boolean) => { if (!allowed()) return false; archived.push(id); return true; },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  const recoveryRun = (id: string, agentId: string): Run => runSchema.parse({ id, taskId: task.id, role: 'recovery', generation: task.coordinatorGeneration, head, base, agentId, workspaceId: 'ws',
    profile: null, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: null, released: false });
  const events = (kind: string) => store.events(task.id).filter(event => event.kind === kind);
  return { dir, store, engine, task, states, observe, archived, recoveryRun, events, close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const failureRecord = () => ({ workspaceId: 'ws', directory: '/worktree', scope: null, state: 'failed' as const, capturedAt: new Date().toISOString(), provedAt: null, attempts: 1, error: 'runtime retirement failed: teardown reported failure', outputTail: '', nextAttemptAt: null });

test('the next terminal lifecycle sweep abandons an intent run that never launched', async () => {
  const f = fixture();
  try {
    const run = { ...f.recoveryRun('recovery-intent', 'unused'), agentId: null, status: 'intent' as const };
    f.store.putRun(run);
    assert.ok(f.store.lifecycleTasks().some(task => task.id === f.task.id), 'the terminal run intent keeps the task on the lifecycle sweep');
    await new Lifecycle(f.engine).enqueuePass();
    await f.engine.drainCleanup();
    const settled = f.store.run(run.id)!;
    assert.equal(settled.released, true);
    assert.equal(settled.status, 'superseded');
    assert.match(f.events('run_intent_abandoned')[0]!.detail, /Abandoned because task is done; run never launched/);
    assert.deepEqual(f.archived, ['ws'], 'the task archive proceeds after the stale intent settles');
  } finally { await f.close(); }
});

test('end-of-task cleanup releases an idle never-reporting run with history kept and archives the workspace', async () => {
  const f = fixture();
  try {
    const run = f.recoveryRun('recovery-idle', 'coord-idle');
    f.store.putRun(run);
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, recoveryActive: true,
      recovery: { id: 'episode', key: 'k', generation: 1, runId: run.id, agentId: run.agentId, status: 'running', summary: '', idleSince: null, incidentId: null } } });
    f.observe('coord-idle');
    f.engine.enqueueCleanup(f.task.id);
    await f.engine.drainCleanup();
    const released = f.store.run(run.id)!;
    assert.equal(released.released, true, 'the idle never-reporting run released');
    assert.equal(released.status, 'superseded');
    assert.equal(released.completion, null, 'history is kept; no invented completion');
    assert.equal(f.store.task(f.task.id).resolution.recoveryActive, false, 'the episode it owned closes');
    assert.equal(f.events('run_released_from_observed_liveness').length, 1);
    assert.deepEqual(f.archived, ['ws'], 'the workspace archive then proceeds');
  } finally { await f.close(); }
});

test('end-of-task cleanup never settles a live or unobservable run', async () => {
  const f = fixture();
  try {
    const live = f.recoveryRun('recovery-live', 'coord-live');
    const unknown = f.recoveryRun('recovery-unknown', 'coord-unknown');
    f.store.putRun(live); f.store.putRun(unknown);
    f.observe('coord-live', { status: 'running', active: true });
    // coord-unknown is intentionally never registered: observe() throws.
    f.engine.enqueueCleanup(f.task.id);
    await f.engine.drainCleanup();
    assert.equal(f.store.run(live.id)!.released, false, 'a live agent still fences');
    assert.equal(f.store.run(unknown.id)!.released, false, 'an unobservable agent is never proof of death');
    assert.deepEqual(f.archived, [], 'the archive waits for the fencing runs');
  } finally { await f.close(); }
});

test('retry_effect on a finished task settles an idle never-reporting run before applying the effect', async () => {
  const f = fixture();
  try {
    const run = f.recoveryRun('recovery-retry', 'coord-retry');
    f.store.putRun(run);
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, recoveryActive: true,
      recovery: { id: 'episode', key: 'k', generation: 1, runId: run.id, agentId: run.agentId, status: 'running', summary: '', idleSince: null, incidentId: null },
      runtimeRetirements: [failureRecord()] } });
    f.observe('coord-retry');
    const task = await f.engine.performTaskControl({ taskId: f.task.id, version: f.store.task(f.task.id).version, action: 'retry_effect',
      effect: 'runtime_retirement.ws', reason: 'Retry the recorded cleanup' } as never);
    assert.equal(f.store.run(run.id)!.released, true, 'the idle never-reporting run released before the retry');
    assert.equal(f.store.run(run.id)!.status, 'superseded');
    assert.equal(f.events('run_released_from_observed_liveness').length, 1);
    assert.deepEqual(f.archived, ['ws'], 'the retried cleanup then archives');
    assert.equal(task.phase, 'done');
  } finally { await f.close(); }
});

/** The live #670 shape: the episode still reads active after its recovery run was superseded and released. */
function activeEpisodeOnReleasedRun(f: ReturnType<typeof fixture>, run: Run) {
  f.engine.resolution.recordStop(f.store.task(f.task.id), 'operator_needed', 'Recovery needs an operator', ['restart', 'route', 'move']);
  const at = new Date().toISOString();
  f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, recoveryActive: true,
    recovery: { id: 'episode', key: 'k', generation: 1, runId: run.id, agentId: run.agentId, status: 'running', summary: '', idleSince: null, incidentId: 'incident-episode' },
    incident: { id: 'incident-episode', role: 'recovery', runId: run.id, fingerprint: 'incident-episode', attempt: 1, cause: 'coordinator_missing', detail: 'Coordinator stalled', action: '', status: 'reconciling', createdAt: at, updatedAt: at } } });
}

test('a done task whose recovery run is already released closes its active episode and archives', async () => {
  const f = fixture();
  try {
    const run = { ...f.recoveryRun('recovery-released', 'coord-released'), status: 'superseded' as const, released: true };
    f.store.putRun(run);
    activeEpisodeOnReleasedRun(f, run);
    f.engine.enqueueCleanup(f.task.id);
    await f.engine.drainCleanup();
    const settled = f.store.task(f.task.id);
    assert.equal(settled.resolution.recoveryActive, false, 'the episode no longer reads active');
    assert.equal(settled.resolution.recovery?.status, 'resolved', 'the episode record resolves');
    assert.equal(settled.resolution.incident?.status, 'resolved', 'the incident settles with the episode');
    assert.equal(settled.resolution.stop, null, 'the done task no longer reads as an open operator_needed');
    assert.equal(f.events('recovery_episode_settled').length, 1, 'the settle is recorded as an event');
    assert.equal(f.store.run(run.id)!.released, true, 'the released run keeps its released record');
    assert.deepEqual(f.archived, ['ws'], 'the workspace archive proceeds on the same pass');
  } finally { await f.close(); }
});

test('a done task with a live unreleased recovery run keeps its episode and waits', async () => {
  const f = fixture();
  try {
    const run = f.recoveryRun('recovery-live-final', 'coord-live-final');
    f.store.putRun(run);
    activeEpisodeOnReleasedRun(f, run);
    f.observe('coord-live-final', { status: 'running', active: true });
    f.engine.enqueueCleanup(f.task.id);
    await f.engine.drainCleanup();
    const held = f.store.task(f.task.id);
    assert.equal(f.store.run(run.id)!.released, false, 'a live recovery run is not settled');
    assert.equal(held.resolution.recoveryActive, true, 'the episode stays active while its run is live');
    assert.equal(held.resolution.incident?.status, 'reconciling', 'the incident is not settled while its run is live');
    assert.equal(f.events('recovery_episode_settled').length, 0);
    assert.deepEqual(f.archived, [], 'the archive waits for the live recovery run');
  } finally { await f.close(); }
});

test('releasing an observed-idle recovery run on a done task settles its incident and stop with the episode', async () => {
  const f = fixture();
  try {
    const run = f.recoveryRun('recovery-idle-stop', 'coord-idle-stop');
    f.store.putRun(run);
    activeEpisodeOnReleasedRun(f, { ...run, status: 'running', released: false });
    f.observe('coord-idle-stop');
    f.engine.enqueueCleanup(f.task.id);
    await f.engine.drainCleanup();
    const settled = f.store.task(f.task.id);
    assert.equal(f.store.run(run.id)!.released, true, 'the never-reporting run released');
    assert.equal(settled.resolution.recoveryActive, false, 'the episode no longer reads active');
    assert.equal(settled.resolution.recovery?.status, 'resolved', 'the episode record resolves');
    assert.equal(settled.resolution.incident?.status, 'resolved', 'the incident settles with the released run');
    assert.equal(settled.resolution.stop, null, 'the done task no longer reads as an open operator_needed');
    assert.deepEqual(f.archived, ['ws'], 'the workspace archive proceeds on the same pass');
  } finally { await f.close(); }
});

test('releasing a recovery run that recorded an escalation on a done task settles its incident and stop', async () => {
  const f = fixture();
  try {
    const run = f.recoveryRun('recovery-escalated-stop', 'coord-escalated-stop');
    const completed = runSchema.parse({ ...run, status: 'finished', completion: { eventId: 'escalated-stop-event', taskId: f.task.id, runId: run.id,
      status: 'escalate', summary: 'Needs an operator', coordinatorGeneration: 1 } });
    f.store.putRun(completed);
    activeEpisodeOnReleasedRun(f, { ...completed, released: false });
    f.observe('coord-escalated-stop');
    f.engine.enqueueCleanup(f.task.id);
    await f.engine.drainCleanup();
    const settled = f.store.task(f.task.id);
    assert.equal(f.store.run(run.id)!.released, true, 'the recorded escalation released its run');
    assert.equal(settled.resolution.recoveryActive, false, 'the episode no longer reads active');
    assert.equal(settled.resolution.incident?.status, 'resolved', 'the incident settles with the released run');
    assert.equal(settled.resolution.stop, null, 'the done task no longer reads as an open operator_needed');
  } finally { await f.close(); }
});

test('a cancelled task closes its stale recovery episode on the lifecycle sweep', async () => {
  const f = fixture();
  try {
    f.store.update(f.task.id, { phase: 'cancelled' });
    const run = { ...f.recoveryRun('recovery-cancelled', 'coord-cancelled'), status: 'superseded' as const, released: true };
    f.store.putRun(run);
    activeEpisodeOnReleasedRun(f, run);
    await new Lifecycle(f.engine).enqueuePass();
    await f.engine.drainCleanup();
    const settled = f.store.task(f.task.id);
    assert.equal(settled.resolution.recoveryActive, false, 'the cancelled task no longer reads an active episode');
    assert.equal(settled.resolution.recovery?.status, 'resolved');
    assert.equal(settled.resolution.incident?.status, 'resolved');
    assert.equal(settled.resolution.stop, null);
    assert.equal(f.events('recovery_episode_settled').length, 1);
    assert.deepEqual(f.archived, [], 'a cancelled task still archives through its disposition, not this pass');
  } finally { await f.close(); }
});

test('a done task with no recorded merge closes its stale recovery episode before the merge guard', async () => {
  const f = fixture();
  try {
    const current = f.store.task(f.task.id);
    f.store.update(f.task.id, { resolution: { ...current.resolution, mergedCommit: null, syncedCommit: null } });
    const run = { ...f.recoveryRun('recovery-unmerged', 'coord-unmerged'), status: 'superseded' as const, released: true };
    f.store.putRun(run);
    activeEpisodeOnReleasedRun(f, run);
    f.engine.enqueueCleanup(f.task.id);
    await f.engine.drainCleanup();
    assert.equal(f.store.task(f.task.id).resolution.recoveryActive, false, 'the episode closes even though the merge guard refuses the archive');
    assert.equal(f.events('recovery_episode_settled').length, 1);
    assert.deepEqual(f.archived, [], 'the merge guard still refuses the archive');
  } finally { await f.close(); }
});

test('a finished task keeps cleanup faults without reopening attention', async () => {
  const f = fixture();
  try {
    f.engine.adapter.archiveTaskWorkspace = async () => { throw Error('Recorded workspace directory is not a Queue allocation'); };
    f.engine.enqueueCleanup(f.task.id);
    await f.engine.drainCleanup();
    assert.equal(f.store.task(f.task.id).phase, 'done');
    assert.match(f.store.task(f.task.id).resolution.cleanupReason, /not a Queue allocation/);
  } finally { await f.close(); }
});

test('a workspace identity read failure waits instead of stopping an active task', async () => {
  const f = fixture();
  try {
    f.store.update(f.task.id, { phase: 'working' });
    let failure: unknown;
    try { await repoCommonDir(join(f.dir, 'unreadable-repository')); } catch (error) { failure = error; }
    assert.ok(failure);
    (f.engine as any).noteStepFailure(f.task.id, failure);
    assert.equal(f.store.task(f.task.id).phase, 'working');
    assert.equal(f.store.task(f.task.id).resolution.stop?.reason, 'external_unavailable');
  } finally { await f.close(); }
});

test('a late cleanup lane failure after closed_out cannot reopen a finished task', async () => {
  const f = fixture();
  try {
    f.store.event(f.task.id, 'closed_out', 'Merged task finished before cleanup');
    (f.engine as any).noteStepFailure(f.task.id, Error('Recorded workspace directory is not a Queue allocation'));
    assert.equal(f.store.task(f.task.id).phase, 'done');
    assert.match(f.store.task(f.task.id).resolution.cleanupReason, /not a Queue allocation/);
  } finally { await f.close(); }
});
