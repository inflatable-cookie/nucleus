import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BbThreads, emptyBbThreadState, type BbThreadPorts, type BbThreadState, type BbWorkspaceRecord } from '../hosts/bb/threads';
import { HostOperationError, type HostOperationName } from '../hosts/bb/plugin/operations';
import { bbFake, bbWire } from './support/bb-fake';
import { wireLabels } from '../shared/wire-labels';
import { formatAgentId } from '../shared/agent-identity';
import type { HostAgentSpec } from '../shared/host';
import type { Profile, Run } from '../shared/contracts';
import { submissionSchema } from '../shared/contracts';
import { Store, qualifiedThreadArchiveEffectKey } from '../core/store/store';
import { createBbHostAdapter } from '../service/bb-host';
import { archiveReplacedReviewer, observeReviewerReplacement } from '../core/workspaces/thread-archive-replacement';
import { archiveFinishedThreads, threadCleanupPending } from '../core/workspaces/thread-archive';
import type { Adapter } from '../core/host';

/**
 * Spec 062 phase 4: delivery, questions and the support roles. Every call crosses
 * the real operation executor and the recorded BB DTOs; the provider question and
 * approval rows use the pinned SDK's declared payloads (see `support/bb-fake.ts`).
 */
const hostId = 'bb:0123456789abcdef0123456789abcdef';
const handle = `bb-worktree-${'a'.repeat(40)}`;

function fixture() {
  const fake = bbFake();
  let state = emptyBbThreadState();
  let parentThread = 'thr_planner';
  let workspace: BbWorkspaceRecord = { id: handle, directory: '/synthetic/worktree', projectId: 'proj_synthetic', repositoryRoot: '/synthetic/repo', title: 'Synthetic' };
  const notSent = (error: unknown) => error instanceof HostOperationError && (error.code === 'invalid_input' || error.code === 'refused');
  // The channel maps a plugin's own unclassified failure to `internal`, which is
  // unknown delivery; the executor's typed refusals stay typed.
  const operation = async (op: HostOperationName, input: unknown) => {
    try { return await fake.operations.execute(op, input); }
    catch (error) {
      if (error instanceof HostOperationError) throw error;
      throw new HostOperationError('unavailable', error instanceof Error ? error.message : String(error));
    }
  };
  const ports: BbThreadPorts = { hostId, operation, state: () => structuredClone(state), save: value => { state = structuredClone(value); },
    workspace: () => workspace, putWorkspace: value => { workspace = value; }, parent: () => parentThread,
    helperPath: '/synthetic/helper.mjs', ticketPath: id => `/synthetic/tickets/${id}.json`, notSent };
  const native = new BbThreads(ports);
  const spec = (run = 'run_synthetic', role = 'worker'): HostAgentSpec => ({
    workspaceId: handle, taskNumber: 1271, title: role === 'worker' ? 'Synthetic task' : `${role}: Synthetic task`,
    profile: { id: 'synthetic-profile', name: 'Synthetic profile', provider: 'codex', model: 'synthetic-model', notes: '', available: true, problem: '', supportedThinking: ['high'], thinkingOptionId: 'high' },
    mcpBindingPath: null,
    attempt: () => ({ requestId: `ns-${run}`, labels: wireLabels({ task: 'task_synthetic', run, role }), environment: {}, prompt: 'Synthetic task prompt with helper binding.' }),
  });
  const callsOf = (method: string) => fake.calls.filter(call => call.method === method);
  return { ...fake, native, ports, spec, callsOf, setParent: (id: string) => { parentThread = id; }, workspace: () => workspace, state: () => state };
}

