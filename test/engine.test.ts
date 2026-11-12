import { fakeAdapter } from './support/fakes';
import { queuedReason, taskWaitStateContext } from '../core/recovery/wait-context';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { socketFixtureDirectory } from './support/socket-fixture';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { CURRENT_SCHEMA, Store, digest, explicitCriticalFalseSubmissionHash } from '../core/store/store';
import { Engine, chooseProfile, capacityFor, recoveryCapacityFor, isTransportFailure, occupiesSlot, queuedDispatchOrder } from '../core/engine';
import { fairSlotRequestOrder } from '../core/dispatch/capacity';
import { LoginSessionFaultError } from '../shared/session-fault';
import { inFlightSlotWaitReason } from '../shared/wait-state';
import { taskStopRecord } from '../shared/task-stop';
import { Admission, admitAdapter } from '../core/host/admission';
import { ABSENT_WORKER_REASON, PRE_AGENT_LAUNCH_FAILURE_REASON, ProvenPreSendRefusalError } from '../core/resolution';
import { submissionSchema, summarizeTask, DEFAULT_GLOBAL_LIMIT, DEFAULT_PROJECT_LIMIT, formatTaskNumber, type Profile, type Run, type Task, dispositionSchema } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import { startCallbacks } from '../service/callbacks/callback';
import {taskWorkspaceTitle} from '../core/workspaces/workspace-title';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { assertCompleted, cleanupDiagnostic, observeOutcome, type BackgroundOutcome } from './support/background-outcome';

const profile: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: ['low'] };
const derivedQueuedReason = (f: ReturnType<typeof fixture>, task: Task) =>
  queuedReason(f.store, task, taskWaitStateContext(f.store, task, null, candidate => f.engine.resolution.slotAdmissionReason(candidate)));
const taskSlotLabel = (task: Task) => task.number ? `#${formatTaskNumber(task.number)}` : task.id;
function fixture() {
  const dir = socketFixtureDirectory('callback.sock');
  const path = join(dir, 'queue.sqlite');
  const store = new Store(path);
  store.setProfiles([{ id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, notes: profile.notes }]);
  const calls = { workspaces: 0, agents: 0, reviews: 0, branchPrLookups: 0, archives: [] as string[], workspaceArchives: [] as string[] };
  const tokens = new Map<string, string>();
  let observation: Partial<AgentObservation> = { status: 'running', active: true };
  const adapter: Adapter = fakeAdapter({
    catalog: async () => ({ providers: [{ key: 'test', label: 'test', available: true, problem: '', models: [{ id: 'test', label: 'test', aliases: [], thinkingOptions: [{ id: 'low', label: 'low' }], defaultThinkingOptionId: null, modes: [], features: [] }] }] }), validate: async t => t.planningCommit,
    createWorkspace: async t => { calls.workspaces++; return { id: `ws-${t.id}`, directory: '/fixture' }; },
     verifyWorkspace: async t => t.branch,
    createAgent: async (t, token) => { calls.agents++; tokens.set(t.id, token); return { id: `agent-${t.id}`, workspaceId: t.workspaceId }; },
    observe: async id => ({ id, workspaceId: `ws-${id.slice(6)}`, status: 'idle', active: false, permissions: false, error: '', ...observation }),
    archiveAgent: async id => { calls.archives.push(id); },
    archiveTaskWorkspace: async (_task,id) => { calls.workspaceArchives.push(id); return true; },
    verifyPr: async () => { calls.reviews++; return { url: 'https://github.com/example/repo/pull/1', head: 'abc', repository: 'example/repo', headRepository: 'example/repo' }; },
    findOpenBranchPr: async () => { calls.branchPrLookups++; return []; },
  });
  const engine = new Engine(store, adapter, 0); engine.profiles = [profile];
  store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', weight: 1, scopes: ['general'] }]);
  function add(repoPath = '/project-a', dependsOn: string[] = [], title = 'Task') {
    return store.insert(submissionSchema.parse({ submissionId: randomUUID(), title, repoPath, dependsOn, planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
  }
  return { dir, path, store, calls, tokens, adapter, engine, add,
    idle: (error?: string) => { observation = { status: 'idle', active: false, ...(error ? { error } : {}) }; },
    observe: (value: Partial<AgentObservation>) => { observation = value; },
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('an ordinary Worker running observation is not a stop or recovery episode', async () => {
  const f = fixture(); try {
    const submitted = f.add();
    f.store.setMeta('paused', false);
    const agentId = `agent-${submitted.id}`;
    f.store.update(submitted.id, { phase: 'working', reason: 'Worker running', workspaceIntent: true,
      workspaceId: `ws-${submitted.id}`, directory: '/fixture', agentIntent: true, agentId, runId: 'active-worker', profile,
      profileGroup: 'test' });
    f.observe({ status: 'running', active: true });
    (f.adapter as Adapter & { supportsCoordinatorRecovery?: boolean }).supportsCoordinatorRecovery = true;

    await f.engine.scheduleTaskQuantum(submitted.id);

    const task = f.store.task(submitted.id);
    const summary = summarizeTask(task, false, false, {}, f.store.runs(task.id));
    assert.equal(task.reason, 'Worker running');
    assert.equal(task.resolution.stop, null);
    assert.equal(task.resolution.recovery, null);
    assert.equal(task.resolution.recoveryActive, false);
    assert.equal(f.store.eventsAll(task.id).some(event => event.kind === 'telemetry_recovery'), false);
    assert.equal(summary.stop, undefined, 'the board shows no stop while work progresses');
    assert.equal(summary.stopRecord, undefined);
    assert.equal(ownerTaskNext(collectOwnerVerbFacts(f.store, task)).stop, null, 'task.next shows no stop while work progresses');
  } finally { await f.close(); }
});

test('an ordinary retired worker replacement still launches with an operator-needed stop', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused', false);
    const initial = f.add();
    const oldAgent = `agent-${initial.id}`;
    f.idle();
    f.adapter.verifyResume = async () => {};
    const pending = f.store.update(initial.id, { phase: 'needs_attention', workspaceId: `ws-${initial.id}`,
      directory: '/fixture', profile, profileGroup: 'test',
      retiredWorkers: [{ agentId: oldAgent, runId: 'old-run', profile, reason: 'replacement' }] });
    f.engine.resolution.recordStop(pending, 'operator_needed', 'Needs an owner', ['restart']);
    await f.engine.scheduleTaskQuantum(initial.id);
    assert.equal(f.calls.agents, 1);
    assert.equal(f.store.task(initial.id).agentId, oldAgent);
  } finally { await f.close(); }
});

test('a validation refusal before dispatch can be retried after repair', async () => {
  const f = fixture(); try {
    const task = f.add();
    f.store.setMeta('paused', false);
    f.adapter.validate = async () => { throw new Error('Planning base unavailable'); };
    await f.engine.wake();
    const refused = f.store.task(task.id);
    assert.equal(refused.phase, 'needs_attention');
    assert.match(refused.reason, /Planning base unavailable/);
    assert.equal(f.calls.workspaces, 0);
    f.adapter.validate = async t => t.planningCommit;
    // Escalate the parked episode as a coordinator would: the attention flag, an
    // escalated recovery and incident, and a pending attention notice.
    f.engine.resolution.attention(f.store.task(task.id), 'Operator repair needed');
    f.engine.resolution.recovery.escalate(f.store.task(task.id), 'Operator repair needed');
    f.store.putNotice({ id: 'attention', taskId: task.id, agentId: 'origin', recipientAgentId: 'origin', workspaceId: null, sources: [], originEntry: true, kind: 'attention', status: 'pending', error: '', text: 'Needs attention' });
    const escalated = f.store.task(task.id);
    assert.equal(escalated.resolution.attention, true);
    assert.equal(escalated.resolution.recovery?.status, 'escalated');
    // A live disposition fence refuses the pre-dispatch retry outright.
    f.store.update(task.id, { disposition: dispositionSchema.parse({ kind: 'cancel', status: 'intent', requestedAt: new Date().toISOString(), requestedBy: 'operator control', reason: 'Cancel requested', workDisposition: 'archive_if_empty', effects: [] }) });
    await assert.rejects(f.engine.performTaskControl({ taskId: task.id, version: f.store.task(task.id).version, action: 'restart', reason: 'Owner re-runs the parked step' }), /Disposition fence is active|disposition owns this task/);
    f.store.update(task.id, { disposition: null });
    f.store.setMeta('paused', true);
    const retried = await f.engine.performTaskControl({ taskId: task.id, version: f.store.task(task.id).version, action: 'restart', reason: 'Owner re-runs the parked step' });
    assert.equal(retried.phase, 'queued');
    // The whole episode closes with the return: the incident resolves, recovery
    // clears, attention clears and the pending attention notice settles, while
    // the escalation event stays as evidence and the pre-dispatch route is recorded.
    assert.equal(retried.resolution.attention, false);
    assert.equal(retried.resolution.recovery, null);
    assert.equal(retried.resolution.recoveryActive, false);
    assert.equal(retried.resolution.incident?.status, 'resolved');
    assert.equal(f.store.notices(task.id).find(notice => notice.id === 'attention')?.status, 'superseded');
    assert.ok(f.store.events(task.id).some(event => event.kind === 'attention_episode_resolved'));
    assert.ok(f.store.events(task.id).some(event => event.kind === 'recovery_escalated'));
    assert.ok(f.store.events(task.id).some(event => ['pre_dispatch_retry_requested', 'restart_requested', 'validation_retry_requested'].includes(event.kind)));
    f.store.setMeta('paused', false);
    await f.engine.wake();
    const working = f.store.task(task.id);
    assert.equal(working.phase, 'working');
    assert.equal(working.resolution.attention, false);
    assert.equal(working.resolution.incident?.status, 'resolved');
    assert.equal(f.calls.workspaces, 1);
    assert.equal(f.calls.agents, 1);
  } finally { await f.close(); }
});

test('restart of a pre-dispatch park with an unproven recorded workspace names the identity to reconcile (round 4)', async () => {
  const f = fixture(); try {
    const task = f.add();
    const parked = f.store.update(task.id, { phase: 'needs_attention', workspaceId: 'retained',
      resolution: { ...task.resolution, attention: true } });
    await assert.rejects(f.engine.performTaskControl({ taskId: task.id, version: parked.version, action: 'restart', reason: 'Owner re-runs the parked step' }),
      /no creation intent; reconcile its identity/);
    assert.equal(f.store.task(task.id).version, parked.version, 'the refusal writes nothing');
  } finally { await f.close(); }
});

test('project default is five; other projects dispatch past a full project', async () => {
  const f = fixture(); try {
    assert.equal(DEFAULT_PROJECT_LIMIT, 5);
    f.store.setMeta('globalLimit', 8); f.store.setMeta('paused', false);
    for (let i = 0; i < 7; i++) f.add();
    for (let i = 0; i < 4; i++) f.add('/project-b');
    await f.engine.wake();
    assert.equal(f.calls.agents, 8);
    // Free slots start together in fair-share order, so the last global slot can land on either project.
    const working = (repo: string) => f.store.tasks().filter(t => t.repoPath === repo && t.phase === 'working').length;
    assert.equal(working('/project-a') + working('/project-b'), 8);
    assert.ok(working('/project-a') <= 5 && working('/project-a') >= 4, `${working('/project-a')} on project a`);
    assert.ok(working('/project-b') >= 3, `${working('/project-b')} on project b`);
    f.store.setMeta('globalLimit', 2); await f.engine.wake(); assert.equal(f.calls.agents, 8);
  } finally { await f.close(); }
});
test('project overrides raise, lower, and zero-stop only their own per-repository cap', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 20); f.store.setMeta('paused', false);
    for (let i = 0; i < 7; i++) f.add('/project-a');
    for (let i = 0; i < 7; i++) f.add('/project-b');
    for (let i = 0; i < 7; i++) f.add('/project-c');
    for (let i = 0; i < 7; i++) f.add('/project-d');
    const projectA = f.store.projectFor('/project-a')!, projectB = f.store.projectFor('/project-b')!, projectC = f.store.projectFor('/project-c')!, projectD = f.store.projectFor('/project-d')!;
    f.store.setProjectDispatchLimitOverride(projectA.key, 6);
    f.store.setProjectDispatchLimitOverride(projectB.key, 2);
    f.store.setProjectDispatchLimitOverride(projectD.key, 0);
    await f.engine.wake();
    const working = (repoPath: string) => f.store.tasks().filter(task => task.repoPath === repoPath && task.phase === 'working').length;
    assert.equal(working('/project-a'), 6, 'the raised override admits one more than the default of five');
    assert.equal(working('/project-b'), 2, 'the lower override holds only its own project');
    assert.equal(working('/project-c'), 5, 'a project without an override keeps the default');
    assert.equal(working('/project-d'), 0, 'a zero override admits no queued task while other projects dispatch');
    assert.equal(f.store.tasks().filter(task => task.repoPath === '/project-d' && task.phase === 'queued').length, 7);
    assert.equal(f.calls.agents, 13);
    f.store.setProjectDispatchLimitOverride(projectC.key, 0);
    await f.engine.wake();
    assert.equal(working('/project-c'), 5, 'setting a project stop leaves already-running work untouched');
    assert.equal(f.calls.agents, 13);
    const recoveryA = f.add('/project-a'), recoveryB = f.add('/project-b'), recoveryD = f.add('/project-d');
    assert.match(recoveryCapacityFor(recoveryA, f.store.admissionCandidates(), 20, f.store.projectDispatchLimitFor(recoveryA)), /Project/);
    assert.match(recoveryCapacityFor(recoveryB, f.store.admissionCandidates(), 20, f.store.projectDispatchLimitFor(recoveryB)), /Project/);
    assert.match(recoveryCapacityFor(recoveryD, f.store.admissionCandidates(), 20, f.store.projectDispatchLimitFor(recoveryD)), /Project/, 'a zero override provides no recovery capacity even when the project is empty');
    f.store.setMeta('globalLimit', 12);
    const waiting = f.add('/project-d');
    assert.match(capacityFor(waiting, f.store.admissionCandidates(), 12, f.store.projectDispatchLimitFor(waiting)), /Global/, 'the global cap still binds across project overrides');
  } finally { await f.close(); }
});
test('parked verification releases occupancy and does not reserve a dispatch slot', async () => {
  const f = fixture(); try {
    const parked = f.add(); f.store.update(parked.id, { workspaceIntent: true, phase: 'verifying', agentActive: false });
    const queued = f.add();
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1); f.store.setMeta('paused', false);
    assert.equal(occupiesSlot(f.store.admissionCandidates().find(task => task.id === parked.id)!), false);
    assert.equal(capacityFor(queued, f.store.admissionCandidates(), 1, 1), '');
    assert.equal(f.engine.resolution.slotAdmissionReason(parked), '', 'mechanical verification needs no agent slot');
    assert.equal(f.engine.resolution.slotAdmissionReason(queued), '');
    await f.engine.wakeRepository('/project-a');
    assert.equal(f.calls.agents, 1);
    assert.equal(f.store.task(queued.id).phase, 'working');
  } finally { await f.close(); }
});
test('fenced parked work releases its slot request and returns to its original place when the fence clears', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1); f.store.setMeta('paused', false);
    const earlier = f.add();
    const queued = f.add();
    f.store.update(earlier.id, { phase: 'awaiting_review', workspaceIntent: true, agentActive: false,
      resolution: { ...earlier.resolution, stop: taskStopRecord('escalated', 'Waiting with the planner') } });

    assert.equal(occupiesSlot(f.store.task(earlier.id)), false, 'the planner wait has no live run to retain occupancy');
    assert.equal(f.engine.resolution.slotAdmissionReason(queued), '', 'a runnable never-dispatched task is admitted while the planner wait is fenced');

    f.store.update(earlier.id, { resolution: { ...f.store.task(earlier.id).resolution, stop: null } });
    assert.equal(f.engine.resolution.slotAdmissionReason(queued), inFlightSlotWaitReason(1, [taskSlotLabel(f.store.task(earlier.id))]),
      'clearing the fence restores the earlier parked request ahead of queued work');
    f.store.update(earlier.id, { resolution: { ...f.store.task(earlier.id).resolution, stop: taskStopRecord('escalated', 'Waiting with the planner') } });
    await f.engine.wakeRepository('/project-a');
    assert.equal(f.store.task(queued.id).phase, 'working', 'the never-dispatched task launches into the free slot');
  } finally { await f.close(); }
});

