import { observeIdle } from './support/fakes';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Engine } from '../core/engine';
import { Store, operationInputHash } from '../core/store/store';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { reopenDispositionWorkspace, productionDeps, resumeDispositions } from '../core/verbs/disposition';
import type { Adapter, AgentObservation } from '../core/host';
import { isDispositionActive, submissionSchema, taskControlInputSchema, type Task } from '../shared/contracts';

/**
 * Spec 050 `retry_effect` on a disposition that stopped at its workspace step
 * (task 448). The acceptance shape is the real one: a supersession whose
 * released run and archived threads already settled, whose recorded
 * `retained_by_replacement` proof cannot be produced because the replacement
 * workspace was retired, and whose original work is clean, published source.
 *
 * These fixtures are real Git repositories with the actual production
 * disposition driver, Paseo adapter surface and durable owner control. The
 * recorded effect identity is derived by the store, the original supersession
 * keeps its kind, replacement link, reason and effect history, and selecting
 * the existing safe `archive_if_empty` policy is one attributed transition —
 * never a rewrite of what the task asked for.
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const base = 'b'.repeat(40);
const submit = (title: string, repoPath: string) => submissionSchema.parse({
  submissionId: randomUUID(), title, repoPath, planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin',
});

interface Fixture {
  root: string; repo: string; origin: string; store: Store; engine: Engine;
  original: Task; replacement: Task; directory: string; head: string; base: string;
  archives: string[]; archivedAgents: string[]; observation: AgentObservation;
  task(): Task; next(): ReturnType<typeof ownerTaskNext>;
  /** The production disposition pass a service restart runs for an active fence. */
  resume(): Promise<Task>;
  retry(values?: { effect?: string; workDisposition?: 'archive_if_empty'; caller?: string; relayed?: boolean; note?: string; version?: number }): Promise<Task>;
}

/**
 * `retained` builds a replacement workspace that really contains the original
 * commits, `squashed` one whose merged source is a copy (no ancestry), and
 * `retired` one that is removed after the replacement finished — the recorded
 * incident's shape.
 */
