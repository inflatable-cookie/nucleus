import { getWorkRoot } from "../core/workspaces/work-root.mjs";
import { after as restoreEnvironmentAfterTests } from "node:test";
const previousWorkRoot = process.env.NUCLEUS_WORK_ROOT;
const previousWorkVolumeId = process.env.NUCLEUS_WORK_VOLUME_ID;
process.env.NUCLEUS_WORK_ROOT = "/fixture/work";
process.env.NUCLEUS_WORK_VOLUME_ID = "";
restoreEnvironmentAfterTests(() => {
  if (previousWorkRoot === undefined) delete process.env.NUCLEUS_WORK_ROOT;
  else process.env.NUCLEUS_WORK_ROOT = previousWorkRoot;
  if (previousWorkVolumeId === undefined) delete process.env.NUCLEUS_WORK_VOLUME_ID;
  else process.env.NUCLEUS_WORK_VOLUME_ID = previousWorkVolumeId;
});
import { fakeAdapter, observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { workspaceCreationRefusal } from '../core/workspaces/workspace-allocation';
import { submissionSchema, type Profile, type Task } from '../shared/contracts';
import type { Adapter } from '../core/host';

/**
 * A dispatch that never became visible — a transport outage at the moment of the
 * create, for example — leaves `workspaceIntent` set with no workspace. The
 * automatic path must keep waiting rather than minting a second workspace, but an
 * operator may replay the *same* create once an exact lookup finds nothing,
 * because the create is keyed by a stable requestId, worktree slug and branch.
 */

const profile: Profile = { id: 'worker', name: 'worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };

function fixture(found: { id: string; directory: string }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-ws-replay-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] }]);
  let workspaces = found;
  const calls = { workspaces: 0, agents: 0 };
  const adapter: Adapter = fakeAdapter({
    profiles: async () => [profile], validate: async t => t.planningCommit,
    createWorkspace: async t => { calls.workspaces++; return { id: `ws-${t.id}`, directory: '/worktree' }; },
    findWorkspaces: async () => workspaces,
    verifyWorkspace: async t => t.branch, createAgent: async t => { calls.agents++; return { id: `agent-${t.runId}`, workspaceId: t.workspaceId }; },
     observe: observeIdle('workspace'),
     verifyPr: async () => ({ url: 'https://example.invalid/pr/1', head: 'a'.repeat(40) }),
  });
  const engine = new Engine(store, adapter, 0); engine.profiles = [profile];
  const uncertain = (changes: Partial<Task> = {}) => {
    const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: 'b'.repeat(40), handoffPath: 'docs/handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'b'.repeat(40));
    return store.update(submitted.id, {
      phase: 'needs_attention', planningBase: 'b'.repeat(40), workspaceIntent: true, branch: `ns-${submitted.id}`,
      profile, profileGroup: 'author', runId: null, reason: 'Workspace creation is uncertain; awaiting a visible result, not retrying creation', ...changes,
    });
  };
  return { store, engine, adapter, calls, uncertain, setWorkspaces: (value: typeof workspaces) => { workspaces = value; },
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('an uncertain workspace creation may be replayed once an exact lookup finds nothing', async () => {
  const f = fixture([]); try {
    const task = f.uncertain();
    const replayed = await f.engine.performTaskControl({ taskId: task.id, version: task.version, action:'restart',reason:'Replay the pre-dispatch validation' });
    assert.equal(replayed.phase, 'queued', 'the task returns to the queue so dispatch replays the same create');
    assert.equal(replayed.workspaceIntent, false, 'the uncertain intent is cleared only for a proven absence');
    assert.match(replayed.reason, /provably absent/);
    assert.equal(f.store.eventsAll(task.id).some(event => event.kind === 'retry_validation'), true, 'the replay is recorded');
    assert.equal(replayed.workspaceId, null, 'no workspace is invented by the control');
  } finally { await f.close(); }
});

test('an orphan worktree is reported precisely and removed only on the explicit control', async () => {
  const f = fixture([]); try {
    const task = f.uncertain();
    const orphan = { directory: '/orphan', branch: task.branch, head: 'b'.repeat(40), lockReason: 'initializing' };
    let removed = 0;
    f.adapter.inspectWorkspaceCreation = async () => removed ? { kind: 'absent' } : { kind: 'partial', orphan, evidence: 'locked initializing' };
    f.adapter.removeOrphanWorkspace = async () => { removed++; };
    await assert.rejects(() => f.engine.performTaskControl({ taskId: task.id, version: task.version, action:'restart',reason:'Replay the pre-dispatch validation' }),
      error => {
        const refusal = (error as Error).message;
        assert.match(refusal, /orphan worktree at \/orphan \(locked: initializing\).*retry_effect effect=workspace_creation discard=true/);
        assert.doesNotMatch(refusal, /removeOrphanWorkspace/, 'no refusal names an internal parameter');
        return true;
      });
    assert.equal(removed, 0);
    assert.equal(f.store.task(task.id).workspaceIntent, true);
    const replayed = await f.engine.performTaskControl({ taskId: task.id, version: task.version, action:'retry_effect',effect:'workspace_creation',discard:true,reason:'Replay the workspace creation' });
    assert.equal(removed, 1);
    assert.equal(replayed.phase, 'queued');
    assert.equal(f.store.eventsAll(task.id).some(event => event.kind === 'orphan_workspace_removed'), true);
  } finally { await f.close(); }
});

/** The classified facts for the incident's shape: a proven base-identical,
 * unpublished orphan branch with no worktree. */
const partialClassification = (task: Task) => ({ kind: 'partial' as const,
  orphan: { directory: null, branch: task.branch, head: 'b'.repeat(40), lockReason: 'partial' }, evidence: 'branch with no worktree' });

// nucleus#1106 shape 1: the incident's orphan branch with no worktree was proven
// base-identical and unpublished, yet the task sat in needs_attention for hours
// because the replay gate admitted only the dispatching phase. The same recovery
// path now clears the proven orphan and replays creation from its own parked stop.
test('recovery clears a proven orphan from its own parked stop and replays creation once', async () => {
  const f = fixture([]); try {
    const submitted = f.uncertain();
    const classified = partialClassification(submitted);
    const refusal = workspaceCreationRefusal(classified);
    assert.match(refusal, /retry_effect effect=workspace_creation discard=true/);
    assert.doesNotMatch(refusal, /removeOrphanWorkspace/, 'the stop names the owner verb and fields, never an internal parameter');
    f.store.update(submitted.id, { resolution: { ...f.store.task(submitted.id).resolution,
      stop: { reason: 'operator_needed', detail: refusal, since: new Date().toISOString(), suggestedVerbs: ['restart', 'route', 'move'] } } }, 'task_stopped', refusal);
    f.adapter.inspectWorkspaceCreation = async () => classified;
    let removed = 0;
    f.adapter.removeOrphanWorkspace = async (_t, value) => { removed++; assert.equal(value.branch, submitted.branch); };
    await f.engine.wake();
    const current = f.store.task(submitted.id);
    assert.equal(current.phase, 'working', 'the replayed creation dispatched a worker');
    assert.equal(removed, 1);
    assert.equal(f.calls.workspaces, 1);
    assert.equal(f.calls.agents, 1);
    assert.equal(f.store.eventsAll(submitted.id).filter(event => event.kind === 'workspace_creation_auto_replay').length, 1);
    assert.equal(f.store.eventsAll(submitted.id).some(event => event.kind === 'orphan_workspace_removed'), true);
    assert.equal(current.resolution.stop, null, 'the parked stop is settled by the replay');
    await f.engine.wake();
    assert.equal(removed, 1, 'one automatic replay, not a loop');
    assert.equal(f.calls.workspaces, 1);
  } finally { await f.close(); }
});

test('a parked task under an open attention episode keeps its stop', async () => {
  const f = fixture([]); try {
    const submitted = f.uncertain();
    const classified = partialClassification(submitted);
    f.adapter.inspectWorkspaceCreation = async () => classified;
    f.store.update(submitted.id, { resolution: { ...f.store.task(submitted.id).resolution, attention: true,
      stop: { reason: 'operator_needed', detail: workspaceCreationRefusal(classified), since: new Date().toISOString(), suggestedVerbs: ['restart', 'route', 'move'] } } }, 'task_stopped');
    let removed = 0;
    f.adapter.removeOrphanWorkspace = async () => { removed++; };
    await f.engine.wake();
    await f.engine.wake();
    const current = f.store.task(submitted.id);
    assert.equal(current.phase, 'needs_attention');
    assert.equal(current.resolution.attention, true, 'an open attention episode keeps its stop');
    assert.equal(removed, 0, 'an attended task is not steamrolled');
    assert.equal(f.calls.workspaces, 0);
    assert.equal(f.store.eventsAll(submitted.id).some(event => event.kind === 'workspace_creation_auto_replay'), false);
  } finally { await f.close(); }
});

// nucleus#1106 shape 2: `next` offers the verb the stop names, with its fields.
test('next offers retry_effect workspace_creation with discard for the parked orphan', async () => {
  const f = fixture([]); try {
    const submitted = f.uncertain();
    const classified = partialClassification(submitted);
    const refusal = workspaceCreationRefusal(classified);
    f.store.update(submitted.id, { resolution: { ...f.store.task(submitted.id).resolution,
      stop: { reason: 'operator_needed', detail: refusal, since: new Date().toISOString(), suggestedVerbs: ['restart', 'route', 'move'] } } }, 'task_stopped', refusal);
    f.adapter.inspectWorkspaceCreation = async () => classified;
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(submitted.id)));
    const exit = next.verbs.filter(verb => verb.verb === 'retry_effect' && verb.available);
    const named = exit.find(verb => (verb.args as { effect?: string } | undefined)?.effect === 'workspace_creation');
    assert.ok(named, 'next offers the replay the stop names');
    assert.deepEqual(named!.fill, ['reason', 'discard']);
    assert.match(next.stop!.detail, /retry_effect effect=workspace_creation discard=true/);
  } finally { await f.close(); }
});