test('budget, delegated-question and dispatch holds do not enter the slot request order', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1);
    const fenced = ['budget', 'responsible_question'] as const;
    for (const reason of fenced) {
      const task = f.add();
      f.store.update(task.id, { phase: 'awaiting_review', workspaceIntent: true, agentActive: false,
        resolution: { ...task.resolution, stop: taskStopRecord(reason, `waiting: ${reason}`) } });
      const queued = f.add();
      assert.equal(f.engine.resolution.slotAdmissionReason(queued), '', `${reason} cannot reserve priority over runnable queued work`);
      f.store.update(queued.id, { phase: 'done' });
    }
    const held = f.add();
    const queued = f.add();
    const dispatchHeld = await f.engine.performTaskControl({ taskId: held.id, version: held.version, action: 'hold', reason: 'Owner stop' }) as Task;
    f.store.update(dispatchHeld.id, { phase: 'awaiting_review', workspaceIntent: true, agentActive: false });
    assert.equal(occupiesSlot(f.store.task(dispatchHeld.id)), false, 'a dispatch-held parked task without a live run releases occupancy');
    assert.equal(f.engine.resolution.slotAdmissionReason(queued), '', 'the dispatch hold cannot reserve priority over runnable queued work');
  } finally { await f.close(); }
});
test('a project-slot wait names real occupancy and the slots earlier requests reserved (papercut 1d72cbab)', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 10); f.store.setMeta('projectLimit', 2); f.store.setMeta('paused', false);
    const running = f.add(); f.store.update(running.id, { phase: 'working', workspaceIntent: true, agentIntent: true, agentId: 'agent-running', agentActive: true });
    f.add(); // an earlier queued request reserves the one free slot in fair order
    const later = f.add();
    assert.equal(capacityFor(later, f.store.admissionCandidates(), 10, 2), '', 'the project is not full of running work');
    assert.match(f.engine.resolution.slotAdmissionReason(later),
      /Waiting for a project slot… Project concurrent task-slot limit reached \(1\/2 occupied: #\d{3}, 1 reserved by earlier requests\)/);
    // A project genuinely full of running work names its occupancy too.
    const second = f.add(); f.store.update(second.id, { phase: 'working', workspaceIntent: true, agentIntent: true, agentId: 'agent-second', agentActive: true });
    assert.match(f.engine.resolution.slotAdmissionReason(later), /Project concurrent task-slot limit reached \(2\/2 occupied: #\d{3}, #\d{3}\)/);
  } finally { await f.close(); }
});
test('queued dispatch waits while review-phase tasks still have unreleased worker runs', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 10); f.store.setMeta('projectLimit', 2); f.store.setMeta('paused', false);
    const first = f.add(), second = f.add();
    await f.engine.wake();
    f.store.update(first.id, { phase: 'awaiting_review' });
    f.store.update(second.id, { phase: 'awaiting_review' });
    for (let i = 0; i < 3; i++) f.add();
    await f.engine.wake();
    assert.equal(f.calls.agents, 2);
    assert.equal(f.store.tasks().filter(task => task.phase === 'queued').length, 3);
  } finally { await f.close(); }
});
test('only live or starting agents retain capacity', async () => {
  // Spec 058 (task 629): slots count live agents. Bare lifecycle phases, a
  // recovery flag, a merge intent and mechanical verification hold nothing
  // without a running agent; live and starting turns hold until released.
  const f = fixture(); try {
    const queued = f.add();
    const idle = (phase: Task['phase'], recoveryActive = false, mergeIntent = false) => {
      const task = f.add();
      f.store.update(task.id, { phase, workspaceIntent: true, resolution: { ...task.resolution, recoveryActive, mergeIntent } });
    };
    // (dispatching with creation intent is starting, not idle: it keeps its
    // slot for workspace-creation serialization and is proven separately.)
    idle('reviewing'); idle('working'); idle('merging'); idle('syncing'); idle('closing');
    idle('needs_attention', true);
    idle('merging', false, true);
    assert.equal(capacityFor(queued, f.store.admissionCandidates(), 10, 8), '', 'idle lifecycles hold no slot');
    const liveWorker = (phase: Task['phase']) => {
      const task = f.add();
      f.store.update(task.id, { phase, workspaceIntent: true, agentIntent: true, agentId: `agent-${task.id}`, agentActive: true });
    };
    liveWorker('working'); liveWorker('reviewing'); liveWorker('merging'); liveWorker('syncing'); liveWorker('closing');
    // A live reviewer turn holds; its release frees the slot.
    const parked = f.add(); f.store.update(parked.id, { phase: 'awaiting_review', workspaceIntent: true });
    const liveReview = (id: string, patch: Partial<Run> = {}): Run => ({ id, taskId: parked.id, role: 'reviewer', generation: 1,
      head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: 'reviewer', workspaceId: 'workspace', profile: null,
      status: 'running', createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), active: true,
      idleSince: null, completion: null, released: false, ...patch });
    f.store.putRun(liveReview('review-live'));
    assert.equal(occupiesSlot(f.store.admissionCandidates().find(task => task.id === parked.id)!), true);
    assert.match(capacityFor(queued, f.store.admissionCandidates(), 10, 6), /Project/);
    f.store.putRun({ ...f.store.run('review-live')!, status: 'finished', active: false, released: true });
    assert.equal(capacityFor(queued, f.store.admissionCandidates(), 10, 6), '', 'a released thread frees the slot');
    // A starting reviewer intent holds before its agent exists; a reported
    // (completion recorded, release pending) thread does not.
    f.store.putRun(liveReview('review-starting', { agentId: null, status: 'intent', active: null }));
    assert.equal(occupiesSlot(f.store.task(parked.id), f.store.runs(parked.id)), true, 'a starting intent holds its slot');
    f.store.putRun({ ...f.store.run('review-starting')!, status: 'finished', active: false, released: true });
    f.store.putRun(liveReview('review-reported', { completion: { eventId: 'e', taskId: parked.id, runId: 'review-reported', status: 'ready_to_merge', summary: 'done', head: 'a'.repeat(40) } }));
    assert.equal(occupiesSlot(f.store.task(parked.id), f.store.runs(parked.id)), false, 'a reported thread frees the slot before its release');
    f.store.putRun({ ...f.store.run('review-reported')!, released: true });
    // Recovery holds only while its agent runs, not via the flag alone.
    const recovering = f.add();
    f.store.update(recovering.id, { phase: 'needs_attention', workspaceIntent: true, resolution: { ...recovering.resolution, recoveryActive: true } });
    assert.equal(occupiesSlot(f.store.task(recovering.id), f.store.runs(recovering.id)), false, 'a recovery flag without an agent holds no slot');
    f.store.putRun({ ...liveReview('recovery-live', { taskId: recovering.id, role: 'recovery' }) });
    assert.equal(occupiesSlot(f.store.task(recovering.id), f.store.runs(recovering.id)), true, 'a running recovery turn holds its slot');
    assert.match(recoveryCapacityFor(queued, f.store.admissionCandidates(), 10, 6), /Project/);
    const other = f.add('/project-b');
    assert.equal(capacityFor(other, f.store.admissionCandidates(), 10, 6), '');
    assert.match(capacityFor(other, f.store.admissionCandidates(), 5, 6), /Global/);
  } finally { await f.close(); }
});
test('terminal tasks with unreleased run intents free slots while live unreleased runs still occupy them', async () => {
  const f = fixture(); try {
    f.store.setMeta('projectLimit', 1);
    const makeIntent = (taskId: string, id: string): Run => ({ id, taskId, role: 'recovery', generation: 1,
      head: 'a'.repeat(40), base: 'b'.repeat(40), agentId: null, workspaceId: 'ws', profile: null,
      status: 'intent', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null,
      completion: null, released: false });
    const done = f.add(), live = f.add(), queued = f.add();
    f.store.update(done.id, { phase: 'done' });
    f.store.putRun(makeIntent(done.id, 'terminal-intent'));
    f.store.putRun({ ...makeIntent(live.id, 'live-intent'), agentId: 'agent-live', status: 'running' });
    const capacityTasks = f.store.admissionCandidates();
    assert.equal(capacityTasks.some(task => task.id === done.id), false, 'terminal rows are omitted from capacity accounting');
    assert.equal(occupiesSlot(f.store.task(done.id), f.store.runs(done.id)), false, 'a terminal run lease cannot reserve a slot');
    assert.equal(occupiesSlot(f.store.task(live.id), f.store.runs(live.id)), true, 'an unreleased live run still reserves a slot');
    assert.match(f.engine.resolution.slotAdmissionReason(queued), /1\/1 occupied: #\d{3}/);
  } finally { await f.close(); }
});
test('a landed closeout without a running agent frees its slot but keeps the merge order', async () => {
  // Spec 058 (task 629): settlement frees the slot. The merge order lives in
  // the integration turn, not in slot occupancy (see
  // test/merged-closeout-capacity.test.ts), so a landed closeout with no live
  // agent holds no slot while a queued task dispatches past it.
  const f = fixture(); try {
    const queued = f.add();
    const closing = f.add();
    f.store.update(closing.id, { phase: 'closing', workspaceIntent: false, resolution: { ...closing.resolution, mergedCommit: 'merged', syncedCommit: 'merged' } });
    assert.equal(occupiesSlot(f.store.task(closing.id)), false, 'settlement frees the slot');
    assert.equal(capacityFor(queued, f.store.tasks(), 10, 1), '');
    assert.equal(capacityFor(f.add('/project-b'), f.store.tasks(), 1, 1), '');
    f.store.update(closing.id, { phase: 'syncing' });
    assert.equal(capacityFor(queued, f.store.tasks(), 10, 1), '', 'closeout resync without an agent holds no slot');
    // A closeout coordinator turn takes a slot again when it launches.
    f.store.putRun({ id: 'closeout-live', taskId: closing.id, role: 'closeout', generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: 'coordinator', workspaceId: 'ws', profile: null, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), active: true, idleSince: null, completion: null, released: false });
    assert.equal(occupiesSlot(f.store.task(closing.id), f.store.runs(closing.id)), true, 'a running closeout turn holds its slot');
    assert.match(capacityFor(queued, f.store.admissionCandidates(), 10, 1), /Project/);
    f.store.update(closing.id, { phase: 'done' });
    assert.equal(capacityFor(queued, f.store.tasks(), 10, 1), '');
  } finally { await f.close(); }
});
test('merged done tasks with retained merge intent release their project and global slots', async () => {
  const f = fixture(); try {
    const merged = Array.from({ length: DEFAULT_PROJECT_LIMIT }, () => f.add());
    for (const task of merged) {
      f.store.update(task.id, { phase: 'done', resolution: { ...task.resolution, mergeIntent: true, mergedCommit: 'a'.repeat(40) } });
    }
    const queued = f.add();
    const capacityTasks = f.store.admissionCandidates();
    assert.equal(capacityTasks.some(task => merged.some(done => done.id === task.id)), false, 'settled merge intents are omitted from terminal capacity rows');
    assert.equal(merged.some(task => occupiesSlot(f.store.task(task.id))), false);
    assert.equal(capacityFor(queued, capacityTasks, DEFAULT_GLOBAL_LIMIT, DEFAULT_PROJECT_LIMIT), '');
    assert.equal(capacityFor(queued, capacityTasks, 1, DEFAULT_PROJECT_LIMIT), '');
  } finally { await f.close(); }
});
test('lifecycle phases hold slots only while an agent is live or starting; parked phases never do', async () => {
  // Spec 058 (task 629): slots count live agents, not phases. A bare lifecycle
  // phase holds nothing; the same phase with a live agent holds.
  for (const phase of ['working', 'reviewing', 'merging', 'syncing', 'closing'] as const) {
    const f = fixture(); try {
      const queued = f.add();
      const idle = f.add(); f.store.update(idle.id, { phase, workspaceIntent: true });
      assert.equal(occupiesSlot(f.store.task(idle.id)), false, `${phase} without an agent holds no slot`);
      assert.equal(capacityFor(queued, f.store.tasks(), 10, 1), '', phase);
      const live = f.add();
      f.store.update(live.id, { phase, workspaceIntent: true, agentIntent: true, agentId: `agent-${live.id}`, agentActive: true });
      assert.equal(occupiesSlot(f.store.task(live.id)), true, `${phase} with a live agent holds its slot`);
      assert.match(capacityFor(queued, f.store.tasks(), 10, 1), /Project/, phase);
    } finally { await f.close(); }
  }
  {
    // A dispatching task creating its workspace is starting: the agent launch
    // follows in the same flow, so the creation window keeps its slot.
    const f = fixture(); try {
      const queued = f.add();
      const creating = f.add(); f.store.update(creating.id, { phase: 'dispatching', workspaceIntent: true });
      assert.equal(occupiesSlot(f.store.task(creating.id)), true, 'dispatching creation holds its slot');
      assert.match(capacityFor(queued, f.store.tasks(), 10, 1), /Project/);
    } finally { await f.close(); }
  }
  for (const phase of ['needs_attention', 'awaiting_review', 'changes_requested', 'verifying'] as const) {
    const f = fixture(); try {
      const queued = f.add();
      const task = f.add(); const parked = f.store.update(task.id, { phase, workspaceIntent: true, agentActive: false });
      assert.equal(occupiesSlot(parked), false, phase);
      assert.equal(capacityFor(queued, f.store.tasks(), 10, 1), '', phase);
    } finally { await f.close(); }
  }
});

test('a parked revision launches ahead of older queued work, then queued waits within the project and global limits', async () => {
  const f = fixture(); let sent = 0; try {
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1); f.store.setMeta('paused', false); f.idle();
    f.adapter.verifyPr = async () => ({ url: 'https://github.com/example/repo/pull/1', head: 'c'.repeat(40) });
    (f.adapter as any).sendRun = async () => { sent++; };
    (f.adapter as any).createRun = async () => ({ id: 'unexpected-new-agent', workspaceId: 'workspace' });
    const queued = f.add();
    const revision = f.add();
    const workerRunId = `worker-${revision.id}`;
    f.store.update(revision.id, { phase: 'changes_requested', workspaceIntent: true, workspaceId: `ws-${revision.id}`, directory: '/fixture', agentId: `agent-${revision.id}`, agentIntent: true,
      runId: workerRunId, profile, agentActive: false, lastAgentStatus: 'idle', prUrl: 'https://github.com/example/repo/pull/1', prHead: 'c'.repeat(40),
      completion: { eventId: `ready-${revision.id}`, taskId: revision.id, runId: workerRunId, status: 'ready_for_review', summary: 'Ready', prNumber: 1, head: 'c'.repeat(40) } });

    await f.engine.scheduleTaskQuantum(revision.id);
    assert.equal(sent, 1, 'the parked revision takes the free slot ahead of older queued work');
    assert.equal(f.store.runs(revision.id).filter(run => !run.released).length, 1);
    assert.equal(f.store.admissionCandidates().filter(task => occupiesSlot(task)).length, 1);

    await f.engine.wakeRepository('/project-a');
    assert.equal(f.store.task(queued.id).phase, 'queued');
    assert.match(f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)), /Global concurrent task-slot limit reached/);
    assert.equal(sent, 1);

    for (const run of f.store.runs(revision.id)) f.store.putRun({ ...run, released: true, status: 'finished' });
    f.store.update(revision.id, { phase: 'done', agentActive: false, agentIntent: false });
    await f.engine.wakeRepository('/project-a');
    assert.equal(f.store.task(queued.id).phase, 'working');
  } finally { await f.close(); }
});

test('a merge-held queued task remains dispatchable but waits behind a parked resume', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1);
    const held = f.store.update(f.add().id, { held: true, mergeHold: true });
    const revision = f.store.update(f.add().id, { phase: 'changes_requested', workspaceIntent: true, agentActive: false });
    assert.equal(queuedDispatchOrder(f.store.tasks())[0]?.id, held.id, 'merge-only holds remain dispatchable');
    assert.equal(f.engine.resolution.slotAdmissionReason(revision), '', 'the parked resume is admitted ahead of never-started queued work');
    assert.equal(f.engine.resolution.slotAdmissionReason(held), inFlightSlotWaitReason(1, [taskSlotLabel(revision)]));
  } finally { await f.close(); }
});

test('merge-held verifying tasks are not slot requests and never starve a waiting review', async () => {
  // 2026-10-02: seven merge-held Project-A tasks in verifying (waiting for operator release) were
  // counted as fair-share slot requests and starved every awaiting_review task behind them.
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 18); f.store.setMeta('projectLimit', 2);
    for (let i = 0; i < 3; i++) f.store.update(f.add().id, { phase: 'verifying', held: true, mergeHold: true, workspaceIntent: true, agentActive: false });
    const review = f.store.update(f.add().id, { phase: 'awaiting_review', workspaceIntent: true, agentActive: false });
    assert.equal(f.engine.resolution.slotAdmissionReason(review), '', 'a review dispatches while held verifying tasks wait for release');
  } finally { await f.close(); }
});

test('a newer queued task does not take the slot an older waiting review is owed', async () => {
  // 2026-10-03: queued dispatch checked free slots only, so new Project-A work took every
  // freed slot while nine older tasks sat in awaiting_review for over an hour.
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 18); f.store.setMeta('projectLimit', 2); f.store.setMeta('paused', false);
    f.store.update(f.add().id, { phase: 'working', workspaceIntent: true, agentActive: true });
    const review = f.store.update(f.add().id, { phase: 'awaiting_review', workspaceIntent: true, agentActive: false });
    const queued = f.add();
    await (f.engine as unknown as { dispatchTask(id: string): Promise<void> }).dispatchTask(queued.id);
    const after = f.store.task(queued.id);
    assert.equal(after.phase, 'queued', 'the newer queued task waits');
    assert.equal(derivedQueuedReason(f, after), inFlightSlotWaitReason(1, [taskSlotLabel(review)]));
    assert.equal(f.engine.resolution.slotAdmissionReason(review), '', 'the older review is admitted');
  } finally { await f.close(); }
});

test('an older queued task does not take the slot a waiting review is owed', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 18); f.store.setMeta('projectLimit', 2); f.store.setMeta('paused', false);
    f.store.update(f.add().id, { phase: 'working', workspaceIntent: true, agentActive: true });
    const queued = f.add();
    const review = f.store.update(f.add().id, { phase: 'awaiting_review', workspaceIntent: true, agentActive: false });
    await (f.engine as unknown as { dispatchTask(id: string): Promise<void> }).dispatchTask(queued.id);
    const after = f.store.task(queued.id);
    assert.equal(after.phase, 'queued', 'the older queued task waits');
    assert.equal(derivedQueuedReason(f, after), inFlightSlotWaitReason(1, [taskSlotLabel(review)]));
    assert.equal(f.engine.resolution.slotAdmissionReason(review), '', 'the review is admitted first even when the queued task is older');
  } finally { await f.close(); }
});

test('needs_attention recovery ranks ahead of older queued work only when recovery is included', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1);
    const queued = f.add();
    const recovery = f.add();
    f.store.update(recovery.id, { phase: 'needs_attention', workspaceIntent: true, agentActive: false,
      resolution: { ...recovery.resolution, attention: true, recovery: { id: 'recovery', key: 'recovery', generation: 1, runId: null, agentId: null, status: 'escalated', summary: 'No callback', idleSince: null, incidentId: null } } });
    assert.equal(f.engine.resolution.slotAdmissionReason(recovery, true), '', 'recovery is admitted ahead of older queued work');
    assert.equal(f.engine.resolution.slotAdmissionReason(queued, true), inFlightSlotWaitReason(1, [taskSlotLabel(recovery)]));
    assert.equal(f.engine.resolution.slotAdmissionReason(queued, false), '', 'queued dispatch proceeds when recovery is not in the request set');
  } finally { await f.close(); }
});

test('queued dispatch proceeds when no in-flight request waits, and project limits still apply per tier', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 18); f.store.setMeta('projectLimit', 1);
    const reviewA = f.store.update(f.add('/project-a').id, { phase: 'awaiting_review', workspaceIntent: true, agentActive: false });
    const reviewA2 = f.store.update(f.add('/project-a').id, { phase: 'awaiting_review', workspaceIntent: true, agentActive: false });
    const queuedA = f.add('/project-a');
    const queuedB = f.add('/project-b');
    assert.equal(f.engine.resolution.slotAdmissionReason(reviewA), '', 'first in-flight in a project is admitted');
    assert.equal(f.engine.resolution.slotAdmissionReason(reviewA2), inFlightSlotWaitReason(1, [taskSlotLabel(reviewA)]), 'project limit wait names the earlier in-flight review');
    assert.equal(f.engine.resolution.slotAdmissionReason(queuedA), inFlightSlotWaitReason(2, [taskSlotLabel(reviewA), taskSlotLabel(reviewA2)]), 'queued work in the same project names the earlier in-flight requests');
    assert.equal(f.engine.resolution.slotAdmissionReason(queuedB), '', 'queued dispatch proceeds in a project with no in-flight wait');
    assert.deepEqual(fairSlotRequestOrder(f.store.tasks(), task => ['queued', 'awaiting_review'].includes(task.phase)).map(task => task.id),
      [reviewA.id, reviewA2.id, queuedA.id, queuedB.id]);
  } finally { await f.close(); }
});