async function supersessionFixture(t: TestContext, shape: 'retained' | 'squashed' | 'retired'): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'ns-disposition-workspace-'));
  const origin = join(root, 'origin.git'), repo = join(root, 'repo');
  const directory = join(root, 'ws-original'), replacementDirectory = join(root, 'ws-replacement');
  const store = new Store(join(root, 'queue.sqlite'));
  store.setMeta('paused', false);
  let engine: Engine | undefined;
  t.after(() => { void engine?.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });

  git(root, 'init', '--bare', '--initial-branch=main', origin);
  git(root, 'init', '--initial-branch=main', repo);
  git(repo, 'config', 'user.name', 'Queue tests');
  git(repo, 'config', 'user.email', 'queue@example.invalid');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'base');
  const planningBase = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', 'origin', 'main');

  const inserted = store.insert(submit('Original work', repo), 'host', 'handoff', planningBase);
  git(repo, 'worktree', 'add', '-b', inserted.branch, directory);
  writeFileSync(join(directory, 'task.txt'), 'original work\n');
  git(directory, 'add', '-A'); git(directory, 'commit', '-m', 'original task work');
  git(directory, 'push', '-u', 'origin', inserted.branch);
  const head = git(directory, 'rev-parse', 'HEAD');
  const original = store.update(inserted.id, {
    phase: 'working', workspaceIntent: true, agentIntent: true, agentId: `worker-${inserted.id}`, runId: 'run-original',
    workspaceId: 'ws-original', directory, planningBase, prHead: head, prUrl: 'https://github.com/example/repo/pull/1043',
  });

  const replacementInserted = store.insert(submit('Replacement work', repo), 'host', 'handoff', planningBase);
  git(repo, 'worktree', 'add', '-b', replacementInserted.branch, replacementDirectory);
  if (shape === 'squashed') {
    git(replacementDirectory, 'merge', '--squash', inserted.branch);
    git(replacementDirectory, 'commit', '-m', 'squashed original source');
  } else {
    git(replacementDirectory, 'merge', '--no-ff', inserted.branch, '-m', 'retain original work');
    writeFileSync(join(replacementDirectory, 'follow-up.txt'), 'replacement follow-up\n');
    git(replacementDirectory, 'add', '-A'); git(replacementDirectory, 'commit', '-m', 'replacement follow-up');
  }
  const replacementHead = git(replacementDirectory, 'rev-parse', 'HEAD');
  const replacement = store.update(replacementInserted.id, {
    phase: 'done', workspaceIntent: true, agentIntent: true, agentId: `worker-${replacementInserted.id}`,
    workspaceId: 'ws-replacement', directory: replacementDirectory, planningBase,
    // A retained replacement of the same PR keeps the exact same PR head.
    ...(shape === 'retained' ? { prHead: head, prUrl: original.prUrl! } : {}),
    resolution: { ...replacementInserted.resolution, mergedCommit: replacementHead, syncedCommit: replacementHead },
  });
  if (shape === 'retired') {
    // The owner's own cleanup retired the replacement workspace after its merge.
    rmSync(replacementDirectory, { recursive: true, force: true });
  }

  const archives: string[] = [], archivedAgents: string[] = [];
  const observation: AgentObservation = { id: `worker-${original.id}`, workspaceId: 'ws-original', status: 'idle', active: false, permissions: false, error: '' };
  const adapter = {
    observe: async (id: string) => ({ ...observation, id }),
    archiveAgent: async (id: string) => { archivedAgents.push(id); },
    archiveTaskWorkspace: async (_task: Task, id: string, path: string) => { archives.push(id); rmSync(path, { recursive: true, force: true }); return true; },
    taskWorkspaceArchived: async (_id: string) => !existsSync(directory),
  } as unknown as Adapter;
  engine = new Engine(store, adapter, 0);
  const task = () => store.task(original.id);
  const next = () => ownerTaskNext(collectOwnerVerbFacts(store, task()));
  const resume = async () => {
    await resumeDispositions(store, productionDeps({
      store, hooks: { emit: async () => ({ hold: false, attention: false, records: [] as unknown[] }) },
      observe: observeIdle('ws-original'),
      archiveAgent: async (id: string) => { archivedAgents.push(id); },
      archiveWorkspace: async (current: Task) => { archives.push(current.workspaceId!); rmSync(current.directory!, { recursive: true, force: true }); return true; },
      observeWorkspaceArchived: async () => !existsSync(directory),
      archiveSiblings: async () => {},
    }));
    return store.task(original.id);
  };
  const retry = (values: Parameters<Fixture['retry']>[0] = {}) => engine!.performTaskControl(taskControlInputSchema.parse({
    taskId: original.id, version: values.version ?? task().version, action: 'retry_effect',
    effect: values.effect ?? 'disposition_workspace.ws-original',
    ...(values.workDisposition ? { workDisposition: values.workDisposition } : {}),
    caller: values.caller ?? 'operator (board)', ...(values.relayed ? { relayed: true } : {}), ...(values.note ? { note: values.note } : {}),
    reason: 'The replacement workspace is retired; recover the recorded disposition workspace step',
  }));
  return { root, repo, origin, store, engine, original, replacement, directory, head, base: planningBase,
    archives, archivedAgents, observation, task, next, resume, retry };
}

const effectView = (f: Fixture) => f.next().verbs.find(view => view.verb === 'retry_effect' && view.args?.effect === 'disposition_workspace.ws-original');

async function supersede(f: Fixture, workDisposition: 'retained_by_replacement' | 'archive_if_empty' = 'retained_by_replacement') {
  return f.engine.disposeTask({ taskId: f.original.id, version: f.task().version, action: 'supersede',
    reason: 'Replaced by the later implementation', replacementTaskId: f.replacement.id, workDisposition });
}