test('ordinary work progresses under persistent host load, one creation per durable minute', async () => {
  const f = fixture([]); try {
    f.adapter.hostLoad = () => ({ load: 38, cpus: 18 });
    const first = f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false, reason: '' });
    const second = f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false, reason: '' });
    await f.engine.wake();
    assert.equal(f.calls.workspaces, 1);
    assert.ok(f.store.task(first.id).workspaceId);
    assert.equal(f.store.task(second.id).workspaceIntent, false);
    assert.match(f.engine.queuedExternalWait(f.store.task(second.id)), /paced under host pressure.*waiting for the admission gap to pass/);
    assert.ok(f.store.getMeta<number>('workspacePressureNotBefore')! > Date.now());
    assert.equal(f.store.eventsAll(first.id).filter(event => event.kind === 'workspace_pressure_admitted').length, 1);
    await f.engine.wake();
    assert.equal(f.calls.workspaces, 1, 'reconciliation does not reset durable pacing');
    f.store.setMeta('workspacePressureNotBefore', Date.now() - 1);
    await f.engine.wake();
    assert.equal(f.calls.workspaces, 2, 'persistent unrelated load cannot starve the next task');
  } finally { await f.close(); }
});

test('an unresolved creation intent holds only its own task under host pressure', async () => {
  const f = fixture([]); try {
    f.adapter.hostLoad = () => ({ load: 38, cpus: 18 });
    const pending = f.uncertain();
    const task = f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false, reason: '' });
    f.store.setMeta('workspacePressureNotBefore', Date.now() - 1);
    await f.engine.wake();
    assert.equal(f.calls.workspaces, 1, 'the next task starts');
    assert.equal(f.store.task(task.id).workspaceId, `ws-${task.id}`);
    assert.equal(f.store.task(pending.id).workspaceIntent, true, 'unknown delivery remains owned');
    assert.equal(f.store.task(pending.id).workspaceId, null);
  } finally { await f.close(); }
});

