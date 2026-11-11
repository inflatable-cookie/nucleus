import { configuredClone, materializeSeed } from './support/git-seed';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rename, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { git, command } from '../core/git/index';
import { RepositoryHooks, FINISHED_WORKTREE_MISSING_KIND, discoverManifest, forgetManifestDiscovery, snapshotGit } from '../core/hooks/hooks';
import { Lifecycle } from '../core/closeout/workspace-lifecycle';
import { requestDisposition, type DispositionDeps } from '../core/verbs/disposition';
import { controlManifestSchema } from '../shared/hooks';
import { isDispositionActive, submissionSchema, type Task } from '../shared/contracts';
import type { Engine } from '../core/engine';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';
import { spawnLog } from './support/spawn-log';

const finished = (overrides: Record<string, unknown> = {}) => ({
  id: 'runtime-stop', events: ['task.finished'], target: 'integration_base',
  mode: 'read_only', delivery: 'advisory',
  program: { kind: 'repository', executable: '.paseo/hooks/runtime-stop', argv: [] },
  timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null, ...overrides,
});
const v7Manifest = (hooks: unknown[]) => ({ schema: 'paseo.queue.control.v7', hooks });

/**
 * A repository-neutral finished-task runtime stop. It records the delivered
 * event beside a mutable control file so a retry observes a repaired control
 * without Queue ever choosing or hardcoding a runtime command.
 */
function runtimeStopScript(controlPath: string, ledgerPath: string) {
  return `#!/usr/bin/env node
const fs=require('fs');
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{
  const event=JSON.parse(raw);
  fs.appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify({eventId:event.eventId,event:event.event,schema:event.schema,root:event.repository.root,phase:event.task.phase,summary:event.delivery.summary,attempt:event.attempt})+'\\n');
  const mode = fs.existsSync(${JSON.stringify(controlPath)}) ? fs.readFileSync(${JSON.stringify(controlPath)},'utf8').trim() : 'ok';
  const result=(outcome)=>JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome,summary:'runtime stop '+outcome,metadata:{},changedPaths:[],commitSubjectSuffix:null});
  if (mode==='sleep') { setTimeout(()=>{process.stdout.write(result('ok'));},60000); return; }
  if (mode==='fail') { process.stderr.write('runtime stop refused\\n'); process.exit(1); }
  process.stdout.write(result('ok'));
});
`;
}

/** A repository with a committed v7 manifest and the stop hook, plus an inserted task. */
async function repoFixture(t: any, options: { hook?: boolean; hookDefinition?: Record<string, unknown>; retained?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-finished-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await materializeSeed(configuredClone, root);
  const repo = join(root, 'repo');
  const control = join(root, 'control.txt');
  const ledger = join(root, 'ledger.jsonl');
  const files: Record<string, { content: string; mode?: number }> = { 'docs/plan.md': { content: '# Plan\n' } };
  if (options.hook !== false) {
    files['.paseo/hooks/runtime-stop'] = { content: runtimeStopScript(control, ledger), mode: 0o755 };
    files['.paseo/queue.json'] = { content: JSON.stringify(v7Manifest([options.hookDefinition ?? finished()]), null, 2) };
  }
  for (const [path, spec] of Object.entries(files)) {
    const full = join(repo, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, spec.content);
    if (spec.mode) await chmod(full, spec.mode);
  }
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'base');
  const head = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'push', 'origin', 'main');
  const storeDir = await mkdtemp(join(tmpdir(), 'nsq-finished-store-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const store = new Store(join(storeDir, 'queue.sqlite'));
  store.setMeta('paused', false);
  t.after(() => store.close());
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Finished runtime stop', repoPath: repo,
    planningCommit: head, handoffPath: 'docs/plan.md', originAgentId: 'origin',
  }), 'host', 'handoff', head);
  const task = store.update(inserted.id, { directory: join(root, 'task-wt'), branch: 'ns-task', workspaceId: 'task-ws', prHead: head });
  if (options.retained !== false) await git(repo, 'worktree', 'add', '-b', 'ns-task', task.directory!, head);
  const setControl = (value: string) => writeFile(control, value);
  return { root, repo, head, store, task, control, ledger, setControl, hooks: new RepositoryHooks(store) };
}