test('a supersession frozen at its workspace proof offers one retry and no repeated thread effects', async t => {
  const f = await supersessionFixture(t, 'retired');
  const result = await supersede(f);
  assert.equal(result.phase, 'needs_attention');
  assert.equal(result.disposition?.status, 'needs_attention');
  assert.match(result.disposition!.effects.find(effect => effect.kind === 'workspace_proof')!.result!, /Replacement workspace is unavailable/);
  assert.deepEqual(f.archivedAgents, [`worker-${f.original.id}`], 'the owned thread archived once');
  assert.deepEqual(f.archives, [], 'nothing was archived while the proof was uncertain');

  const offered = effectView(f);
  assert.ok(offered?.available, 'next offers the recorded pending effect');
  assert.equal(offered!.args!.taskId, f.original.id);
  assert.equal(offered!.args!.version, f.task().version);
  assert.match(offered!.note ?? '', /archive_if_empty is the existing safe policy/);

  // Re-running the recorded policy now that evidence is still unavailable is
  // refused by the store as pending again, and the settled thread is not
  // archived or released a second time.
  const reRun = await f.retry();
  assert.equal(reRun.phase, 'needs_attention');
  assert.equal(f.archivedAgents.length, 1, 'a settled archive_thread is never replayed');
  assert.equal(f.archives.length, 0);
  assert.equal(reRun.disposition!.workDisposition, 'retained_by_replacement', 'the recorded request stays exact');
  assert.deepEqual(reRun.disposition!.proofPolicies, [], 're-running the recorded policy records no transition');
  assert.equal(reRun.disposition!.replacementTaskId, f.replacement.id);
  assert.equal(reRun.disposition!.reason, 'Replaced by the later implementation');
  assert.equal(reRun.disposition!.effects.filter(effect => effect.kind === 'workspace_proof').length, 2, 'each attempt is its own history');
});

test('the owner-selected archive_if_empty policy completes the same supersession once, with clean published source', async t => {
  const f = await supersessionFixture(t, 'retired');
  const frozen = await supersede(f);
  const archivedBefore = f.archivedAgents.length;
  const settled = await f.retry({ workDisposition: 'archive_if_empty' });

  assert.equal(settled.phase, 'cancelled');
  assert.equal(settled.disposition?.status, 'complete');
  assert.equal(settled.disposition?.kind, 'supersede');
  assert.equal(settled.disposition?.replacementTaskId, f.replacement.id);
  assert.equal(settled.disposition?.reason, 'Replaced by the later implementation');
  assert.match(settled.reason, /^Superseded by /, 'the terminal projection is unchanged');
  assert.equal(settled.disposition?.workDisposition, 'retained_by_replacement', 'past intent is not overwritten');
  assert.deepEqual(settled.disposition?.proofPolicies, [{ policy: 'archive_if_empty', previous: 'retained_by_replacement',
    at: settled.disposition!.proofPolicies[0]!.at, by: 'operator (board)', authority: 'operator', note: null,
    reason: 'The replacement workspace is retired; recover the recorded disposition workspace step' }]);
  assert.match(settled.disposition!.workspaceEvidence, /origin queue branch/);
  assert.deepEqual(f.archives, ['ws-original'], 'one workspace archive, no duplicate effect');
  assert.equal(f.archivedAgents.length, archivedBefore, 'no thread effect repeats on the resume');
  assert.equal(existsSync(f.directory), false);
  assert.equal(isDispositionActive(settled), false);
  assert.ok(f.store.events(f.original.id).some(event => event.kind === 'disposition_proof_policy'));
  assert.ok(f.store.events(f.original.id).some(event => event.kind === 'disposition_workspace_retry_result'));
  // The frozen occurrence keeps its own recorded uncertainty.
  assert.ok(frozen.disposition!.effects.every(effect => effect.kind !== 'archive_workspace' || effect.result === null || Boolean(effect.result)));
});

test('an available replacement that really retains the commits satisfies the recorded policy without a transition', async t => {
  const f = await supersessionFixture(t, 'retained');
  const settled = await supersede(f);
  assert.equal(settled.phase, 'cancelled');
  assert.equal(settled.disposition?.status, 'complete');
  assert.match(settled.disposition!.workspaceEvidence, /Replacement retains every unique task commit/);
  assert.deepEqual(settled.disposition!.proofPolicies, []);
  assert.deepEqual(f.archives, ['ws-original']);
});

test('a squashed copy of the work is not an ancestry claim: the workspace is preserved', async t => {
  const f = await supersessionFixture(t, 'squashed');
  const settled = await supersede(f);
  assert.equal(settled.phase, 'cancelled');
  assert.equal(settled.disposition?.workspaceArchived, false);
  assert.match(settled.disposition!.workspaceEvidence, /Replacement does not retain task commit/);
  assert.deepEqual(f.archives, []);
  assert.equal(existsSync(f.directory), true);
});