test('simultaneous parked resumes never pass global or project limits', async () => {
  const cases = [
    { globalLimit: 2, projectLimit: 1, secondProject: '/project-a' },
    { globalLimit: 1, projectLimit: 2, secondProject: '/project-b' },
  ];
  for (const limits of cases) {
    const f = fixture(); let sent = 0; try {
      f.store.setMeta('globalLimit', limits.globalLimit); f.store.setMeta('projectLimit', limits.projectLimit); f.store.setMeta('paused', false); f.idle();
      f.adapter.verifyPr = async () => ({ url: 'https://github.com/example/repo/pull/1', head: 'c'.repeat(40) });
      (f.adapter as any).sendRun = async () => { sent++; };
      (f.adapter as any).createRun = async () => ({ id: 'unexpected-new-agent', workspaceId: 'workspace' });
      const prepare = (task: Task) => {
        const runId = `worker-${task.id}`;
        return f.store.update(task.id, { phase: 'changes_requested', workspaceIntent: true, workspaceId: `ws-${task.id}`, directory: '/fixture', agentId: `agent-${task.id}`, agentIntent: true,
          runId, profile, agentActive: false, lastAgentStatus: 'idle', prUrl: 'https://github.com/example/repo/pull/1', prHead: 'c'.repeat(40),
          completion: { eventId: `ready-${task.id}`, taskId: task.id, runId, status: 'ready_for_review', summary: 'Ready', prNumber: 1, head: 'c'.repeat(40) } });
      };
      const first = prepare(f.add());
      const second = prepare(f.add(limits.secondProject));
      await Promise.all([f.engine.scheduleTaskQuantum(first.id), f.engine.scheduleTaskQuantum(second.id)]);
      const occupied = f.store.admissionCandidates().filter(task => occupiesSlot(task));
      assert.equal(sent, 1, `one fresh run fits the limits ${JSON.stringify(limits)}`);
      assert.ok(occupied.length <= limits.globalLimit);
      assert.ok(occupied.filter(task => task.repoPath === first.repoPath).length <= limits.projectLimit);
    } finally { await f.close(); }
  }
});
test('a project with no pipeline cannot dispatch past its implementation cap', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 10); f.store.setMeta('projectLimit', 2); f.store.setMeta('paused', false);
    for (let i = 0; i < 4; i++) f.add();
    await f.engine.wake();
    assert.equal(f.calls.agents, 2);
    assert.equal(f.store.tasks().filter(task => task.phase === 'queued').length, 2);
  } finally { await f.close(); }
});
test('workspace admission still defers a project with pipeline headroom', async () => {
  const f = fixture(); try {
    const queued = f.add();
    const pipeline = f.add(); f.store.update(pipeline.id, { phase: 'awaiting_review', workspaceIntent: true, workspaceId: 'retained', agentActive: true });
    const admission = new Admission({ workspaceBudget: 1, startIntervalMs: 0 });
    const engine = new Engine(f.store, admitAdapter(f.adapter, admission), 0); engine.profiles = [profile];
    f.store.setMeta('projectLimit', 1); f.store.setMeta('paused', false);
    await engine.wake();
    assert.equal(f.store.task(queued.id).phase, 'queued');
    assert.equal(f.calls.workspaces, 0);
    await engine.stop();
  } finally { await f.close(); }
});
test('paused queue persists submissions and does not dispatch', async () => {
  const f = fixture(); try { f.add(); await f.engine.wake(); assert.equal(f.calls.workspaces, 0); assert.equal(f.store.tasks().length, 1); } finally { await f.close(); }
});
test('routine engine passes skip retained terminal task reconciliation', async () => {
  const f = fixture(); try {
    const done = f.add(), cancelled = f.add();
    f.store.update(done.id, { phase: 'done', finishedAt: new Date().toISOString() });
    f.store.update(cancelled.id, { phase: 'cancelled', finishedAt: new Date().toISOString() });
    let externalMergeChecks = 0, hookChecks = 0;
    (f.engine.resolution as any).recoverExternalMerge = async () => { externalMergeChecks++; return false; };
    (f.engine.hooks as any).reconcileTask = async () => { hookChecks++; return { hold: false }; };
    f.store.setMeta('paused', false);
    await f.engine.wake();
    assert.equal(externalMergeChecks, 0);
    assert.equal(hookChecks, 0);
  } finally { await f.close(); }
});
test('a versioned control is not starved behind a running reconciliation pass', async () => {
  const f = fixture();
  let first: Promise<BackgroundOutcome> | undefined, coalesced: Promise<BackgroundOutcome> | undefined;
  let failed = false;
  let releasePass!: () => void;
  const passGate = new Promise<void>(resolve => { releasePass = resolve; });
  try {
    const original = f.add(), runId = 'retained-worker-run';
    const blocked = f.store.update(original.id, {
      phase: 'blocked', workspaceIntent: true, workspaceId: 'retained-workspace', directory: '/fixture',
      agentIntent: true, agentId: 'retained-worker', runId, profile,
      completion: { eventId: 'blocked', taskId: original.id, runId, status: 'blocked', summary: 'Awaiting an external contract' },
    });
    let passes = 0;
    // The audit lane is held open while a same-task control must still run on its
    // own exclusive lane; acceptance is never serviced by the whole-store pass.
    (f.engine as any).auditPass = async () => { passes++; await passGate; return { fault: null, covered: true, reached: 0 }; };
    // Both wakes are observed at creation; each must complete, the coalesced one on its own pass.
    first = observeOutcome(f.engine.wake());
    coalesced = observeOutcome(f.engine.wake()); // Coalesced wake while the first audit is still active.
    f.adapter.observe = async id => ({ id, workspaceId: blocked.workspaceId!, status: 'idle', active: false, permissions: false, error: '' });
    const control = f.engine.performTaskControl({ taskId: blocked.id, version: blocked.version, action: 'restart', role: 'worker', reason: 'Resume the retained worker', instruction: 'Adopt the existing exact-branch PR' });
    const resumed = await Promise.race([
      control,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Versioned control starved behind a running pass')), 250)),
    ]);
    assert.equal(resumed.phase, 'changes_requested');
    assert.equal(resumed.reason, 'Adopt the existing exact-branch PR');
    assert.equal(passes, 1);
    releasePass();
    await assertCompleted(first, 'the first wake');
    await assertCompleted(coalesced, 'the coalesced wake');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    releasePass?.();
    await f.close();
    if (failed) for (const [label, outcome] of [['the first wake', first], ['the coalesced wake', coalesced]] as const) {
      const note = await cleanupDiagnostic(outcome, label);
      if (note) process.stderr.write(`[engine] secondary: ${note}\n`);
    }
  }
});
test('operator resume returns a retained blocked worker despite full global and project capacity', async () => {
  const f = fixture(); try {
    const occupied = f.add(), blockedTask = f.add(), runId = 'blocked-worker-run';
    f.store.update(occupied.id, {
      phase: 'working', workspaceIntent: true, workspaceId: 'occupied-workspace', directory: '/fixture',
      agentIntent: true, agentId: 'occupied-worker', runId: 'occupied-run', profile,
    });
    const blocked = f.store.update(blockedTask.id, {
      phase: 'blocked', workspaceIntent: true, workspaceId: 'retained-workspace', directory: '/fixture',
      agentIntent: true, agentId: 'retained-worker', runId, profile,
      completion: { eventId: 'blocked', taskId: blockedTask.id, runId, status: 'blocked', summary: 'Awaiting an external contract' },
    });
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1);
    (f.adapter as any).createRun = async () => ({ id: 'unexpected-new-agent', workspaceId: 'workspace' });
    assert.match(capacityFor(blocked, f.store.tasks(), 1, 1), /Global/);
    f.adapter.observe = async id => ({ id, workspaceId: blocked.workspaceId!, status: 'idle', active: false, permissions: false, error: '' });
    const resumed = await f.engine.performTaskControl({ taskId: blocked.id, version: blocked.version, action: 'restart', role: 'worker', reason: 'Resume the retained worker', instruction: 'Continue under the resolved ruling' });
    assert.equal(resumed.phase, 'changes_requested');
    assert.equal(resumed.reason, 'Continue under the resolved ruling');
    assert.equal(f.store.tasks().filter(task => occupiesSlot(task)).length, 1, 'operator acceptance does not reserve a new slot');
    f.store.setMeta('paused', false);
    await f.engine.scheduleTaskQuantum(blocked.id);
    assert.match(f.store.task(blocked.id).reason, /Waiting for a project slot…/);
    assert.equal(f.store.tasks().filter(task => occupiesSlot(task)).length, 1);
  } finally { await f.close(); }
});
test('pause during workspace creation stops agent launch; resume uses the same workspace', async () => {
  const f = fixture(); try {
    const original = f.adapter.createWorkspace;
    f.adapter.createWorkspace = async t => { const result = await original(t); f.store.setMeta('paused', true); return result; };
    f.add(); f.store.setMeta('paused', false); await f.engine.wake();
    assert.equal(f.calls.workspaces, 1); assert.equal(f.calls.agents, 0);
    f.store.setMeta('paused', false); await f.engine.wake(); assert.equal(f.calls.agents, 1); assert.equal(f.calls.workspaces, 1);
  } finally { await f.close(); }
});
test('paused callback is durable across reopening; pause verifies and releases and starts no new run', async () => {
  const f = fixture(); let reopened: Store | undefined; try {
    const t = f.add(); f.store.setMeta('paused', false); await f.engine.wake();
    f.store.setMeta('paused', true); f.idle();
    const current = f.store.task(t.id);
    const event = { eventId: 'completion', taskId: t.id, runId: current.runId!, status: 'ready_for_review' as const, summary: 'Ready', prNumber: 1 };
    await f.engine.complete(event, f.tokens.get(t.id)!); await f.engine.wake(); await f.engine.stop();
    assert.equal(f.calls.reviews, 2, 'intake verifies identity and pause applies the stored result');
    assert.equal(f.store.task(t.id).phase, 'awaiting_review');
    assert.equal(f.calls.agents, 1, 'pause starts no reviewer');
    assert.equal(f.store.task(t.id).agentActive, false);
    reopened = new Store(f.path); assert.equal(reopened.getMeta('paused'), true); assert.deepEqual(reopened.task(t.id).completion, event);
    const engine = new Engine(reopened, f.adapter); await engine.refresh();
    await engine.wake(); assert.equal(f.calls.reviews, 2); assert.equal(f.calls.agents, 1);
    reopened.setMeta('paused', false); await engine.wake(); assert.equal(f.calls.reviews, 2); assert.equal(reopened.task(t.id).phase, 'awaiting_review'); assert.equal(f.calls.agents, 1);
    await engine.stop();
  } finally { reopened?.close(); await f.close(); }
});
test('callbacks authenticate and deduplicate; readiness requires a PR', async () => {
  const f = fixture(); try {
    const t = f.add(); f.store.setMeta('paused', false); await f.engine.wake(); f.store.setMeta('paused', true);
    const event = { eventId: 'result', taskId: t.id, runId: f.store.task(t.id).runId!, status: 'blocked' as const, summary: 'No remote' };
    await assert.rejects(f.engine.complete(event, 'wrong'), /Unauthorized/);
    await assert.rejects(f.engine.complete({ ...event, status: 'ready_for_review' }, f.tokens.get(t.id)!), /PR number/);
    const result = await f.engine.complete(event, f.tokens.get(t.id)!);
    assert.deepEqual(await f.engine.complete(event, f.tokens.get(t.id)!), result);
    await assert.rejects(f.engine.complete({ ...event, summary: 'different' }, f.tokens.get(t.id)!), /conflict/);
  } finally { await f.close(); }
});
test('a responsible worker that names an impediment and changes nothing gets a retained pushback before the blocked hook', async () => {
  const f = fixture(); try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.dir, encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Queue test'); git('config', 'user.email', 'queue-test@example.test');
    writeFileSync(join(f.dir, 'README.md'), 'base\n'); git('add', 'README.md'); git('commit', '-m', 'base');
    const head = git('rev-parse', 'HEAD'), runId = 'worker-run', token = 'worker-token';
    const task = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Responsible task', repoPath: f.dir,
      planningCommit: head, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', head,
      { phase: 'working', reason: 'Worker running', responsible: true, workspaceIntent: true, workspaceId: `ws-${'a'.repeat(8)}`,
        directory: f.dir, agentIntent: true, agentId: `agent-${'a'.repeat(8)}`, runId, profile, profileGroup: 'test' }, { runId, token });
    // Align the fixture's deterministic adapter identity with this generated task.
    f.store.update(task.id, { workspaceId: `ws-${task.id}`, agentId: `agent-${task.id}` });
    f.store.setMeta('paused', false);
    f.idle();
    const completion = { eventId: 'worker-no-delivery', taskId: task.id, runId, status: 'blocked' as const,
      summary: 'No external blocker and no change', impediment: 'npm ci exited 1: registry unreachable', head };
    await f.engine.complete(completion, token);
    await f.engine.wakeTask(task.id);
    const current = f.store.task(task.id);
    const record = JSON.parse(f.store.eventsAll(task.id).find(event => event.kind === 'non_delivery')!.detail);
    assert.deepEqual([record.role, record.provider, record.model], ['worker', 'test', 'test']);
    assert.equal(current.phase, 'changes_requested', JSON.stringify({ reason: current.reason, completion: current.completion,
      events: f.store.eventsAll(task.id).map(event => [event.kind, event.detail]) }));
    assert.match(current.reason, /You reported no external blocker and produced no change/);
    assert.equal(f.store.runs(task.id).length, 0, 'the first non-delivery does not start recovery or an alternate provider');
  } finally { await f.close(); }
});
test('a responsible worker that names no impediment and changes nothing continues the same worker, not recovery', async () => {
  const f = fixture(); try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.dir, encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Queue test'); git('config', 'user.email', 'queue-test@example.test');
    writeFileSync(join(f.dir, 'README.md'), 'base\n'); git('add', 'README.md'); git('commit', '-m', 'base');
    const head = git('rev-parse', 'HEAD'), runId = 'worker-run', token = 'worker-token';
    const task = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Responsible task', repoPath: f.dir,
      planningCommit: head, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', head,
      { phase: 'working', reason: 'Worker running', responsible: true, workspaceIntent: true, workspaceId: `ws-${'a'.repeat(8)}`,
        directory: f.dir, agentIntent: true, agentId: `agent-${'a'.repeat(8)}`, runId, profile, profileGroup: 'test' }, { runId, token });
    // Align the fixture's deterministic adapter identity with this generated task.
    f.store.update(task.id, { workspaceId: `ws-${task.id}`, agentId: `agent-${task.id}` });
    f.store.setMeta('paused', false);
    f.idle();
    const completion = { eventId: 'worker-empty', taskId: task.id, runId, status: 'blocked' as const,
      summary: 'Setup is confirmed; I read the pilot recipe', head };
    await f.engine.complete(completion, token);
    await f.engine.wakeTask(task.id);
    const current = f.store.task(task.id);
    const record = JSON.parse(f.store.eventsAll(task.id).find(event => event.kind === 'unfinished_continuation')!.detail);
    assert.deepEqual([record.role, record.reason, record.observedHead], ['worker', 'no_impediment', head]);
    assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'non_delivery').length, 0);
    assert.equal(current.phase, 'changes_requested', JSON.stringify({ reason: current.reason, completion: current.completion,
      events: f.store.eventsAll(task.id).map(event => [event.kind, event.detail]) }));
    assert.match(current.reason, /You reported no impediment and pushed no commit/);
    assert.equal(current.resolution.pendingRevisionCause, 'unfinished');
  } finally { await f.close(); }
});
test('a worker push HTTP 502 report continues the retained worker without parking or recovery', async () => {
  const f = fixture(); try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.dir, encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Queue test'); git('config', 'user.email', 'queue-test@example.test');
    writeFileSync(join(f.dir, 'README.md'), 'base\n'); git('add', 'README.md'); git('commit', '-m', 'base');
    const head = git('rev-parse', 'HEAD'), runId = 'worker-run', token = 'worker-token';
    const task = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Responsible task', repoPath: f.dir,
      planningCommit: head, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', head,
      { phase: 'working', reason: 'Worker running', responsible: true, workspaceIntent: true, workspaceId: `ws-${'a'.repeat(8)}`,
        directory: f.dir, agentIntent: true, agentId: `agent-${'a'.repeat(8)}`, runId, profile, profileGroup: 'test' }, { runId, token });
    // Align the fixture's deterministic adapter identity with this generated task.
    f.store.update(task.id, { workspaceId: `ws-${task.id}`, agentId: `agent-${task.id}` });
    f.store.setMeta('paused', false);
    f.idle();
    const completion = { eventId: 'worker-empty', taskId: task.id, runId, status: 'blocked' as const,
      summary: 'Push failed twice', impediment: 'git push: HTTP 502 from github.com', cause: { kind: 'external' as const, name: 'GitHub outage' }, head };
    await f.engine.complete(completion, token);
    await f.engine.wakeTask(task.id);
    const current = f.store.task(task.id);
    const record = JSON.parse(f.store.eventsAll(task.id).find(event => event.kind === 'unfinished_continuation')!.detail);
    assert.deepEqual([record.role, record.reason, record.observedHead], ['worker', 'forge_transient', head]);
    assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'non_delivery').length, 0);
    assert.equal(current.phase, 'changes_requested', JSON.stringify({ reason: current.reason, completion: current.completion,
      events: f.store.eventsAll(task.id).map(event => [event.kind, event.detail]) }));
    assert.match(current.reason, /observing the remote branch or existing PR before every retry/);
    assert.equal(f.store.runs(task.id).length, 0, 'no recovery run starts');
    assert.equal(f.store.eventsAll(task.id).some(event => /escalat/.test(event.kind)), false);
    assert.equal(current.resolution.pendingRevisionCause, 'unfinished');
  } finally { await f.close(); }
});
test('a stalled observation pass does not overwrite a recorded same-thread continuation with blocked/error', async () => {
  const f = fixture(); try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.dir, encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Queue test'); git('config', 'user.email', 'queue-test@example.test');
    writeFileSync(join(f.dir, 'README.md'), 'base\n'); git('add', 'README.md'); git('commit', '-m', 'base');
    git('branch', '-M', 'main');
    const head = git('rev-parse', 'HEAD'), runId = 'worker-run', token = 'worker-token';
    const task = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Responsible task', repoPath: f.dir,
      planningCommit: head, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', head,
      { phase: 'working', reason: 'Worker running', responsible: true, workspaceIntent: true, workspaceId: `ws-${'a'.repeat(8)}`,
        directory: f.dir, agentIntent: true, agentId: `agent-${'a'.repeat(8)}`, runId, profile, profileGroup: 'test' }, { runId, token });
    // Align the fixture's deterministic adapter identity with this generated task.
    f.store.update(task.id, { workspaceId: `ws-${task.id}`, agentId: `agent-${task.id}` });
    f.store.setMeta('paused', false);
    f.idle();
    const completion = { eventId: 'worker-empty-race', taskId: task.id, runId, status: 'blocked' as const,
      summary: 'Setup is confirmed; I read the pilot recipe', head };
    await f.engine.complete(completion, token);
    // The first pass stalls on a network-bound read after it has read the blocked return. A second pass
    // records the same-thread push-back while it waits; the stalled pass then resumes past the push-back guard.
    const resolution = f.engine.resolution as unknown as { heavyRunAlive(t: Task): Promise<boolean> };
    const original = resolution.heavyRunAlive.bind(resolution);
    let stalled = true;
    resolution.heavyRunAlive = async (t: Task) => {
      if (stalled) { stalled = false; await f.engine.wakeTask(task.id); }
      return original(t);
    };
    await f.engine.wakeTask(task.id);
    const current = f.store.task(task.id);
    const events = f.store.eventsAll(task.id).map(event => [event.kind, event.detail.slice(0, 80)]);
    assert.equal(current.phase, 'changes_requested', JSON.stringify({ phase: current.phase, reason: current.reason, events }));
    assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'non_delivery_pushback' || event.kind === 'unfinished_pushback').length, 1);
    assert.equal(f.store.eventsAll(task.id).some(event => event.kind === 'recovery_pending'), false, 'the continuation starts no recovery');
  } finally { await f.close(); }
});
test('an observed provider failure on an empty return keeps its existing handling, not a same-thread continuation', async () => {
  const f = fixture(); try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.dir, encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Queue test'); git('config', 'user.email', 'queue-test@example.test');
    writeFileSync(join(f.dir, 'README.md'), 'base\n'); git('add', 'README.md'); git('commit', '-m', 'base');
    git('branch', '-M', 'main');
    const head = git('rev-parse', 'HEAD'), runId = 'worker-run', token = 'worker-token';
    const task = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Responsible task', repoPath: f.dir,
      planningCommit: head, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', head,
      { phase: 'working', reason: 'Worker running', responsible: true, workspaceIntent: true, workspaceId: `ws-${'a'.repeat(8)}`,
        directory: f.dir, agentIntent: true, agentId: `agent-${'a'.repeat(8)}`, runId, profile, profileGroup: 'test' }, { runId, token });
    // Align the fixture's deterministic adapter identity with this generated task.
    f.store.update(task.id, { workspaceId: `ws-${task.id}`, agentId: `agent-${task.id}` });
    f.store.setMeta('paused', false);
    // The retained thread's observed error is the provider's own quota refusal.
    f.idle('insufficient_quota: the usage limit for this key is exhausted');
    const completion = { eventId: 'worker-empty-quota', taskId: task.id, runId, status: 'blocked' as const,
      summary: 'Setup is confirmed; I read the pilot recipe', head };
    await f.engine.complete(completion, token);
    await f.engine.wakeTask(task.id);
    const current = f.store.task(task.id);
    const events = f.store.eventsAll(task.id);
    assert.equal(events.filter(event => ['unfinished_pushback', 'non_delivery_pushback'].includes(event.kind)).length, 0,
      'a quota-exhausted thread is never pushed back into the same provider');
    assert.notEqual(current.phase, 'changes_requested', JSON.stringify({ reason: current.reason, events: events.map(event => [event.kind, event.detail]) }));
  } finally { await f.close(); }
});
test('a responsible worker unfinished return with new commits continues the same round', async () => {
  const f = fixture(); try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.dir, encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Queue test'); git('config', 'user.email', 'queue-test@example.test');
    writeFileSync(join(f.dir, 'README.md'), 'base\n'); git('add', 'README.md'); git('commit', '-m', 'base');
    const head = git('rev-parse', 'HEAD'), runId = 'worker-run', token = 'worker-token';
    const task = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Responsible task', repoPath: f.dir,
      planningCommit: head, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', head,
      { phase: 'working', reason: 'Worker running', responsible: true, workspaceIntent: true, workspaceId: `ws-${'a'.repeat(8)}`,
        directory: f.dir, agentIntent: true, agentId: `agent-${'a'.repeat(8)}`, runId, profile, profileGroup: 'test' }, { runId, token });
    // Align the fixture's deterministic adapter identity with this generated task.
    f.store.update(task.id, { workspaceId: `ws-${task.id}`, agentId: `agent-${task.id}` });
    f.store.setMeta('paused', false);
    f.idle();
    // Partial progress past the starting head, then an unfinished return with no external cause.
    writeFileSync(join(f.dir, 'wrapper.ts'), 'partial\n'); git('add', 'wrapper.ts'); git('commit', '-m', 'partial wrapper');
    const progressed = git('rev-parse', 'HEAD');
    const completion = { eventId: 'worker-unfinished', taskId: task.id, runId, status: 'blocked' as const,
      summary: 'Error: implementation remains unfinished; the wrapper is in but the full inventory is still unwritten' };
    await f.engine.complete(completion, token);
    await f.engine.wakeTask(task.id);
    const current = f.store.task(task.id);
    const record = JSON.parse(f.store.eventsAll(task.id).find(event => event.kind === 'unfinished_continuation')!.detail);
    assert.deepEqual([record.role, record.baselineHead, record.observedHead], ['worker', head, progressed]);
    assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'non_delivery').length, 0);
    assert.equal(current.phase, 'changes_requested', JSON.stringify({ reason: current.reason, completion: current.completion,
      events: f.store.eventsAll(task.id).map(event => [event.kind, event.detail]) }));
    assert.match(current.reason, /continue the same approved round/);
    assert.equal(current.resolution.pendingRevisionCause, 'unfinished');
  } finally { await f.close(); }
});
test('new pushed commits alone make a blocked return unfinished work, whatever its summary says', async () => {
  const f = fixture(); try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.dir, encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Queue test'); git('config', 'user.email', 'queue-test@example.test');
    writeFileSync(join(f.dir, 'README.md'), 'base\n'); git('add', 'README.md'); git('commit', '-m', 'base');
    const head = git('rev-parse', 'HEAD'), runId = 'worker-run', token = 'worker-token';
    const task = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Responsible task', repoPath: f.dir,
      planningCommit: head, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', head,
      { phase: 'working', reason: 'Worker running', responsible: true, workspaceIntent: true, workspaceId: `ws-${'a'.repeat(8)}`,
        directory: f.dir, agentIntent: true, agentId: `agent-${'a'.repeat(8)}`, runId, profile, profileGroup: 'test' }, { runId, token });
    f.store.update(task.id, { workspaceId: `ws-${task.id}`, agentId: `agent-${task.id}` });
    f.store.setMeta('paused', false);
    f.idle();
    // Real pushed progress, and a summary that names no unfinished wording at all.
    writeFileSync(join(f.dir, 'wrapper.ts'), 'partial\n'); git('add', 'wrapper.ts'); git('commit', '-m', 'partial wrapper');
    const progressed = git('rev-parse', 'HEAD');
    const completion = { eventId: 'worker-stopped', taskId: task.id, runId, status: 'blocked' as const,
      summary: 'Stopped after landing the wrapper so the next turn can start from it' };
    await f.engine.complete(completion, token);
    await f.engine.wakeTask(task.id);
    const current = f.store.task(task.id);
    const record = JSON.parse(f.store.eventsAll(task.id).find(event => event.kind === 'unfinished_continuation')!.detail);
    assert.deepEqual([record.role, record.observedHead], ['worker', progressed], 'pushed commits are the evidence');
    assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'non_delivery').length, 0, 'not a fault');
    assert.equal(current.phase, 'changes_requested', JSON.stringify({ reason: current.reason, completion: current.completion,
      events: f.store.eventsAll(task.id).map(event => [event.kind, event.detail]) }));
    assert.equal(current.resolution.pendingRevisionCause, 'unfinished');
  } finally { await f.close(); }
});
test('a stopped callback-free worker discovers its exact branch PR before coordinator recovery', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused', false);
    const original = f.add();
    f.store.update(original.id, {
      phase: 'blocked', reason: 'Worker transport failed before callback', workspaceIntent: true,
      workspaceId: `ws-${original.id}`, directory: '/fixture', agentIntent: true,
      agentId: `agent-${original.id}`, runId: 'initial', profile, profileGroup: 'test',
    });
    f.observe({ status: 'error', active: false, error: 'transient socket failure' });
    f.adapter.findOpenBranchPr = async task => {
      f.calls.branchPrLookups++;
      assert.equal(task.branch, `ns-${task.id}`);
      return [{ number: 51, url: 'https://github.com/example/repo/pull/51', head: 'abc' }];
    };
    await f.engine.wake();
    const reconciled = f.store.task(original.id);
    assert.equal(reconciled.phase, 'changes_requested');
    assert.equal(reconciled.resumePrNumber, 51);
    assert.equal(reconciled.prUrl, 'https://github.com/example/repo/pull/1');
    assert.equal(reconciled.prHead, 'abc');
    assert.match(reconciled.reason, /authenticated readiness confirmation/);
    assert.equal(f.calls.branchPrLookups, 1);
    assert.equal(f.store.runs(original.id).filter(run => run.role === 'recovery').length, 0);
    assert.ok(f.store.eventsAll(original.id).some(event => event.kind === 'initial_pr_reconciled'));
  } finally { await f.close(); }
});
test('a blocked completion keeps its block when the branch PR the worker pushed is discovered', async () => {
  // A blocked completion is the worker's own authenticated block, not a PR report. Queue #392
  // (Tom, 2026-10-24): g05.167's shape — the worker pushed its PR and then reported a blocker —
  // used to arm an instruction-free readiness confirmation, which turned the block into review
  // readiness on the same head (Queue387: required tsc/tsx checks unrun, exit 127, then
  // awaiting_review). Discovery now records the PR's identity only, so the block keeps its
  // reason and findings and the retained worker's explicit continuation resumes that same PR.
  const f = fixture(); try {
    f.store.setMeta('paused', false);
    const original = f.add();
    f.store.update(original.id, {
      phase: 'blocked', reason: 'Worker reported a blocker after pushing its PR', workspaceIntent: true,
      workspaceId: `ws-${original.id}`, directory: '/fixture', agentIntent: true,
      agentId: `agent-${original.id}`, runId: 'initial', profile, profileGroup: 'test',
      completion: { eventId: 'blocked', taskId: original.id, runId: 'initial', status: 'blocked', summary: 'Blocked on credentials; the PR is open at the pushed head' },
    });
    f.observe({ status: 'error', active: false, error: 'transient socket failure' });
    f.adapter.findOpenBranchPr = async task => {
      f.calls.branchPrLookups++;
      assert.equal(task.branch, `ns-${task.id}`);
      return [{ number: 51, url: 'https://github.com/example/repo/pull/51', head: 'abc' }];
    };
    await f.engine.wake();
    const reconciled = f.store.task(original.id);
    assert.equal(reconciled.phase, 'blocked', `reason=${reconciled.reason}`);
    // Queue #912: escalation routes by host, so the planner ladder now takes this block; the wait names that escalation and the report stays evidence.
    assert.match(reconciled.reason, /^Waiting with the planner or task owner .*: blocker escalation .* is open$/, 'the ladder wait names its open escalation');
    assert.equal(reconciled.completion?.status, 'blocked', 'the worker blocker report is preserved');
    assert.equal(reconciled.completion?.eventId, 'blocked');
    assert.equal(reconciled.resumePrNumber, 51, 'the discovered identity is recorded');
    assert.equal(reconciled.prHead, 'abc');
    assert.equal(reconciled.prUrl, 'https://github.com/example/repo/pull/1');
    assert.equal(reconciled.resolution.revisionResumeUnpublished, false, 'no readiness confirmation is armed');
    assert.equal(f.store.runs(original.id).length, 0, 'no identity-only continuation or reviewer is dispatched');
    assert.equal(f.store.eventsAll(original.id).filter(event => event.kind === 'blocked_pr_identity_recorded').length, 1);
    assert.equal(f.store.eventsAll(original.id).some(event => event.kind === 'initial_pr_reconciled'), false);
  } finally { await f.close(); }
});
test('a consumed blocked receipt is not re-emitted on every branch-PR audit pass', async () => {
  // g01.050 minted 1,618 task.blocked occurrences in nine hours: the audit reconciled the
  // blocked lane every pass and each reconcile re-processed the same receipt.
  const f = fixture(); try {
    f.store.setMeta('paused', false);
    const original = f.add();
    f.store.update(original.id, {
      phase: 'working', reason: 'Worker stopped without a completion callback; inspect the thread', workspaceIntent: true,
      workspaceId: `ws-${original.id}`, directory: '/fixture', agentIntent: true,
      agentId: `agent-${original.id}`, runId: 'initial', profile, profileGroup: 'test',
      resolution: { ...original.resolution, attention: true },
      completion: { eventId: 'blocked', taskId: original.id, runId: 'initial', status: 'blocked', summary: 'Blocked before edits: environment cannot open the fixture' },
    });
    f.idle();
    let lookups = 0, emissions = 0;
    f.adapter.findOpenBranchPr = async () => { lookups++; return []; };
    const emit = f.engine.hooks.emit.bind(f.engine.hooks);
    f.engine.hooks.emit = async (event: any, task: any, context: any, accept?: any) => { if (event === 'task.blocked') emissions++; return emit(event, task, context, accept); };
    await f.engine.wake();
    assert.equal(f.store.task(original.id).phase, 'blocked');
    assert.equal(f.store.task(original.id).resolution.attention, false, 'late completion clears the stopped-worker attention flag');
    for (let i = 0; i < 3; i++) await f.engine.wake();
    assert.equal(emissions, 1, 'the blocked receipt runs its lifecycle hook once');
    assert.equal(f.store.hookEvents(original.id).filter(record => record.event === 'task.blocked').length <= 1, true, 'no fresh occurrence per pass');
    assert.equal(f.store.task(original.id).phase, 'blocked');
    assert.equal(f.store.eventsAll(original.id).filter((event: any) => event.kind === 'workspace_released').length, 1, 'the receipt is processed once');
    assert.ok(lookups >= 2, 'PR discovery still runs for the blocked lane');
  } finally { await f.close(); }
});
test('a cancelled task is never reconciled back to blocked, and a reopened one is restored with its outcome row', async () => {
  // g05.222: cancelled at 22:42:57; a branch-PR audit that had picked the lane earlier
  // reconciled it at 22:43 and re-processed the worker's old blocked receipt.
  const f = fixture(); try {
    f.store.setMeta('paused', false);
    const original = f.add();
    const completion = { eventId: 'blocked', taskId: original.id, runId: 'initial', status: 'blocked' as const, summary: 'Blocked on missing autosave' };
    f.store.update(original.id, { phase: 'blocked', reason: completion.summary, workspaceIntent: true,
      workspaceId: `ws-${original.id}`, directory: '/fixture', agentIntent: true, agentId: `agent-${original.id}`, runId: 'initial', profile, profileGroup: 'test', completion });
    const disposition = dispositionSchema.parse({ kind: 'cancel', status: 'complete', requestedAt: new Date().toISOString(), requestedBy: 'operator control', reason: 'Tom: cancel and replan', workDisposition: 'archive_if_empty', hookEmitted: true });
    const cancelled = f.store.update(original.id, { phase: 'cancelled', reason: 'Cancelled: Tom: cancel and replan', disposition });
    let emissions = 0;
    const emit = f.engine.hooks.emit.bind(f.engine.hooks);
    f.engine.hooks.emit = async (event: any, task: any, context: any, accept?: any) => { if (event === 'task.blocked') emissions++; return emit(event, task, context, accept); };
    await (f.engine as any).reconcile(cancelled);
    assert.equal(f.store.task(original.id).phase, 'cancelled', 'reconcile leaves a disposed task alone');
    assert.equal(emissions, 0);
    // The live corruption: a completed disposition sitting in a reopened phase.
    f.store.db.prepare('DELETE FROM outcomes WHERE taskId=?').run(original.id);
    const reopened = f.store.update(original.id, { phase: 'blocked', reason: completion.summary });
    assert.equal(reopened.disposition?.status, 'complete');
    const { Lifecycle } = await import('../core/closeout/workspace-lifecycle');
    await new Lifecycle(f.engine).pass();
    const restored = f.store.task(original.id);
    assert.equal(restored.phase, 'cancelled');
    assert.ok(f.store.events(original.id).some((event: any) => event.kind === 'terminal_phase_restored'));
    assert.equal(f.store.outcome(original.id)?.outcome, 'cancelled', 'the permanent outcome row is written on restore');
  } finally { await f.close(); }
});
test('stale worker snapshots cannot overwrite a newer revision request', async () => {
  const f = fixture(); try {
    const t = f.add(); f.store.setMeta('paused', false); await f.engine.wake(); f.idle();
    const working = f.store.task(t.id);
    f.store.update(t.id, { completion: { eventId: 'ready', taskId: t.id, runId: working.runId!, status: 'ready_for_review', summary: 'Ready', prNumber: 1 } });
    const stale = f.store.task(t.id);
    f.store.update(t.id, { phase: 'changes_requested', reason: 'Repair PR identity', resolution: { ...stale.resolution, revisionPrRepair: true } });
    await (f.engine as any).reconcile(stale);
    assert.equal(f.store.task(t.id).phase, 'changes_requested');assert.equal(f.calls.reviews, 0);
  } finally { await f.close(); }
});
test('an accepted worker receipt cannot reopen review after a later pre-merge hold', async () => {
  const f = fixture(); try {
    const original = f.add(); f.store.setMeta('paused', false); await f.engine.wake(); f.idle();
    const working = f.store.task(original.id);
    const head = 'b'.repeat(40);
    const completion = { eventId: 'ready', taskId: original.id, runId: working.runId!, status: 'ready_for_review' as const, summary: 'Ready', prNumber: 1 };
    const held = f.store.update(original.id, {
      phase: 'needs_attention', reason: 'Repository pre-merge refusal requires coordinator judgment', completion,
      prHead: head, prUrl: 'https://github.com/example/repo/pull/1',
      resolution: { ...working.resolution, review: { eventId: 'review', taskId: original.id, runId: 'review-run', status: 'ready_to_merge', summary: 'Approved', prNumber: 1, head, reviewCommentId: 1 } },
    });
    await (f.engine as any).reconcile(held);
    const retained = f.store.task(original.id);
    assert.equal(retained.phase, 'needs_attention');
    assert.equal(retained.resolution.review?.status, 'ready_to_merge');
    assert.equal(f.calls.reviews, 0);
  } finally { await f.close(); }
});
test('unknown workspace creation is recovered only from positive identity, never retried blindly', async () => {
  const f = fixture(); try {
    const t = f.add(); f.store.setMeta('paused', false);
    f.adapter.createWorkspace = async () => { f.calls.workspaces++; throw new Error('connection lost'); };
    await f.engine.wake(); await f.engine.wake(); assert.equal(f.calls.workspaces, 1); assert.equal(f.calls.agents, 0);
    f.adapter.findWorkspaces = async () => [{ id: `ws-${t.id}`, directory: '/fixture' }];
    await f.engine.wake(); assert.equal(f.calls.agents, 1); assert.equal(f.calls.workspaces, 1);
  } finally { await f.close(); }
});
test('explicit resume replaces a definitively absent initial worker in the retained workspace',async()=>{
  const f=fixture();try{
    const original=f.add(),runId='timed-out-run';
    const uncertain=f.store.update(original.id,{phase:'needs_attention',reason:ABSENT_WORKER_REASON,workspaceIntent:true,workspaceId:`ws-${original.id}`,directory:'/fixture',profile,profileGroup:'test',planningBase:original.planningCommit,agentIntent:true,runId});
    f.store.setCredential(runId,'old-token');let lookups=0,purged:string[]=[];
    f.adapter.findAgents=async()=>{lookups++;return[]};f.adapter.purgeReportingFiles=(_task,runs)=>{purged=runs};
    const ready=await f.engine.performTaskControl({ taskId: uncertain.id, version: uncertain.version, action: 'restart', role: 'worker', reason: 'Resume the retained worker', instruction: 'Continue the original handoff' });
    assert.equal(ready.phase,'dispatching');assert.equal(ready.workspaceId,uncertain.workspaceId);assert.equal(ready.profile?.id,profile.id);
    assert.equal(ready.agentIntent,false);assert.equal(ready.agentId,null);assert.equal(ready.runId,runId);assert.equal(ready.restartRunId,runId);assert.deepEqual(purged,[runId]);assert.equal(lookups,1);
    assert.throws(()=>f.store.authenticate(runId,'old-token'),/Unauthorized/);
    f.store.setMeta('paused',false);await f.engine.wake();const running=f.store.task(uncertain.id);
    assert.equal(running.phase,'working');assert.equal(running.runId,runId,'the retried creation reuses the same run ID');assert.equal(running.workspaceId,uncertain.workspaceId);assert.equal(f.calls.workspaces,0);assert.equal(f.calls.agents,1);
  }finally{await f.close()}
});
test('Pi settings-lock launch failure retries once after backoff in the retained workspace',async()=>{
  const f=fixture();try{
    const original=f.add();let attempts=0;const launchError='Invalid settings file ~/.pi/agent/settings.json: Lock file is already being held\nUnknown option: --mcp-config';
    f.adapter.createAgent=async t=>{attempts++;if(attempts===1)throw Error(launchError);return{id:'retried-worker',workspaceId:t.workspaceId}};
    f.store.setMeta('paused',false);await f.engine.wake();
    const failed=f.store.task(original.id),workspaceId=failed.workspaceId;
    assert.equal(attempts,1);assert.equal(failed.phase,'dispatching');assert.equal(failed.reason,PRE_AGENT_LAUNCH_FAILURE_REASON);
    assert.equal(failed.transientProviderRetry?.status,'waiting');assert.equal(failed.transientProviderRetry?.resumes,0);
    assert.equal(failed.transientProviderRetry?.runId,failed.runId);assert.equal(f.calls.workspaces,1);
    await f.engine.wake();assert.equal(attempts,1,'the persisted backoff prevents an early creation retry');
    const waiting=f.store.task(original.id);
    f.store.update(original.id,{transientProviderRetry:{...waiting.transientProviderRetry!,retryAt:'2000-01-01T00:00:00.000Z'}});
    await f.engine.wake();
    await f.engine.wake();
    const retried=f.store.task(original.id);
    assert.equal(attempts,2);assert.equal(retried.agentId,'retried-worker');assert.equal(retried.phase,'working');
    assert.equal(retried.workspaceId,workspaceId);assert.equal(f.calls.workspaces,1);
    assert.equal(f.store.events(original.id).filter(event=>event.kind==='absent_worker_retry').length,1);
  }finally{await f.close()}
});
test('absent-worker resume preserves an uncertain intent when a matching worker appears',async()=>{
  const f=fixture();try{
    const original=f.add(),runId='uncertain-run';
    const uncertain=f.store.update(original.id,{phase:'needs_attention',reason:ABSENT_WORKER_REASON,workspaceIntent:true,workspaceId:`ws-${original.id}`,directory:'/fixture',profile,planningBase:original.planningCommit,agentIntent:true,runId});
    f.store.setCredential(runId,'old-token');let purged=false;
    f.adapter.findAgents=async()=>[{id:'late-worker',workspaceId:uncertain.workspaceId}];f.adapter.purgeReportingFiles=()=>{purged=true};
    await assert.rejects(f.engine.performTaskControl({ taskId: uncertain.id, version: uncertain.version, action: 'restart', role: 'worker', reason: 'Resume the retained worker', instruction: 'Continue' }),/no longer proven absent/);
    const retained=f.store.task(uncertain.id);assert.equal(retained.agentIntent,true);assert.equal(retained.runId,runId);assert.equal(retained.agentId,null);
    assert.equal(purged,false);assert.doesNotThrow(()=>f.store.authenticate(runId,'old-token'));assert.equal(f.calls.agents,0);
  }finally{await f.close()}
});
test('a transient initial worker error resumes the same run in its retained thread',async()=>{
 const f=fixture();try{
  f.store.setMeta('paused',false);const submitted=f.add();await f.engine.wake();
  const initial=f.store.task(submitted.id),runId=initial.runId!,agentId=initial.agentId!,head=initial.planningBase;
  f.store.authenticate(runId,f.tokens.get(initial.id)!);
  const continuations:{intentId:string;text:string}[]=[];
  f.adapter.continueWorker=async(_task,intentId,text)=>{continuations.push({intentId,text});f.observe({status:'running',active:true,error:'',updatedAt:new Date().toISOString()})};
  f.observe({status:'error',active:false,error:'opencode-go API error (429): rate_limit_error; retry after a brief wait',updatedAt:new Date().toISOString()});
  await f.engine.wake();
  const waiting=f.store.task(initial.id);assert.equal(waiting.transientProviderRetry?.status,'waiting');assert.equal(waiting.runId,runId);
  f.store.update(initial.id,{transientProviderRetry:{...waiting.transientProviderRetry!,retryAt:'2000-01-01T00:00:00.000Z'}});
  await f.engine.wake();
  const resumed=f.store.task(initial.id);
  assert.equal(resumed.runId,runId);assert.equal(resumed.agentId,agentId);assert.equal(resumed.planningBase,head);
  assert.equal(resumed.transientProviderRetry?.status,'sent');assert.equal(resumed.transientProviderRetry?.resumes,1);
  assert.equal(continuations.length,1);assert.match(continuations[0].text,/Continue where you left off; report via your existing authenticated callback/);
  assert.doesNotThrow(()=>f.store.authenticate(runId,f.tokens.get(initial.id)!),'the existing run callback credential remains valid');
 }finally{await f.close()}
});
test('an errored worker is replaced only after its same-thread continuation is refused',async()=>{
 const f=fixture();try{
  f.store.setMeta('paused',false);
  const backup:Profile={...profile,id:'backup',name:'Backup',model:'backup-model'};
  f.engine.profiles=[profile,backup];
  f.store.setMeta('pool',[
   {profileId:profile.id,enabled:true,group:'test',weight:1,roles:['worker'],scopes:['general']},
   {profileId:backup.id,enabled:true,group:'backup',weight:1,roles:['worker'],scopes:['general']},
  ]);
  f.adapter.verifyResume=async()=>{};
  const submitted=f.add();await f.engine.wake();const initial=f.store.task(submitted.id);
  const runId=initial.runId!,workspaceId=initial.workspaceId;
  f.adapter.continueWorker=async()=>{throw new ProvenPreSendRefusalError('Retained thread is archived; no continuation was sent')};
  f.observe({status:'error',active:false,error:'provider error'});
  await f.engine.wake();
  const waiting=f.store.task(submitted.id);
  f.store.update(submitted.id,{transientProviderRetry:{...waiting.transientProviderRetry!,retryAt:'2000-01-01T00:00:00.000Z'}});
  await f.engine.wake();
  const replaced=f.store.task(submitted.id);
  assert.ok(replaced.agentId,'replacement worker was created');
  assert.notEqual(replaced.runId,runId);
  assert.equal(replaced.workspaceId,workspaceId);
  assert.equal(f.calls.workspaces,1,'replacement stays in the retained workspace');
  assert.equal(f.calls.agents,2,'one replacement is created after the refused continuation');
  assert.ok(f.store.events(submitted.id).some(event=>event.kind==='worker_resume_refused'));
  assert.equal(f.store.runs(submitted.id).some(run=>run.role==='recovery'),false,'the errored worker never enters coordinator recovery');
 }finally{await f.close()}
});
test('explicit worker resume supersedes initial transient retry and its stale missing-callback wait',async()=>{
 const f=fixture();try{
  f.store.setMeta('paused',false);const submitted=f.add();await f.engine.wake();f.idle();
  const initial=f.store.task(submitted.id),runId=initial.runId!;
  let sends=0;f.adapter.continueWorker=async()=>{sends++};
  const error='opencode-go API error (429): rate_limit_error; retry after a brief wait';
  const stopped=f.store.update(initial.id,{phase:'needs_attention',transientProviderRetry:{runId,resumes:0,status:'waiting',error,retryAt:'2000-01-01T00:00:00.000Z',messageId:null,resumedAt:null,observedUpdatedAt:null,sawProgress:false}});
  f.engine.resolution.resumeWorker(stopped,'Report the completed work only; no edits or repeated checks',true);
  const resumed=f.store.task(initial.id),version=resumed.version;
  const observation={id:initial.agentId!,workspaceId:initial.workspaceId!,status:'error' as const,active:false,permissions:false,error};
  assert.equal(await f.engine.resolution.resumeTransientWorker(stopped,observation),false,'fresh state overrides a stale pre-resume sweep snapshot');
  assert.equal(sends,0);assert.equal(f.store.task(initial.id).version,version);
  f.store.update(initial.id,{prUrl:'https://github.com/example/repo/pull/1',prHead:'abc',resumePrNumber:1,transientProviderRetry:{...stopped.transientProviderRetry!,status:'sent',resumes:1,resumedAt:'2000-01-01T00:00:00.000Z',sawProgress:true}});
  const reconciled=f.store.task(initial.id),reconciledVersion=reconciled.version;
  assert.equal(await f.engine.resolution.resumeTransientWorker(reconciled,{...observation,status:'idle',error:''}),false);
  assert.equal(f.store.task(initial.id).version,reconciledVersion,'old transient missing-callback evidence cannot overwrite the pending report-only revision');
  assert.equal(f.store.task(initial.id).resolution.pendingWorkerInstruction,resumed.resolution.pendingWorkerInstruction);
 }finally{await f.close()}
});
test('recovery retry resumes a stopped pre-callback worker on its retained thread (Spec 058 task 577)',async()=>{
  const f=fixture();try{
    f.store.setMeta('paused',false);const initial=f.add();await f.engine.wake();f.idle();
    const failed=f.store.update(initial.id,{phase:'needs_attention',reason:'provider protocol error'});
    f.adapter.verifyResume=async()=>{};
    f.adapter.observe=async id=>({id,workspaceId:failed.workspaceId,status:'idle',active:false,permissions:false,error:''});
    const sent:string[]=[];const stubs=f.adapter as unknown as {
      createRun:(t:unknown,r:{ id: string; workspaceId: string },token:string)=>Promise<{ id: string; workspaceId: string }>;
      sendRun:(t:unknown,r:{ agentId: string })=>Promise<void> };
    stubs.createRun=async (_t,r)=>({ id:`agent-${r.id}`, workspaceId:r.workspaceId });
    stubs.sendRun=async (_t,r)=>{sent.push(r.agentId!)};
    f.engine.resolution.retry(failed);
    const resumed=f.store.task(failed.id);
    assert.equal(resumed.phase,'changes_requested');
    assert.equal(resumed.failoverReason,'', 'no replacement is armed without a failure or an approved model change');
    assert.equal(resumed.replacementProfile,null);
    assert.equal(resumed.agentId,failed.agentId,'the retained worker is kept');
    await f.engine.wake();
    const continued=f.store.task(failed.id);
    assert.equal(continued.retiredWorkers.length,0,'no worker is retired');
    assert.equal(continued.agentId,failed.agentId);
    assert.deepEqual(sent,[failed.agentId!],'the continuation run goes to the retained worker');
    assert.equal(f.calls.workspaces,1);
  }finally{await f.close()}
});
test('a completed worker clears its pending replacement profile with the failover reason',async()=>{
  const f=fixture();try{
    f.store.setMeta('paused',false);const task=f.add();await f.engine.wake();
    const working=f.store.task(task.id);
    f.store.update(task.id,{failoverReason:'Replace stopped worker',replacementProfile:{profileId:'backup',reason:'Use stronger model'},
      completion:{eventId:'ready',taskId:task.id,runId:working.runId!,status:'ready_for_review',summary:'Finished',prNumber:1}});
    await (f.engine as any).recoverExhaustedWorkers();
    const recovered=f.store.task(task.id);
    assert.equal(recovered.failoverReason,'');assert.equal(recovered.replacementProfile,null);
    assert.equal(f.store.events(task.id).filter(event=>event.kind==='worker_recovered').length,1);
  }finally{await f.close()}
});
test('group counts pace under the per-model share order; unavailability and strict preferences hold', async () => {
  const f = fixture(); try {
    const t = f.add(); const profiles = [profile, { ...profile, id: 'second' }, { ...profile, id: 'third' }];
    const pool = profiles.map((p, i) => ({ profileId: p.id, enabled: true, group: i === 2 ? 'b' : 'a', weight: 1, roles: ['worker' as const], scopes: ['general' as const] }));
    assert.equal(chooseProfile(t, profiles, pool, { a: 2, b: 1 }, new Set())?.entry.group, 'b');
    assert.equal(chooseProfile(t, profiles, pool, {}, new Set(['a']))?.profile.id, 'third');
    assert.equal(chooseProfile({ ...t, preferredProfileId: 'worker', requirePreferred: true }, profiles, pool, {}, new Set(['a'])), null);
  } finally { await f.close(); }
});
test('recent assignment window drives rotation while lifetime use only breaks ties',async()=>{
  const f=fixture();try{
    const task=f.add(),profiles=[{...profile,id:'a'},{...profile,id:'b'},{...profile,id:'c'}];
    const pool=profiles.map(p=>({profileId:p.id,enabled:true,group:p.id,weight:1,roles:['worker' as const],scopes:['general' as const]}));
    for(const [key,count] of [['a',38],['b',65],['c',105]] as const)f.store.db.prepare('INSERT INTO assignments VALUES(?,?)').run(key,count);
    const selected:string[]=[];
    for(let i=0;i<5;i++){
      const choice=chooseProfile(task,profiles,pool,f.store.counts(),new Set(),'worker',f.store.recentCounts())!;
      selected.push(choice.entry.group);f.store.transaction(()=>f.store.chargeAssignment(choice.entry.group,choice.profile.id));
    }
    assert.deepEqual(selected,['a','b','c','a','b']);
    for(let i=0;i<50;i++)f.store.transaction(()=>f.store.chargeAssignment('c','c'));
    assert.deepEqual(f.store.recentCounts(),{c:50,'profile:c':50});
    // Task 987: the history keeps the 50 rows the picker reads, not 1,000.
    assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM assignment_history').get()!.count,50);
  }finally{await f.close()}
});
test('a weight-2 model takes twice the assignments of a weight-1 model across subscription groups',async()=>{
  const f=fixture();try{
    const task=f.add(),profiles=[{...profile,id:'heavy'},{...profile,id:'light'}];
    const pool=[{profileId:'heavy',enabled:true,group:'sub-a',weight:2,roles:['worker' as const],scopes:['general' as const]},{profileId:'light',enabled:true,group:'sub-b',weight:1,roles:['worker' as const],scopes:['general' as const]}];
    const picked:string[]=[];
    for(let i=0;i<24;i++){
      const choice=chooseProfile(task,profiles,pool,f.store.counts(),new Set(),'worker',f.store.recentCounts())!;
      picked.push(choice.profile.id);f.store.transaction(()=>f.store.chargeAssignment(choice.entry.group,choice.profile.id));
    }
    assert.equal(picked.filter(p=>p==='heavy').length,16);
    assert.equal(picked.filter(p=>p==='light').length,8);
    assert.equal(picked[0],'heavy');assert.equal(picked[1],'light');
  }finally{await f.close()}
});
test('a group counter never outranks a per-model share and an unavailable group still blocks',async()=>{
  const f=fixture();try{
    const task=f.add(),profiles=[{...profile,id:'weighted'},{...profile,id:'other'}];
    const pool=[{profileId:'weighted',enabled:true,group:'sub-a',weight:2,roles:['worker' as const],scopes:['general' as const]},{profileId:'other',enabled:true,group:'sub-b',weight:1,roles:['worker' as const],scopes:['general' as const]}];
    // The weighted model is half-paced per model, but its group looks fresher:
    // the per-model share decides and the sub-b group count must not outrank it.
    const recent={'profile:weighted':4,'sub-a':0,'sub-b':9};
    assert.equal(chooseProfile(task,profiles,pool,{},new Set(),'worker',recent)?.profile.id,'other');
    // Availability stays a hard gate whatever the weights say.
    assert.equal(chooseProfile(task,profiles,pool,{},new Set(['sub-a']),'worker',recent)?.profile.id,'other');
    assert.equal(chooseProfile(task,profiles,pool,{},new Set(['sub-a','sub-b']),'worker',recent),null);
  }finally{await f.close()}
});
test('real Unix socket helper delivers an authenticated, repeatable receipt while paused', async () => {
  const f = fixture(); let close: (() => Promise<void>) | undefined; try {
    const t = f.add(); f.store.setMeta('paused', false); await f.engine.wake(); f.store.setMeta('paused', true);
    const socket = join(f.dir, 'callback.sock'), helper = join(f.dir, 'report.mjs');
    close = await startCallbacks(socket, helper, f.engine);
    const run = (prefix='NUCLEUS') => new Promise<string>((resolve, reject) => {
      const inherited=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('NORTHSTAR_')&&!key.startsWith('NUCLEUS_')));
      const child = spawn(process.execPath, [helper], { env: { ...inherited, [`${prefix}_SOCKET`]: socket, [`${prefix}_TASK_ID`]: t.id, [`${prefix}_RUN_ID`]: f.store.task(t.id).runId!, [`${prefix}_RUN_TOKEN`]: f.tokens.get(t.id)! } });
      let out = '', err = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c); child.on('error', reject); child.on('close', code => code === 0 ? resolve(out) : reject(new Error(err))); child.stdin.end(JSON.stringify({ status: 'blocked', summary: 'No remote' }));
    });
    const first = await run(); assert.equal(JSON.parse(first).accepted, true); assert.equal(await run(), first);
    // The retired environment family is never a live session's callback credential.
    await assert.rejects(run('NORTHSTAR'), /Missing Nucleus callback environment/);
    assert.equal(f.store.task(t.id).phase, 'working');
  } finally { await close?.(); await f.close(); }
});