/** Mark the fixture task terminal with the synchronized integration commits a real closeout records. */
function terminal(f: { store: Store; task: Task; head: string }, phase: 'done' | 'cancelled'): Task {
  return f.store.update(f.task.id, {
    phase,
    resolution: { ...f.store.task(f.task.id).resolution, mergedCommit: f.head, syncedCommit: f.head },
  });
}

const ledgerLines = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean);

test('v7 adds the finished-task stop while v1-v6 stay frozen', () => {
  assert.equal(controlManifestSchema.safeParse(v7Manifest([finished()])).success, true);
  assert.throws(() => controlManifestSchema.parse(v7Manifest([finished({ mode: 'integration_write' })])), /read_only/);
  assert.throws(() => controlManifestSchema.parse(v7Manifest([finished({ delivery: 'required' })])), /advisory/);
  // The stop may share a hook only with events it does not contradict.
  assert.equal(controlManifestSchema.safeParse(v7Manifest([finished({ events: ['task.finished', 'task.blocked'] })])).success, true);

  const legacy = { id: 'runtime-stop', events: ['task.finished'], mode: 'read_only', delivery: 'advisory', executable: '.paseo/hooks/runtime-stop', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null };
  const program = { kind: 'repository', executable: '.paseo/hooks/runtime-stop', argv: [] };
  const generations: Array<[string, Record<string, unknown>]> = [
    ['paseo.queue.control.v1', legacy],
    ['paseo.queue.control.v2', { ...legacy, executable: undefined, program }],
    ['paseo.queue.control.v3', { ...legacy, executable: undefined, program, target: 'integration_base' }],
    ['paseo.queue.control.v4', { ...legacy, executable: undefined, program, target: 'integration_base' }],
    ['paseo.queue.control.v5', { ...legacy, executable: undefined, program, target: 'integration_base' }],
    ['paseo.queue.control.v6', { ...legacy, executable: undefined, program, target: 'integration_base' }],
  ];
  for (const [schema, raw] of generations) {
    const hook = { ...raw };
    if (hook.executable === undefined) delete hook.executable;
    const manifest = ['paseo.queue.control.v5', 'paseo.queue.control.v6'].includes(schema)
      ? { schema, closeout: 'hooks', hooks: [hook] } : { schema, hooks: [hook] };
    assert.throws(() => controlManifestSchema.parse(manifest), /event|Invalid|Unrecognized|finished/i, `${schema} must not accept the finished-task stop`);
  }
  // A v7 manifest still carries v6's pre-archive retention gate.
  const retention = { id: 'retention', events: ['task.pre_archive'], target: 'integration_base', mode: 'read_only', delivery: 'required', program, timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null };
  assert.equal(controlManifestSchema.safeParse({ schema: 'paseo.queue.control.v7', hooks: [retention, finished()] }).success, true);
});

test('a repository without the bound hook is unchanged', async t => {
  const absent = await repoFixture(t, { hook: false });
  const outcome = await absent.hooks.finished(terminal(absent, 'done'));
  assert.deepEqual(outcome, { hold: false, attention: false, records: [] });
  assert.equal(absent.store.hookEvents().length, 0);
  assert.equal(existsSync(join(absent.root, 'ledger.jsonl')), false);
});

test('a done task runs the hook once in the retained worktree', async t => {
  const f = await repoFixture(t);
  const task = terminal(f, 'done');
  const outcome = await f.hooks.finished(f.store.task(task.id));
  assert.equal(outcome.hold, false);
  assert.equal(outcome.attention, false);
  assert.equal(outcome.records.at(-1)!.state, 'result');
  const delivered = JSON.parse((await ledgerLines(f.ledger))[0]);
  assert.equal(delivered.event, 'task.finished');
  assert.equal(delivered.schema, 'paseo.queue.event.v1');
  assert.equal(delivered.root, task.directory);
  assert.equal(delivered.phase, 'done');

  // A second pass reuses the settled occurrence: containers stop once.
  const repeated = await f.hooks.finished(f.store.task(task.id));
  assert.equal(repeated.records.at(-1)!.eventId, outcome.records.at(-1)!.eventId);
  assert.equal((await ledgerLines(f.ledger)).length, 1);
});