test('archive_if_empty still holds dirty and unpushed work; it never becomes a discard', async t => {
  for (const shape of ['dirty', 'unpushed'] as const) {
    const f = await supersessionFixture(t, 'retired');
    await supersede(f);
    if (shape === 'dirty') writeFileSync(join(f.directory, 'untracked.txt'), 'unpublished\n');
    else {
      writeFileSync(join(f.directory, 'unpushed.txt'), 'unpushed\n');
      git(f.directory, 'add', '-A'); git(f.directory, 'commit', '-m', 'unpushed local work');
    }
    const settled = await f.retry({ workDisposition: 'archive_if_empty' });
    assert.equal(settled.phase, 'cancelled', shape);
    assert.equal(settled.disposition?.workspaceArchived, false, shape);
    assert.match(settled.disposition!.workspaceEvidence, shape === 'dirty' ? /dirty/ : /not on origin/, shape);
    assert.deepEqual(f.archives, [], shape);
    assert.equal(existsSync(f.directory), true, shape);
    // The policy transition is recorded as history even though it preserved the work.
    assert.equal(settled.disposition?.workDisposition, 'retained_by_replacement', shape);
    assert.equal(settled.disposition!.proofPolicies.length, 1, shape);
  }
});

test('stale, mismatched, unauthorized and non-safe policy recoveries refuse with nothing written', async t => {
  const f = await supersessionFixture(t, 'retired');
  const frozen = await supersede(f);
  const before = JSON.stringify(f.task().disposition);

  await assert.rejects(f.retry({ version: frozen.version - 1, workDisposition: 'archive_if_empty' }), /Task changed/);
  await assert.rejects(f.retry({ effect: 'disposition_workspace.other-ws', workDisposition: 'archive_if_empty' }),
    /No recorded side effect disposition_workspace\.other-ws is pending/);
  await assert.rejects(f.retry({ workDisposition: 'archive_if_empty', caller: 'agent:stranger' }),
    /Disposition proof policy selection needs the operator at the board or a relayed operator authorization note/);
  // A relayed identity without the operator's authorization note is not authority either.
  await assert.rejects(f.retry({ workDisposition: 'archive_if_empty', caller: 'agent:relay', relayed: true }),
    /requires the recorded operator authorization note/);
  // retained_by_replacement is never selectable as a retry policy.
  assert.throws(() => taskControlInputSchema.parse({ taskId: f.original.id, version: f.task().version, action: 'retry_effect',
    effect: 'disposition_workspace.ws-original', workDisposition: 'retained_by_replacement', reason: 'select it again' }),
    /Retained-by-replacement disposition is only valid for supersession/);
  assert.throws(() => taskControlInputSchema.parse({ taskId: f.original.id, version: f.task().version, action: 'retry_effect',
    effect: 'disposition_workspace.ws-original', workDisposition: 'preserve', reason: 'preserve it' }),
    /owner-selected archive_if_empty recovery/);

  assert.equal(JSON.stringify(f.task().disposition), before, 'a refused recovery changes nothing');
  assert.deepEqual(f.archives, []);
  assert.deepEqual(f.archivedAgents, [`worker-${f.original.id}`]);
});

test('a relayed owner note is recorded as the transition authority', async t => {
  const f = await supersessionFixture(t, 'retired');
  await supersede(f);
  const settled = await f.retry({ workDisposition: 'archive_if_empty', caller: 'agent:relay', relayed: true,
    note: 'Tom authorized retiring the published original workspace now that the replacement is gone' });
  assert.equal(settled.disposition?.status, 'complete');
  assert.equal(settled.disposition!.proofPolicies[0]!.authority, 'relayed_note');
  assert.equal(settled.disposition!.proofPolicies[0]!.by, 'agent:relay');
  assert.match(settled.disposition!.proofPolicies[0]!.note!, /Tom authorized/);
  assert.deepEqual(f.archives, ['ws-original']);
});

