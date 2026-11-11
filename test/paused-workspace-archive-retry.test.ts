import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { QueueRuntime } from '../service/runtime-owner';
import { PaseoAdapter, type AgentObservation } from '../service/paseo-composition';
import { digest } from '../core/store/store';
import { command, git } from '../core/git/index';
import { repoCommonDir } from '../core/workspaces/workspace-allocation';
import { workspaceDiscardKey } from '../core/workspaces/orphan-worktree';
import { submissionSchema, taskControlInputSchema, type Task } from '../shared/contracts';
import { missingHistory, terminalArchiveFixture } from './support/terminal-archive-fixture';

/**
 * A workspace archive retry while Queue is paused truthfully reports that no
 * attempt ran and the pause still holds. Before this, `retry_effect` joined the
 * cleanup lane (which returns at its first pause check), then re-read the
 * unchanged `workspaceArchiveRetries` record and threw its stored Git failure as
 * if the call had just observed it: the 10:01 discard retry reported the 09:10
 * error, although no attempt, event, adapter or Git call happened at 10:01. The
 * stored failure stays timestamped history, and a content-discard authorization
 * the same call validly recorded is reported as durable for a later eligible
 * attempt - never as an archive that ran, succeeded or will succeed.
 */

/** The real public `RuntimeOwner.taskControl` route over a disposable Git fixture. */
async function publicFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ns-paused-archive-')));
  const origin = join(root, 'origin.git'), primary = join(root, 'primary'), data = join(root, 'data');
  await command('git', ['init', '--bare', '--initial-branch=main', origin], root);
  await command('git', ['init', '--initial-branch=main', primary], root);
  await git(primary, 'config', 'user.name', 'Queue test');
  await git(primary, 'config', 'user.email', 'queue@example.invalid');
  await writeFile(join(primary, 'README.md'), 'base\n');
  await git(primary, 'add', '-A');
  await git(primary, 'commit', '-m', 'base');
  await git(primary, 'remote', 'add', 'origin', origin);
  await git(primary, 'push', 'origin', 'main');
  const base = await git(primary, 'rev-parse', 'HEAD');
  // The runtime's callback surface binds inside its data dir, which the adapter's
  // helper path shares.
  await mkdir(data, { recursive: true });
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', join(data, 'callback.sock'), join(data, 'worker-report.mjs'));
  // The fixture has no daemon: the bootstrap connect must fail fast rather than
  // reach a socket, and no sweep may run.
  adapter.connect = async () => { throw Error('fixture daemon is absent'); };
  const runtime = new QueueRuntime({ dataDir: join(root, 'runtime'), adapterFactory: () => adapter, timers: false,
    settings: { daemonUrl: 'ws://127.0.0.1:1' }, connectTimeoutMs: 250 });
  const store = runtime.store;
  // Queue #912: the task's one registered host is online, so its paused retry reaches the pause check (the connect above never succeeds here).
  (adapter as unknown as { client: { isConnected: boolean } }).client = { isConnected: true };
  runtime.hostRegistry.connect('host', 'ws://127.0.0.1:1', { adapter: runtime.adapter, admission: runtime.admission });
  const inserted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Paused workspace archive retry',
    repoPath: primary, planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
  const directory = join(data, 'workspaces', digest(await repoCommonDir(primary)), inserted.branch);
  adapter.findWorkspaces = async () => [];
  await adapter.populateTaskWorktree(inserted);
  await writeFile(join(directory, 'task.txt'), 'task\n');
  await git(directory, 'add', '-A');
  await git(directory, 'commit', '-m', 'task');
  await git(directory, 'push', 'origin', inserted.branch);
  const head = await git(directory, 'rev-parse', 'HEAD');
  // Everything the archive proof would touch is counted: the adapter entry point
  // covers its Git work, and the catalog refresh is the first observation it makes.
  const counts = { archives: 0, proofs: 0, catalogRefreshes: 0, historyReads: 0, description: [] as string[] };
  const archiveTaskWorkspace = adapter.archiveTaskWorkspace.bind(adapter);
  (adapter as unknown as { archiveTaskWorkspace: typeof adapter.archiveTaskWorkspace }).archiveTaskWorkspace = (async (...args: Parameters<typeof archiveTaskWorkspace>) => {
    counts.proofs++;
    return archiveTaskWorkspace(...args);
  }) as typeof adapter.archiveTaskWorkspace;
  const remote = { catalogued: true, descriptor: { projectRootPath: primary },
    participant: { id: 'worker', workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' } as AgentObservation };
  const api = { workspaces: { ref: () => ({ directory,
    refresh: async () => { counts.catalogRefreshes++; },
    current: () => remote.catalogued ? remote.descriptor : undefined,
    archive: async (requestId: string) => { counts.archives++; remote.catalogued = false; return { archivedAt: new Date().toISOString() }; },
  }) }, agents: { list: async () => { counts.description.push('inventory'); return { entries: [], pageInfo: { hasMore: false } }; } } };
  (adapter as unknown as { api: typeof api }).api = api;
  adapter.observe = async id => ({ ...remote.participant, id });
  adapter.agentTimelinePage = async () => { counts.historyReads++; return null; };
  const observedAt = new Date(Date.now() - 51 * 60_000).toISOString();
  const failure = { workspaceId: 'ws', attempts: 5, error: missingHistory, nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString() };
  store.update(inserted.id, { phase: 'done', workspaceId: 'ws', directory, agentId: 'worker', prHead: head,
    prUrl: 'https://github.com/example/repo/pull/1', resolution: { ...inserted.resolution, mergedCommit: head, syncedCommit: head,
      workspaceArchiveRetries: [failure], cleanupReason: `Workspace archive for ws failed: ${missingHistory}` } });
  // The historical failure's own recorded time, as the audit lane wrote it.
  store.event(inserted.id, 'workspace_cleanup_wait', `ws: ${missingHistory}; attempt 5`);
  const failureEvent = store.eventsAll(inserted.id).findLast(event => event.kind === 'workspace_cleanup_wait')!;
  store.db.prepare('UPDATE events SET at=? WHERE id=?').run(observedAt, failureEvent.id);
  store.setMeta('paused', true);
  t.after(async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); });
  const task = () => store.task(inserted.id);
  const control = (extra: Record<string, unknown> = {}) => taskControlInputSchema.parse({ action: 'retry_effect',
    taskId: inserted.id, version: task().version, effect: 'workspace_archive.ws', caller: 'operator (board)',
    reason: 'Retry the paused workspace archive', ...extra });
  const outcomes = () => store.verbOutcomes('1970-01-01T00:00:00.000Z').filter(row => row.action === 'retry_effect');
  const discardEvents = () => store.eventsAll(inserted.id).filter(event => event.kind === 'workspace_discard_authorized');
  return { root, primary, directory, runtime, store, adapter, counts, remote, failure, observedAt, task, control, outcomes,
    discardEvents, discardKey: workspaceDiscardKey(inserted.id, 'ws') };
}

