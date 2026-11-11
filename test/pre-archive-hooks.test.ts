import { configuredClone, materializeSeed } from './support/git-seed';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { git, command } from '../core/git/index';
import { RepositoryHooks, hookHoldReason } from '../core/hooks/hooks';
import { Lifecycle } from '../core/closeout/workspace-lifecycle';
import { archiveUnusedWorkspace } from '../core/workspaces/unused-workspace';
import { requestDisposition, type DispositionDeps } from '../core/verbs/disposition';
import { controlManifestSchema } from '../shared/hooks';
import { isDispositionActive, submissionSchema, type Task } from '../shared/contracts';
import type { Engine } from '../core/engine';
import type { Adapter } from '../core/host';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';

const preArchive = (overrides: Record<string, unknown> = {}) => ({
  id: 'retention', events: ['task.pre_archive'], target: 'integration_base',
  mode: 'read_only', delivery: 'required',
  program: { kind: 'repository', executable: '.paseo/hooks/retention', argv: [] },
  timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null, ...overrides,
});
const v6Manifest = (hooks: unknown[]) => ({ schema: 'paseo.queue.control.v6', hooks });

/**
 * A repository-neutral retention gate. It records the delivered event beside a
 * mutable control file, so a retry re-runs the pinned bytes and observes the
 * source owner's repair between attempts. Every mode is data, never a command.
 */
function retentionScript(controlPath: string, ledgerPath: string) {
  return `#!/usr/bin/env node
const fs=require('fs');
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{
  const event=JSON.parse(raw);
  fs.appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify({eventId:event.eventId,event:event.event,schema:event.schema,root:event.repository.root,baseCommit:event.repository.baseCommit,summary:event.delivery.summary,attempt:event.attempt})+'\\n');
  const mode = fs.existsSync(${JSON.stringify(controlPath)}) ? fs.readFileSync(${JSON.stringify(controlPath)},'utf8').trim() : 'ok';
  const result=(outcome)=>JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome,summary:'retention gate '+outcome,metadata:{},changedPaths:[],commitSubjectSuffix:null});
  if (mode==='write') fs.writeFileSync(process.cwd()+'/written-by-hook.txt','mutation');
  if (mode==='sleep') { setTimeout(()=>{process.stdout.write(result('ok'));},60000); return; }
  process.stdout.write(result(mode==='refuse'?'blocked':mode==='fail'?'failed':'ok'));
});
`;
}