test('schema 50 upgrade preserves pause, limits, identities, credentials and receipts', async () => {
 const f=fixture(); let upgraded: Store | undefined;
 try {
  const task=f.add();f.store.setMeta('paused',true);f.store.setMeta('globalLimit',32);f.store.setMeta('projectLimit',5);
  f.store.update(task.id,{phase:'working',runId:'legacy-run',agentId:'legacy-agent',workspaceId:'legacy-workspace'});
  f.store.setCredential('legacy-run','test-only-token');
  const result={taskId:task.id,runId:'legacy-run',eventId:'legacy-event',status:'blocked' as const,summary:'Legacy result'};
  f.store.acceptCompletion(result,'test-only-token',null);
  const legacy:any=f.store.task(task.id);delete legacy.resolution;delete legacy.workerModel;delete legacy.workerModels;
  f.store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(legacy),task.id);
  f.store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
  f.store.setMeta('schema',50);
  upgraded=new Store(f.path);
  assert.equal(upgraded.getMeta('schema'), CURRENT_SCHEMA);assert.equal(upgraded.getMeta('paused'),true);assert.equal(upgraded.getMeta('globalLimit'),32);
  assert.equal(upgraded.hookEvents(task.id).length,0);
  assert.equal(upgraded.getMeta('projectLimit'),5);
  assert.equal(upgraded.task(task.id).agentId,'legacy-agent');assert.equal(upgraded.task(task.id).workspaceId,'legacy-workspace');
  assert.equal(upgraded.task(task.id).resolution.mergeIntent,false);assert.deepEqual(upgraded.task(task.id).workerModels,[]);
  assert.equal(upgraded.task(task.id).disposition,null);
  assert.deepEqual(upgraded.receipt(result,'test-only-token'),{accepted:true,eventId:'legacy-event'});
  assert.deepEqual(upgraded.pool()[0].roles,['worker']);
 } finally {upgraded?.close();await f.close()}
});