test('an operator-promoted task skips the load guard and records the override', async () => {
  const f = fixture([]); try {
    f.adapter.hostLoad = () => ({ load: 38, cpus: 18 });
    const queued = f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false, branch: 'x', reason: '' });
    const promoted = f.store.promoteQueuedTask(queued, 'operator');
    assert.ok(promoted.queuePriority > 0);
    await f.engine.wake();
    assert.equal(f.calls.workspaces, 1, 'the promoted task creates its workspace despite the load');
    assert.equal(f.store.task(promoted.id).workspaceId, `ws-${promoted.id}`);
    const skipped = f.store.eventsAll(promoted.id).find(event => event.kind === 'load_guard_skipped');
    assert.ok(skipped, 'the override is recorded');
    assert.match(skipped.detail, /load guard skipped for promoted task; load 38\.0 over 18 CPUs/);
  } finally { await f.close(); }
});

test('the load-guard override event is atomic with the dispatch intent', async () => {
  const f = fixture([]); try {
    f.adapter.hostLoad = () => ({ load: 38, cpus: 18 });
    const queued = f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false, branch: 'x', reason: '' });
    const promoted = f.store.promoteQueuedTask(queued, 'operator');
    const originalEmit = f.engine.hooks.emit.bind(f.engine.hooks);
    f.engine.hooks.emit = (async (...args: Parameters<typeof originalEmit>) => {
      // A concurrent edit between the pre-dispatch hook and the intent transaction
      // fences the dispatch: the audit event must not outlive an unrecorded intent.
      if (args[0] === 'task.pre_dispatch') f.store.update(promoted.id, { reason: 'concurrent edit' });
      return originalEmit(...args);
    }) as typeof f.engine.hooks.emit;
    await f.engine.wake();
    assert.equal(f.store.task(promoted.id).workspaceIntent, false, 'no durable intent is recorded');
    assert.equal(f.calls.workspaces, 0);
    assert.equal(f.store.eventsAll(promoted.id).some(event => event.kind === 'load_guard_skipped'), false, 'no audit event without the intent');
  } finally { await f.close(); }
});

