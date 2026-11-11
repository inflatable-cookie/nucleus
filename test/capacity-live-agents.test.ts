import { fakeAdapter } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { occupiesSlot, capacityFor } from '../core/dispatch/capacity';
import { Admission } from '../core/host/admission';
import { submissionSchema, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter } from '../core/host';

/**
 * Spec 058 (task 629; Tom, 2026-11-03): capacity slots count live agents. A
 * task holds a slot only while one of its agents is live or starting; a task
 * with no running agent that is only waiting on hosted checks, the repository
 * integration (merge) turn, a thread release or settlement holds no slot. It
 * keeps its merge order, and when it next needs an agent it requests a slot
 * through the ordinary fair-share order.
 */

const profile: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: ['low'] };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-live-slots-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const calls = { workspaces: 0, agents: 0 };
  const adapter: Adapter = fakeAdapter({
    profiles: async () => [profile], validate: async t => t.planningCommit,
    createWorkspace: async t => { calls.workspaces++; return { id: `ws-${t.id}`, directory: '/fixture' }; },
     verifyWorkspace: async t => t.branch,
    createAgent: async t => { calls.agents++; return { id: `agent-${t.id}`, workspaceId: t.workspaceId }; },
    observe: async id => ({ id, workspaceId: `ws-${id.slice(6)}`, status: 'idle', active: false, permissions: false, error: '' }),
    archiveTaskWorkspace: async () => true,
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/1', head: 'a'.repeat(40) }),
    findOpenBranchPr: async () => [],
  });
  const engine = new Engine(store, adapter, 0); engine.profiles = [profile];
  store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', weight: 1, scopes: ['general'] }]);
  store.setMeta('paused', false);
  const add = (repoPath = '/project-a') =>
    store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath, planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
  const liveWorker = (repoPath: string, phase: Task['phase'] = 'working') => {
    const task = add(repoPath);
    return store.update(task.id, { phase, workspaceIntent: true, workspaceId: `ws-${task.id}`, directory: '/fixture',
      agentIntent: true, agentId: `agent-${task.id}`, runId: `run-${task.id}`, profile, profileGroup: 'test', agentActive: true });
  };
  return { dir, store, calls, engine, add, liveWorker,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const liveRun = (taskId: string, id: string, patch: Partial<Run> = {}): Run => ({ id, taskId, role: 'reviewer', generation: 1,
  head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: `agent-${id}`, workspaceId: 'workspace', profile: null,
  status: 'running', createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), active: true,
  idleSince: null, completion: null, released: false, ...patch });

test('a task waiting on hosted checks holds no slot; the freed slot goes to the next request', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1);
    const worker = f.liveWorker('/project-a');
    const queued = f.add('/project-a');
    assert.match(f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)), /Global concurrent task-slot limit reached \(1\/1 occupied/,
      'the live worker occupies the only slot');
    // The worker reports; hosted checks run on the PR with no agent attached.
    const waiting = f.store.update(worker.id, { phase: 'verifying', reason: 'Waiting for required checks',
      agentActive: false, agentIntent: false, agentId: null, runId: null,
      completion: { eventId: 'ready', taskId: worker.id, runId: `run-${worker.id}`, status: 'ready_for_review', summary: 'Ready', prNumber: 1, head: 'a'.repeat(40) } });
    assert.equal(occupiesSlot(f.store.task(waiting.id)), false, 'waiting on checks holds no slot');
    assert.equal(capacityFor(f.store.task(queued.id), f.store.admissionCandidates(), 1, 1), '', 'the slot is free');
    assert.equal(f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)), '',
      'mechanical checks do not reserve a slot needed by never-dispatched work');
    // The checks-waiter itself is admitted when it next needs an agent.
    assert.equal(f.engine.resolution.slotAdmissionReason(f.store.task(waiting.id)), '', 'review after CI takes the freed slot');
    f.store.putRun(liveRun(waiting.id, 'review-live'));
    assert.equal(occupiesSlot(f.store.task(waiting.id), f.store.runs(waiting.id)), true, 'the new reviewer turn holds its slot again');
    // Once the waiter settles, the queued task launches into the freed slot.
    f.store.update(waiting.id, { phase: 'done', agentActive: false });
    f.store.putRun({ ...f.store.run('review-live')!, status: 'finished', active: false, released: true });
    await f.engine.wake();
    assert.equal(f.store.task(queued.id).phase, 'working', 'the queued task launches into the freed slot');
    assert.equal(f.calls.agents, 1);
  } finally { await f.close(); }
});