test('schema 50 upgrade preserves classified revisions and the semantic budget', async () => {
 const f=fixture(); let upgraded: Store | undefined;
 try {
  const task=f.add();
  f.store.update(task.id,{resolution:{...f.store.task(task.id).resolution,revisionRuns:2}});
  const makeRun=(id:string,revisionCause:Run['revisionCause']):Run=>({id,taskId:task.id,role:'revision',generation:1,head:'a'.repeat(40),base:'b'.repeat(40),agentId:'worker',workspaceId:'workspace',instruction:null,revisionCause,profile,profileGroup:'test',status:'finished',createdAt:new Date().toISOString(),lastObservedAt:null,active:false,idleSince:null,completion:null,released:true});
  f.store.putRun(makeRun('admin-one','administrative'));
  f.store.putRun(makeRun('admin-two','administrative'));
  f.store.putRun(makeRun('review-one','review'));
  f.store.putRun(makeRun('legacy-unclassified',undefined));
  f.store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
  f.store.setMeta('schema',50);
  upgraded=new Store(f.path);
  assert.equal(upgraded.getMeta('schema'), CURRENT_SCHEMA);
  assert.equal(upgraded.task(task.id).resolution.revisionRuns,2);
  assert.deepEqual(upgraded.runs(task.id).map(run=>run.revisionCause).sort(),['administrative','administrative','review',undefined].sort());
 } finally {upgraded?.close();await f.close()}
});