test('a promoted task still waits for its dependencies', async () => {
  const f = fixture([]); try {
    f.adapter.hostLoad = () => ({ load: 38, cpus: 18 });
    const parent = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Parent', repoPath: '/repo', planningCommit: 'b'.repeat(40), handoffPath: 'docs/handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'b'.repeat(40));
    const child = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Child', repoPath: '/repo', planningCommit: 'b'.repeat(40), handoffPath: 'docs/handoff.md', originAgentId: 'origin', dependsOn: [parent.id] }), 'host', 'handoff', 'b'.repeat(40));
    f.store.promoteQueuedTask(f.store.task(child.id), 'operator');
    await f.engine.wake();
    assert.match(f.store.dependencyWait(f.store.task(child.id)) ?? '', /prerequisite/i);
    assert.equal(f.store.task(child.id).workspaceId, null, 'promotion does not bypass dependencies');
    assert.equal(f.calls.workspaces, 1, 'the eligible parent progresses under bounded pressure admission');
  } finally { await f.close(); }
});

test('a promoted task still waits for a task slot', async () => {
  const f = fixture([]); try {
    f.adapter.hostLoad = () => ({ load: 38, cpus: 18 });
    // Task 629 (PR 877) counts slots by live agents, so the occupying task
    // holds its slot with an observed-live agent, not merely a working phase.
    f.uncertain({ phase: 'working', workspaceId: 'ws-occupied', directory: '/worktree', agentActive: true });
    const queued = f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false, branch: 'x', reason: '' });
    f.store.promoteQueuedTask(queued, 'operator');
    f.store.setMeta('globalLimit', 1);
    await f.engine.wake();
    assert.match(f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)), /Global concurrent task-slot limit reached/);
    assert.equal(f.store.task(queued.id).workspaceId, null, 'promotion does not bypass the slot limit');
    assert.equal(f.calls.workspaces, 0);
  } finally { await f.close(); }
});

test('the replay refuses while a workspace is visible, so it cannot mint a second one', async () => {
  const f = fixture([{ id: 'ws-visible', directory: '/worktree' }]); try {
    const task = f.uncertain();
    await assert.rejects(() => f.engine.performTaskControl({ taskId: task.id, version: task.version, action:'restart',reason:'Replay the pre-dispatch validation' }), /does not uniquely match/);
    const unchanged = f.store.task(task.id);
    assert.equal(unchanged.phase, 'needs_attention');
    assert.equal(unchanged.workspaceIntent, true, 'a visible workspace leaves the fence intact');
  } finally { await f.close(); }
});

test('the replay refuses once a worker creation is in flight', async () => {
  const f = fixture([]); try {
    // A bare agent-creation intent with no retained run, workspace, directory or
    // profile is not a replayable absent-worker creation: the operator path needs
    // the complete retained intent, so this state refuses rather than guessing.
    const task = f.uncertain({ agentIntent: true });
    await assert.rejects(() => f.engine.performTaskControl({ taskId: task.id, version: task.version, action:'restart',reason:'Replay the pre-dispatch validation' }), /Absent-worker retry requires a retained creation intent with no worker/);
    assert.equal(f.store.task(task.id).workspaceIntent, true);
  } finally { await f.close(); }
});

test('an ordinary pre-dispatch retry is unchanged', async () => {
  const f = fixture([]); try {
    const task = f.uncertain({ phase: 'needs_attention', workspaceIntent: false });
    const retried = await f.engine.performTaskControl({ taskId: task.id, version: task.version, action:'restart',reason:'Replay the pre-dispatch validation' });
    assert.equal(retried.phase, 'queued');
    assert.match(retried.reason, /Restart requested/);
  } finally { await f.close(); }
});


test('operator retry settles an escalated dispatch and reuses the recorded workspace through dispatch', async () => {
  const f = fixture([{ id: 'retained', directory: '/worktree' }, { id: 'older', directory: '/older' }]);
  try {
    let task = f.uncertain({ workspaceId: 'retained', directory: '/worktree', held: true });
    f.engine.resolution.attention(task, 'Worktree behind planning base');
    f.engine.resolution.recovery.escalate(f.store.task(task.id), 'Operator repair required');
    task = f.store.task(task.id);
    let proofs = 0;
    f.adapter.verifyWorkspace = async t => { proofs++; return t.branch; };
    const result = await f.engine.performTaskControl({ taskId: task.id, version: task.version, action:'restart',reason:'Replay the pre-dispatch validation' });
    assert.equal(proofs, 1);
    assert.equal(result.phase, 'queued');
    assert.equal(result.workspaceId, 'retained');
    assert.equal(result.directory, '/worktree');
    assert.equal(result.workspaceIntent, true);
    assert.equal(result.resolution.attention, false);
    assert.equal(result.resolution.recovery, null);
    assert.equal(result.resolution.incident?.status, 'resolved');
    assert.ok(f.store.eventsAll(task.id).some(event => event.kind === 'recovery_escalated'));
    f.store.update(task.id, { held: false });
    await f.engine.wake();
    assert.equal(f.calls.workspaces, 0, 'no workspace create, even with an older duplicate present');
    assert.equal(f.calls.agents, 1, f.store.task(task.id).reason);
    assert.equal(f.store.task(task.id).workspaceId, 'retained');
    assert.equal(f.store.task(task.id).phase, 'working');
  } finally { await f.close(); }
});