test('a cancelled task runs the same hook once in the retained worktree', async t => {
  const f = await repoFixture(t);
  const task = terminal(f, 'cancelled');
  const outcome = await f.hooks.finished(f.store.task(task.id));
  assert.equal(outcome.hold, false);
  assert.equal(outcome.records.at(-1)!.state, 'result');
  const delivered = JSON.parse((await ledgerLines(f.ledger))[0]);
  assert.equal(delivered.event, 'task.finished');
  assert.equal(delivered.root, task.directory);
  assert.equal(delivered.phase, 'cancelled');
  assert.equal(f.store.task(task.id).phase, 'cancelled');
});

test('a missing worktree skips the stop with one note', async t => {
  const f = await repoFixture(t, { retained: false });
  const task = terminal(f, 'done');
  const outcome = await f.hooks.finished(f.store.task(task.id));
  assert.deepEqual(outcome, { hold: false, attention: false, records: [] });
  assert.equal(f.store.hookEvents(task.id).length, 0);
  assert.equal(f.store.events(task.id).filter(event => event.kind === FINISHED_WORKTREE_MISSING_KIND).length, 1);
  // The note is once per task, not once per pass.
  await f.hooks.finished(f.store.task(task.id));
  assert.equal(f.store.events(task.id).filter(event => event.kind === FINISHED_WORKTREE_MISSING_KIND).length, 1);
});

test('a failure is a warning and the task stays done', async t => {
  const f = await repoFixture(t);
  const task = terminal(f, 'done');
  await f.setControl('fail');
  const outcome = await f.hooks.finished(f.store.task(task.id));
  assert.equal(outcome.hold, false);
  assert.equal(outcome.attention, false);
  assert.equal(outcome.records.at(-1)!.state, 'failed');
  assert.match(outcome.records.at(-1)!.error, /exited with code 1/);
  assert.equal(f.store.task(task.id).phase, 'done');
  assert.ok(f.store.events(task.id).some(event => event.kind === 'hook_failed'));
  assert.equal((await ledgerLines(f.ledger)).length, 1);
  // A failure is not retried automatically on the next pass.
  const repeated = await f.hooks.finished(f.store.task(task.id));
  assert.equal(repeated.records.at(-1)!.eventId, outcome.records.at(-1)!.eventId);
  assert.equal((await ledgerLines(f.ledger)).length, 1);
});

test('a restart during the stop records uncertainty and does not double-run it', async t => {
  const f = await repoFixture(t);
  const task = terminal(f, 'done');
  const first = await f.hooks.finished(f.store.task(task.id));
  assert.equal(first.records.at(-1)!.state, 'result');
  // Simulate a process that died after spawn: the durable occurrence reads running.
  const record = f.store.hookEvents(task.id).find(candidate => candidate.event === 'task.finished')!;
  f.store.putHookEvent({ ...record, state: 'running', processId: null });
  const restarted = await f.hooks.finished(f.store.task(task.id));
  assert.equal(restarted.hold, false);
  assert.equal(restarted.records.at(-1)!.state, 'uncertain');
  assert.match(restarted.records.at(-1)!.error, /Restart during the finished-task runtime stop/);
  assert.equal((await ledgerLines(f.ledger)).length, 1);
});

test('retry_hook re-runs the pinned stop after the repository is repaired', async t => {
  const f = await repoFixture(t);
  const task = terminal(f, 'done');
  await f.setControl('fail');
  const failed = await f.hooks.finished(f.store.task(task.id));
  const occurrence = failed.records.at(-1)!;
  assert.equal(occurrence.state, 'failed');

  await f.setControl('ok');
  const retried = await f.hooks.retry(f.store.task(task.id), occurrence.eventId);
  assert.equal(retried.hold, false);
  assert.equal(retried.records.at(-1)!.eventId, occurrence.eventId);
  assert.equal(retried.records.at(-1)!.state, 'result');
  assert.equal(retried.records.at(-1)!.attempt, 2);
  assert.equal((await ledgerLines(f.ledger)).length, 2);
});