test('exhausted worker is replaced once in the same workspace and stale callbacks are fenced',async()=>{
 const f=fixture();try{
  const second={...profile,id:'second',model:'second'};f.engine.profiles=[profile,second];
  f.store.setMeta('pool',[{profileId:profile.id,enabled:true,group:'first',weight:1,roles:['worker'],scopes:['general']},{profileId:second.id,enabled:true,group:'second',weight:1,roles:['worker'],scopes:['general']}]);
  const task=f.add();f.store.update(task.id,{preferredProfileId:profile.id});f.store.setMeta('paused',false);await f.engine.wake();const old=f.store.task(task.id);const oldToken=f.tokens.get(task.id)!;
  let replacements=0;f.adapter.verifyResume=async()=>{};
  f.adapter.observe=async id=>({id,workspaceId:old.workspaceId,status:'error',active:false,permissions:false,error:id===old.agentId?'weekly usage limit exceeded':'',model:id===old.agentId?'author-model':'second'});
  f.adapter.createAgent=async(t,token,prompt)=>{replacements++;assert.equal(t.workspaceId,old.workspaceId);assert.match(prompt,/Preserve and inspect/);return{id:'replacement',workspaceId:t.workspaceId}};
  await f.engine.wake();const replaced=f.store.task(task.id);
  assert.equal(replaced.agentId,'replacement');assert.equal(replaced.profile?.id,'second');assert.equal(replaced.workspaceId,old.workspaceId);assert.equal(f.calls.workspaces,1);assert.equal(replaced.retiredWorkers[0].agentId,old.agentId);assert.ok(replaced.workerModels.includes('author-model'));
  assert.equal(JSON.parse(String(f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('first')!.data)).unavailable,true);
  await assert.rejects(f.engine.complete({eventId:'late-old',taskId:task.id,runId:old.runId!,status:'blocked',summary:'late'},oldToken),/Stale/);
  await f.engine.wake();assert.equal(replacements,1);
 }finally{await f.close()}
});
test('required worker survives an RPC crash and waits for its provider before same-profile replacement',async()=>{
 const f=fixture();try{
  const task=f.add();f.store.update(task.id,{profileRequests:{worker:{profileId:profile.id,reason:'Required worker',required:true}}});
  f.store.setMeta('paused',false);await f.engine.wake();const old=f.store.task(task.id);
  f.store.setAvailability('test',JSON.stringify({group:'test',unavailable:true,reason:'Provider down',retryAt:null}));
  f.adapter.verifyResume=async()=>{};
  f.adapter.observe=async id=>({id,workspaceId:old.workspaceId,status:'error',active:false,permissions:false,error:'Pi RPC process is closed'});
  f.adapter.createAgent=async t=>({id:'replacement',workspaceId:t.workspaceId});
  await (f.engine as any).recoverExhaustedWorkers();
  assert.equal(f.store.task(task.id).agentId,old.agentId);
  assert.equal(f.store.task(task.id).resolution.stop?.reason,'provider_unavailable');
  f.store.setAvailability('test',JSON.stringify({group:'test',unavailable:false,reason:'',retryAt:null}));
  await (f.engine as any).recoverExhaustedWorkers();
  assert.equal(f.store.task(task.id).agentId,'replacement');
  assert.equal(f.store.task(task.id).profile?.id,profile.id);
 }finally{await f.close()}
});
test('provider outage does not promote a fallback above worker demand',async()=>{
 const f=fixture();try{
  const strong={...profile,id:'strong',model:'strong'};f.engine.profiles=[profile,strong];
  f.store.setMeta('pool',[{profileId:profile.id,enabled:true,group:'test',weight:1,capability:'medium',roles:['worker'],scopes:['general']},
    {profileId:strong.id,enabled:true,group:'strong',weight:1,capability:'very_high',roles:['worker'],scopes:['general']}]);
  const task=f.add();f.store.update(task.id,{complexity:'medium',preferredProfileId:profile.id});
  f.store.setMeta('paused',false);await f.engine.wake();const old=f.store.task(task.id);
  f.store.setAvailability('test',JSON.stringify({group:'test',unavailable:true,reason:'Provider down',retryAt:null}));
  f.adapter.observe=async id=>({id,workspaceId:old.workspaceId,status:'error',active:false,permissions:false,error:'Pi RPC process is closed'});
  await (f.engine as any).recoverExhaustedWorkers();
  assert.equal(f.store.task(task.id).agentId,old.agentId);
  assert.equal(f.store.task(task.id).resolution.stop?.reason,'provider_unavailable');
 }finally{await f.close()}
});
test('a stopped callback-free worker fails over when its subscription group is operator-disabled',async()=>{
 const f=fixture();try{
  const second={...profile,id:'second',model:'second'};f.engine.profiles=[profile,second];
  f.store.setMeta('pool',[{profileId:profile.id,enabled:true,group:'first',weight:1,roles:['worker'],scopes:['general']},{profileId:second.id,enabled:true,group:'second',weight:1,roles:['worker'],scopes:['general']}]);
  const task=f.add();f.store.update(task.id,{preferredProfileId:profile.id});f.store.setMeta('paused',false);await f.engine.wake();const old=f.store.task(task.id);
  f.store.db.prepare('INSERT INTO availability VALUES(?,?)').run('first',JSON.stringify({group:'first',unavailable:true,reason:'Provider start timed out repeatedly',retryAt:null}));
  f.adapter.verifyResume=async()=>{};
  f.adapter.observe=async id=>({id,workspaceId:old.workspaceId,status:'idle',active:false,permissions:false,error:'',model:id===old.agentId?'author-model':'second'});
  f.adapter.createAgent=async(t)=>({id:'replacement',workspaceId:t.workspaceId});
  await f.engine.wake();const replaced=f.store.task(task.id);
  assert.equal(replaced.agentId,'replacement');assert.equal(replaced.profile?.id,'second');assert.equal(replaced.workspaceId,old.workspaceId);
  assert.equal(replaced.retiredWorkers[0].agentId,old.agentId);assert.match(replaced.retiredWorkers[0].reason,/Provider start timed out/);
  assert.ok(f.store.events(task.id).some(event=>event.kind==='provider_unavailable'));
 }finally{await f.close()}
});
test('pause and active old worker prevent replacement; explicit exhausted callback persists until resume',async()=>{
 const f=fixture();try{
  const task=f.add();f.store.setMeta('paused',false);await f.engine.wake();const old=f.store.task(task.id);
  f.store.setMeta('paused',true);await f.engine.complete({eventId:'quota',taskId:task.id,runId:old.runId!,status:'blocked',summary:'Provider subscription exhausted',providerUnavailable:true},f.tokens.get(task.id)!);await f.engine.wake();
  assert.equal(f.store.db.prepare('SELECT * FROM availability').all().length,0);assert.equal(f.store.task(task.id).agentId,old.agentId);
  f.store.setMeta('paused',false);await f.engine.wake();assert.equal(f.store.task(task.id).agentId,old.agentId);assert.equal(f.store.db.prepare('SELECT * FROM availability').all().length,0);
  f.observe({status:'idle',active:false,error:'usage limit reached'});await f.engine.wake();assert.equal(f.store.task(task.id).agentId,old.agentId);assert.match(f.store.task(task.id).reason,/no eligible replacement/);
  // Blocked only by the exhausted group: failover owns the wait until it resets.
  assert.deepEqual(f.store.task(task.id).resolution.stop?.reason,'provider_unavailable');
  assert.deepEqual(f.store.task(task.id).resolution.stop?.suggestedVerbs,[]);
 }finally{await f.close()}
});
test('an exhausted worker with no profile eligible even after a reset gets owner routing verbs',async()=>{
 const f=fixture();try{
  const task=f.add();f.store.setMeta('paused',false);await f.engine.wake();const old=f.store.task(task.id);
  // The only worker profile has dropped out of the catalog: waiting for a reset cannot help.
  f.engine.profiles=f.engine.profiles.map(entry=>({...entry,available:false,problem:'removed'}));
  f.observe({status:'idle',active:false,error:'usage limit reached'});await f.engine.wake();
  const stopped=f.store.task(task.id);
  assert.equal(stopped.agentId,old.agentId);assert.equal(stopped.phase,'needs_attention');
  assert.equal(stopped.resolution.stop?.reason,'route_unavailable');
  assert.deepEqual(stopped.resolution.stop?.suggestedVerbs,['restart','route']);
  assert.match(stopped.reason,/No eligible replacement worker: No eligible worker profile: .*unavailable: removed/);
 }finally{await f.close()}
});
test('a lost replacement creation is retried once automatically, then escalates without launching blindly',async()=>{
 const f=fixture();try{
  const task=f.add();f.store.setMeta('paused',false);await f.engine.wake();const old=f.store.task(task.id);
  const second={...profile,id:'second',model:'second'};f.engine.profiles=[profile,second];f.store.setMeta('pool',[...f.store.pool(),{profileId:'second',enabled:true,group:'second',weight:1,roles:['worker'],scopes:['general']}]);
  f.adapter.verifyResume=async()=>{};f.adapter.observe=async id=>({id,workspaceId:old.workspaceId,status:'error',active:false,permissions:false,error:'usage_limit_reached',model:'author'});
  let attempts=0;f.adapter.createAgent=async()=>{attempts++;throw Error('lost response')};
  await f.engine.wake();await f.engine.wake();
  // The proven-absent first creation was automatically replaced exactly once in the retained workspace.
  assert.equal(attempts,2);assert.equal(f.calls.workspaces,1);
  await f.engine.wake();
  // The second absence escalates to the coordinator instead of another blind launch.
  assert.equal(attempts,2);assert.equal(f.store.task(task.id).agentId,null);assert.equal(f.store.task(task.id).agentIntent,true);
  assert.match(f.store.task(task.id).reason,/also proved absent/);
 }finally{await f.close()}
});

test('pause during continuation verification prevents replacement intent and dispatch',async()=>{
 const f=fixture();try{
  const task=f.add();f.store.setMeta('paused',false);await f.engine.wake();const old=f.store.task(task.id);
  f.engine.profiles.push({...profile,id:'second',model:'second'});f.store.setMeta('pool',[...f.store.pool(),{profileId:'second',enabled:true,group:'second',weight:1,roles:['worker'],scopes:['general']}]);
  f.adapter.observe=async id=>({id,workspaceId:old.workspaceId,status:'error',active:false,permissions:false,error:'quota_exceeded',model:'author'});
  f.adapter.verifyResume=async()=>{f.store.setMeta('paused',true)};await f.engine.wake();
  assert.equal(f.store.task(task.id).agentId,old.agentId);assert.equal(f.store.task(task.id).retiredWorkers.length,0);assert.equal(f.calls.agents,1);
 }finally{await f.close()}
});
test('required preferred profile does not silently fall back after exhaustion',async()=>{
 const f=fixture();try{
  const task=f.add();f.store.update(task.id,{preferredProfileId:profile.id,requirePreferred:true});f.store.setMeta('paused',false);await f.engine.wake();const old=f.store.task(task.id);
  f.engine.profiles.push({...profile,id:'second',model:'second'});f.store.setMeta('pool',[...f.store.pool(),{profileId:'second',enabled:true,group:'second',weight:1,roles:['worker'],scopes:['general']}]);
  f.adapter.observe=async id=>({id,workspaceId:old.workspaceId,status:'error',active:false,permissions:false,error:'insufficient_quota'});await f.engine.wake();
  assert.equal(f.store.task(task.id).agentId,old.agentId);assert.equal(f.store.task(task.id).phase,'needs_attention');assert.equal(f.calls.agents,1);
 }finally{await f.close()}
});

test('provider reset time is persisted once and expired availability permits a new attempt',async()=>{
 const f=fixture();try{
  const task=f.add();f.store.setMeta('paused',false);await f.engine.wake();const old=f.store.task(task.id);
  const retryAt=new Date(Date.now()+3600000).toISOString();f.store.setMeta('paused',true);f.observe({status:'idle',active:false,error:'usage limit reached'});
  await f.engine.complete({eventId:'timed-quota',taskId:task.id,runId:old.runId!,status:'blocked',summary:'usage limit reached',providerUnavailable:true,providerRetryAt:retryAt},f.tokens.get(task.id)!);await f.engine.wake();
  assert.equal(f.store.task(task.id).phase,'blocked','pause applies the stored blocked result before unpause failover');
  f.store.setMeta('paused',false);await f.engine.wake();const row=f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('test')!;assert.equal(JSON.parse(String(row.data)).retryAt,retryAt);
  await f.engine.wake();assert.equal(JSON.parse(String(f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('test')!.data)).retryAt,retryAt);
  f.store.db.prepare('UPDATE availability SET data=? WHERE group_id=?').run(JSON.stringify({group:'test',unavailable:true,reason:'usage limit reached',retryAt:new Date(Date.now()-1000).toISOString()}),'test');
  f.adapter.verifyResume=async()=>{};f.adapter.createAgent=async t=>({id:'after-reset',workspaceId:t.workspaceId});await f.engine.wake();await f.engine.wake();assert.equal(f.store.task(task.id).agentId,'after-reset');assert.equal(f.store.task(task.id).retiredWorkers.length,1);
 }finally{await f.close()}
});