test('BB phase 4: a follow-up steers a live turn and never resends an unknown steer', async () => {
  const f = fixture();
  const worker = await f.native.createAgent(f.spec());
  f.rows.get(worker.id).status = 'active';
  await f.native.steerOrNotify(worker.id, 'Synthetic direction', 'msg_steer');
  const steered = f.callsOf('threads.send');
  assert.equal(steered.length, 1);
  assert.equal(steered[0]!.args.mode, 'steer');
  assert.equal(f.callsOf('threads.list').length, 1, 'the plugin proves a live turn with one read before the steer');

  // A steer whose write may have landed is unknown delivery: it is never resent,
  // and the queued fallback is not allowed to run on the same message identity.
  f.controls.loseSteer = true;
  await assert.rejects(f.native.steerOrNotify(worker.id, 'Synthetic direction', 'msg_unknown'));
  assert.equal(f.state().writes['steer:' + worker.id + ':msg_unknown']?.status, 'unknown');
  const afterFirst = f.callsOf('threads.send').length;
  await assert.rejects(f.native.steerOrNotify(worker.id, 'Synthetic direction', 'msg_unknown'), /unknown/i);
  assert.equal(f.callsOf('threads.send').length, afterFirst, 'an unknown steer is never resent, not even as the queued fallback');
});

test('BB phase 4: a steer proven not sent falls back to exactly one queued send', async () => {
  const f = fixture();
  const worker = await f.native.createAgent(f.spec());
  f.rows.get(worker.id).status = 'idle';
  await f.native.steerOrNotify(worker.id, 'Synthetic notice', 'msg_idle');
  const sends = f.callsOf('threads.send');
  assert.equal(sends.length, 1, 'the proven not-sent steer wrote nothing, so only the fallback is delivered');
  assert.equal(sends[0]!.args.mode, 'queue-if-active');
  assert.equal(f.state().writes['steer:' + worker.id + ':msg_idle']?.status, 'refused');
  assert.equal(f.state().writes['send:' + worker.id + ':msg_idle']?.status, 'settled');
});

test('BB phase 4: an interaction answer binds the thread and request before any status read, and is never resent', async () => {
  const f = fixture();
  const worker = await f.native.createAgent(f.spec());
  const reviewer = await f.native.createAgent(f.spec('review_synthetic', 'reviewer'));
  f.rows.get(reviewer.id).hasPendingInteraction = true;
  const question = bbWire('interactionQuestion', { threadId: reviewer.id });
  f.interactions.set(reviewer.id, [question]);

  const pending = await f.native.pendingQuestions(reviewer.id);
  assert.deepEqual(pending, [{ requestId: question.id, questions: [{ header: 'Scope', question: 'How wide should the change go?', options: ['Just this file', 'The whole repository'] }] }]);
  assert.deepEqual(await f.native.pendingQuestions(worker.id), [], 'another thread has no questions');

  // The answer binds the exact thread and request: a wrong thread or a wrong
  // request is refused before the resolve write.
  await assert.rejects(f.native.answerQuestion(worker.id, question.id, { Scope: 'Just this file' }));
  await assert.rejects(f.native.answerQuestion(reviewer.id, 'pint_other_request', { Scope: 'Just this file' }));
  assert.equal(f.callsOf('threads.interactions.resolve').length, 0);

  await f.native.answerQuestion(reviewer.id, question.id, { Scope: 'Just this file' });
  const resolved = f.callsOf('threads.interactions.resolve');
  assert.equal(resolved.length, 1);
  assert.deepEqual(resolved[0]!.args, { threadId: reviewer.id, interactionId: question.id, resolution: { kind: 'user_answer', answers: { scope: { selected: ['Just this file'] } } } });

  // A free-text answer is carried as free text, never as a fake option.
  f.interactions.set(reviewer.id, [bbWire('interactionQuestion', { id: 'pint_free_text', threadId: reviewer.id })]);
  await f.native.answerQuestion(reviewer.id, 'pint_free_text', { Scope: 'Only the two changed files' });
  assert.deepEqual(f.callsOf('threads.interactions.resolve')[1]!.args.resolution, { kind: 'user_answer', answers: { scope: { selected: [], freeText: 'Only the two changed files' } } });

  // An answer whose delivery is unknown is never resent.
  f.interactions.set(reviewer.id, [bbWire('interactionQuestion', { id: 'pint_unknown', threadId: reviewer.id })]);
  f.controls.loseAnswer = true;
  await assert.rejects(f.native.answerQuestion(reviewer.id, 'pint_unknown', { Scope: 'Just this file' }));
  const afterFirst = f.callsOf('threads.interactions.resolve').length;
  await assert.rejects(f.native.answerQuestion(reviewer.id, 'pint_unknown', { Scope: 'Just this file' }), /unknown/i);
  assert.equal(f.callsOf('threads.interactions.resolve').length, afterFirst, 'the recorded unknown intent fences a second answer');
});