test('retained-workspace retry preserves the hold on proof failure, identity drift, or concurrent edits', async () => {
  for (const mode of ['dirty', 'directory', 'absent', 'race'] as const) {
    const f = fixture([{ id: 'retained', directory: '/worktree' }]);
    try {
      const task = f.uncertain({ workspaceId: 'retained', directory: '/worktree', held: true });
      if (mode === 'dirty') f.adapter.verifyWorkspace = async () => { throw Error('Worktree is not clean'); };
      if (mode === 'directory') f.setWorkspaces([{ id: 'retained', directory: '/other' }]);
      if (mode === 'absent') f.setWorkspaces([]);
      if (mode === 'race') f.adapter.verifyWorkspace = async t => { f.store.update(t.id, { reason: 'concurrent edit' }); return t.branch; };
      await assert.rejects(() => f.engine.performTaskControl({ taskId: task.id, version: task.version, action:'restart',reason:'Replay the pre-dispatch validation' }),
        /not clean|does not uniquely match|not visible|changed during|needs a restart/);
      assert.equal(f.store.task(task.id).phase, 'needs_attention', mode);
      assert.equal(f.calls.workspaces, 0);
      assert.equal(f.calls.agents, 0);
    } finally { await f.close(); }
  }
});

test('a released worker run from an earlier owner move does not block the retained-workspace replay (nucleus#1147)', async () => {
  // 1147 returns a task with no live worker and no PR to dispatch, whatever released
  // history it carries. Validation retry applies the same rule, so the replay verifies
  // the retained workspace and queues it without creating one.
  const f = fixture([{ id: 'retained', directory: '/worktree' }]);
  try {
    const task = f.uncertain({ workspaceId: 'retained', directory: '/worktree', held: true });
    f.store.putRun({ id: 'old-worker', taskId: task.id, role: 'worker', released: true } as never);
    const replayed = await f.engine.performTaskControl({ taskId: task.id, version: task.version, action: 'restart', reason: 'Replay the pre-dispatch validation' });
    assert.equal(replayed.phase, 'queued');
    assert.equal(replayed.workspaceId, 'retained');
    assert.equal(f.calls.workspaces, 0, 'the retained workspace is reused, not created');
    assert.equal(f.store.runs(task.id).find(run => run.id === 'old-worker')?.released, true, 'the released run stays history');
  } finally { await f.close(); }
});

test('retained-workspace restart applies while paused; nothing is created until unpause (round 4)', async () => {
  const f = fixture([{ id: 'retained', directory: '/worktree' }]);
  try {
    const task = f.uncertain({ workspaceId: 'retained', directory: '/worktree', held: true });
    f.store.setMeta('paused', true);
    const restarted = await f.engine.performTaskControl({ taskId: task.id, version: task.version, action: 'restart', reason: 'Replay the pre-dispatch validation' });
    assert.notEqual(restarted.phase, 'needs_attention', 'the re-admission is recorded while paused');
    await f.engine.wake();
    assert.equal(f.calls.workspaces, 0, 'no workspace is created while paused');
    assert.equal(f.calls.agents, 0, 'no agent is created while paused');
  } finally { await f.close(); }
});