test('removal hides queued tasks, retains identity and history, and survives reopening', async () => {
  const f = fixture(); try {
    const task = f.add(); const removed = await f.engine.removeTask(task.id, task.version);
    assert.ok(removed.removedAt); assert.equal(f.store.tasks().length, 0);
    assert.equal(f.store.existing(submissionSchema.strip().parse({ ...task, hostId: undefined }) /* #912: the task record names its host; a submission does not */)?.id, task.id);
    assert.equal(f.store.events(task.id)[0].kind, 'removed');
    const reopened = new Store(f.path); try { assert.equal(reopened.tasks().length, 0); assert.ok(reopened.task(task.id).removedAt); } finally { reopened.close(); }
    f.store.setMeta('paused', false); await f.engine.wake(); assert.equal(f.calls.agents, 0);
  } finally { await f.close(); }
});
test('removal resolves every attached thread, revokes callbacks and suppresses future notices', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused', false); const initial=f.add(); await f.engine.wake();
    const task=f.store.update(initial.id,{phase:'blocked'}); const token=f.tokens.get(task.id)!;
    await assert.rejects(f.engine.removeTask(task.id,task.version),/still active/);
    f.idle(); await f.engine.removeTask(task.id,task.version);
    assert.deepEqual(f.calls.archives,[task.agentId]);
    assert.deepEqual(f.calls.workspaceArchives,[task.workspaceId]);
    assert.throws(()=>f.store.authenticate(task.runId!,token),/Unauthorized/);
    let notices=0; f.engine.resolution.adapter.notify=async()=>{notices++;};
    await f.engine.wake();assert.equal(f.store.tasks().length,0);assert.equal(f.store.notices(task.id).length,0);assert.equal(notices,0);
  } finally { await f.close(); }
});
test('removal archives worker, coordinator, reviewer and retained run threads before hiding the task', async () => {
  const f = fixture(); try {
    const original=f.add();
    const task=f.store.update(original.id,{phase:'blocked',agentId:'worker',coordinatorAgentId:'coordinator',
      resolution:{...original.resolution,reviewerAgentId:'reviewer'},retiredWorkers:[{agentId:'retired',runId:'retired-run',profile,reason:'quota'}]});
    f.store.putRun({id:'review-run',taskId:task.id,role:'reviewer',generation:1,head:'head',base:'base',agentId:'run-agent',workspaceId:'workspace',profile:null,status:'finished',createdAt:new Date().toISOString(),lastObservedAt:null,active:false,idleSince:null,completion:null,released:true});
    f.idle();
    await f.engine.removeTask(task.id,task.version);
    assert.deepEqual(new Set(f.calls.archives),new Set(['worker','coordinator','reviewer','retired','run-agent']));
    assert.ok(f.store.task(task.id).removedAt);
  } finally { await f.close(); }
});
test('removal leaves the task visible when an attached thread cannot be archived', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused',false);const original=f.add();await f.engine.wake();f.idle();
    const task=f.store.update(original.id,{phase:'blocked'});
    f.adapter.archiveAgent=async()=>{throw Error('archive failed')};
    await assert.rejects(f.engine.removeTask(task.id,task.version),/archive failed/);
    assert.equal(f.store.task(task.id).removedAt,null);
    assert.equal(f.store.tasks().length,1);
  } finally { await f.close(); }
});
test('removal leaves the task visible when its workspace cannot be archived', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused',false);const original=f.add();await f.engine.wake();f.idle();
    const task=f.store.update(original.id,{phase:'blocked'});
    f.adapter.archiveTaskWorkspace=async()=>{throw Error('workspace archive failed')};
    await assert.rejects(f.engine.removeTask(task.id,task.version),/workspace archive failed/);
    assert.equal(f.store.task(task.id).removedAt,null);
    assert.equal(f.store.tasks().length,1);
  } finally { await f.close(); }
});
test('removal refuses stale versions and unresolved creation or merge effects', async () => {
  const f = fixture(); try {
    const task=f.add();await assert.rejects(f.engine.removeTask(task.id,task.version+1),/Task changed/);
    let current=f.store.update(task.id,{phase:'needs_attention',workspaceIntent:true});
    await assert.rejects(f.engine.removeTask(task.id,current.version),/uncertain/);
    current=f.store.update(task.id,{workspaceIntent:false,resolution:{...task.resolution,mergeIntent:true}});
    await assert.rejects(f.engine.removeTask(task.id,current.version),/uncertain/);
    assert.equal(f.store.tasks().length,1);
  } finally { await f.close(); }
});

test('dependency chains and joins wait for closeout while independent projects proceed', async () => {
  const f=fixture();try {
    const first=f.add(), second=f.add('/project-a',[first.id]), other=f.add('/project-b');
    const joined=f.add('/project-c',[second.id,other.id]);
    f.store.setMeta('paused',false);await f.engine.wake();
    assert.equal(f.calls.agents,2);assert.equal(f.store.task(second.id).phase,'queued');assert.match(derivedQueuedReason(f, f.store.task(joined.id)),/Waiting for prerequisites/);
    for(const phase of ['awaiting_review','merging','syncing','closing'] as const){
      f.store.update(first.id,{phase});await f.engine.wake();assert.equal(f.store.task(second.id).phase,'queued');
    }
    f.store.update(first.id,{phase:'done'});await f.engine.wake();assert.equal(f.store.task(second.id).phase,'working');assert.equal(f.store.task(joined.id).phase,'queued');
    f.store.update(second.id,{phase:'done'});await f.engine.wake();assert.equal(f.store.task(joined.id).phase,'queued');
    f.store.update(other.id,{phase:'done'});await f.engine.wake();assert.equal(f.store.task(joined.id).phase,'working');assert.equal(f.calls.agents,4);
  }finally{await f.close();}
});
test('failed and removed prerequisites wait; completed history and restart preserve eligibility',async()=>{
  const f=fixture();try {
    const parent=f.add(),child=f.add('/project-b',[parent.id]);
    for(const phase of ['blocked','error','cancelled'] as const){f.store.update(parent.id,{phase});assert.match(f.store.dependencyWait(f.store.task(child.id)),new RegExp(phase));}
    await f.engine.removeTask(parent.id,f.store.task(parent.id).version);
    assert.match(f.store.dependencyWait(f.store.task(child.id)),/removed before completion/);
    assert.throws(()=>f.add('/project-c',[parent.id]),/removed before completion/);
    const completed=f.add();f.store.update(completed.id,{phase:'done'});await f.engine.removeTask(completed.id,f.store.task(completed.id).version);
    const ready=f.add('/project-c',[completed.id]);assert.equal(f.store.dependencyWait(ready),'');
    const reopened=new Store(f.path);try{assert.deepEqual(reopened.task(child.id).dependsOn,[parent.id]);assert.match(reopened.dependencyWait(reopened.task(child.id)),/removed/);assert.equal(reopened.dependencyWait(reopened.task(ready.id)),'');}finally{reopened.close();}
    f.store.setMeta('paused',false);await f.engine.wake();assert.equal(f.store.task(child.id).phase,'queued');assert.equal(f.store.task(ready.id).phase,'working');
  }finally{await f.close();}
});
test('queued dependency graphs can be rewired without replacing tasks and reject cycles',async()=>{
  const f=fixture();try {
    assert.throws(()=>f.add('/project-a',['missing']),/Submit prerequisites first/);
    const a=f.add(),b=f.add(),child=f.add('/project-a',[a.id,b.id]);
    const input=submissionSchema.strip().parse({ ...child, hostId: undefined });
    assert.equal(f.store.existing({...input,dependsOn:[...input.dependsOn].reverse()})?.id,child.id);
    assert.throws(()=>f.store.existing({...input,dependsOn:[a.id]}),/different content/);
    assert.throws(()=>submissionSchema.parse({...input,dependsOn:[a.id,a.id]}),/Duplicate/);
    assert.throws(()=>f.store.validateDependencies({...input,dependsOn:[child.id]}),/itself/);
    const rewired=f.store.updateDependencies(child,[a.id]);
    assert.equal(rewired.id,child.id);assert.deepEqual(rewired.dependsOn,[a.id]);assert.match(rewired.reason,/Waiting for prerequisites/);
    assert.throws(()=>f.store.updateDependencies(a,[child.id]),/cycle/);
    assert.throws(()=>f.store.updateDependencies(rewired,['missing']),/does not exist/);
    const cleared=f.store.updateDependencies(rewired,[]);assert.deepEqual(cleared.dependsOn,[]);assert.equal(cleared.reason,'Waiting for dispatch');
    const started=f.store.update(cleared.id,{phase:'dispatching',workspaceIntent:true});
    assert.throws(()=>f.store.updateDependencies(started,[b.id]),/before dispatch begins/);
  }finally{await f.close();}
});
test('an explicit critical false replays the same submission; critical true and stored explicit-false rows reconcile as designed',async()=>{
  const f=fixture();try {
    const input=submissionSchema.parse({submissionId:randomUUID(),title:'Task',repoPath:'/project-a',dependsOn:[],planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin'});
    const task=f.store.insert(input,'host','handoff','a'.repeat(40));
    assert.equal(f.store.existing({...input,critical:false})?.id,task.id);
    assert.equal(f.store.existing(submissionSchema.strip().parse({ ...task, hostId: undefined }) /* #912: the task record names its host; a submission does not */)?.id,task.id);
    assert.throws(()=>f.store.existing({...input,critical:true}),/different content/);
    // A row stored before the elision kept its explicit false in the digest and still replays.
    const explicit=submissionSchema.parse({...input,submissionId:randomUUID(),critical:false});
    const stored=f.store.insert(explicit,'host','handoff','a'.repeat(40));
    f.store.db.prepare('UPDATE tasks SET input_hash=? WHERE id=?').run(explicitCriticalFalseSubmissionHash(explicit),stored.id);
    assert.equal(f.store.existing(explicit)?.id,stored.id);
  }finally{await f.close();}
});
test('promotion moves a queued task to the front of its project without moving other project slots',async()=>{
  const f=fixture();try{
    const first=f.add('/project-a'),other=f.add('/project-b'),second=f.add('/project-a'),urgent=f.add('/project-a');
    const promoted=f.store.promoteQueuedTask(urgent,'test run');assert.equal(promoted.id,urgent.id);assert.ok(promoted.queuePriority>0);
    assert.deepEqual(queuedDispatchOrder(f.store.tasks()).map(task=>task.id),[urgent.id,other.id,first.id,second.id]);
    assert.match(f.store.events(urgent.id).find(event=>event.kind==='queue_promoted')!.detail,/test run/);
    assert.equal(f.store.promoteQueuedTask(promoted).version,promoted.version);
    f.store.setMeta('globalLimit',1);f.store.setMeta('paused',false);await f.engine.wake();
    assert.equal(f.store.task(urgent.id).phase,'working');assert.equal(f.store.task(first.id).phase,'queued');assert.equal(f.store.task(other.id).phase,'queued');
    assert.throws(()=>f.store.promoteQueuedTask(f.store.task(urgent.id)),/queued or parked/);
  }finally{await f.close();}
});

test('promotion ranks an in-flight task before other requests globally within its tier',async()=>{
  const f=fixture();try{
    f.store.setMeta('globalLimit',1);f.store.setMeta('projectLimit',1);
    const queued=f.add('/project-d');f.store.promoteQueuedTask(queued);
    const priorPromotedReview=f.store.update(f.add('/project-b').id,{phase:'awaiting_review',workspaceIntent:true,agentActive:false});
    f.store.promoteQueuedTask(priorPromotedReview);
    const olderReview=f.store.update(f.add('/project-c').id,{phase:'awaiting_review',workspaceIntent:true,agentActive:false});
    const promotedReview=f.store.update(f.add('/project-a').id,{phase:'awaiting_review',workspaceIntent:true,agentActive:false});
    const promoted=f.store.promoteQueuedTask(promotedReview);
    const order=fairSlotRequestOrder(f.store.tasks(),task=>['queued','awaiting_review'].includes(task.phase));

    assert.deepEqual(order.map(task=>task.id),[promotedReview.id,priorPromotedReview.id,olderReview.id,queued.id]);
    assert.ok(promoted.queuePriority>priorPromotedReview.queuePriority);
    assert.equal(f.engine.resolution.slotAdmissionReason(promotedReview),'');
    assert.notEqual(f.engine.resolution.slotAdmissionReason(olderReview),'');
    assert.notEqual(f.engine.resolution.slotAdmissionReason(queued),'');
  }finally{await f.close();}
});

test('promotion accepts parked review, revision, verification and waiting recovery tasks',async()=>{
  const f=fixture();try{
    for(const phase of ['awaiting_review','changes_requested','verifying'] as const){
      const task=f.add(`/project-${phase}`);
      const parked=f.store.update(task.id,{phase,workspaceIntent:true,agentActive:false});
      assert.ok(f.store.promoteQueuedTask(parked).queuePriority>0,phase);
    }
    const attention=f.add('/project-attention');
    const recovery=f.store.update(attention.id,{phase:'needs_attention',workspaceIntent:true,agentActive:false,
      resolution:{...attention.resolution,attention:true,recovery:{id:'recovery',key:'recovery',generation:1,runId:null,agentId:null,status:'escalated',summary:'Waiting for recovery',idleSince:null,incidentId:null}}});
    assert.ok(f.store.promoteQueuedTask(recovery).queuePriority>0);

    const active=f.store.update(f.add('/project-active').id,{phase:'awaiting_review',workspaceIntent:true,agentActive:true});
    assert.throws(()=>f.store.promoteQueuedTask(active),/queued or parked/);
    const noRecovery=f.store.update(f.add('/project-no-recovery').id,{phase:'needs_attention',workspaceIntent:true,agentActive:false});
    assert.throws(()=>f.store.promoteQueuedTask(noRecovery),/queued or parked/);
  }finally{await f.close();}
});

test('promotion refuses done, cancelled and merged tasks and clears terminal priority',async()=>{
  const f=fixture();try{
    const done=f.store.promoteQueuedTask(f.add());
    const completed=f.store.update(done.id,{phase:'done'});
    assert.equal(completed.queuePriority,0);
    assert.throws(()=>f.store.promoteQueuedTask(completed),/unmerged/);

    const cancelled=f.store.promoteQueuedTask(f.add());
    const cancelledTask=f.store.update(cancelled.id,{phase:'cancelled'});
    assert.equal(cancelledTask.queuePriority,0);
    assert.throws(()=>f.store.promoteQueuedTask(cancelledTask),/unmerged/);

    const mergedBase=f.add();
    const merged=f.store.update(mergedBase.id,{phase:'verifying',workspaceIntent:true,agentActive:false,
      resolution:{...mergedBase.resolution,mergedCommit:'b'.repeat(40)}});
    assert.throws(()=>f.store.promoteQueuedTask(merged),/unmerged/);
  }finally{await f.close();}
});


test('pre-dependency submissions retain their stored identity and default to no prerequisites',async()=>{
  const f=fixture();try {
    const task=f.add();const input=submissionSchema.strip().parse({ ...task, hostId: undefined }) /* #912: the task record names its host; a submission does not */;
    const {dependsOn,skipPRReview,notifyOriginOnCloseout,completionNotificationAgentIds,instruction,brief,lanes,draftProvenance,leadProvenance,mergeHold,...legacy}=input;
    const {dependsOn:ignored,...legacyTask}=task;
    f.store.db.prepare('UPDATE tasks SET input_hash=?,data=? WHERE id=?').run(digest(JSON.stringify(legacy)),JSON.stringify(legacyTask),task.id);
    assert.equal(f.store.existing(input)?.id,task.id);assert.deepEqual(f.store.task(task.id).dependsOn,[]);
  }finally{await f.close();}
});


test('editable per-project cap applies to every project inside the global cap and lowering drains existing slots',async()=>{
 const f=fixture();try{
  f.store.setMeta('paused',false);f.store.setMeta('projectLimit',2);f.store.setMeta('globalLimit',3);
  // Legacy overrides have no scheduling authority.
  f.store.setMeta('projectLimits',{'/project-a':99});
  for(let i=0;i<3;i++)f.add('/project-a');
  for(let i=0;i<3;i++)f.add('/project-b');
  await f.engine.wake();assert.equal(f.calls.agents,3);
  assert.equal(f.store.tasks().filter(t=>t.repoPath==='/project-a'&&t.phase==='working').length,2);
  f.store.setMeta('globalLimit',4);await f.engine.wake();assert.equal(f.calls.agents,4);
  assert.equal(f.store.tasks().filter(t=>t.repoPath==='/project-b'&&t.phase==='working').length,2);
  f.store.setMeta('projectLimit',1);f.store.setMeta('globalLimit',2);await f.engine.wake();assert.equal(f.calls.agents,4);
  f.store.setMeta('globalLimit',6);f.add('/project-c');f.add('/project-c');await f.engine.wake();assert.equal(f.calls.agents,5);
  assert.equal(f.calls.archives.length,0);
 }finally{await f.close();}
});

test('workspace titles track task state and reconcile an uncertain rename',async()=>{
  const f=fixture();try{
    const task=f.add('/project-a',[],'g05.036 portable Widget family adapter worker');
    assert.equal(taskWorkspaceTitle({...f.store.task(task.id),phase:'working',held:false}),'Working: 001 g05.036 portable Widget family adapter');
    assert.equal(taskWorkspaceTitle({...f.store.task(task.id),phase:'awaiting_review',held:false}),'Review: 001 g05.036 portable Widget family adapter');
    assert.equal(taskWorkspaceTitle({...f.store.task(task.id),phase:'changes_requested',held:false}),'Changes: 001 g05.036 portable Widget family adapter');
    assert.equal(taskWorkspaceTitle({...f.store.task(task.id),phase:'needs_attention',held:false}),'Attention: 001 g05.036 portable Widget family adapter');
    assert.equal(taskWorkspaceTitle({...f.store.task(task.id),phase:'working',held:true}),'Held by planner: 001 g05.036 portable Widget family adapter');
    const titles:{title:string;requestId:string;uncertain:boolean}[]=[];
    f.adapter.setTaskWorkspaceTitle=async(_task,title,requestId,uncertain)=>{titles.push({title,requestId,uncertain});if(titles.length===1)throw Error('connection lost')};
    f.store.setMeta('globalLimit',1);f.store.setMeta('paused',false);await f.engine.wake();
    assert.equal(titles[0].title,'Working: 001 g05.036 portable Widget family adapter');assert.equal(titles[0].uncertain,false);
    assert.equal(titles.length,1,'a failed title update is not retried immediately');
    const pending=f.store.getMeta<any>(`workspaceTitle:${task.id}`);f.store.setMeta(`workspaceTitle:${task.id}`,{...pending,retryAt:0});
    await f.engine.wake();assert.equal(titles.at(-1)?.title,'Working: 001 g05.036 portable Widget family adapter');assert.equal(titles.at(-1)?.uncertain,true);assert.equal(titles[1].requestId,titles[0].requestId);
    await f.engine.wake();assert.equal(titles.length,2);
    f.store.update(task.id,{phase:'blocked',reason:'Blocked'});await f.engine.wake();
    assert.equal(titles.at(-1)?.title,'Blocked: 001 g05.036 portable Widget family adapter');assert.equal(titles.at(-1)?.uncertain,false);assert.notEqual(titles.at(-1)?.requestId,titles[0].requestId);
    const beforeLabelChange=titles.length;
    f.store.update(task.id,{holds:{dispatch:{owner:'operator',reason:'Wait for #248',at:new Date().toISOString(),generation:1,until:null}},held:false});await f.engine.wake();
    assert.equal(titles.length,beforeLabelChange+1,'a changed computed label is sent even when phase and held are unchanged');
    assert.equal(titles.at(-1)?.title,'Waiting on #248: 001 g05.036 portable Widget family adapter');
  }finally{await f.close()}
});

test('a task callback wake drives only the affected task',async()=>{
  const f=fixture();try{
    const first=f.add(),second=f.add();
    f.store.setMeta('paused',false);
    let reconciled:string[]=[];
    (f.engine.hooks as any).reconcileTask=async(task:Task)=>{reconciled.push(task.id);return {hold:false}};
    await f.engine.wakeTask(first.id);
    assert.deepEqual(reconciled,[first.id]);
    assert.equal(f.store.task(second.id).phase,'queued');
  }finally{await f.close()}
});

test('a daemon transport failure leaves a lane retryable instead of parking it', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused', false);
    const task = f.add();
    // A settled workspace and agent: the only thing failing is the transport, so the
    // uncertainty rules (which correctly park) are not what this exercises.
    f.store.update(task.id, { phase: 'working', workspaceIntent: true, workspaceId: 'ws-settled', directory: '/fixture', agentId: 'agent-settled', runId: 'run-settled' });
    // The live shape: the transport drops mid-call and the step fails.
    f.adapter.observe = async () => { throw new Error('Transport not connected (status: disconnected)'); };
    await f.engine.wake();
    const after = f.store.task(task.id);
    assert.notEqual(after.phase, 'needs_attention', `a daemon blip must not park the lane for an operator; got ${after.phase}: ${after.reason}`);
    assert.match(String(after.reason), /transport unavailable/i, 'the lane stays retryable and says why');
    // A task fault still parks, so this does not hide real failures.
    assert.equal(isTransportFailure(new Error('Underlying review model is not independent of the worker')), false);
    assert.equal(isTransportFailure(new Error('Transport not connected (status: disconnected)')), true);
    assert.equal(isTransportFailure(new Error('Liveness check timed out (15000ms)')), true);
  } finally { await f.close(); }
});