test('BB phase 4: a permission answer maps onto BB decisions, refuses an unrepresentable one, and a question dismisses', async () => {
  const f = fixture();
  const reviewer = await f.native.createAgent(f.spec('review_synthetic', 'reviewer'));
  const approval = bbWire('interactionApproval', { id: 'pint_approval_one', threadId: reviewer.id });
  const second = bbWire('interactionApproval', { id: 'pint_approval_two', threadId: reviewer.id });
  const third = bbWire('interactionApproval', { id: 'pint_approval_three', threadId: reviewer.id });
  const question = bbWire('interactionQuestion', { id: 'pint_question', threadId: reviewer.id });
  f.interactions.set(reviewer.id, [approval, second, third, question]);

  await f.native.answerPermission(reviewer.id, approval.id, 'accept', 'intent_one');
  assert.deepEqual(f.callsOf('threads.interactions.resolve')[0]!.args.resolution, { decision: 'allow_once', grantedPermissions: null });
  await f.native.answerPermission(reviewer.id, second.id, 'acceptForSession', 'intent_two');
  assert.deepEqual(f.callsOf('threads.interactions.resolve')[1]!.args.resolution, { decision: 'allow_for_session', grantedPermissions: null });
  // acceptAlways has no BB counterpart: it is refused before the write, not widened.
  await assert.rejects(f.native.answerPermission(reviewer.id, third.id, 'acceptAlways', 'intent_three'), /no acceptAlways permission decision/);
  assert.equal(f.callsOf('threads.interactions.resolve').length, 2);

  await f.native.dismissQuestion(reviewer.id, question.id);
  assert.deepEqual(f.callsOf('threads.interactions.cancel')[0]!.args, { threadId: reviewer.id, interactionId: question.id });
  // Dismissal is only ever a question; a pending permission keeps its own state.
  assert.equal(f.interactions.get(reviewer.id)!.find(row => row.id === third.id)!.status, 'pending');
  await assert.rejects(f.native.dismissQuestion(reviewer.id, approval.id), /not a native question/);
  assert.equal(f.callsOf('threads.interactions.cancel').length, 1);
});

test('BB phase 4: a reparent writes every recorded thread parent once and reads it back, and an unknown write is never resent', async () => {
  const f = fixture();
  const worker = await f.native.createAgent(f.spec('run_worker', 'worker'));
  const reviewer = await f.native.createAgent(f.spec('run_reviewer', 'reviewer'));
  const recovery = await f.native.createAgent(f.spec('run_recovery', 'recovery'));
  const coordinator = await f.native.createAgent(f.spec('run_coordinator', 'coordinator'));
  const executor = await f.native.createAgent(f.spec('run_executor', 'executor'));

  f.setParent('thr_successor');
  await f.native.reparentTaskThreads('task_synthetic', 'thr_successor');
  const updates = f.callsOf('threads.update').filter(call => call.args.parentThreadId !== undefined);
  assert.deepEqual(updates.map(call => call.args.threadId).sort(), [worker.id, reviewer.id, recovery.id, coordinator.id, executor.id].sort());
  for (const id of [worker.id, reviewer.id, recovery.id, coordinator.id, executor.id]) assert.equal(f.rows.get(id)!.parentThreadId, 'thr_successor');
  // Every write read its own postcondition back, and a second pass writes nothing.
  assert.equal(f.callsOf('threads.get').length >= 5, true);
  await f.native.reparentTaskThreads('task_synthetic', 'thr_successor');
  assert.equal(f.callsOf('threads.update').filter(call => call.args.parentThreadId !== undefined).length, 5);
  assert.equal(f.rows.get('thr_planner'), undefined, 'the planner itself is never a recorded thread and never written');

  // A reparent whose delivery is unknown is settled by observation, never re-sent.
  f.controls.loseReparent = true;
  f.setParent('thr_successor_two');
  await assert.rejects(f.native.reparentTaskThreads('task_synthetic', 'thr_successor_two'));
  f.controls.loseReparent = false;
  assert.equal(f.callsOf('threads.update').filter(call => call.args.parentThreadId === 'thr_successor_two').length, 1, 'the unknown write stopped the sweep after its own thread');
  await f.native.reparentTaskThreads('task_synthetic', 'thr_successor_two');
  assert.equal(f.callsOf('threads.update').filter(call => call.args.parentThreadId === 'thr_successor_two').length, 5, 'each thread is written once; the observed one was settled, never rewritten');
  await f.native.reparentTaskThreads('task_synthetic', 'thr_successor_two');
  assert.equal(f.callsOf('threads.update').filter(call => call.args.parentThreadId === 'thr_successor_two').length, 5);
  for (const id of [worker.id, reviewer.id, recovery.id, coordinator.id, executor.id]) assert.equal(f.rows.get(id)!.parentThreadId, 'thr_successor_two');
});

