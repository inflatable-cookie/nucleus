import { test, weighted } from './support/sharded-test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { git } from '../core/git/index';
import { RepositoryHooks, blobDigest, executeHookProgram } from '../core/hooks/hooks';
import { Lifecycle } from '../core/closeout/workspace-lifecycle';
import { submissionSchema, taskControlInputSchema, type Task } from '../shared/contracts';
import { EVENT_SCHEMA_V4 } from '../shared/hooks';
import { Engine } from '../core/engine';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';
import { configuredClone, materializeSeed } from './support/git-seed';

const preArchive = (overrides: Record<string, unknown> = {}) => ({
  id: 'retention', events: ['task.pre_archive'], target: 'integration_base',
  mode: 'read_only', delivery: 'required',
  program: { kind: 'repository', executable: '.paseo/hooks/retention', argv: [] },
  timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null, ...overrides,
});
const v6Manifest = (hooks: unknown[]) => ({ schema: 'paseo.queue.control.v6', hooks });

/** The gate records the full delivered event, so the v4 reconciliation payload can be asserted exactly. */
function retentionScript(controlPath: string, ledgerPath: string, tag = '') {
  return `#!/usr/bin/env node
const fs=require('fs');
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{
  const event=JSON.parse(raw);
  fs.appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify({...event, cwd:process.cwd()})+'\\n');
  const mode = fs.existsSync(${JSON.stringify(controlPath)}) ? fs.readFileSync(${JSON.stringify(controlPath)},'utf8').trim() : 'ok';
  const result=(outcome)=>JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome,summary:'retention gate '+outcome+${JSON.stringify(tag)},metadata:{},changedPaths:[],commitSubjectSuffix:null});
  if (mode==='sleep') { setTimeout(()=>{process.stdout.write(result('ok'));},60000); return; }
  if (mode==='slow-ok') { setTimeout(()=>{process.stdout.write(result('ok'));},3000); return; }
  const wrongPredecessor=mode==='strict-prior'&&event.repository.retention?.prior.baseCommit!==event.repository.retention?.taskHead;
  process.stdout.write(result(mode==='refuse'||wrongPredecessor?'blocked':mode==='fail'?'failed':'ok'));
});
`;
}

/**
 * Timeout probes pin a short hook timeout, so an attempt the test makes time out
 * (control `sleep`) is a real timeout with real process-group termination. An
 * attempt meant to answer runs with the standard hook budget instead: under QA
 * load a node hook can take longer than the probe to start, and a rerun that
 * times out again is host speed, not the behaviour under test (milestone
 * 2ec3eba7). Only the test seam widens it; the pinned record is unchanged.
 */
const TIMEOUT_PROBE_MS = 1500;

async function repoFixture(t: any, options: { secondHook?: boolean; timeoutProbe?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-retrecon-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await materializeSeed(configuredClone, root);
  const repo = join(root, 'repo');
  const control = join(root, 'control.txt');
  const controlB = join(root, 'control-b.txt');
  const ledger = join(root, 'ledger.jsonl');
  const second = options.secondHook ? [preArchive({ id: 'retention-b', program: { kind: 'repository', executable: '.paseo/hooks/retention-b', argv: [] } })] : [];
  for (const [path, content] of Object.entries({
    'docs/plan.md': '# Plan\n',
    '.paseo/hooks/retention': retentionScript(control, ledger),
    ...(options.secondHook ? { '.paseo/hooks/retention-b': retentionScript(controlB, ledger, ' (b)') } : {}),
    '.paseo/queue.json': JSON.stringify(v6Manifest([preArchive(options.timeoutProbe ? { timeoutMs: TIMEOUT_PROBE_MS } : {}), ...second]), null, 2),
  })) {
    const full = join(repo, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  await chmod(join(repo, '.paseo/hooks/retention'), 0o755);
  if (options.secondHook) await chmod(join(repo, '.paseo/hooks/retention-b'), 0o755);
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'base');
  const head = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'push', 'origin', 'main');
  const storeDir = await mkdtemp(join(tmpdir(), 'nsq-retrecon-store-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const store = new Store(join(storeDir, 'queue.sqlite'));
  store.setMeta('paused', false);
  t.after(() => store.close());
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Retention reconciliation', repoPath: repo,
    planningCommit: head, handoffPath: 'docs/plan.md', originAgentId: 'origin',
  }), 'host', 'handoff', head);
  const task = store.update(inserted.id, { directory: join(root, 'task-wt'), branch: 'ns-task', workspaceId: 'task-ws', prHead: head });
  await git(repo, 'worktree', 'add', '-b', 'ns-task', task.directory!, head);
  const controlMode = () => existsSync(control) ? readFileSync(control, 'utf8').trim() : 'ok';
  const hooks = new RepositoryHooks(store, options.timeoutProbe ? {
    run: request => executeHookProgram(controlMode() === 'sleep' ? request : { ...request, timeoutMs: HOOK_TEST_TIMEOUT_MS }),
  } : {});
  const setControl = (value: string) => writeFile(control, value);
  const setControlB = (value: string) => writeFile(controlB, value);
  const ledgerEvents = async () => {
    if (!existsSync(ledger)) return [];
    const text = (await readFile(ledger, 'utf8')).trim();
    return text ? text.split('\n').map(line => JSON.parse(line)) : [];
  };
  const blobAt = (commit: string, path: string) =>
    execFileSync('git', ['-C', repo, 'cat-file', 'blob', `${commit}:${path}`]);
  // The real done shape for a merged task keeps the settled merge intent
  // (`mergeIntent: true`) alongside the recorded merged commit.
  const doneMerged = (extra: Record<string, unknown> = {}) => store.update(task.id,
    { phase: 'done', resolution: { ...store.task(task.id).resolution, mergedCommit: head, syncedCommit: head, mergeIntent: true, ...extra } });
  // Every timeout-path assertion names the occurrence's facts, so a failure says
  // whether the rerun timed out again or never fired (milestone 2ec3eba7).
  const facts = (eventId: string) => {
    const record = store.hookEvents(task.id).find(item => item.eventId === eventId);
    return JSON.stringify(record ? { attempt: record.attempt, state: record.state, timedOut: record.timedOut,
      processGroupEmpty: record.processGroupEmpty, terminationError: record.terminationError, error: record.error.slice(0, 300) } : null);
  };
  return { root, repo, head, store, task, control, ledger, hooks, setControl, setControlB, ledgerEvents, blobAt, doneMerged, facts };
}