test('a Paseo restart does not park working tasks, and a parked task with a live worker resumes', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused', false);
    const task = f.add();
    // The exhausted-worker sweep only visits tasks with a profile; the live park came from there.
    const profile = { id: 'author', name: 'author', provider: 'test', model: 'author', notes: '', available: true, problem: '', supportedThinking: [] };
    f.store.update(task.id, { phase: 'working', workspaceIntent: true, workspaceId: 'ws-settled', directory: '/fixture', agentId: 'agent-settled', runId: 'run-settled', profile });
    f.adapter.observe = async () => { throw new Error('Transport not connected (status: disconnected)'); };
    await f.engine.wake();
    assert.notEqual(f.store.task(task.id).phase, 'needs_attention', f.store.task(task.id).reason);
    // Tasks already parked by the outage (live 2026-09-29) resume once the worker is seen running.
    f.store.update(task.id, { phase: 'needs_attention', reason: 'Transport not connected (status: disconnected)', resolution: { ...f.store.task(task.id).resolution, recovery: { id: 'r', key: 'k', generation: 1, runId: null, agentId: null, status: 'pending', summary: '', idleSince: null, incidentId: null } } });
    f.adapter.observe = async id => ({ id, workspaceId: 'ws-settled', status: 'running', active: true, permissions: false, error: '' });
    await f.engine.wake();
    const resumed = f.store.task(task.id);
    assert.equal(resumed.phase, 'working', resumed.reason);
    assert.equal(resumed.resolution.recovery, null, 'no coordinator is left pending for an outage');
  } finally { await f.close(); }
});

test('a login-session environment fault leaves a lane retryable instead of parking it', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused', false);
    const task = f.add();
    f.store.update(task.id, { phase: 'working', workspaceIntent: true, workspaceId: 'ws-settled', directory: '/fixture', agentId: 'agent-settled', runId: 'run-settled' });
    f.adapter.observe = async () => { throw new LoginSessionFaultError(new Error('gh api: OSStatus -26276')); };
    await f.engine.wake();
    const after = f.store.task(task.id);
    assert.notEqual(after.phase, 'needs_attention', `a dead login session must not charge the task; got ${after.phase}: ${after.reason}`);
    assert.match(String(after.reason), /login session/i);
  } finally { await f.close(); }
});

test('a stopping owner records no transport wait from its own disposed client', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused', false);
    const task = f.add();
    f.store.update(task.id, { phase: 'working', workspaceIntent: true, workspaceId: 'ws-settled', directory: '/fixture', agentId: 'agent-settled', runId: 'run-settled' });
    const before = f.store.task(task.id);
    // Drain disposes this owner's Paseo client, then an observation still in flight fails against it.
    f.engine.stopped = true;
    f.engine.resolution.transportDeferred(before, new Error('Transport not connected (status: disposed)'));
    const stopping = f.store.task(task.id);
    assert.equal(stopping.reason, before.reason, 'the leaving owner writes no wait onto the task');
    assert.equal(f.store.events(task.id).some(event => event.kind === 'transport_deferred'), false);
    // Control: a live owner with an unreachable daemon still reads as a wait with its real cause.
    f.engine.stopped = false;
    f.engine.resolution.transportDeferred(stopping, new Error('Transport not connected (status: disconnected)'));
    assert.match(f.store.task(task.id).reason, /Daemon transport unavailable; retrying on the next pass: Transport not connected \(status: disconnected\)/);
  } finally { await f.close(); }
});

test('an observation disconnect preserves an existing task blocker', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused', false);
    const task = f.add();
    const reason = 'Revision budget exhausted; operator decision required';
    f.store.update(task.id, { phase: 'needs_attention', reason, workspaceIntent: true, workspaceId: 'ws-settled', directory: '/fixture', agentId: 'agent-settled', runId: 'run-settled' });
    f.adapter.observe = async () => { throw Error('Transport not connected (status: disconnected)'); };
    await f.engine.wake();
    assert.equal(f.store.task(task.id).reason, reason);
    assert.equal(f.store.task(task.id).phase, 'needs_attention');
    assert.ok(f.store.events(task.id).some(event => event.kind === 'transport_deferred'));
  } finally { await f.close(); }
});

test('late worker lookup preserves a worker already bound while the lookup was in flight', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused', false);
    const task = f.add();
    const pending = f.store.update(task.id, { phase: 'dispatching', workspaceIntent: true, workspaceId: 'workspace', directory: '/fixture', agentIntent: true, agentId: null, runId: 'pending-run' });
    f.adapter.findAgents = async () => {
      f.store.update(task.id, { agentId: 'bound-worker', phase: 'working', reason: 'Worker running' });
      return [{ id: 'bound-worker', workspaceId: 'workspace' }];
    };
    await (f.engine as any).recover(pending);
    assert.equal(f.store.task(task.id).phase, 'working');
    assert.equal(f.store.task(task.id).agentId, 'bound-worker');
    assert.equal(f.store.task(task.id).reason, 'Worker running');
  } finally { await f.close(); }
});

test('papercuts have two separate slots per project while sharing the global cap', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 6); f.store.setMeta('projectLimit', 1); f.store.setMeta('paused', false);
    // The in-flight cap is twice the normal project slot limit (two). Lift it here
    // so this test reads papercut slots without the first-dispatch cap binding.
    for (const repo of ['/project-a', '/project-b']) f.store.ensureProject(repo);
    f.store.projectInFlightLimitFor = () => 4;
    for (const repo of ['/project-a', '/project-b']) {
      f.add(repo); f.add(repo);
      for (let i=0;i<3;i++) f.store.update(f.add(repo).id, {papercutTask:true, queuePriority:8});
    }
    await f.engine.wake();
    const active = f.store.admissionCandidates().filter(task => occupiesSlot(task));
    assert.equal(active.length, 6);
    for (const repo of ['/project-a', '/project-b']) {
      assert.equal(active.filter(t => t.repoPath===repo && t.papercutTask).length, 2);
      assert.equal(active.filter(t => t.repoPath===repo && !t.papercutTask).length, 1);
      const waiting=f.store.tasks().find(t=>t.repoPath===repo && t.papercutTask && t.phase==='queued')!;
      assert.match(f.engine.resolution.slotAdmissionReason(waiting), /Global/);
    }
    f.store.setMeta('globalLimit', 10);
    const waiting=f.store.tasks().find(t=>t.papercutTask && t.phase==='queued')!;
    assert.match(f.engine.resolution.slotAdmissionReason(waiting), /papercut task-slot/);
    f.store.setMeta('papercutProjectLimit', 3);
    await f.engine.wake();
    assert.equal(f.store.admissionCandidates().filter(t=>occupiesSlot(t)&&t.papercutTask).length,6);
    f.store.setMeta('papercutProjectLimit', 1);
    await f.engine.wake();
    assert.equal(f.store.admissionCandidates().filter(t=>occupiesSlot(t)&&t.papercutTask).length,6,'lowering the allowance never stops active tasks');
  } finally { await f.close(); }
});

test('a multi-repository project shares one papercut allowance, and fully parked work releases it', async () => {
  const f=fixture(); try {
    f.store.setMeta('globalLimit',10); f.store.setMeta('projectLimit',1); f.store.setMeta('paused',false);
    f.store.upsertProject({key:'combined',name:'Combined',repositories:[{origin:null,path:'/a'},{origin:null,path:'/b'}],primary:{origin:null,path:'/a'}});
    const cuts=[];
    for(const repo of ['/a','/b','/a','/b'])cuts.push(f.store.update(f.add(repo).id,{papercutTask:true}));
    await f.engine.wake();
    assert.equal(cuts.filter(t=>f.store.task(t.id).phase==='working').length,2);
    const working=f.store.task(cuts.find(t=>f.store.task(t.id).phase==='working')!.id);
    const parked=f.store.update(working.id,{phase:'awaiting_review',agentActive:false,completion:{eventId:'ready',taskId:working.id,runId:working.runId!,status:'ready_for_review',summary:'Ready',prNumber:1,head:'c'.repeat(40)}});
    assert.equal(occupiesSlot(parked),false);
    assert.equal(f.engine.resolution.slotAdmissionReason(parked),'','the retained review can reacquire its papercut slot');
    const queued=f.store.task(cuts.find(t=>f.store.task(t.id).phase==='queued')!.id);
    assert.match(f.engine.resolution.slotAdmissionReason(queued),/in-flight/,'queued papercuts cannot steal a slot owed to a retained review');
    const policy=f.store.papercutDispatchPolicy();
    const held=f.store.update(parked.id,{phase:'blocked',resolution:{...parked.resolution,recoveryActive:true}});
    assert.equal(recoveryCapacityFor(queued,f.store.admissionCandidates(),10,1,policy),'','a recovery flag without a running agent holds no slot');
    f.store.putRun({id:'recovery-live',taskId:held.id,role:'recovery',generation:1,head:'a'.repeat(40),base:'a'.repeat(40),agentId:'agent-recovery',workspaceId:'workspace',profile:null,status:'running',createdAt:new Date().toISOString(),lastObservedAt:new Date().toISOString(),active:true,idleSince:null,completion:null,released:false});
    assert.equal(occupiesSlot(f.store.task(held.id),f.store.runs(held.id)),true,'a running recovery turn holds its slot');
    assert.match(recoveryCapacityFor(queued,f.store.admissionCandidates(),10,1,policy),/papercut/,'recovery retains the same allowance');
    assert.equal(held.papercutTask,true);
  } finally { await f.close(); }
});

test('simultaneous papercut revision resumes cannot exceed their allowance', async () => {
  const f=fixture();let sent=0;try {
    f.store.setMeta('globalLimit',10);f.store.setMeta('projectLimit',1);f.store.setMeta('papercutProjectLimit',1);f.store.setMeta('paused',false);f.idle();
    f.adapter.verifyPr=async()=>({url:'https://github.com/example/repo/pull/1',head:'c'.repeat(40)});
    (f.adapter as any).sendRun=async()=>{sent++;};
    (f.adapter as any).createRun=async()=>({id:'unexpected-new-agent',workspaceId:'workspace'});
    const prepare=(task:Task)=>f.store.update(task.id,{papercutTask:true,phase:'changes_requested',workspaceIntent:true,workspaceId:`ws-${task.id}`,directory:'/fixture',agentId:`agent-${task.id}`,agentIntent:true,runId:`worker-${task.id}`,profile,agentActive:false,lastAgentStatus:'idle',prUrl:'https://github.com/example/repo/pull/1',prHead:'c'.repeat(40),completion:{eventId:`ready-${task.id}`,taskId:task.id,runId:`worker-${task.id}`,status:'ready_for_review',summary:'Ready',prNumber:1,head:'c'.repeat(40)}});
    const first=prepare(f.add()),second=prepare(f.add());
    await Promise.all([f.engine.scheduleTaskQuantum(first.id),f.engine.scheduleTaskQuantum(second.id)]);
    assert.equal(sent,1);
    assert.equal(f.store.admissionCandidates().filter(t=>occupiesSlot(t)&&t.papercutTask).length,1);
  }finally{await f.close();}
});

test('queued reservations do not claim occupied global slots are full', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 2);
    f.store.setMeta('projectLimit', 5);
    const first = f.add(), second = f.add(), third = f.add();
    assert.equal(f.engine.resolution.slotAdmissionReason(first), '');
    assert.equal(f.engine.resolution.slotAdmissionReason(second), '');
    const reason = f.engine.resolution.slotAdmissionReason(third);
    assert.match(reason, /2 earlier queued reservations/);
    assert.match(reason, /0\/2 global slots occupied/);
    assert.doesNotMatch(reason, /limit reached/);
  } finally { await f.close(); }
});


test('board dispatch hold blocks workspace and worker creation; release keeps order, capacity and task holds', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused', false); f.store.setMeta('dispatchHeld', true);
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1);
    const first = f.add(), second = f.add(), ownHeld = f.add();
    await f.engine.performTaskControl({ taskId: ownHeld.id, version: ownHeld.version, action: 'hold', kind: 'dispatch', reason: 'Task hold' });
    await f.engine.wake();
    assert.equal(f.calls.workspaces, 0); assert.equal(f.calls.agents, 0);
    assert.equal(derivedQueuedReason(f, f.store.task(first.id)), 'Dispatch held by the operator');
    assert.equal(ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(first.id))).dispatchHeld, true);
    assert.equal(ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(first.id))).stop?.detail, 'Dispatch held by the operator');
    f.store.setMeta('dispatchHeld', false);
    await f.engine.wake();
    assert.equal(f.store.task(first.id).phase, 'working');
    assert.equal(f.store.task(second.id).phase, 'queued');
    assert.equal(f.calls.agents, 1);
    f.store.update(first.id, { phase: 'done', agentActive: false }); await f.engine.wake();
    assert.equal(f.store.task(second.id).phase, 'working');
    assert.equal(f.store.task(ownHeld.id).phase, 'queued');
    assert.ok(f.store.task(ownHeld.id).holds.dispatch);
  } finally { await f.close(); }
});

test('pause wins over board dispatch hold without clearing it', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused', true); f.store.setMeta('dispatchHeld', true);
    const task = f.add(); await f.engine.wake();
    assert.equal(f.calls.workspaces, 0); assert.equal(f.calls.agents, 0);
    assert.notEqual(derivedQueuedReason(f, f.store.task(task.id)), 'Dispatch held by the operator');
    f.store.setMeta('paused', false); await f.engine.wake();
    assert.equal(f.calls.workspaces, 0);
    assert.equal(derivedQueuedReason(f, f.store.task(task.id)), 'Dispatch held by the operator');
  } finally { await f.close(); }
});

test('transient Git failures defer dispatch and recover, then sustained failure parks', async () => {
  const { GitTransientError } = await import('../core/forge/forge-health');
  for (const kind of ['lock', 'ssh', 'network'] as const) {
    const f = fixture();
    try {
      const task = f.add(); f.store.setMeta('paused', false);
      let calls = 0;
      f.adapter.validate = async t => { if (++calls === 1) throw new GitTransientError(kind, Error(kind === 'ssh' ? 'SSH authentication retry budget exhausted; operator SSH/key inspection required' : kind)); return t.planningCommit; };
      await f.engine.wake();
      assert.equal(f.store.task(task.id).phase, 'queued');
      assert.match(f.store.task(task.id).reason, /Retrying at/);
      assert.doesNotMatch(f.store.task(task.id).reason, /inspect.*key/i);
      const episode = f.store.getMeta<any>(`gitTransient:${task.id}`);
      f.store.setMeta(`gitTransient:${task.id}`, { ...episode, retryAt: 0 });
      await f.engine.wake();
      assert.equal(f.store.task(task.id).phase, 'working');
      assert.equal(calls, 2);
    } finally { await f.close(); }
  }
  const f = fixture();
  try {
    const task = f.add(); f.store.setMeta('paused', false);
    f.adapter.validate = async () => { throw new GitTransientError('ssh', Error('SSH authentication retry budget exhausted; operator SSH/key inspection required')); };
    await f.engine.wake();
    const episode = f.store.getMeta<any>(`gitTransient:${task.id}`);
    f.store.setMeta(`gitTransient:${task.id}`, { ...episode, startedAt: Date.now() - 900_001, retryAt: 0 });
    await f.engine.wake();
    assert.equal(f.store.task(task.id).phase, 'needs_attention');
    assert.match(f.store.task(task.id).reason, /15 minutes.*inspect SSH authentication and keys/i);
  } finally { await f.close(); }
});


test('a remote outage shares its retry deadline and unknown writes are not retried', async () => {
  const { GitTransientError } = await import('../core/forge/forge-health');
  const f = fixture(); try {
    const first = f.add('/first'), second = f.add('/second');
    f.store.setMeta('paused', false);
    f.adapter.validate = async () => { throw new GitTransientError('network', Error('HTTP 503')); };
    await f.engine.wake();
    const a = f.store.getMeta<any>(`gitTransient:${first.id}`), b = f.store.getMeta<any>(`gitTransient:${second.id}`);
    assert.ok(a && b); assert.equal(a.retryAt, b.retryAt);
    assert.equal(f.store.task(first.id).phase, 'queued');
  } finally { await f.close(); }
  const unknown = fixture(); try {
    const task = unknown.add(); unknown.store.setMeta('paused', false);
    unknown.adapter.validate = async () => { throw new GitTransientError('network', Error('connection reset after write'), true); };
    await unknown.engine.wake();
    assert.equal(unknown.store.task(task.id).phase, 'needs_attention');
    assert.equal(unknown.store.getMeta(`gitTransient:${task.id}`), undefined);
  } finally { await unknown.close(); }
});