test('a task waiting on the merge turn holds no slot but keeps its place', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1);
    const merging = f.add('/project-a');
    const turn = f.store.update(merging.id, { phase: 'merging', workspaceIntent: true, workspaceId: `ws-${merging.id}`,
      resolution: { ...merging.resolution, mergeIntent: true, integrationTurn: { sequence: 1, acceptedAt: merging.createdAt } } });
    assert.equal(occupiesSlot(f.store.task(turn.id)), false, 'waiting on the merge turn holds no slot');
    assert.equal(f.engine.resolution.holdsIntegrationTurn(f.store.task(turn.id)), true, 'it keeps its merge order');
    assert.equal(f.engine.resolution.claimIntegrationTurn(f.store.task(turn.id)), true, 'the merge lease is separate from slots');
    // The merge wait does not fence dispatch: queued work launches past it.
    const queued = f.add('/project-a');
    assert.equal(f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)), '');
    await f.engine.wake();
    assert.equal(f.store.task(queued.id).phase, 'working');
    assert.equal(f.engine.resolution.holdsIntegrationTurn(f.store.task(turn.id)), true, 'the turn survives dispatch past it');
  } finally { await f.close(); }
});

test('a queued task already waiting on capacity does not rewrite itself as the in-flight list changes', async () => {
  const f = fixture(); try {
    const queued = f.add('/project-a');
    const first = f.engine.resolution.recordStop(f.store.task(queued.id), 'capacity', 'Waiting for a project slot… waiting behind 2 in-flight: #1, #2');
    const again = f.engine.resolution.recordStop(first, 'capacity', 'Waiting for a project slot… waiting behind 3 in-flight: #1, #2, #3');
    assert.equal(again.version, first.version, 'no write for a changed in-flight list');
    const moved = f.engine.resolution.recordStop(again, 'operator_needed', 'Needs an owner');
    assert.ok(moved.version > first.version, 'another stop still records');
  } finally { await f.close(); }
});

test('a task awaiting thread release holds no slot; its revision takes a slot again', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1);
    const revision = f.add('/project-a');
    const reported = f.store.update(revision.id, { phase: 'changes_requested', workspaceIntent: true, workspaceId: `ws-${revision.id}`,
      agentIntent: true, agentId: `agent-${revision.id}`, agentActive: false,
      completion: { eventId: 'refused', taskId: revision.id, runId: 'revision-1', status: 'ready_for_review', summary: 'Ready', prNumber: 1, head: 'a'.repeat(40) } });
    f.store.putRun(liveRun(reported.id, 'revision-reported', { role: 'revision', agentId: `agent-${revision.id}`,
      completion: { eventId: 'refused', taskId: reported.id, runId: 'revision-reported', status: 'ready_for_review', summary: 'Ready', prNumber: 1, head: 'a'.repeat(40) } }));
    assert.equal(occupiesSlot(f.store.task(reported.id), f.store.runs(reported.id)), false, 'a reported thread holds no slot before its release');
    f.store.putRun({ ...f.store.run('revision-reported')!, status: 'finished', active: false, released: true });
    assert.equal(occupiesSlot(f.store.task(reported.id), f.store.runs(reported.id)), false, 'thread release settles the slot');
    // The revision re-enters through the ordinary fair-share order.
    assert.equal(f.engine.resolution.slotAdmissionReason(f.store.task(reported.id)), '', 'a revision after a refusal takes a slot again');
    f.store.putRun(liveRun(reported.id, 'revision-live', { role: 'revision', agentId: `agent-${reported.id}` }));
    assert.equal(occupiesSlot(f.store.task(reported.id), f.store.runs(reported.id)), true);
    const queued = f.add('/project-a');
    assert.match(capacityFor(queued, f.store.admissionCandidates(), 10, 1), /Project/, 'the revision turn caps the project again');
  } finally { await f.close(); }
});