test('a restart between the reopen and the proof finishes the same step once', async t => {
  const f = await supersessionFixture(t, 'retired');
  await supersede(f);
  const first = reopenDispositionWorkspace(f.store, { taskId: f.original.id, version: f.task().version, workspaceId: 'ws-original',
    policy: 'archive_if_empty', reason: 'Owner retry after the restart', by: 'operator (board)', authority: { kind: 'operator', note: null } });
  assert.equal(first.disposition?.status, 'preserving', 'the durable step survives the restart');
  // A replay of the same request writes nothing again: the transition is its own identity.
  const replayed = reopenDispositionWorkspace(f.store, { taskId: f.original.id, version: first.version, workspaceId: 'ws-original',
    policy: 'archive_if_empty', reason: 'Replayed after a lost reply', by: 'operator (board)', authority: { kind: 'operator', note: null } });
  assert.equal(replayed.version, first.version);
  assert.equal(replayed.disposition!.proofPolicies.length, 1, 'a lost reply keeps the first recorded transition');
  // A conflicting policy on the already-reopened step refuses rather than rewriting it.
  assert.throws(() => reopenDispositionWorkspace(f.store, { taskId: f.original.id, version: replayed.version, workspaceId: 'ws-original',
    policy: 'preserve' as never, reason: 'Change my mind', by: 'operator (board)', authority: { kind: 'operator', note: null } }),
    /already reopened under another proof policy/);
  // The ordinary restart pass resumes the recorded step; nothing is re-dispatched.
  const settled = await f.resume();
  assert.equal(settled.disposition?.status, 'complete');
  assert.deepEqual(f.archives, ['ws-original']);
  assert.equal(f.archivedAgents.length, 1, 'the settled thread is never archived again');
});

test('a replayed retry whose disposition already completed is answered by that outcome, never re-run', async t => {
  const f = await supersessionFixture(t, 'retired');
  await supersede(f);
  const control = { taskId: f.original.id, version: f.task().version, action: 'retry_effect' as const,
    effect: 'disposition_workspace.ws-original', workDisposition: 'archive_if_empty' as const,
    caller: 'operator (board)', reason: 'Recover the recorded workspace step' };
  const payload = { type: 'task_control' as const, control };
  const acceptance = f.store.acceptOperation({ key: 'disposition-workspace-replay', kind: 'task_control',
    inputHash: operationInputHash(payload), taskId: control.taskId, expectedVersion: control.version, payload });
  assert.ok('accepted' in acceptance);
  const operationId = acceptance.operation.id;
  f.store.putOperation({ ...acceptance.operation, state: 'running', startedAt: new Date().toISOString(), attempts: 1 });
  // The first run completes the disposition, then the process stops before the operation settles.
  const applied = await f.engine.performTaskControl(taskControlInputSchema.parse(control), operationId);
  assert.equal(applied.disposition?.status, 'complete');
  assert.deepEqual(f.archives, ['ws-original']);
  assert.notEqual(f.task().version, control.version, 'the task moved on, so the replayed version is stale');
  await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse(control)), /Task changed/);
  const replayed = await f.engine.performTaskControl(taskControlInputSchema.parse(control), operationId);
  assert.equal(replayed.disposition?.status, 'complete');
  assert.deepEqual(f.archives, ['ws-original'], 'no archive is replayed');
  assert.equal(f.archivedAgents.length, 1);
});

test('concurrent retries archive once: the loser refuses on the changed version', async t => {
  const f = await supersessionFixture(t, 'retired');
  await supersede(f);
  const outcomes = await Promise.allSettled([
    f.retry({ workDisposition: 'archive_if_empty' }),
    f.retry({ workDisposition: 'archive_if_empty' }),
  ]);
  const applied = outcomes.filter(outcome => outcome.status === 'fulfilled');
  const refused = outcomes.filter(outcome => outcome.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(applied.length, 1);
  assert.equal(refused.length, 1);
  // Whichever observation the loser made, it changes nothing and archives nothing.
  assert.match(String(refused[0]!.reason), /Task changed|No recorded side effect/);
  assert.deepEqual(f.archives, ['ws-original']);
  assert.equal(f.task().disposition?.status, 'complete');
  assert.equal(f.task().disposition!.proofPolicies.length, 1, 'one recorded transition');
});