test('a branch left behind by an interrupted orphan removal is still detected and removed', async () => {
  const { execFileSync } = await import('node:child_process');
  const { PaseoAdapter } = await import('../service/paseo-composition');
  const dir = mkdtempSync(join(tmpdir(), 'ns-orphan-'));
  try {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    run('init', '-q', '-b', 'main'); run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
    const task = { id: 'abc', repoPath: dir, baseBranch: 'main', branch: 'ns-abc' } as Task;
    const adapter = new PaseoAdapter('ws://127.0.0.1:1', join(dir, 'cb.sock'), join(dir, 'report.mjs'));
    run('branch', 'ns-abc');
    const orphan = await adapter.inspectOrphanWorkspace(task);
    assert.equal(orphan?.directory, null, 'the branch alone is an orphan when no worktree is listed');
    await adapter.removeOrphanWorkspace(task, orphan!);
    assert.equal(await adapter.inspectOrphanWorkspace(task), null);
    assert.equal(run('branch', '--list', 'ns-abc'), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a leftover that is not a provable orphan blocks replay instead of reading as absent', async () => {
  const { execFileSync } = await import('node:child_process');
  const { PaseoAdapter } = await import('../service/paseo-composition');
  const dir = mkdtempSync(join(tmpdir(), 'ns-orphan-'));
  try {
    const run = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
    run('init', '-q', '-b', 'main'); run('commit', '-q', '--allow-empty', '-m', 'base');
    const task = { id: 'abc', repoPath: dir, baseBranch: 'main', branch: 'ns-abc' } as Task;
    const adapter = new PaseoAdapter('ws://127.0.0.1:1', join(dir, 'cb.sock'), join(dir, 'report.mjs'));
    assert.equal(await adapter.inspectOrphanWorkspace(task), null, 'nothing left means replay is safe');
    run('branch', 'ns-abc');
    const tree = join(dir, 'wt', 'ns-abc');
    run('worktree', 'add', '-q', tree, 'ns-abc');
    await assert.rejects(() => adapter.inspectOrphanWorkspace(task), /Complete unpublished checkout exists|bind it, do not replay/);
    writeFileSync(join(tree, 'notes.txt'), 'authored');
    await assert.rejects(() => adapter.inspectOrphanWorkspace(task), /unlocked and dirty|not a provable orphan/, 'unlocked dirty at a non-owned path is authored work');
    await assert.rejects(() => adapter.removeOrphanWorkspace(task, { directory: tree, branch: 'ns-abc', head: run('rev-parse', 'ns-abc'), lockReason: 'partial' }), /unlocked and dirty|not a provable orphan/);
    assert.equal(existsSync(join(tree, 'notes.txt')), true, 'authored notes survive a refused discard');
    rmSync(join(tree, 'notes.txt'));
    run('worktree', 'lock', '--reason', 'operator is initializing a rebuild', tree);
    await assert.rejects(() => adapter.inspectOrphanWorkspace(task), /not locked with the exact reason/, 'a foreign lock that merely mentions initializing is not proof');
    run('worktree', 'unlock', tree); run('worktree', 'lock', '--reason', 'INITIALIZING', tree);
    await assert.rejects(() => adapter.inspectOrphanWorkspace(task), /not locked with the exact reason/, 'the reason is compared case-sensitively');
    run('worktree', 'unlock', tree); run('worktree', 'lock', '--reason', 'initializing', tree);
    assert.match((await adapter.inspectOrphanWorkspace(task))?.directory ?? '', /\/wt\/ns-abc$/, 'locked initializing and clean is an orphan');
    run('worktree', 'unlock', tree); run('worktree', 'remove', tree);
    // A slug-matched locked detached worktree at a unique clean commit is not removable.
    run('branch', '-D', 'ns-abc'); run('branch', 'ns-abc');
    run('worktree', 'add', '-q', '--detach', tree, 'main');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'unique'], { cwd: tree });
    run('worktree', 'lock', '--reason', 'initializing', tree);
    await assert.rejects(() => adapter.inspectOrphanWorkspace(task), /not the task branch tip/);
    await assert.rejects(() => adapter.removeOrphanWorkspace(task, { directory: tree, branch: 'ns-abc', head: run('rev-parse', 'ns-abc'), lockReason: 'initializing' }), /not the task branch tip/);
    assert.equal(existsSync(tree), true, 'the unique commit survives');
    run('worktree', 'unlock', tree); run('worktree', 'remove', '--force', tree);
    run('checkout', '-q', 'ns-abc'); run('commit', '-q', '--allow-empty', '-m', 'work'); run('checkout', '-q', 'main');
    await assert.rejects(() => adapter.inspectOrphanWorkspace(task), /commits beyond base/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pressure sampled after validation is recorded atomically with the creation intent', async () => {
  const f = fixture([]); try {
    let samples = 0;
    f.adapter.hostLoad = () => ({ load: ++samples === 1 ? 2 : 38, cpus: 18 });
    const task = f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false, branch: 'x', reason: '' });
    await f.engine.wake();
    assert.equal(f.calls.workspaces, 1);
    assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'workspace_pressure_admitted').length, 1);
    assert.ok(f.store.getMeta<number>('workspacePressureNotBefore')! > Date.now());
  } finally { await f.close(); }
});

test('a pause arriving during validation prevents pressure admission and its durable marker', async () => {
  const f = fixture([]); try {
    f.adapter.hostLoad = () => ({ load: 38, cpus: 18 });
    const task = f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false, reason: '' });
    f.adapter.validate = async t => { f.store.setMeta('paused', true); return t.planningCommit; };
    await f.engine.wake();
    assert.equal(f.calls.workspaces, 0);
    assert.equal(f.store.task(task.id).workspaceIntent, false);
    assert.equal(f.store.getMeta('workspacePressureNotBefore'), undefined);
  } finally { await f.close(); }
});