/** A repository with a committed v6 manifest and the retention hook, plus an inserted task. */
async function repoFixture(t: any, options: { hook?: boolean; hookDefinition?: Record<string, unknown>; retained?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-prearchive-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await materializeSeed(configuredClone, root);
  const repo = join(root, 'repo');
  const control = join(root, 'control.txt');
  const ledger = join(root, 'ledger.jsonl');
  const files: Record<string, { content: string; mode?: number }> = { 'docs/plan.md': { content: '# Plan\n' } };
  if (options.hook !== false) {
    files['.paseo/hooks/retention'] = { content: retentionScript(control, ledger), mode: 0o755 };
    files['.paseo/queue.json'] = { content: JSON.stringify(v6Manifest([options.hookDefinition ?? preArchive()]), null, 2) };
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
  const storeDir = await mkdtemp(join(tmpdir(), 'nsq-prearchive-store-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const store = new Store(join(storeDir, 'queue.sqlite'));
  store.setMeta('paused', false);
  t.after(() => store.close());
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Retention gate', repoPath: repo,
    planningCommit: head, handoffPath: 'docs/plan.md', originAgentId: 'origin',
  }), 'host', 'handoff', head);
  const task = store.update(inserted.id, { directory: join(root, 'task-wt'), branch: 'ns-task', workspaceId: 'task-ws', prHead: head });
  if (options.retained !== false) await git(repo, 'worktree', 'add', '-b', 'ns-task', task.directory!, head);
  const setControl = (value: string) => writeFile(control, value);
  return { root, repo, head, store, task, control, ledger, setControl, hooks: new RepositoryHooks(store) };
}

test('v6 adds the pre-archive retention gate while v1-v5 stay frozen', () => {
  assert.equal(controlManifestSchema.safeParse(v6Manifest([preArchive()])).success, true);
  assert.throws(() => controlManifestSchema.parse(v6Manifest([preArchive({ mode: 'integration_write' })])), /read_only/);
  assert.throws(() => controlManifestSchema.parse(v6Manifest([preArchive({ delivery: 'advisory' })])), /required delivery/);
  assert.throws(() => controlManifestSchema.parse(v6Manifest([preArchive({ events: ['task.pre_archive', 'task.closeout'] })])), /only event/);
  assert.throws(() => controlManifestSchema.parse(v6Manifest([preArchive({ target: 'reviewed_head' })])), /integration base|target/i);
  const legacy = { id: 'retention', events: ['task.pre_archive'], mode: 'read_only', delivery: 'required', executable: '.paseo/hooks/retention', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null };
  const program = { kind: 'repository', executable: '.paseo/hooks/retention', argv: [] };
  const generations: Array<[string, Record<string, unknown>]> = [
    ['paseo.queue.control.v1', legacy],
    ['paseo.queue.control.v2', { ...legacy, executable: undefined, program }],
    ['paseo.queue.control.v3', { ...legacy, executable: undefined, program, target: 'integration_base' }],
    ['paseo.queue.control.v4', { ...legacy, executable: undefined, program, target: 'integration_base' }],
    ['paseo.queue.control.v5', { ...legacy, executable: undefined, program, target: 'integration_base' }],
  ];
  for (const [schema, raw] of generations) {
    const hook = { ...raw };
    if (hook.executable === undefined) delete hook.executable;
    const manifest = schema === 'paseo.queue.control.v5' ? { schema, closeout: 'hooks', hooks: [hook] } : { schema, hooks: [hook] };
    assert.throws(() => controlManifestSchema.parse(manifest), /event|Invalid|Unrecognized|pre_archive/i, `${schema} must not accept the pre-archive gate`);
  }
});

test('a repository without the bound hook reports no hold and archives unchanged', async t => {
  const absent = await repoFixture(t, { hook: false });
  const noManifest = await absent.hooks.retentionGate(absent.store.task(absent.task.id), { directory: absent.task.directory!, head: absent.head, reason: 'Closeout archive' });
  assert.deepEqual(noManifest, { hold: false, attention: false, records: [] });
  assert.equal(absent.store.hookEvents().length, 0);

  const unbound = await repoFixture(t, { hookDefinition: preArchive({ events: ['task.closeout'], mode: 'integration_write', allowedPaths: ['docs/out.md'], commitSubject: { prefix: 'queue: closeout', maxBytes: 80 } }) });
  const other = await unbound.hooks.retentionGate(unbound.store.task(unbound.task.id), { directory: unbound.task.directory!, head: unbound.head, reason: 'Closeout archive' });
  assert.deepEqual(other, { hold: false, attention: false, records: [] });
  assert.equal(unbound.store.hookEvents().length, 0);
});

test('a refusal holds the worktree with the hook evidence; retry_hook re-runs it and a pass archives', async t => {
  const f = await repoFixture(t);
  await f.setControl('refuse');
  const first = await f.hooks.retentionGate(f.store.task(f.task.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  assert.equal(first.hold, true);
  const refused = first.records.at(-1)!;
  assert.equal(refused.state, 'blocked');
  assert.match(hookHoldReason(first), /retention gate blocked/);
  assert.equal(existsSync(f.task.directory!), true);
  const delivered = JSON.parse((await readFile(f.ledger, 'utf8')).trim().split('\n')[0]);
  assert.equal(delivered.event, 'task.pre_archive');
  assert.equal(delivered.schema, 'paseo.queue.event.v1');
  assert.equal(delivered.root, f.task.directory);
  assert.equal(delivered.baseCommit, f.head);
  assert.equal(delivered.summary, 'Closeout archive');
  assert.equal((await f.store.task(f.task.id)).baseBranch, 'main');

  // A repeated pass reuses the refused occurrence without executing the hook again.
  const repeated = await f.hooks.retentionGate(f.store.task(f.task.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  assert.equal(repeated.hold, true);
  assert.equal(repeated.records.at(-1)!.eventId, refused.eventId);
  assert.equal((await readFile(f.ledger, 'utf8')).trim().split('\n').length, 1);

  // The source owner makes the declared originals durable; the existing control re-runs the gate.
  await f.setControl('ok');
  const retried = await f.hooks.retry(f.store.task(f.task.id), refused.eventId);
  assert.equal(retried.hold, false);
  assert.equal(retried.records.at(-1)!.state, 'result');
  assert.equal((await readFile(f.ledger, 'utf8')).trim().split('\n').length, 2);

  // A settled result answers for the unchanged worktree, so the archive proceeds.
  const settled = await f.hooks.retentionGate(f.store.task(f.task.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  assert.equal(settled.hold, false);
  assert.equal((await readFile(f.ledger, 'utf8')).trim().split('\n').length, 2);
});

test('a settled retry clears only the backoff of the workspace the gate belongs to', async t => {
  const f = await repoFixture(t);
  // Wiring the same callback the engine binds makes the real directory mapping run.
  lifecycleFor(f.store, f.hooks, []);
  const secondary = join(f.root, 'closeout-wt');
  await git(f.repo, 'worktree', 'add', '-b', 'ns-closeout', secondary, f.head);
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const done = f.store.update(f.task.id, {
    phase: 'done',
    resolution: { ...f.store.task(f.task.id).resolution, mergedCommit: f.head, syncedCommit: f.head,
      closeoutWorkspaceId: 'closeout-ws', closeoutDirectory: secondary, closeoutWorkspaceHead: f.head,
      workspaceArchiveRetries: [
        { workspaceId: 'task-ws', attempts: 1, error: 'primary archive failed', nextAttemptAt: future },
        { workspaceId: 'closeout-ws', attempts: 1, error: 'closeout archive failed', nextAttemptAt: future },
      ] },
  });
  await f.setControl('refuse');
  const gate = await f.hooks.retentionGate(f.store.task(done.id), { directory: secondary, head: f.head, reason: 'Closeout archive' });
  assert.equal(gate.hold, true);
  await f.setControl('ok');
  const retried = await f.hooks.retry(f.store.task(done.id), gate.records.at(-1)!.eventId);
  assert.equal(retried.hold, false);
  assert.deepEqual(f.store.task(done.id).resolution.workspaceArchiveRetries.map(record => record.workspaceId), ['task-ws'],
    'the secondary gate clears only the secondary workspace backoff, never the primary');
});

test('a timeout and a failed gate both hold without deleting the worktree', async t => {
  const timedOut = await repoFixture(t, { hookDefinition: preArchive({ timeoutMs: 300 }) });
  await timedOut.setControl('sleep');
  const timeout = await timedOut.hooks.retentionGate(timedOut.store.task(timedOut.task.id), { directory: timedOut.task.directory!, head: timedOut.head, reason: 'Closeout archive' });
  assert.equal(timeout.hold, true);
  assert.match(timeout.records.at(-1)!.error, /timeout/i);
  assert.equal(existsSync(timedOut.task.directory!), true);

  const failed = await repoFixture(t);
  await failed.setControl('fail');
  const failure = await failed.hooks.retentionGate(failed.store.task(failed.task.id), { directory: failed.task.directory!, head: failed.head, reason: 'Closeout archive' });
  assert.equal(failure.hold, true);
  assert.equal(failure.records.at(-1)!.state, 'blocked');
  assert.match(failure.records.at(-1)!.summary, /retention gate failed/);
  assert.equal(existsSync(failed.task.directory!), true);
});

test('the read-only proof holds a gate that writes to the retained worktree', async t => {
  const f = await repoFixture(t);
  await f.setControl('write');
  const outcome = await f.hooks.retentionGate(f.store.task(f.task.id), { directory: f.task.directory!, head: f.head, reason: 'Closeout archive' });
  assert.equal(outcome.hold, true);
  assert.equal(outcome.records.at(-1)!.state, 'uncertain');
  assert.match(outcome.records.at(-1)!.error, /changed HEAD, index or worktree/);
  assert.equal(existsSync(join(f.task.directory!, 'written-by-hook.txt')), true);
});

/** A lifecycle over a minimal engine stub: only the archive boundary and task updates matter. */
function lifecycleFor(store: Store, hooks: RepositoryHooks, archived: Array<{ id: string; directory: string }>) {
  const engine = {
    store, hooks, stopped: false, paused: () => false,
    enqueueCleanup: async () => {},
    adapter: { archiveTaskWorkspace: async (_task: Task, id: string, directory: string) => { archived.push({ id, directory }); return true; } },
    retirement: { capture: async () => null, markArchived: (task: Task) => task.resolution.runtimeRetirements, archived: async () => {}, hasScope: () => false, flagArchiveFailure: () => {} },
    resolution: { update: (task: Task, changes: Record<string, unknown>, _patch: Record<string, unknown>, kind: string, detail: string) => store.update(task.id, { resolution: { ...store.task(task.id).resolution, ...changes } as Task['resolution'] }, kind, detail) },
    removeSiblings: async () => {},
  };
  const lifecycle = new Lifecycle(engine as unknown as Engine);
  // The engine binds this callback to the real lifecycle; the archive tests wire it
  // the same way so a passed pre-archive retry settles the backoff it recorded.
  hooks.options.retentionGateSettled = (taskId, worktree) => lifecycle.retentionReconciledAt(taskId, worktree);
  return lifecycle;
}

test('the closeout archive consults the retention gate before archiving', async t => {
  const f = await repoFixture(t);
  const done = f.store.update(f.task.id, { phase: 'done', resolution: { ...f.store.task(f.task.id).resolution, mergedCommit: f.head, syncedCommit: f.head } });
  const archived: Array<{ id: string; directory: string }> = [];
  const lifecycle = lifecycleFor(f.store, f.hooks, archived);

  await f.setControl('refuse');
  await lifecycle.archive(f.store.task(done.id));
  assert.equal(archived.length, 0);
  assert.equal(existsSync(f.task.directory!), true);
  assert.match(f.store.task(done.id).resolution.cleanupReason, /retention gate blocked/);
  assert.equal(f.store.task(done.id).resolution.workspaceArchiveRetries.length, 1, 'the refusal recorded one archive backoff');

  await f.setControl('ok');
  const refused = f.store.hookEvents(done.id).find(record => record.event === 'task.pre_archive')!;
  // The successful ordinary pre-archive retry itself clears the workspace archive
  // backoff (commit 01f949e0 plus this retry path), so the next archive proceeds.
  await f.hooks.retry(f.store.task(done.id), refused.eventId);
  assert.deepEqual(f.store.task(done.id).resolution.workspaceArchiveRetries, [], 'a passed retention retry clears the archive backoff');
  await lifecycle.archive(f.store.task(done.id));
  assert.equal(archived.length, 1);
  assert.equal(archived[0].id, done.workspaceId);
});

test('the unused-workspace archive consults the retention gate before archiving', async t => {
  const f = await repoFixture(t, { retained: false });
  const old = join(f.root, 'old');
  await git(f.repo, 'worktree', 'add', '-b', f.task.branch, old, f.head);
  const task = f.store.update(f.task.id, {
    phase: 'needs_attention', workspaceId: 'retained', directory: join(f.root, 'retained'),
    workspaceIntent: true, agentId: '', runId: null, prHead: null, planningBase: f.head,
  });
  let archived = 0;
  const adapter = {
    findWorkspaces: async () => [{ id: 'old', directory: old }],
    archiveTaskWorkspace: async () => { archived++; return true; },
  } as unknown as Adapter;
  const gate = async (target: { directory: string; head: string }) => {
    const outcome = await f.hooks.retentionGate(f.store.task(task.id), { ...target, reason: 'Unused workspace cleanup' });
    return outcome.hold ? { hold: true, detail: hookHoldReason(outcome) } : { hold: false, detail: '' };
  };
  const control = { taskId: task.id, version: f.store.task(task.id).version, unusedWorkspaceId: 'old' };

  await f.setControl('refuse');
  await assert.rejects(() => archiveUnusedWorkspace(f.store, adapter, control, () => true, undefined, gate), /retention gate blocked/);
  assert.equal(archived, 0);
  assert.ok(f.store.events(task.id).some(event => event.kind === 'unused_workspace_retention_hold'));

  await f.setControl('ok');
  const refused = f.store.hookEvents(task.id).find(record => record.event === 'task.pre_archive')!;
  await f.hooks.retry(f.store.task(task.id), refused.eventId);
  await archiveUnusedWorkspace(f.store, adapter, { ...control, version: f.store.task(task.id).version }, () => true, undefined, gate);
  assert.equal(archived, 1);
});

test('the disposition archive holds until the retention gate settles, then archives', async () => {
  const store = new Store(':memory:');
  try {
    store.setMeta('paused', false);
    const base = 'b'.repeat(40);
    const inserted = store.insert(submissionSchema.parse({
      submissionId: randomUUID(), title: 'Duplicate', repoPath: '/repo',
      planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin',
    }), 'host', 'handoff', base);
    const task = store.update(inserted.id, {
      phase: 'working', workspaceIntent: true, agentIntent: true,
      workspaceId: `ws-${inserted.id}`, directory: `/missing-${inserted.id}`, agentId: `worker-${inserted.id}`, runId: 'run-1',
    });
    let hold = true;
    const archived: string[] = [];
    const deps: DispositionDeps = {
      hooks: {
        emit: async () => ({ hold: false, attention: false, records: [] as unknown[] }),
        preArchive: async () => hold ? { hold: true, detail: 'Repository hook retention task.pre_archive holds this transition: mandatory originals are not durable' } : { hold: false, detail: '' },
      },
      observeAgent: async () => ({ stopped: true }),
      archiveAgent: async () => {},
      proveWorkspaceEmpty: async () => ({ empty: true, detail: 'empty' }),
      proveRetainedByReplacement: async () => ({ retained: true, detail: 'retained' }),
      archiveWorkspace: async (target: Task) => { archived.push(target.workspaceId!); return true; },
      observeWorkspaceArchived: async () => false,
      settleCancelledPr: async () => 'PR closed',
    };
    const control = { taskId: task.id, version: task.version, action: 'cancel' as const, reason: 'Duplicate task' };

    const first = await requestDisposition(store, deps, control);
    assert.equal(archived.length, 0);
    assert.notEqual(first.disposition?.status, 'complete');
    assert.notEqual(first.phase, 'cancelled');
    assert.match(first.reason, /retention|holds this transition/);
    assert.equal(isDispositionActive(first), true);

    hold = false;
    const second = await requestDisposition(store, deps, control);
    assert.equal(second.disposition?.status, 'complete');
    assert.deepEqual(archived, [task.workspaceId]);
  } finally { store.close(); }
});


test('accepted report-only archive uses the planning head and preserves the retention gate', async t => {
  const f = await repoFixture(t);
  const archived: Array<{ id: string; directory: string }> = [];
  const lifecycle = lifecycleFor(f.store, f.hooks, archived);
  const done = f.store.update(f.task.id, { phase: 'done', prHead: null, prUrl: null });
  await lifecycle.archive(done);
  assert.equal(archived.length, 0, 'a bare done state grants no report-only archive');
  const accepted = f.store.update(done.id, { reportAcceptance: { artifact: { key: 'report', version: 1, digest: 'sha256:' + 'a'.repeat(64) },
    acceptedBy: 'owner', reason: 'Accepted report', acceptedAt: new Date().toISOString(), taskVersion: done.version } });
  await f.setControl('refuse');
  await lifecycle.archive(accepted);
  assert.equal(archived.length, 0);
  assert.ok(existsSync(f.task.directory!));
  const refused = f.store.hookEvents(done.id).find(record => record.event === 'task.pre_archive')!;
  assert.ok(refused, 'ordinary retention gate ran for the report');
  await f.setControl('ok');
  await f.hooks.retry(f.store.task(done.id), refused.eventId);
  const repaired = f.store.task(done.id);
  f.store.update(done.id, { resolution: { ...repaired.resolution, workspaceArchiveRetries: [] } });
  await lifecycle.archive(f.store.task(done.id));
  assert.equal(archived.length, 1);
  assert.equal(f.store.task(done.id).resolution.mergedCommit, null);
  assert.equal(f.store.task(done.id).resolution.syncedCommit, null);
});

test('pre-archive holds when a retained workspace head cannot be resolved', async t => {
  const { hooks, task } = await repoFixture(t, { retained: false });
  const result = await hooks.preArchive(task);
  assert.equal(result.hold, true);
  assert.match(result.detail, /Cannot prove the retained workspace head/);
});