test('a durable intent recovers a cancelled stop a crash left unrun', async t => {
  const f = await repoFixture(t);
  const task = terminal(f, 'cancelled');
  // Simulate a crash after the terminal transition and before the stop ran: the
  // durable intent is the only evidence the task still owes an evaluation.
  f.store.update(task.id, { resolution: { ...f.store.task(task.id).resolution, finishedHook: { phase: 'cancelled', at: new Date().toISOString() } } }, 'test_intent');
  assert.equal(f.store.finishedHookTasks().length, 1);
  await lifecycleFor(f.store, f.hooks, []).enqueuePass();
  assert.equal((await ledgerLines(f.ledger)).length, 1);
  const delivered = JSON.parse((await ledgerLines(f.ledger))[0]);
  assert.equal(delivered.event, 'task.finished');
  assert.equal(delivered.phase, 'cancelled');
  assert.equal(f.store.task(task.id).resolution.finishedHook, null);
  assert.equal(f.store.finishedHookTasks().length, 0);
});

test('a durable intent reconciles a running stop from a crash without re-running it', async t => {
  const f = await repoFixture(t);
  const task = terminal(f, 'cancelled');
  const first = await f.hooks.finished(f.store.task(task.id));
  assert.equal(first.records.at(-1)!.state, 'result');
  // Simulate a crash mid-run with the intent still owed: the occurrence reads
  // running and the stop's only external effect is the repository's runtime.
  const record = f.store.hookEvents(task.id).find(candidate => candidate.event === 'task.finished')!;
  f.store.putHookEvent({ ...record, state: 'running', processId: null });
  f.store.update(task.id, { resolution: { ...f.store.task(task.id).resolution, finishedHook: { phase: 'cancelled', at: new Date().toISOString() } } }, 'test_intent');
  await lifecycleFor(f.store, f.hooks, []).enqueuePass();
  assert.equal(f.store.hookEvents(task.id).find(candidate => candidate.event === 'task.finished')!.state, 'uncertain');
  assert.equal((await ledgerLines(f.ledger)).length, 1);
  assert.equal(f.store.task(task.id).resolution.finishedHook, null);
});