test('sweep replays one proven empty creation and refuses conflicting evidence', async () => {
  for (const kind of ['absent', 'partial', 'conflicting'] as const) {
    const f = fixture([]); try {
      const task = f.uncertain({ phase: 'dispatching' });
      const orphan = { directory: '/orphan', branch: task.branch, head: 'b'.repeat(40), lockReason: 'initializing' };
      f.adapter.inspectWorkspaceCreation = async () => kind === 'partial' ? { kind, orphan, evidence: 'base-identical' }
        : kind === 'conflicting' ? { kind, evidence: 'changed work' } : { kind };
      let removed = 0;
      f.adapter.removeOrphanWorkspace = async () => { removed++; };
      await f.engine.wake();
      const current = f.store.task(task.id);
      if (kind === 'conflicting') {
        assert.equal(current.workspaceIntent, true);
        assert.equal(f.store.eventsAll(task.id).some(event => event.kind === 'workspace_creation_auto_replay'), false);
        assert.equal(removed, 0);
      } else {
        assert.equal(current.phase, 'working');
        assert.equal(f.calls.workspaces, 1);
        assert.equal(removed, kind === 'partial' ? 1 : 0);
        assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'workspace_creation_auto_replay').length, 1);
      }
    } finally { await f.close(); }
  }
});

test('a Builds drop defers several dispatches without creation or incidents and resumes when proved', async () => {
  const f = fixture([]); try {
    const { CheckoutUnavailableError } = await import('../core/workspaces/checkout-volume');
    let available = false;
    f.adapter.preflightWorkspaceStorage = async () => { if (!available) throw new CheckoutUnavailableError('volume identity unprovable'); };
    const tasks = Array.from({ length: 3 }, () => f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false }));
    await f.engine.wake();
    for (const task of tasks) {
      const current = f.store.task(task.id);
      assert.equal(current.phase, 'queued');
      assert.match(current.reason, /checkout storage unavailable/);
      assert.equal(current.workspaceIntent, false);
      assert.equal(current.resolution.incident, null);
    }
    assert.equal(f.calls.workspaces, 0);
    assert.equal(f.calls.agents, 0);
    available = true;
    await f.engine.wake();
    assert.ok(f.calls.workspaces > 0);
  } finally { await f.close(); }
});

test('a shared GitHub outage leaves several dispatches waiting without launches and clears on recovery', async () => {
  const f = fixture([]); try {
    const { ForgeOutageError } = await import('../core/forge/forge-health');
    let healthy = false;
    f.adapter.validate = async task => { if (!healthy) throw new ForgeOutageError(new Error('HTTP 503')); return task.planningCommit; };
    const tasks = Array.from({ length: 3 }, () => f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false }));
    await f.engine.wake();
    for (const task of tasks) {
      const current = f.store.task(task.id);
      assert.match(current.reason, /GitHub is unavailable/);
      assert.equal(current.resolution.incident, null);
      assert.equal(current.workspaceIntent, false);
    }
    assert.equal(f.calls.workspaces, 0);
    assert.equal(f.calls.agents, 0);
    healthy = true;
    await f.engine.wake();
    assert.ok(f.calls.workspaces > 0);
  } finally { await f.close(); }
});

test('a second proven empty creation remains with its owner', async () => {
  const f = fixture([]); try {
    const task = f.uncertain({ phase: 'dispatching' });
    f.adapter.inspectWorkspaceCreation = async () => ({ kind: 'absent' });
    f.store.event(task.id, 'workspace_creation_auto_replay', 'absent');
    await f.engine.wake();
    assert.equal(f.calls.workspaces, 0);
    assert.equal(f.store.task(task.id).workspaceIntent, true);
    assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'workspace_creation_auto_replay').length, 1);
  } finally { await f.close(); }
});