/** Refuse the ordinary gate once so the task holds a recorded pre-archive refusal. */
async function refuseGate(f: Awaited<ReturnType<typeof repoFixture>>) {
  await f.setControl('refuse');
  const outcome = await f.hooks.retentionGate(f.store.task(f.task.id),
    { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  assert.equal(outcome.hold, true);
  return outcome.records.at(-1)!;
}

/** Commit a consumer repair to main and return the new integration base. */
async function advanceMain(f: Awaited<ReturnType<typeof repoFixture>>, mutate: (manifest: any) => void, programTag?: string) {
  const path = join(f.repo, '.paseo/queue.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  mutate(manifest);
  await writeFile(path, JSON.stringify(manifest, null, 2));
  if (programTag !== undefined) {
    const program = join(f.repo, '.paseo/hooks/retention');
    await writeFile(program, retentionScript(f.control, f.ledger, programTag));
    await chmod(program, 0o755);
  }
  await git(f.repo, 'add', '-A');
  await git(f.repo, 'commit', '-m', 'consumer repair');
  return git(f.repo, 'rev-parse', 'HEAD');
}

function lifecycleFor(store: Store, hooks: RepositoryHooks, archived: Array<{ id: string; directory: string }>,
  taskWorkspaceArchived?: (id: string) => Promise<boolean>) {
  const engine = {
    store, hooks, stopped: false, paused: () => false,
    adapter: { archiveTaskWorkspace: async (_task: Task, id: string, directory: string) => { archived.push({ id, directory }); return true; },
      ...(taskWorkspaceArchived ? { taskWorkspaceArchived } : {}) },
    retirement: { capture: async () => null, markArchived: (task: Task) => task.resolution.runtimeRetirements, archived: async () => {}, hasScope: () => false, flagArchiveFailure: () => {} },
    resolution: { update: (task: Task, changes: Record<string, unknown>, _patch: Record<string, unknown>, kind: string, detail: string) => store.update(task.id, { resolution: { ...store.task(task.id).resolution, ...changes } as Task['resolution'] }, kind, detail) },
    removeSiblings: async () => {},
  };
  return new Lifecycle(engine as unknown as Engine);
}


weighted(10)('reconciliation refuses unless every proof holds', async t => {
  const fresh = await repoFixture(t);
  const control = (taskId = fresh.task.id, reason = 'consumer repair merged') =>
    fresh.hooks.retryRetentionAtIntegrationBase(fresh.store.task(taskId), reason);

  await assert.rejects(
    () => fresh.hooks.retryRetentionAtIntegrationBase(fresh.store.task(fresh.task.id), ''),
    /requires an operator reason/);
  await assert.rejects(() => fresh.hooks.retryRetentionAtIntegrationBase(fresh.store.task(fresh.task.id), '  '), /requires an operator reason/);

  const working = fresh.store.task(fresh.task.id);
  assert.equal(working.phase, 'queued');
  await assert.rejects(() => control(), /requires a done task/);

  const unmerged = fresh.store.update(fresh.task.id, { phase: 'done' });
  assert.equal(fresh.store.task(unmerged.id).phase, 'done');
  await assert.rejects(() => control(), /requires a merged task/);

  // A merge intent with no merged commit is still an unlanded merge: refused.
  fresh.store.update(unmerged.id, { resolution: { ...fresh.store.task(unmerged.id).resolution, mergeIntent: true } });
  await assert.rejects(() => control(), /pending merge intent/);

  // A settled merge intent (`mergedCommit` set) is the real done shape: the
  // control proceeds past the merge proofs instead of refusing it as pending.
  fresh.store.update(unmerged.id, { resolution: { ...fresh.store.task(unmerged.id).resolution, mergedCommit: fresh.head, syncedCommit: fresh.head } });
  await assert.rejects(() => control(), /requires a recorded task\.pre_archive refusal/);

  const done = fresh.doneMerged();
  const prior = await refuseGate(fresh);

  // The worktree moves: a corrective edit inside the retained worktree is refused.
  await git(fresh.task.directory!, '-c', 'user.name=Queue test', '-c', 'user.email=queue@example.invalid',
    'commit', '--allow-empty', '-m', 'worker drift');
  await assert.rejects(() => control(), /requires the recorded worktree head/);
  await git(fresh.repo, 'update-ref', 'refs/heads/ns-task', fresh.head);
  await git(fresh.task.directory!, 'reset', '--hard', fresh.head);

  // The worktree is dirty.
  await writeFile(join(fresh.task.directory!, 'draft.txt'), 'uncommitted');
  await assert.rejects(() => control(), /requires a clean retained worktree/);
  await rm(join(fresh.task.directory!, 'draft.txt'));

  // The merged commit is not an ancestor of the integration base: point the
  // recorded merge at a worktree-only commit while main stays behind it.
  await git(fresh.task.directory!, '-c', 'user.name=Queue test', '-c', 'user.email=queue@example.invalid',
    'commit', '--allow-empty', '-m', 'side commit');
  const side = await git(fresh.task.directory!, 'rev-parse', 'HEAD');
  fresh.store.update(done.id, { prHead: side, resolution: { ...fresh.store.task(done.id).resolution, mergedCommit: side, syncedCommit: side } });
  await assert.rejects(() => control(), /ancestor of the current integration base/);
  fresh.store.update(done.id, { prHead: fresh.head, resolution: { ...fresh.store.task(done.id).resolution, mergedCommit: fresh.head, syncedCommit: fresh.head } });
  await git(fresh.task.directory!, 'reset', '--hard', fresh.head);

  // The manifest is gone at the integration base.
  await rm(join(fresh.repo, '.paseo/queue.json'));
  await git(fresh.repo, 'add', '-A');
  await git(fresh.repo, 'commit', '-m', 'drop manifest');
  await assert.rejects(() => control(), /stay bound for task\.pre_archive/);

  // The hook id is gone at the integration base: restore the manifest from
  // the refused head, then rebind a different hook id on main.
  await git(fresh.repo, 'checkout', fresh.head, '--', '.paseo/queue.json');
  await advanceMain(fresh, (manifest: any) => { manifest.hooks[0].id = 'other-gate'; });
  await assert.rejects(() => control(), /stay bound for task\.pre_archive/);

  assert.equal(prior.state, 'blocked');
});

weighted(8)('a refused gate reconciles at the integration base with the exact v4 payload, and the archive accepts it', async t => {
  const f = await repoFixture(t);
  const prior = await refuseGate(f);
  const done = f.doneMerged();
  const base = await advanceMain(f, (manifest: any) => { manifest.hooks[0].maxOutputBytes = 65535; });

  await f.setControl('ok');
  const outcome = await f.hooks.retryRetentionAtIntegrationBase(f.store.task(done.id), 'consumer repair merged to main');
  assert.equal(outcome.hold, false);
  const record = outcome.records.at(-1)!;
  assert.equal(record.event, 'task.pre_archive');
  assert.equal(record.occurrence, 2);
  assert.equal(record.baseCommit, base);
  assert.equal(record.manifest.digest, blobDigest(f.blobAt(base, '.paseo/queue.json')));
  assert.notEqual(record.manifest.digest, prior.manifest.digest);
  assert.equal(record.program.kind, 'repository');
  if (record.program.kind === 'repository')
    assert.equal(record.program.executable.digest, blobDigest(f.blobAt(base, '.paseo/hooks/retention')));
  assert.deepEqual(record.retentionReconciliation, {
    priorEventId: prior.eventId, priorBaseCommit: prior.baseCommit,
    priorManifestDigest: prior.manifest.digest, taskHead: f.head, mergedCommit: f.head,
  });
  assert.deepEqual(record.workspace, { path: f.task.directory!, head: f.head });

  const event = record.eventPayload!;
  assert.equal(event.schema, EVENT_SCHEMA_V4);
  assert.equal(event.eventId, record.eventId);
  assert.equal(event.attempt, 1);
  assert.equal(event.repository.root, f.task.directory!);
  assert.equal(event.repository.baseBranch, 'main');
  assert.equal(event.repository.baseCommit, base);
  assert.equal((event.repository as any).target, 'merged_integration_base');
  assert.deepEqual((event.repository as any).retention, {
    route: 'merged_task_reconciliation', mergedCommit: f.head, taskHead: f.head,
    manifestDigest: record.manifest.digest,
    prior: { eventId: prior.eventId, baseCommit: prior.baseCommit, manifestDigest: prior.manifest.digest },
  });
  assert.equal(event.task.phase, 'done');
  assert.deepEqual(event.delivery, prior.eventPayload!.delivery);

  const delivered = await f.ledgerEvents();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].schema, EVENT_SCHEMA_V4);
  assert.equal(delivered[1].repository.baseCommit, base);
  assert.equal(delivered[1].attempt, 1);

  // The lifecycle archive accepts the settled reconciliation without re-running the gate.
  const archived: Array<{ id: string; directory: string }> = [];
  await lifecycleFor(f.store, f.hooks, archived).archive(f.store.task(done.id));
  assert.equal(archived.length, 1);
  assert.equal((await f.ledgerEvents()).length, 2);

  // The ordinary gate still answers for the unchanged worktree without executing again.
  const settled = await f.hooks.retentionGate(f.store.task(done.id),
    { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  assert.equal(settled.hold, false);
  assert.equal((await f.ledgerEvents()).length, 2);
});

weighted(12)('a passed reconciliation clears the workspace archive backoff and immediately queues cleanup', async t => {
  const f = await repoFixture(t);
  const prior = await refuseGate(f);
  const done = f.doneMerged();
  await advanceMain(f, (manifest: any) => { manifest.hooks[0].maxOutputBytes = 65535; });
  const retry = {
    workspaceId: 'task-ws', attempts: 10, error: 'retention gate refused archive',
    nextAttemptAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
  f.store.update(done.id, { resolution: {
    ...f.store.task(done.id).resolution,
    workspaceArchiveRetries: [retry],
    cleanupReason: `Workspace archive for ${retry.workspaceId} failed: ${retry.error}`,
  } });

  const engine = new Engine(f.store, {} as any);
  engine.hooks.retryRetentionAtIntegrationBase = (task, reason) => f.hooks.retryRetentionAtIntegrationBase(task, reason);
  engine.wakeTask = async () => {};
  engine.wakeRepository = async () => {};
  const queued: string[] = [];
  engine.enqueueCleanup = taskId => { queued.push(taskId); };

  await f.setControl('ok');
  const current = f.store.task(done.id);
  const result = await engine.performTaskControl({ taskId: current.id, version: current.version,
    action: 'retry_effect', effect: `merged_task_retention.${prior.eventId}`, reason: 'consumer repair merged to main' });

  const delivered = await f.ledgerEvents();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].repository.target, 'merged_integration_base');
  assert.equal(delivered[1].repository.retention.prior.eventId, prior.eventId);
  const reconciled = f.store.task(done.id);
  assert.deepEqual(reconciled.resolution.workspaceArchiveRetries, []);
  assert.equal(reconciled.resolution.cleanupReason, '');
  assert.deepEqual(result.resolution.workspaceArchiveRetries, []);
  assert.equal(result.resolution.cleanupReason, '');
  assert.deepEqual(queued, [done.id]);
});

weighted(10)('a reconciliation refusal stays a hold with its evidence, and a changed head re-gates normally', async t => {
  const f = await repoFixture(t);
  await refuseGate(f);
  const done = f.doneMerged();
  await advanceMain(f, (manifest: any) => { manifest.hooks[0].maxOutputBytes = 65535; });

  await f.setControl('refuse');
  const refused = await f.hooks.retryRetentionAtIntegrationBase(f.store.task(done.id), 'consumer repair merged to main');
  assert.equal(refused.hold, true);
  assert.equal(refused.records.at(-1)!.eventPayload!.schema, EVENT_SCHEMA_V4);

  const held = await f.hooks.retentionGate(f.store.task(done.id),
    { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  assert.equal(held.hold, true);
  assert.equal(held.records.at(-1)!.eventId, refused.records.at(-1)!.eventId);
  assert.equal((await f.ledgerEvents()).length, 2);

  // The worktree moves to a new head: the reconciliation no longer answers and
  // the ordinary worktree-head gate runs again.
  await f.setControl('ok');
  await git(f.task.directory!, '-c', 'user.name=Queue test', '-c', 'user.email=queue@example.invalid',
    'commit', '--allow-empty', '-m', 'post-merge drift');
  const drifted = await git(f.task.directory!, 'rev-parse', 'HEAD');
  assert.notEqual(drifted, f.head);
  const regated = await f.hooks.retentionGate(f.store.task(done.id),
    { directory: f.task.directory!, head: drifted, reason: 'Closeout archive' });
  assert.equal(regated.hold, false);
  assert.equal(regated.records.at(-1)!.eventPayload!.schema, 'paseo.queue.event.v1');
  assert.equal((await f.ledgerEvents()).length, 3);
});

weighted(18)('the control mints and runs its own occurrence when the base still equals the refused pin', async t => {
  const f = await repoFixture(t);
  const prior = await refuseGate(f);
  const done = f.doneMerged();
  // No advanceMain: B === prior.baseCommit with the same manifest digest, so
  // the ordinary open-record search would resume the refused occurrence.

  await f.setControl('refuse');
  const first = await f.hooks.retryRetentionAtIntegrationBase(f.store.task(done.id), 're-run at the unchanged base');
  assert.equal(first.hold, true);
  const minted = first.records.at(-1)!;
  assert.notEqual(minted.eventId, prior.eventId);
  assert.equal(minted.occurrence, 2);
  assert.equal(minted.state, 'blocked');
  assert.equal(minted.eventPayload!.schema, EVENT_SCHEMA_V4);
  assert.equal(minted.baseCommit, f.head);
  assert.equal((await f.ledgerEvents()).length, 2);

  // The minted occurrence settles terminally, so a later control retry
  // reconciles it instead of refusing on a leftover intent.
  await f.setControl('ok');
  const second = await f.hooks.retryRetentionAtIntegrationBase(f.store.task(done.id), 'consumer made originals durable');
  assert.equal(second.hold, false);
  const settled = second.records.at(-1)!;
  assert.equal(settled.occurrence, 3);
  assert.equal(settled.state, 'result');
  assert.equal(settled.retentionReconciliation?.priorEventId, prior.eventId);
  assert.equal((await f.ledgerEvents()).length, 3);

  const archived: Array<{ id: string; directory: string }> = [];
  await lifecycleFor(f.store, f.hooks, archived).archive(f.store.task(done.id));
  assert.equal(archived.length, 1);
  assert.equal((await f.ledgerEvents()).length, 3);
});

weighted(9)('reconciliation executes the program bytes pinned at the base with the worktree as cwd', async t => {
  const f = await repoFixture(t);
  await refuseGate(f);
  const done = f.doneMerged();
  // The consumer repairs the gate program itself on main: distinct bytes with
  // a summary marker the refused-head file does not carry.
  const base = await advanceMain(f, (manifest: any) => { manifest.hooks[0].maxOutputBytes = 65535; }, ' (base)');
  assert.notEqual(blobDigest(f.blobAt(base, '.paseo/hooks/retention')).toString(),
    blobDigest(f.blobAt(f.head, '.paseo/hooks/retention')).toString());

  await f.setControl('ok');
  const outcome = await f.hooks.retryRetentionAtIntegrationBase(f.store.task(done.id), 'gate program repaired on main');
  assert.equal(outcome.hold, false);
  const record = outcome.records.at(-1)!;
  assert.equal(record.program.kind, 'repository');
  if (record.program.kind === 'repository')
    assert.equal(record.program.executable.digest, blobDigest(f.blobAt(base, '.paseo/hooks/retention')));
  assert.match(record.result?.summary ?? '', /\(base\)/);

  const delivered = await f.ledgerEvents();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].cwd, f.task.directory!);

  // The retained worktree file is untouched: the base bytes ran from outside it.
  const worktreeProgram = await readFile(join(f.task.directory!, '.paseo/hooks/retention'), 'utf8');
  assert.ok(!worktreeProgram.includes('(base)'));
});

weighted(6)('an ordinary emission and an active or unmerged task keep the worktree-head v1 pin', async t => {
  const f = await repoFixture(t);

  await assert.rejects(
    () => f.hooks.retryRetentionAtIntegrationBase(f.store.task(f.task.id), 'too early'),
    /requires a done task/);

  await f.setControl('refuse');
  const active = await f.hooks.retentionGate(f.store.task(f.task.id),
    { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  assert.equal(active.hold, true);
  const ordinary = await f.ledgerEvents();
  assert.equal(ordinary.length, 1);
  assert.equal(ordinary[0].schema, 'paseo.queue.event.v1');
  assert.equal(ordinary[0].repository.baseCommit, f.head);
  assert.ok(!('target' in ordinary[0].repository));
  assert.ok(!('retention' in ordinary[0].repository));

  const unmerged = f.store.update(f.task.id, { phase: 'done' });
  await assert.rejects(
    () => f.hooks.retryRetentionAtIntegrationBase(f.store.task(unmerged.id), 'never merged'),
    /requires a merged task/);
  await f.setControl('ok');
  const retried = await f.hooks.retry(f.store.task(unmerged.id), active.records.at(-1)!.eventId);
  assert.equal(retried.hold, false);
  const settled = await f.ledgerEvents();
  assert.equal(settled.length, 2);
  assert.equal(settled[1].schema, 'paseo.queue.event.v1');
});


weighted(11)('a retry after a failed advanced-base reconciliation retains the original task-head predecessor', async t => {
  const f = await repoFixture(t);
  const original = await refuseGate(f);
  const done = f.doneMerged();
  const firstBase = await advanceMain(f, (manifest: any) => { manifest.hooks[0].maxOutputBytes = 65535; });
  await f.setControl('refuse');
  const failed = (await f.hooks.retryRetentionAtIntegrationBase(f.store.task(done.id), 'first repair')).records.at(-1)!;
  assert.equal(failed.state, 'blocked');
  assert.equal(failed.baseCommit, firstBase);
  assert.notEqual(firstBase, f.head);
  const secondBase = await advanceMain(f, (manifest: any) => { manifest.hooks[0].maxOutputBytes = 65534; });
  // This consumer oracle refuses a reconciliation base posing as the retained
  // declaration's predecessor, as the actual Project-A v4 gate does.
  await f.setControl('strict-prior');
  const result = await f.hooks.retryRetentionAtIntegrationBase(f.store.task(done.id), 'second repair');
  assert.equal(result.hold, false);
  const passed = result.records.at(-1)!;
  assert.equal(passed.baseCommit, secondBase);
  const payload = passed.eventPayload!;
  assert.ok(payload.schema === EVENT_SCHEMA_V4);
  assert.deepEqual(payload.repository.retention.prior, {
    eventId: original.eventId, baseCommit: f.head, manifestDigest: original.manifest.digest,
  });
  assert.equal(passed.retentionReconciliation?.priorEventId, original.eventId);
  const history = f.store.hookEvents(done.id);
  assert.equal(history.find(record => record.eventId === failed.eventId)!.state, 'blocked');
  assert.deepEqual(history.find(record => record.eventId === failed.eventId)!.eventPayload, failed.eventPayload);
  const archived: Array<{ id: string; directory: string }> = [];
  await lifecycleFor(f.store, f.hooks, archived).archive(f.store.task(done.id));
  assert.equal(archived.length, 1);
  assert.equal((await f.ledgerEvents()).length, 3);
});

weighted(9)('a reconciliation is superseded once the occurrence it reconciled later passes, so the archive goes on (Project-A #3686)', async t => {
  const { supersededRetentionReconciliation } = await import('../shared/hooks');
  const f = await repoFixture(t);
  const original = await refuseGate(f);
  const done = f.doneMerged();
  await advanceMain(f, (manifest: any) => { manifest.hooks[0].maxOutputBytes = 65535; });
  // The reconciliation at the integration base refuses too.
  await f.setControl('refuse');
  const reconciliation = await f.hooks.retryRetentionAtIntegrationBase(f.store.task(done.id), 'reconcile at the base');
  assert.equal(reconciliation.hold, true);
  // The owner retries the original ordinary occurrence, and it now passes.
  await f.setControl('ok');
  await new Promise(resolve => setTimeout(resolve, 5));
  await f.hooks.retry(f.store.task(done.id), original.eventId, false, false);
  const records = f.store.hookEvents(done.id);
  const recon = records.find(record => record.eventId === reconciliation.records.at(-1)!.eventId)!;
  assert.equal(supersededRetentionReconciliation(records, recon), true);
  const gate = await f.hooks.retentionGate(f.store.task(done.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  assert.equal(gate.hold, false, 'the newer ordinary pass answers the gate');
  assert.equal(gate.records.at(-1)!.eventId, original.eventId);
});

weighted(19)('a superseded reconciliation for one hook never bypasses another required retention hook (review #550)', async t => {
  const f = await repoFixture(t, { secondHook: true });
  const original = (await (async () => {
    await f.setControl('refuse');
    const outcome = await f.hooks.retentionGate(f.store.task(f.task.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
    assert.equal(outcome.hold, true);
    return outcome.records.find(record => record.hookId === 'retention' && record.state === 'blocked')!;
  })());
  const done = f.doneMerged();
  await advanceMain(f, (manifest: any) => { manifest.hooks[0].maxOutputBytes = 65535; });
  await f.hooks.retryRetentionAtIntegrationBase(f.store.task(done.id), 'reconcile at the base');
  // Hook A now passes on its original occurrence; hook B would refuse.
  await f.setControl('ok');
  await f.setControlB('refuse');
  await new Promise(resolve => setTimeout(resolve, 5));
  await f.hooks.retry(f.store.task(done.id), original.eventId, false, false);
  const gate = await f.hooks.retentionGate(f.store.task(done.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  assert.equal(gate.hold, true, 'hook B still gates the archive');
  assert.ok(gate.records.some(record => record.hookId === 'retention-b' && record.state === 'blocked'), JSON.stringify(gate.records.map(record => [record.hookId, record.state])));
});

weighted(6)('a timed-out pre-archive check runs again on the next cleanup pass, a refusal does not, and the reruns are bounded (Tom, 2026-10-19)', async t => {
  const { RETENTION_TIMEOUT_ATTEMPTS } = await import('../core/hooks/hooks');
  const f = await repoFixture(t, { timeoutProbe: true });
  const gate = () => f.hooks.retentionGate(f.store.task(f.task.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  await f.setControl('sleep');
  const timedOut = await gate();
  assert.equal(timedOut.hold, true);
  const eventId = timedOut.records.at(-1)!.eventId;
  const record = () => f.store.hookEvents(f.task.id).find(item => item.eventId === eventId)!;
  assert.equal(record().timedOut, true, f.facts(eventId));
  // Load eases: the next pass reruns the same occurrence and it passes.
  await f.setControl('ok');
  const passed = await gate();
  assert.equal(passed.hold, false, f.facts(eventId));
  assert.equal(record().attempt, 2, f.facts(eventId));
  assert.equal(record().timedOut, false, f.facts(eventId));
  assert.ok(f.store.events(f.task.id).some(event => event.kind === 'retention_timeout_rerun'));
  assert.equal(RETENTION_TIMEOUT_ATTEMPTS, 3);
});

weighted(6)('a refused pre-archive check is not rerun by the cleanup pass', async t => {
  const f = await repoFixture(t);
  const refused = await refuseGate(f);
  await f.setControl('ok');
  const again = await f.hooks.retentionGate(f.store.task(f.task.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  assert.equal(again.hold, true, 'a refusal holds until its owner retries it');
  assert.equal(f.store.hookEvents(f.task.id).find(item => item.eventId === refused.eventId)!.attempt, 1);
  assert.ok(!f.store.events(f.task.id).some(event => event.kind === 'retention_timeout_rerun'));
});

weighted(16)('timed-out pre-archive reruns stop at the attempt bound and the hold stands', async t => {
  const { RETENTION_TIMEOUT_ATTEMPTS } = await import('../core/hooks/hooks');
  const f = await repoFixture(t, { timeoutProbe: true });
  const gate = () => f.hooks.retentionGate(f.store.task(f.task.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  await f.setControl('sleep');
  const first = await gate();
  const eventId = first.records.at(-1)!.eventId;
  for (let pass = 0; pass < RETENTION_TIMEOUT_ATTEMPTS + 1; pass++) assert.equal((await gate()).hold, true, f.facts(eventId));
  const record = f.store.hookEvents(f.task.id).find(item => item.eventId === eventId)!;
  assert.equal(record.attempt, RETENTION_TIMEOUT_ATTEMPTS, `no rerun past the bound: ${f.facts(eventId)}`);
  assert.equal(f.store.events(f.task.id).filter(event => event.kind === 'retention_timeout_rerun').length, RETENTION_TIMEOUT_ATTEMPTS - 1);
});

weighted(5)('a timeout whose process group was not proven gone is never rerun (review #552)', async t => {
  const f = await repoFixture(t, { timeoutProbe: true });
  const gate = () => f.hooks.retentionGate(f.store.task(f.task.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  await f.setControl('sleep');
  const eventId = (await gate()).records.at(-1)!.eventId;
  const timedOut = f.store.hookEvents(f.task.id).find(item => item.eventId === eventId)!;
  assert.equal(timedOut.timedOut, true, f.facts(eventId));
  f.store.putHookEvent({ ...timedOut, processGroupEmpty: false, terminationError: 'The recorded process group remained after SIGKILL' });
  await f.setControl('ok');
  assert.equal((await gate()).hold, true);
  assert.equal(f.store.hookEvents(f.task.id).find(item => item.eventId === eventId)!.attempt, 1);
  assert.ok(!f.store.events(f.task.id).some(event => event.kind === 'retention_timeout_rerun'));
});

weighted(11)('a timed-out reconciliation superseded by a later pass is never rerun (review #552)', async t => {
  const f = await repoFixture(t, { timeoutProbe: true });
  const original = await refuseGate(f);
  const done = f.doneMerged();
  await advanceMain(f, (manifest: any) => { manifest.hooks[0].maxOutputBytes = 65535; });
  await f.setControl('sleep');
  const reconciliation = await f.hooks.retryRetentionAtIntegrationBase(f.store.task(done.id), 'reconcile at the base');
  assert.equal(reconciliation.records.at(-1)!.timedOut, true, f.facts(reconciliation.records.at(-1)!.eventId));
  await f.setControl('ok');
  await new Promise(resolve => setTimeout(resolve, 5));
  await f.hooks.retry(f.store.task(done.id), original.eventId, false, false);
  const delivered = (await f.ledgerEvents()).length;
  const gate = await f.hooks.retentionGate(f.store.task(done.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  assert.equal(gate.hold, false, f.facts(reconciliation.records.at(-1)!.eventId));
  assert.equal((await f.ledgerEvents()).length, delivered, 'nothing executes again');
  assert.ok(!f.store.events(done.id).some(event => event.kind === 'retention_timeout_rerun'));
});

weighted(9)('concurrent cleanup callers rerun a timed-out check once (review #552)', async t => {
  const f = await repoFixture(t, { timeoutProbe: true });
  const gate = () => f.hooks.retentionGate(f.store.task(f.task.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  await f.setControl('sleep');
  const eventId = (await gate()).records.at(-1)!.eventId;
  await f.setControl('ok');
  const delivered = (await f.ledgerEvents()).length;
  const [a, b] = await Promise.all([gate(), gate()]);
  assert.equal(a.hold, false, f.facts(eventId));
  assert.equal(b.hold, false, f.facts(eventId));
  assert.equal((await f.ledgerEvents()).length, delivered + 1, `one rerun execution: ${f.facts(eventId)}`);
  assert.equal(f.store.hookEvents(f.task.id).find(item => item.eventId === eventId)!.attempt, 2, f.facts(eventId));
  assert.equal(f.store.events(f.task.id).filter(event => event.kind === 'retention_timeout_rerun').length, 1);
});

weighted(5)('a rerun that fails to start clears the timeout flag, so the failure stays held (review #552)', async t => {
  const f = await repoFixture(t, { timeoutProbe: true });
  const gate = () => f.hooks.retentionGate(f.store.task(f.task.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  await f.setControl('sleep');
  const eventId = (await gate()).records.at(-1)!.eventId;
  (f.hooks.options as any).run = async () => { throw new Error('spawn EAGAIN'); };
  assert.equal((await gate()).hold, true);
  const record = () => f.store.hookEvents(f.task.id).find(item => item.eventId === eventId)!;
  assert.match(record().error, /could not start/, f.facts(eventId));
  assert.equal(record().timedOut, false, f.facts(eventId));
  assert.equal((await gate()).hold, true, f.facts(eventId));
  assert.equal(f.store.events(f.task.id).filter(event => event.kind === 'retention_timeout_rerun').length, 1, 'the start failure is not rerun');
});

weighted(8)('a refused worktree removed outside Queue is observed archived, and its retention gate stops being an effect (Project-A #1900)', async t => {
  const { ownerPendingEffects, collectOwnerVerbFacts } = await import('../core/verbs/owner-verbs');
  const f = await repoFixture(t);
  const prior = await refuseGate(f);
  const done = f.doneMerged();
  const effects = () => ownerPendingEffects(collectOwnerVerbFacts(f.store, f.store.task(done.id))).map(effect => effect.effect);
  assert.ok(effects().includes(`merged_task_retention.${prior.eventId}`));
  assert.ok(effects().includes(`hook.${prior.eventId}`));
  // Something outside Queue removes the retained worktree; no archive intent exists.
  await git(f.repo, 'worktree', 'remove', '--force', f.task.directory!);
  assert.equal(f.store.task(done.id).resolution.archiveIntentWorkspaceId, null);

  // While Paseo still lists the workspace, the stale refusal keeps holding.
  const archived: Array<{ id: string; directory: string }> = [];
  await lifecycleFor(f.store, f.hooks, archived, async () => false).archive(f.store.task(done.id));
  assert.deepEqual(f.store.task(done.id).resolution.archivedWorkspaceIds, []);
  assert.equal(archived.length, 0);

  // Absent from the catalog and from disk: the archive already happened.
  f.store.update(done.id, { resolution: { ...f.store.task(done.id).resolution, workspaceArchiveRetries: [] } });
  await lifecycleFor(f.store, f.hooks, archived, async () => true).archive(f.store.task(done.id));
  assert.equal(archived.length, 0, 'no archive request for a workspace already gone');
  assert.deepEqual(f.store.task(done.id).resolution.archivedWorkspaceIds, ['task-ws']);
  assert.equal((await f.ledgerEvents()).length, 1, 'the gate does not run against the removed worktree');
  assert.match(f.store.events(done.id).find(event => event.kind === 'workspace_archived')!.detail, /without a Queue archive intent/);
  // The refusal stays in history but no longer offers a retry.
  assert.equal(f.store.hookEvents(done.id).find(record => record.eventId === prior.eventId)!.state, 'blocked');
  assert.deepEqual(effects().filter(effect => effect.includes(prior.eventId)), []);
});

weighted(6)('an explicit retry that fails its baseline clears the timeout flag, so cleanup does not rerun it (review #552)', async t => {
  const f = await repoFixture(t, { timeoutProbe: true });
  const gate = () => f.hooks.retentionGate(f.store.task(f.task.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  await f.setControl('sleep');
  const eventId = (await gate()).records.at(-1)!.eventId;
  const record = () => f.store.hookEvents(f.task.id).find(item => item.eventId === eventId)!;
  assert.equal(record().timedOut, true, f.facts(eventId));
  await git(f.task.directory!, 'commit', '--allow-empty', '-m', 'moved head');
  await f.hooks.retry(f.store.task(f.task.id), eventId, false, false);
  assert.match(record().error, /baseline failed/, f.facts(eventId));
  assert.equal(record().timedOut, false, f.facts(eventId));
  await git(f.task.directory!, 'reset', '--hard', f.head);
  await f.setControl('ok');
  const delivered = (await f.ledgerEvents()).length;
  assert.equal((await gate()).hold, true, 'the baseline failure stays held');
  assert.equal((await f.ledgerEvents()).length, delivered);
  assert.ok(!f.store.events(f.task.id).some(event => event.kind === 'retention_timeout_rerun'));
});

weighted(7)('a rerun slower than the timeout probe still answers, so a slow host cannot fake a second timeout (milestone 2ec3eba7)', async t => {
  const f = await repoFixture(t, { timeoutProbe: true });
  const gate = () => f.hooks.retentionGate(f.store.task(f.task.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  await f.setControl('sleep');
  const eventId = (await gate()).records.at(-1)!.eventId;
  assert.equal(f.store.hookEvents(f.task.id).find(item => item.eventId === eventId)!.timedOut, true, f.facts(eventId));
  // The rerun takes twice the probe, as a node hook can under QA load.
  await f.setControl('slow-ok');
  const passed = await gate();
  assert.equal(passed.hold, false, f.facts(eventId));
  assert.equal(f.store.hookEvents(f.task.id).find(item => item.eventId === eventId)!.attempt, 2, f.facts(eventId));
});

weighted(6)('terminal archive waits for a host run that still holds the workspace, then archives once it settles (Project-E 096)', async t => {
  const { hostRunRecordSchema } = await import('../shared/contracts');
  const f = await repoFixture(t);
  const done = f.doneMerged();
  const at = new Date().toISOString();
  const live = f.store.putHostRun(hostRunRecordSchema.parse({
    id: 'detached-qa', epoch: 1, caller: 'interactive:501', repository: { origin: 'acme/repo', path: f.task.directory! },
    selector: 'qa', runClass: 'heavy', classSource: 'default', priority: 'interactive', state: 'running',
    submittedAt: at, capacityDeadlineAt: at, runTimeoutMs: 60_000,
    budgetFallback: { cpu: 1, memoryBytes: 100_000_000 }, budget: { cpu: 0.5, memoryBytes: 100_000_000, wallMs: 100, source: 'history' },
    position: null, admittedAt: at, launchedAt: at, settledAt: null, capacitySample: null,
    pid: null, processGroupId: null, startIdentity: null, settlement: null, wallMs: null, cpuMs: null, containers: [],
    capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null,
  }));
  const archived: Array<{ id: string; directory: string }> = [];
  await lifecycleFor(f.store, f.hooks, archived).archive(f.store.task(done.id));
  assert.equal(archived.length, 0, 'no archive while the host run holds the workspace');
  assert.match(f.store.task(done.id).resolution.workspaceArchiveRetries[0]?.error ?? '', /host run detached-qa \(running\)/);
  f.store.putHostRun({ ...live, state: 'settled', settledAt: at, capacityReleasedAt: at, capacityReleaseReason: 'settled', capacityReleaseKind: 'automatic' });
  f.store.update(done.id, { resolution: { ...f.store.task(done.id).resolution, workspaceArchiveRetries: [] } });
  await lifecycleFor(f.store, f.hooks, archived).archive(f.store.task(done.id));
  assert.equal(archived.length, 1, 'the settled run releases the workspace for its ordinary archive');
});