/** The engine-level fixture with an owner discard retry over the same task. */
const discardRetry = (f: Awaited<ReturnType<typeof terminalArchiveFixture>>, extra: Record<string, unknown> = {}) =>
  f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'retry_effect', taskId: f.task().id,
    version: f.task().version, effect: 'workspace_archive.ws', caller: 'operator (board)',
    reason: 'Retire the stuck workspace', discard: true, ...extra }));

test('the public retry route reports the pause and never replays the stored failure as its own observation', async t => {
  const f = await publicFixture(t);
  const before = f.task();
  await assert.rejects(f.runtime.taskControl(f.control()), (error: unknown) => {
    const message = (error as Error).message;
    assert.match(message, /^Nucleus is paused; this retry ran no archive attempt for workspace ws, and the pause still holds/);
    assert.match(message, /Its recorded failure \(attempt 5, observed .*Z\) remains history, not this call's observation/);
    // The parent falsification: the stored Git error must not come back as a result.
    assert.doesNotMatch(message, new RegExp(missingHistory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
  const after = f.task();
  assert.deepEqual(after.resolution.workspaceArchiveRetries, before.resolution.workspaceArchiveRetries, 'the old failure is unchanged');
  assert.equal(after.version, before.version, 'the receipt rewrites no task state');
  assert.deepEqual(after.resolution.archivedWorkspaceIds, []);
  assert.equal(after.resolution.archiveIntentWorkspaceId, null);
  assert.equal(after.resolution.cleanupReason, before.resolution.cleanupReason);
  // No attempt, archive, Git proof, catalog refresh, thread inventory or event.
  assert.deepEqual(f.counts, { archives: 0, proofs: 0, catalogRefreshes: 0, historyReads: 0, description: [] });
  assert.deepEqual(f.store.eventsAll(after.id).filter(event => event.kind === 'workspace_cleanup_wait').map(event => event.detail),
    [`ws: ${missingHistory}; attempt 5`], 'the historical failure line is the only one recorded');
  assert.equal(f.store.eventsAll(after.id).filter(event => event.kind === 'owner_control').length, 0);
  assert.equal(f.store.getMeta(f.discardKey), undefined, 'nothing authorized a discard');
  assert.equal(f.store.getMeta('paused'), true, 'the pause still holds');
  assert.equal(existsSync(f.directory), true, 'the workspace is still there');
  const outcomes = f.outcomes();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.outcome, 'refused');
  assert.match(String((outcomes[0]!.detail as { reason?: string }).reason), /Nucleus is paused; this retry ran no archive attempt/);
  // The durable receipt is a definite refusal, not an uncertain effect: a
  // `needs_attention` operation would have returned an acceptance instead.
  const operation = f.store.operations({ taskId: after.id }).find(item => item.kind === 'task_control')!;
  assert.equal(operation.state, 'failed');
  assert.match(operation.diagnostic, /Nucleus is paused; this retry ran no archive attempt/);
});

test('the public retry route keeps the recorded discard once and names the pause that held it', async t => {
  const f = await publicFixture(t);
  const before = f.task();
  await assert.rejects(f.runtime.taskControl(f.control({ discard: true })),
    /Nucleus is paused; this retry ran no archive attempt for workspace ws.*The operator content discard this call recorded is durable and retained for a later eligible attempt, and it lifts no pause/);
  const record = f.store.getMeta<Record<string, unknown>>(f.discardKey)!;
  assert.deepEqual({ ...record, at: undefined }, { workspaceId: 'ws', directory: f.directory, caller: 'operator (board)',
    authority: 'operator', note: null, reason: 'Retry the paused workspace archive', at: undefined });
  assert.equal(f.discardEvents().length, 1);
  assert.deepEqual(f.task().resolution.workspaceArchiveRetries, before.resolution.workspaceArchiveRetries, 'no attempt was recorded');
  assert.equal(f.task().resolution.archivedWorkspaceIds.length, 0);
  assert.equal(f.counts.archives, 0);
  assert.equal(f.counts.proofs, 0);
  assert.equal(f.store.getMeta('paused'), true);
  assert.equal(existsSync(f.directory), true);
  // A lost reply at the fresh version keeps the first authorization and attempts nothing.
  await assert.rejects(f.runtime.taskControl(f.control({ discard: true })),
    /The operator content discard already recorded for this workspace is retained for a later eligible attempt/);
  assert.equal(f.discardEvents().length, 1, 'the authorization is never re-minted');
  assert.equal(f.store.getMeta<{ caller: string }>(f.discardKey)!.caller, 'operator (board)');
  assert.deepEqual(f.task().resolution.workspaceArchiveRetries, before.resolution.workspaceArchiveRetries);
  assert.equal(f.counts.archives, 0);
});

test('a repeated identical public retry reopens its own operation and still mints no authorization or attempt', async t => {
  const f = await publicFixture(t);
  const control = f.control();
  await assert.rejects(f.runtime.taskControl(control), /Nucleus is paused; this retry ran no archive attempt for workspace ws/);
  await assert.rejects(f.runtime.taskControl(control), /Nucleus is paused; this retry ran no archive attempt for workspace ws/);
  const rows = f.store.operations({ taskId: f.task().id }).filter(operation => operation.kind === 'task_control');
  assert.equal(rows.length, 1, 'one durable operation identity for the repeated request');
  assert.equal(f.outcomes().length, 1, 'the same operation records one refused outcome');
  assert.equal(f.task().resolution.workspaceArchiveRetries[0]!.attempts, 5);
  assert.equal(f.store.eventsAll(f.task().id).filter(event => event.kind === 'workspace_cleanup_wait').length, 1);
  assert.equal(f.counts.proofs, 0);
});

test('an unauthorized discard, a stale version and another workspace stay conservative while paused', async t => {
  const f = await publicFixture(t);
  const before = f.task();
  await assert.rejects(f.runtime.taskControl(f.control({ caller: 'someone-else', discard: true })), /someone-else has none/);
  assert.equal(f.store.getMeta(f.discardKey), undefined);
  assert.deepEqual(f.task().resolution.workspaceArchiveRetries, before.resolution.workspaceArchiveRetries);
  await assert.rejects(f.runtime.taskControl(f.control({ discard: true, relayed: true })), /authorization note/);
  assert.equal(f.store.getMeta(f.discardKey), undefined);
  const stale = { ...f.control(), version: before.version - 1 };
  await assert.rejects(f.runtime.taskControl(taskControlInputSchema.parse(stale)), /Task changed/);
  await assert.rejects(f.runtime.taskControl(f.control({ effect: 'workspace_archive.other-ws' })), /No recorded side effect workspace_archive\.other-ws is pending/);
  assert.equal(f.counts.archives, 0);
  assert.equal(f.counts.proofs, 0);
  assert.deepEqual(f.task().resolution.workspaceArchiveRetries, before.resolution.workspaceArchiveRetries);
});

test('a paused retry of an unconfirmed archive intent reports the hold without inventing a failure', async t => {
  const f = await publicFixture(t);
  f.store.update(f.task().id, { resolution: { ...f.task().resolution, archiveIntentWorkspaceId: 'ws', workspaceArchiveRetries: [] } });
  await assert.rejects(f.runtime.taskControl(f.control()),
    /Nucleus is paused; this retry ran no archive attempt for workspace ws.*No failure record changed and nothing is claimed archived/);
  assert.equal(f.task().resolution.archiveIntentWorkspaceId, 'ws', 'the unconfirmed intent is untouched');
  assert.deepEqual(f.task().resolution.workspaceArchiveRetries, []);
  assert.equal(f.counts.proofs, 0);
  assert.equal(f.counts.catalogRefreshes, 0);
  assert.equal(existsSync(f.directory), true);
});

test('a pause that lands before the effect is reported as held, not as the stored or a new failure', async t => {
  const f = await terminalArchiveFixture(t);
  const lifecycle = (f.engine as unknown as { lifecycle: { archive: (task: Task, retry?: string) => Promise<void> } }).lifecycle;
  const archive = lifecycle.archive.bind(lifecycle);
  let entered = false;
  lifecycle.archive = async (task, retry) => { entered = true; f.store.setMeta('paused', true); return archive(task, retry); };
  const archivesBefore = f.remote.archives.length;
  await assert.rejects(f.retry(), /Nucleus is paused; this retry ran no archive attempt for workspace ws/);
  assert.equal(entered, true, 'the cleanup occurrence ran, and the archive declined at its own pause check');
  assert.equal(f.remote.archives.length, archivesBefore);
  assert.equal(f.task().resolution.workspaceArchiveRetries[0]!.attempts, 5, 'no synthetic attempt increment');
  assert.equal(f.task().resolution.workspaceArchiveRetries[0]!.error, missingHistory);
  assert.equal(existsSync(f.directory), true);
});

test('an actual attempted failure names its own attempt so it cannot be confused with history', async t => {
  const f = await terminalArchiveFixture(t);
  f.remote.participant.status = 'running';
  f.remote.participant.active = true;
  await assert.rejects(f.retry(), /Workspace archive retry for ws attempt 6 failed: .*participants? to become idle|active/i);
  const recorded = f.task().resolution.workspaceArchiveRetries[0]!;
  assert.equal(recorded.attempts, 6, 'a real attempt increments the recorded attempt');
  assert.notEqual(recorded.error, missingHistory, 'the cause is this attempt, not the stored one');
  assert.equal(f.remote.archives.length, 0);
  assert.equal(existsSync(f.directory), true);
});

test('a discard recorded while paused archives on isolated resume through the ordinary fences', async t => {
  const f = await terminalArchiveFixture(t);
  await writeFile(join(f.directory, 'unsaved.txt'), 'never committed\n');
  f.store.setMeta('paused', true);
  await assert.rejects(discardRetry(f),
    /Nucleus is paused; this retry ran no archive attempt for workspace ws.*content discard this call recorded is durable and retained/);
  assert.equal(existsSync(f.directory), true, 'nothing was deleted while paused');
  assert.equal(f.remote.archives.length, 0);
  assert.equal(f.task().resolution.workspaceArchiveRetries[0]!.attempts, 5);
  assert.equal(f.store.eventsAll(f.task().id).filter(event => event.kind === 'workspace_discard_authorized').length, 1);
  // Resume only inside this isolated fixture; the retained authorization is
  // eligible on a later attempt, and every ordinary fence still runs.
  f.store.setMeta('paused', false);
  const archived = await f.retry();
  assert.deepEqual(archived.resolution.archivedWorkspaceIds, ['ws']);
  assert.deepEqual(archived.resolution.workspaceArchiveRetries, []);
  assert.equal(f.remote.archives.length, 1);
  assert.equal(existsSync(f.directory), false);
  assert.equal(f.store.eventsAll(f.task().id).filter(event => event.kind === 'workspace_discard_authorized').length, 1,
    'the resume records no second authorization');
  assert.equal(f.store.eventsAll(f.task().id).filter(event => event.kind === 'workspace_contents_discarded').length, 1);
  assert.match(f.store.eventsAll(f.task().id).find(event => event.kind === 'workspace_archived')!.detail,
    /unproven contents discarded by operator \(board\) \(operator\)/);
});

test('an ordinary unpaused retry still archives and clears that workspace record', async t => {
  const f = await terminalArchiveFixture(t);
  const before = f.task();
  const archived = await f.retry();
  assert.deepEqual(archived.resolution.archivedWorkspaceIds, ['ws']);
  assert.deepEqual(archived.resolution.workspaceArchiveRetries, []);
  assert.equal(archived.resolution.cleanupReason, '');
  assert.equal(f.remote.archives.length, 1);
  assert.equal(existsSync(f.directory), false);
  for (const key of ['phase', 'branch', 'prHead', 'completion', 'disposition'] as const)
    assert.deepEqual(archived[key], before[key], key);
});