test('BB phase 4: every support role spawns under the task planner with its own role metadata', async () => {
  const f = fixture();
  const roles: Array<[string, string]> = [['worker', 'run_worker'], ['reviewer', 'run_reviewer'], ['recovery', 'run_recovery'], ['coordinator', 'run_coordinator'], ['executor', 'run_executor']];
  for (const [role, run] of roles) {
    const created = await f.native.createAgent(f.spec(run, role));
    const spawn = f.callsOf('threads.spawn').at(-1)!.args;
    assert.equal(spawn.parentThreadId, 'thr_planner', `${role} is parented to the task planner`);
    assert.equal(spawn.parentNotifications, 'off');
    assert.equal(spawn.visibility, 'visible');
    assert.equal(spawn.pluginMetadata.nucleus.role, role);
    assert.equal(f.rows.get(created.id)!.environmentId, f.workspace().environmentId, `${role} shares the task environment`);
  }
  // A decider and a consult reviewer are created idle and delivered by a send.
  const decider = await f.native.createSupportThread({ task: 'task_synthetic', workspaceId: handle, role: 'decider', key: 'decider-synthetic',
    title: '#1271 decider: Synthetic task', profile: { provider: 'codex', model: 'synthetic-model' } });
  const consult = await f.native.createSupportThread({ task: 'task_synthetic', workspaceId: handle, role: 'reviewer', key: 'consult-synthetic',
    title: '#1271 reviewer: Synthetic task', profile: { provider: 'codex', model: 'synthetic-model' } });
  for (const created of [decider, consult]) {
    const spawn = f.callsOf('threads.spawn').at(-1)!.args;
    assert.equal(spawn.parentThreadId, 'thr_planner');
    assert.equal(spawn.parentNotifications, 'off');
    assert.equal(Object.hasOwn(spawn, 'input'), false, 'a support thread is created idle, not with a prompt');
    assert.equal(spawn.pluginMetadata.nucleus.task, 'task_synthetic');
    assert.equal(f.rows.get(created.id)!.environmentId, f.workspace().environmentId);
  }
  // The planner ask is one queued send to a thread Nucleus did not create.
  await f.native.deliver('thr_planner', 'Synthetic planner question', 'msg_ask');
  assert.equal(f.callsOf('threads.send').at(-1)!.args.threadId, 'thr_planner');
});

test('BB phase 4: closeout archives recorded children before their parents and records completion once', async () => {
  const f = fixture();
  const worker = await f.native.createAgent(f.spec('run_worker', 'worker'));
  // A recorded child of the worker: a dependent BB names in the worker's cascade.
  const childRow = bbWire('list', { id: 'thr_child', parentThreadId: worker.id, environmentId: f.rows.get(worker.id)!.environmentId, environmentPath: '/synthetic/worktree', hasPendingInteraction: false });
  f.rows.set('thr_child', childRow);
  const state = f.state();
  state.agents['thr_child'] = { id: 'thr_child', task: 'task_synthetic', run: 'run_child', role: 'executor', workspaceId: handle, parentThreadId: worker.id, labels: wireLabels({ task: 'task_synthetic', run: 'run_child', role: 'executor' }) };
  f.ports.save(state);
  f.controls.cascadeNames.set(worker.id, [worker.id, 'thr_child']);

  await f.native.archiveAgent(worker.id);
  const archives = f.callsOf('threads.archive').map(call => call.args.threadId);
  assert.deepEqual(archives, ['thr_child', worker.id], 'the recorded child is archived first, then its parent');
  assert.ok(f.rows.get('thr_child')!.archivedAt, 'the child is archived');
  assert.ok(f.rows.get(worker.id)!.archivedAt, 'the parent is archived');
  // One completion: the same archive lane writes nothing twice.
  await f.native.archiveAgent(worker.id);
  assert.equal(f.callsOf('threads.archive').length, 2, 'a second closeout pass records no second archive');
  assert.equal(f.state().writes['archive:' + 'thr_child']?.status, 'settled');
  assert.equal(f.state().writes['archive:' + worker.id]?.status, 'settled');
});