test('global and project limits cap concurrent live agents while idle lifecycles do not count', async () => {
  const f = fixture(); try {
    f.liveWorker('/project-a');
    f.liveWorker('/project-b');
    const idle = f.add('/project-a');
    f.store.update(idle.id, { phase: 'working', workspaceIntent: true, workspaceId: `ws-${idle.id}` });
    assert.equal(occupiesSlot(f.store.task(idle.id)), false, 'an idle lifecycle holds no slot');
    const thirdProject = f.add('/project-c');
    assert.match(capacityFor(thirdProject, f.store.admissionCandidates(), 2, 5), /Global/, 'two live agents fill the global cap');
    const secondInA = f.add('/project-a');
    assert.match(capacityFor(secondInA, f.store.admissionCandidates(), 10, 1), /Project/, 'one live agent fills the project cap');
    const idleOnly = f.add('/project-d');
    f.store.update(idleOnly.id, { phase: 'reviewing', workspaceIntent: true, workspaceId: `ws-${idleOnly.id}` });
    assert.equal(capacityFor(f.add('/project-d'), f.store.admissionCandidates(), 10, 1), '', 'idle lifecycles alone leave the project cap open');
  } finally { await f.close(); }
});

test('workspace creation keeps its slot until the launch follows; the budget counts live-agent workspaces', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1);
    const creating = f.add('/project-a');
    f.store.update(creating.id, { phase: 'dispatching', workspaceIntent: true });
    assert.equal(occupiesSlot(f.store.task(creating.id)), true, 'creation in progress is starting');
    const queued = f.add('/project-a');
    assert.match(f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)), /task-slot limit reached/,
      'a second dispatch waits while creation is in flight');
    // The workspace exists but the agent launch has not been recorded yet: the
    // dispatch window still serializes.
    f.store.update(creating.id, { workspaceId: `ws-${creating.id}`, directory: '/fixture' });
    assert.equal(occupiesSlot(f.store.task(creating.id)), true, 'the pre-launch window keeps its slot');
    f.store.update(creating.id, { phase: 'done' });
    // The workspace budget still defers creation while a live agent holds a workspace...
    const admission = new Admission({ workspaceBudget: 1, startIntervalMs: 0 });
    const live = f.liveWorker('/project-b');
    const owned = f.store.admissionCandidates().filter(task => occupiesSlot(task) && task.workspaceId).length;
    assert.equal(owned, 1);
    assert.equal(admission.workspaceAdmission(owned).admitted, false, 'the budget still defers while live work fills it');
    // ...and idle lifecycles with retained workspaces no longer consume it.
    f.store.update(live.id, { agentActive: false, agentIntent: false, agentId: null, completion: { eventId: 'ready', taskId: live.id, runId: `run-${live.id}`, status: 'ready_for_review', summary: 'Ready', prNumber: 1, head: 'a'.repeat(40) } });
    const ownedAfter = f.store.admissionCandidates().filter(task => occupiesSlot(task) && task.workspaceId).length;
    assert.equal(ownedAfter, 0, 'settled work frees the budget');
    assert.equal(admission.workspaceAdmission(ownedAfter).admitted, true);
  } finally { await f.close(); }
});

test('capacity waits report live agents without reserving slots for mechanical checks', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1);
    const worker = f.liveWorker('/project-a');
    // Lift the in-flight cap (twice the slot limit) so only slot occupancy is read.
    f.store.projectInFlightLimitFor = () => 10;
    const waiter = f.add('/project-a');
    f.store.update(waiter.id, { phase: 'verifying', reason: 'Waiting for required checks', workspaceIntent: true });
    const queued = f.add('/project-a');
    const reason = f.engine.resolution.slotAdmissionReason(f.store.task(queued.id));
    assert.match(reason, new RegExp(`Global concurrent task-slot limit reached \\(1/1 occupied:.*${worker.number ? `#${String(worker.number).padStart(3, '0')}` : worker.id}`),
      'the wait reports the live agent in use');
    assert.doesNotMatch(reason, /waiting without a slot/, 'mechanical checks are not agent requests');
  } finally { await f.close(); }
});