test('a concurrent lifecycle scan cannot execute the same cancelled stop twice', async t => {
  const f = await repoFixture(t);
  const task = terminal(f, 'cancelled');
  f.store.update(task.id, { resolution: { ...f.store.task(task.id).resolution, finishedHook: { phase: 'cancelled', at: new Date().toISOString() } } }, 'test_intent');
  // Hold the first caller inside executeReadOnly, after its durable intent was
  // written and before it claims `running`, so the second caller's intent read
  // overlaps it. Without one shared execution this is where both callers spawn.
  let firstSnapshotStarted!: () => void;
  const snapshotStarted = new Promise<void>(resolve => { firstSnapshotStarted = resolve; });
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
  let snapshots = 0;
  const hooks = new RepositoryHooks(f.store, {
    snapshot: (async (root: string) => {
      if (++snapshots === 1) { firstSnapshotStarted(); await firstReleased; }
      return snapshotGit(root);
    }) as typeof snapshotGit,
  });
  const first = hooks.finished(f.store.task(task.id));
  await snapshotStarted;
  const second = hooks.finished(f.store.task(task.id));
  // Give the second caller time to reach the same occurrence while the first is
  // held before it claims `running`. With one shared execution it never gets
  // past the section, so the wait simply expires.
  const deadline = Date.now() + 1500;
  while (snapshots < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  releaseFirst();
  const [inline] = await Promise.all([first, second]);
  assert.equal((await ledgerLines(f.ledger)).length, 1);
  assert.equal(f.store.hookEvents(task.id).filter(record => record.event === 'task.finished').length, 1);
  assert.equal(f.store.task(task.id).resolution.finishedHook, null);
  assert.equal(inline.records.at(-1)!.state, 'result');
});

/** A lifecycle over a minimal engine stub: only the archive boundary and task updates matter. */
function lifecycleFor(store: Store, hooks: RepositoryHooks, archived: Array<{ id: string; directory: string }>) {
  const engine = {
    store, hooks, stopped: false, paused: () => false,
    // #912: lifecycle runs each host-scoped effect through the engine host context.
    withHost: (_id: string, fn: () => unknown) => fn(), taskHostAvailable: () => true,
    adapter: { archiveTaskWorkspace: async (_task: Task, id: string, directory: string) => { archived.push({ id, directory }); return true; } },
    retirement: { capture: async () => null, markArchived: (task: Task) => task.resolution.runtimeRetirements, archived: async () => {}, hasScope: () => false, flagArchiveFailure: () => {} },
    resolution: { update: (task: Task, changes: Record<string, unknown>, _patch: Record<string, unknown>, kind: string, detail: string) => store.update(task.id, { resolution: { ...store.task(task.id).resolution, ...changes } as Task['resolution'] }, kind, detail) },
    removeSiblings: async () => {},
  };
  return new Lifecycle(engine as unknown as Engine);
}

test('the closeout archive runs the finished stop in the worktree before archiving', async t => {
  const f = await repoFixture(t);
  const done = terminal(f, 'done');
  const archived: Array<{ id: string; directory: string }> = [];
  const lifecycle = lifecycleFor(f.store, f.hooks, archived);
  await lifecycle.archive(f.store.task(done.id));
  assert.equal(archived.length, 1);
  assert.equal(archived[0].directory, done.directory);
  const delivered = JSON.parse((await ledgerLines(f.ledger))[0]);
  assert.equal(delivered.event, 'task.finished');
  assert.equal(delivered.root, done.directory);
});

test('a completed cancellation runs the finished stop and never reopens the task', async () => {
  const store = new Store(':memory:');
  try {
    store.setMeta('paused', false);
    const base = 'b'.repeat(40);
    const inserted = store.insert(submissionSchema.parse({
      submissionId: randomUUID(), title: 'Cancel runtime stop', repoPath: '/repo',
      planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin',
    }), 'host', 'handoff', base);
    const task = store.update(inserted.id, {
      phase: 'working', workspaceIntent: true, agentIntent: true,
      workspaceId: `ws-${inserted.id}`, directory: `/missing-${inserted.id}`, agentId: `worker-${inserted.id}`, runId: 'run-1',
    });
    const stopped: string[] = [];
    const intents: Array<Task['resolution']['finishedHook']> = [];
    const deps: DispositionDeps = {
      hooks: {
        emit: async () => ({ hold: false, attention: false, records: [] as unknown[] }),
        finished: async (target: Task) => { stopped.push(target.phase); intents.push(target.resolution.finishedHook); return { hold: false, attention: false, records: [] as unknown[] }; },
      },
      observeAgent: async () => ({ stopped: true }),
      archiveAgent: async () => {},
      proveWorkspaceEmpty: async () => ({ empty: true, detail: 'empty' }),
      proveRetainedByReplacement: async () => ({ retained: true, detail: 'retained' }),
      archiveWorkspace: async () => true,
      observeWorkspaceArchived: async () => false,
      settleCancelledPr: async () => 'PR closed',
    };
    const completed = await requestDisposition(store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate task' });
    assert.equal(completed.phase, 'cancelled');
    assert.deepEqual(stopped, ['cancelled']);
    // The terminal transaction records the durable intent the stop will clear.
    assert.equal(intents[0]?.phase, 'cancelled');
    assert.equal(isDispositionActive(completed), false);
  } finally { store.close(); }
});

test('a throwing finished stop cannot reopen a completed cancellation', async () => {
  const store = new Store(':memory:');
  try {
    store.setMeta('paused', false);
    const base = 'c'.repeat(40);
    const inserted = store.insert(submissionSchema.parse({
      submissionId: randomUUID(), title: 'Throw runtime stop', repoPath: '/repo',
      planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin',
    }), 'host', 'handoff', base);
    const task = store.update(inserted.id, {
      phase: 'working', workspaceIntent: true, agentIntent: true,
      workspaceId: `ws-${inserted.id}`, directory: `/missing-${inserted.id}`, agentId: `worker-${inserted.id}`, runId: 'run-1',
    });
    const deps: DispositionDeps = {
      hooks: {
        emit: async () => ({ hold: false, attention: false, records: [] as unknown[] }),
        finished: async () => { throw new Error('runtime stop exploded'); },
      },
      observeAgent: async () => ({ stopped: true }),
      archiveAgent: async () => {},
      proveWorkspaceEmpty: async () => ({ empty: true, detail: 'empty' }),
      proveRetainedByReplacement: async () => ({ retained: true, detail: 'retained' }),
      archiveWorkspace: async () => true,
      observeWorkspaceArchived: async () => false,
      settleCancelledPr: async () => 'PR closed',
    };
    const completed = await requestDisposition(store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate task' });
    assert.equal(completed.phase, 'cancelled');
    assert.ok(store.events(task.id).some(event => event.kind === 'finished_hook_warning'));
  } finally { store.close(); }
});

/**
 * Task 434 (performance audit 2026-10-25, item A3): the finished-task stop reads
 * the bound manifest on every terminal pass, and an unchanged (checkout, commit)
 * pair cannot answer differently. The spawn counts are the measurement: the
 * parent shape is the uncached path, reproduced here by forgetting the settled
 * answer before each read.
 */
test('an unfinished asynchronous reset can erase measured Git work', async t => {
  const f = await repoFixture(t);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let delay = true;
  const log = await spawnLog(f.root, ['git'], async path => {
    if (delay) await pending;
    await writeFile(path, '');
  });
  t.after(() => log.restore());
  const reset = log.reset();
  await command('git', ['rev-parse', 'HEAD'], f.repo);
  assert.equal(log.counts().git, 1, 'the work was recorded before reset completed');
  release();
  await reset;
  assert.equal(log.counts().git, 0, 'the late reset erases the measured work');
  delay = false;
  await log.reset();
  await command('git', ['rev-parse', 'HEAD'], f.repo);
  assert.equal(log.counts().git, 1, 'a completed reset preserves subsequent work');
});

test('a settled manifest discovery answers again without reading Git until its checkout is replaced', async t => {
  const f = await repoFixture(t);
  const log = await spawnLog(f.root, ['git']);
  t.after(() => log.restore());

  await log.reset();
  const first = await discoverManifest(f.repo, f.head);
  const uncached = log.counts().git;
  assert.ok(first, 'the fixture commits a control manifest');
  assert.equal(first.pin.commit, f.head);
  assert.ok(uncached >= 2, `an uncached read lists the tree and reads the blob: ${uncached}`);

  await log.reset();
  const second = await discoverManifest(f.repo, f.head);
  assert.strictEqual(second, first, 'the same settled discovery answers');
  assert.equal(log.counts().git, 0, 'a settled answer costs no Git process');
  // Forgetting discovery rebuilds its envelope; immutable tree entries stay cached.
  forgetManifestDiscovery(f.repo);
  const rebuilt = await discoverManifest(f.repo, f.head);
  assert.notStrictEqual(rebuilt, first, 'forgetting discards the settled discovery');
  assert.deepEqual(rebuilt, first, 'the same committed manifest is rediscovered');
  assert.equal(log.counts().git, 0, 'rediscovery reuses the immutable tree entry');

  // An absent manifest is a settled answer too: most repositories never have one.
  const plain = await repoFixture(t, { hook: false });
  await log.reset();
  assert.equal(await discoverManifest(plain.repo, plain.head), null);
  const absentFirst = log.counts().git;
  assert.ok(absentFirst >= 1, 'an absent manifest costs one tree read');
  await log.reset();
  assert.equal(await discoverManifest(plain.repo, plain.head), null);
  assert.equal(log.counts().git, 0, 'a settled absence costs no Git process');

  // A checkout replaced at the same path is a different repository identity: the
  // settled answer is not reused, and the fresh read answers the same commit.
  const replacement = join(f.root, 'replacement');
  await command('git', ['clone', join(f.root, 'origin.git'), replacement], f.root);
  await rm(f.repo, { recursive: true, force: true });
  await rename(replacement, f.repo);
  await log.reset();
  const reread = await discoverManifest(f.repo, f.head);
  assert.ok(log.counts().git > 0, 'a replaced checkout is read again');
  assert.equal(reread?.pin.digest, first.pin.digest, 'the same commit still pins the same manifest');
  t.diagnostic(JSON.stringify({ workload: 'manifest discovery for one (checkout, commit) pair',
    uncachedGitSpawns: uncached, cachedGitSpawns: 0, absentManifestCachedSpawns: 0 }));
});