test('BB phase 4: an archive whose cascade read is unavailable is refused, left unarchived and recorded incomplete', async () => {
  const f = fixture();
  const worker = await f.native.createAgent(f.spec());
  f.controls.loseCascade = true;
  await assert.rejects(f.native.archiveAgent(worker.id));
  assert.equal(f.rows.get(worker.id)!.archivedAt, null, 'a failed cascade read never archives');
  assert.equal(f.callsOf('threads.archive').length, 0);
  assert.notEqual(f.state().writes['archive:' + worker.id]?.status, 'settled', 'the cleanup stays incomplete for the next pass');
});

test('BB phase 4: an archive whose cascade names a thread this task does not own is refused, even with no sidebar child', async () => {
  const f = fixture();
  const worker = await f.native.createAgent(f.spec());
  // No sidebar child of the worker at all: a zero child count is no cascade proof.
  f.controls.cascadeNames.set(worker.id, [worker.id, 'thr_foreign_lifecycle_dependent']);
  await assert.rejects(f.native.archiveAgent(worker.id), /does not own/);
  assert.equal(f.rows.get(worker.id)!.archivedAt, null);
  assert.equal(f.callsOf('threads.archive').length, 0);
  // The refusal names the foreign dependent, so an operator sees what stopped it.
  const refused = await f.native.archiveAgent(worker.id).catch((error: Error) => error.message);
  assert.match(String(refused), /thr_foreign_lifecycle_dependent/);
});