test('the in-flight project cap gates queued workspace starts, follows slot limits and leaves existing work free', async () => {
  const f = fixture(); try {
    f.store.setMeta('projectLimit', 1);
    const parked = f.add('/project-a');
    f.store.update(parked.id, { phase: 'awaiting_review', workspaceId: `ws-${parked.id}`, workspaceIntent: true });
    const held = f.add('/project-a');
    f.store.update(held.id, { phase: 'needs_attention', workspaceId: `ws-${held.id}`, workspaceIntent: true, held: true });
    const queued = f.add('/project-a');
    assert.equal(f.store.projectInFlightLimitFor(f.store.task(queued.id)), 2, 'the default is twice the effective project slot limit');
    assert.equal(f.engine.resolution.projectInFlightAdmissionReason(f.store.task(queued.id)), '', 'the held task does not consume first-dispatch admission');
    const slotWait = f.engine.resolution.slotAdmissionReason(f.store.task(queued.id));
    assert.match(slotWait, /waiting behind 1 in-flight/, 'live slot ordering remains independent of the workspace cap');
    const projectKey = f.store.projectFor('/project-a')!.key;
    f.store.setProjectDispatchLimitOverride(projectKey, 0);
    assert.equal(f.engine.resolution.projectInFlightAdmissionReason(f.store.task(queued.id)), 'Waiting: 1 of 0 tasks in flight for this project', 'zero slots allow nothing in flight');
    f.store.setProjectDispatchLimitOverride(projectKey, null);
    assert.equal(f.engine.resolution.slotAdmissionReason(f.store.task(parked.id)), '', 'review on an in-flight task remains eligible');
    assert.equal(f.engine.resolution.slotAdmissionReason(f.store.task(held.id)), '', 'the cap does not change stops or attention on existing work');

    const otherProject = f.add('/project-b');
    assert.equal(f.engine.resolution.slotAdmissionReason(f.store.task(otherProject.id)), '', 'a capped project does not reserve another project\'s slot');
    f.store.update(parked.id, { phase: 'done' });
    assert.equal(f.engine.resolution.projectInFlightAdmissionReason(f.store.task(queued.id)), '', 'finishing a workspace task releases the next first dispatch');
    assert.equal(f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)), '', 'finishing a workspace task releases the next start');
    await f.engine.wake();
    assert.equal(f.store.task(queued.id).phase, 'working', 'the next queued task starts after the count drops below the cap');

    f.store.setProjectDispatchLimitOverride(projectKey, 3);
    assert.equal(f.store.projectInFlightLimitFor(f.store.task(queued.id)), 6, 'a changed project slot limit changes the default cap');
    f.store.setMeta('projectInFlightLimitOverrides', { [projectKey]: 4 });
    assert.equal(f.store.projectInFlightLimitFor(f.store.task(queued.id)), 6, 'an in-flight override an older build stored is ignored (Tom, 2026-11-08)');
  } finally { await f.close(); }
});

test('parked faults and held workspaces cannot starve first dispatch, but live recovery still counts', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1);
    for (const phase of ['blocked', 'error', 'needs_attention'] as const) {
      const task = f.add('/project-a');
      f.store.update(task.id, { phase, workspaceId: `ws-${task.id}`, workspaceIntent: true, agentActive: false });
    }
    const queued = f.add('/project-a');
    // A cap of one (below twice any slot limit) shows exactly which tasks count.
    f.store.projectInFlightLimitFor = () => 1;
    assert.equal(f.engine.resolution.projectInFlightAdmissionReason(f.store.task(queued.id)), '');
    assert.equal(f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)), '');
    const fault = f.store.tasks().find(task => task.phase === 'needs_attention')!;
    f.store.putRun(liveRun(fault.id, 'recovery-live', { role: 'recovery' }));
    assert.equal(f.engine.resolution.projectInFlightAdmissionReason(f.store.task(queued.id)), 'Waiting: 1 of 1 tasks in flight for this project', 'a live recovery still consumes admission');
    f.store.putRun({ ...f.store.run('recovery-live')!, active: false, released: true, status: 'finished' });
    await f.engine.wake();
    assert.equal(f.store.task(queued.id).phase, 'working', 'parked tasks retain ownership while new work starts');
    assert.equal(f.store.task(fault.id).workspaceId, `ws-${fault.id}`, 'the parked workspace is preserved');
  } finally { await f.close(); }
});

test('capacity index follows task transitions and preserves newest-first order', async () => {
  const f = fixture(); try {
    const oldest = f.add(), middle = f.add(), newest = f.add();
    const ids = () => f.store.admissionCandidates().map(task => task.id);
    assert.deepEqual(ids(), [newest.id, middle.id, oldest.id]);
    f.store.update(middle.id, { phase: 'done' });
    assert.deepEqual(ids(), [newest.id, oldest.id]);
    assert.throws(() => f.store.transaction(() => {
      f.store.update(oldest.id, { phase: 'cancelled' });
      throw new Error('rollback');
    }), /rollback/);
    assert.deepEqual(ids(), [newest.id, oldest.id]);
    f.store.db.prepare('UPDATE tasks SET data=data WHERE id=?').run(newest.id);
    assert.deepEqual(ids(), [newest.id, oldest.id]);
  } finally { await f.close(); }
});