test('a retained Stash workspace waits through a drive drop without launching recovery', async () => {
  const f = fixture([]); try {
    const { CheckoutUnavailableError } = await import('../core/workspaces/checkout-volume');
    let available = false, observations = 0;
    f.adapter.preflightWorkspaceStorage = async () => { if (!available) throw new CheckoutUnavailableError('mount unavailable'); };
    f.adapter.observe = async id => { observations++; return { id, workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' }; };
    const task = f.uncertain({ phase: 'working', workspaceId: 'workspace', directory: `${getWorkRoot()}/queue/workspaces/test`, agentIntent: true, agentId: 'worker', runId: 'run' });
    await f.engine.wake();
    assert.match(f.store.task(task.id).reason, /checkout storage unavailable/);
    assert.equal(f.store.task(task.id).resolution.incident, null);
    assert.equal(f.calls.agents, 0);
    const observedDuringDrop = observations;
    available = true;
    await f.engine.wake();
    assert.ok(observations > observedDuringDrop);
  } finally { await f.close(); }
});

test('a retired workspace never preflights or launches recovery when its mount returns', async () => {
  const f = fixture([]); try {
    let preflights = 0, observations = 0;
    f.adapter.preflightWorkspaceStorage = async () => { preflights++; };
    f.adapter.observe = async id => { observations++; return { id, workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' }; };
    const task = f.uncertain({ phase: 'working', workspaceId: 'workspace', directory: '/Volumes/retired-volume/queue/workspaces/test', agentIntent: true, agentId: 'worker', runId: 'run' });
    await f.engine.wake(); await f.engine.wake();
    assert.equal(preflights, 0);
    assert.equal(f.store.task(task.id).resolution.incident, null);
    assert.equal(f.calls.agents, 0);
  } finally { await f.close(); }
});

test('a pre-send Builds refusal preserves the worker identity and retries without an incident', async () => {
  const f = fixture([]); try {
    const { CheckoutUnavailableError } = await import('../core/workspaces/checkout-volume');
    let available = false, attemptedRun = '';
    f.adapter.createAgent = async task => {
      if (!available) { attemptedRun = task.runId!; throw new CheckoutUnavailableError('mount unavailable'); }
      assert.equal(task.runId, attemptedRun);
      return { id: 'worker', workspaceId: task.workspaceId! };
    };
    const task = f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false });
    await f.engine.wake();
    const waiting = f.store.task(task.id);
    assert.match(waiting.reason, /checkout storage unavailable/);
    assert.equal(waiting.resolution.incident, null);
    assert.equal(waiting.agentIntent, false);
    assert.equal(waiting.restartRunId, attemptedRun);
    available = true;
    await f.engine.wake();
    assert.equal(f.store.task(task.id).agentId, 'worker');
  } finally { await f.close(); }
});


test('a different Builds identity is refused rather than treated as a drive wait', async () => {
  const f = fixture([]); try {
    const { CheckoutRefusalError } = await import('../core/workspaces/checkout-volume');
    f.adapter.preflightWorkspaceStorage = async () => { throw new CheckoutRefusalError('different volume identity'); };
    const task = f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false });
    await f.engine.wake();
    const current = f.store.task(task.id);
    assert.equal(current.phase, 'needs_attention');
    assert.match(current.reason, /different volume identity/);
    assert.equal(f.calls.workspaces, 0);
    assert.equal(f.calls.agents, 0);
  } finally { await f.close(); }
});

test('the admission gap follows the load band: none at CPU count, 20 s to twice it, 60 s above', async () => {
  for (const [load, gapMs] of [[18, 0], [36, 20_000], [37, 60_000]] as const) {
    const f = fixture([]); try {
      f.adapter.hostLoad = () => ({ load, cpus: 18 });
      const task = f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false, branch: 'x', reason: '' });
      await f.engine.wake();
      assert.equal(f.calls.workspaces, 1, `load ${load} admits the first creation`);
      const admitted = f.store.eventsAll(task.id).find(event => event.kind === 'workspace_pressure_admitted');
      if (gapMs === 0) {
        assert.equal(admitted, undefined, `load ${load} is not paced`);
        assert.equal(f.store.getMeta('workspacePressureNotBefore'), undefined);
      } else {
        assert.equal(JSON.parse(admitted!.detail).gapMs, gapMs, `load ${load} uses its band gap`);
      }
    } finally { await f.close(); }
  }
});

test('a paced task starts when the admission gap ends, with no other wake', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const f = fixture([]); try {
    f.adapter.hostLoad = () => ({ load: 25, cpus: 18 });
    const first = f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false, branch: 'x', reason: '' });
    const second = f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false, branch: 'y', reason: '' });
    // Nothing else drives dispatch: the only later pass is the wake armed for the gap end.
    const settle = async (done: () => boolean) => { for (let i = 0; i < 500 && !done(); i++) await new Promise(resolve => setImmediate(resolve)); };
    await f.engine.wake();
    assert.equal(f.calls.workspaces, 1);
    assert.ok(f.store.task(first.id).workspaceId);
    assert.match(f.engine.queuedExternalWait(f.store.task(second.id)), /paced under host pressure.*waiting for the admission gap to pass/);
    t.mock.timers.tick(19_999);
    await settle(() => false);
    assert.equal(f.calls.workspaces, 1, 'no admission before the gap ends');
    t.mock.timers.tick(1);
    await settle(() => f.calls.workspaces === 2);
    assert.equal(f.calls.workspaces, 2, 'the paced task is admitted at the gap end without a sweep');
    assert.ok(f.store.task(second.id).workspaceId);
    assert.doesNotMatch(f.engine.queuedExternalWait(f.store.task(second.id)), /paced under host pressure/, 'the wait text is not stale after the gap');
  } finally { await f.close(); }
});

test('a promoted task bypasses an active admission gap', async () => {
  const f = fixture([]); try {
    f.adapter.hostLoad = () => ({ load: 25, cpus: 18 });
    const queued = f.store.update(f.uncertain().id, { phase: 'queued', workspaceIntent: false, branch: 'x', reason: '' });
    const promoted = f.store.promoteQueuedTask(queued, 'operator');
    f.store.setMeta('workspacePressureNotBefore', Date.now() + 60_000);
    await f.engine.wake();
    assert.equal(f.calls.workspaces, 1, 'the promoted task creates its workspace inside the gap');
    assert.equal(f.store.task(promoted.id).workspaceId, `ws-${promoted.id}`);
  } finally { await f.close(); }
});