test('BB phase 4: a reviewer replacement archives only the displaced thread through the durable archive effect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bb-phase4-reviewer-'));
  const store = new Store(join(directory, 'queue.sqlite'));
  try {
    store.setMeta('paused', false);
    store.setMeta('hostRegistry', [{ id: hostId, endpoint: 'fixture' }]);
    const initial = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Reviewer replacement', repoPath: '/synthetic/repo',
      planningCommit: 'a'.repeat(40), handoffPath: '/synthetic/handoff.md', originAgentId: 'origin' }), hostId, '/synthetic/handoff.md', 'a'.repeat(40));
    store.update(initial.id, { phase: 'reviewing', workspaceId: handle, directory: '/synthetic/worktree', plannerAgentId: formatAgentId(hostId, 'thr_planner') });

    const fake = bbFake();
    const notSent = (error: unknown) => error instanceof HostOperationError && (error.code === 'invalid_input' || error.code === 'refused');
    const operation = async (op: HostOperationName, input: unknown) => {
      try { return await fake.operations.execute(op, input); }
      catch (error) { if (error instanceof HostOperationError) throw error; throw new HostOperationError('unavailable', error instanceof Error ? error.message : String(error)); }
    };
    store.setMeta('bbWorkspaces', { [handle]: { id: handle, directory: '/synthetic/worktree', projectId: 'proj_synthetic', repositoryRoot: '/synthetic/repo', title: 'Synthetic' } satisfies BbWorkspaceRecord });
    const adapter = createBbHostAdapter(hostId, () => true, directory, store, operation) as Adapter & { guardedNativeAgentCreate(spec: HostAgentSpec, mcp: boolean, retry: boolean): Promise<{ id: string; workspaceId: string | null }> };
    const profile: Profile = { id: 'synthetic-profile', name: 'Synthetic profile', provider: 'codex', model: 'synthetic-model', notes: '', available: true, problem: '', supportedThinking: ['high'], thinkingOptionId: 'high' };
    const spec = (run: string, role: string): HostAgentSpec => ({ workspaceId: handle, taskNumber: 1271, title: `${role}: Synthetic task`, profile, mcpBindingPath: null,
      attempt: () => ({ requestId: `ns-${run}`, labels: wireLabels({ task: initial.id, run, role }), environment: {}, prompt: 'Synthetic prompt.' }) });
    const displaced = await adapter.guardedNativeAgentCreate(spec('run_displaced_reviewer', 'reviewer'), false, false);
    const current = await adapter.guardedNativeAgentCreate(spec('run_current_reviewer', 'reviewer'), false, false);

    const at = new Date().toISOString();
    const run = { id: 'run_displaced_reviewer', taskId: initial.id, hostId, role: 'reviewer', generation: 0, head: 'b'.repeat(40), base: 'a'.repeat(40),
      agentId: displaced.id, workspaceId: handle, profile, profileGroup: null, status: 'running', createdAt: at, lastObservedAt: at, active: false, idleSince: at,
      completion: null, released: false } satisfies Run;
    store.putRun(run);
    const task = store.task(initial.id);
    store.update(initial.id, { resolution: { ...task.resolution, reviewerAgentId: displaced.id, currentRunId: run.id } });
    assert.ok(store.threadArchiveKey(displaced.id, hostId));

    // The reviewer route records the replacement intent, and the archive fence runs
    // before the run is released.
    assert.equal(await archiveReplacedReviewer(store, adapter, run), true);
    assert.ok(fake.rows.get(displaced.id)!.archivedAt, 'the displaced reviewer thread is archived');
    // Ordinary observation then owns the release of the displaced run.
    assert.equal(await observeReviewerReplacement(store, adapter, run), true);
    assert.equal(fake.rows.get(current.id)!.archivedAt, null, 'the retained reviewer thread is untouched');
    const effect = store.getMeta<{ status: string; op?: string }>(qualifiedThreadArchiveEffectKey(hostId, displaced.id));
    assert.equal(effect?.status, 'archived', 'the existing durable archive effect records the archive once');
    assert.equal(effect?.op, undefined, 'the effect names an archive, never a removal');
    const released = store.run(run.id)!;
    assert.equal(released.released, true);
    assert.equal(released.status, 'superseded');
    assert.equal(store.task(initial.id).resolution.reviewerAgentId, null, 'the displaced binding is cleared for the next launch');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('BB phase 4: closeout refused by a foreign cascade stays unarchived and is recorded as incomplete', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bb-phase4-closeout-'));
  const store = new Store(join(directory, 'queue.sqlite'));
  try {
    store.setMeta('paused', false);
    store.setMeta('hostRegistry', [{ id: hostId, endpoint: 'fixture' }]);
    const initial = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Closeout refusal', repoPath: '/synthetic/repo',
      planningCommit: 'a'.repeat(40), handoffPath: '/synthetic/handoff.md', originAgentId: 'origin' }), hostId, '/synthetic/handoff.md', 'a'.repeat(40));
    store.update(initial.id, { phase: 'working', workspaceId: handle, directory: '/synthetic/worktree', plannerAgentId: formatAgentId(hostId, 'thr_planner') });
    const fake = bbFake();
    const notSent = (error: unknown) => error instanceof HostOperationError && (error.code === 'invalid_input' || error.code === 'refused');
    const operation = async (op: HostOperationName, input: unknown) => {
      try { return await fake.operations.execute(op, input); }
      catch (error) { if (error instanceof HostOperationError) throw error; throw new HostOperationError('unavailable', error instanceof Error ? error.message : String(error)); }
    };
    store.setMeta('bbWorkspaces', { [handle]: { id: handle, directory: '/synthetic/worktree', projectId: 'proj_synthetic', repositoryRoot: '/synthetic/repo', title: 'Synthetic' } satisfies BbWorkspaceRecord });
    const adapter = createBbHostAdapter(hostId, () => true, directory, store, operation) as Adapter & { guardedNativeAgentCreate(spec: HostAgentSpec, mcp: boolean, retry: boolean): Promise<{ id: string; workspaceId: string | null }> };
    const profile: Profile = { id: 'synthetic-profile', name: 'Synthetic profile', provider: 'codex', model: 'synthetic-model', notes: '', available: true, problem: '', supportedThinking: ['high'], thinkingOptionId: 'high' };
    const worker = await adapter.guardedNativeAgentCreate({ workspaceId: handle, taskNumber: 1271, title: 'Synthetic task', profile, mcpBindingPath: null,
      attempt: () => ({ requestId: 'ns-worker', labels: wireLabels({ task: initial.id, run: 'run_worker', role: 'worker' }), environment: {}, prompt: 'Synthetic prompt.' }) }, false, false);
    const current = store.task(initial.id);
    store.update(initial.id, { agentId: worker.id, phase: 'done', completion: null,
      resolution: { ...current.resolution, mergedCommit: 'c'.repeat(40), syncedCommit: 'c'.repeat(40) } });
    // A zero sidebar child count with a foreign lifecycle dependent: the cascade read
    // names a thread this task never created, so closeout refuses rather than guesses.
    fake.controls.cascadeNames.set(worker.id, ['thr_foreign_lifecycle_dependent']);

    await archiveFinishedThreads(store, adapter, initial.id);
    assert.equal(fake.rows.get(worker.id)!.archivedAt, null, 'the refused thread stays unarchived');
    const effect = store.getMeta<{ status: string; detail?: string }>(store.threadArchiveKey(worker.id, hostId)!);
    assert.notEqual(effect?.status, 'archived');
    assert.equal(effect?.status, 'ready', 'a proven pre-send refusal leaves the durable effect ready, not uncertain');
    assert.match(String(effect?.detail), /thr_foreign_lifecycle_dependent/);
    assert.equal(threadCleanupPending(store, store.task(initial.id), false), true, 'the cleanup is recorded as incomplete');
    assert.ok(store.events(initial.id).some(event => event.kind === 'thread_archive_wait' || event.kind === 'thread_archive_uncertain'));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('BB phase 4: the recorded BB interaction row is read as what it is, never as a native question', async () => {
  const f = fixture();
  const reviewer = await f.native.createAgent(f.spec('review_synthetic', 'reviewer'));
  f.rows.get(reviewer.id).hasPendingInteraction = true;
  // The exact row captured from the isolated BB 0.49 by proof:bb (plugin kind).
  f.interactions.set(reviewer.id, [bbWire('interaction', { threadId: reviewer.id })]);
  assert.deepEqual(await f.native.pendingQuestions(reviewer.id), [], 'a plugin interaction is not a provider question');
  const answer = await f.native.answerQuestion(reviewer.id, 'pint_synthetic', { Scope: 'Just this file' }).catch((error: Error) => error.message);
  assert.match(String(answer), /not a native question/, 'the recorded plugin interaction is refused as an answer target, not guessed at');
  assert.equal(f.callsOf('threads.interactions.resolve').length, 0);
});

test('BB phase 4: a support thread whose spawn reply is lost is adopted by its metadata, never spawned twice', async () => {
  const f = fixture();
  await f.native.createAgent(f.spec());
  f.controls.delaySpawn = true;
  f.controls.loseSpawn = true;
  await assert.rejects(f.native.createSupportThread({ task: 'task_synthetic', workspaceId: handle, role: 'decider', key: 'decider-late',
    title: '#1271 decider: Synthetic task', profile: { provider: 'codex', model: 'synthetic-model' } }), /unknown/i);
  assert.equal(f.callsOf('threads.spawn').length, 2, 'one worker and one support spawn were attempted');
  f.land();
  const adopted = await f.native.createSupportThread({ task: 'task_synthetic', workspaceId: handle, role: 'decider', key: 'decider-late',
    title: '#1271 decider: Synthetic task', profile: { provider: 'codex', model: 'synthetic-model' } });
  assert.equal(f.callsOf('threads.spawn').length, 2, 'the late support thread is adopted, not spawned again');
  assert.equal(f.state().agents[adopted.id]?.run, 'decider-late');
});
