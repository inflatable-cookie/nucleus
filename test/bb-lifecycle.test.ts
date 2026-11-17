import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { QueueRuntime } from '../service/runtime-owner';
import { git } from '../core/git/index';
import { leadSubmit, type Run, type Task } from '../shared/contracts';
import { formatAgentId } from '../shared/agent-identity';
import { fakeAdapter } from './support/fakes';
import { createBbHostAdapter } from '../service/bb-host';
import { bbFake, bbWire } from './support/bb-fake';
import type { Adapter as HostAdapter } from '../core/host';
const paseoHost = 'paseo:primary', bbHost = 'bb:0123456789abcdef0123456789abcdef';
const base = 'd'.repeat(40), prUrl = 'https://github.com/example/lifecycle/pull/7';
interface Fixture {
 runtime: QueueRuntime; root: string; repo: string; fake: ReturnType<typeof bbFake>; adapter: HostAdapter;
 planner: string; helperPath: string; merges: string[]; paseoObserves: string[]; close(): Promise<void>;
}
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One end-to-end pass: a wake, a settle, then re-read. The timers would drive
 * the same passes; the test just drives them by hand.
 */
async function driveUntil(f: Fixture, ready: () => boolean, label: string, taskId?: string, passes = 400): Promise<void> {
  for (let i = 0; i < passes; i++) {
    if (ready()) return;
    // The passes the timers would drive: the task's own observation pass and
    // the fleet sweep, spread across checks so completion follow-ups run their
    // lanes instead of racing the sweep.
    try {
      // The passes the timers would drive: the observation pass releases
      // finished runs, the task quantum applies results and dispatches the
      // next role, and the fleet sweep covers the rest.
      if (taskId) {
        if (i % 3 === 1) await f.runtime.engine.resolution.observe(null, taskId);
        if (i % 3 === 2) await f.runtime.engine.wakeTask(taskId).catch(() => {});
      }
      if (i % 5 === 4) await f.runtime.engine.wake().catch(() => {});
    } catch { /* a refused pass is the next pass's work */ }
    await pause(25);
  }
  const task = taskId ? f.runtime.store.task(taskId) : null;
  assert.ok(ready(), `${label} after ${passes} passes${task ? ` (phase ${task.phase}: ${task.reason})` : ''}`);
}

const helperReport = (f: Fixture, ticketPath: string, payload: Record<string, unknown>) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [f.helperPath, ticketPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(payload));
  });

const runTicketPath = (f: Fixture, run: Run | { id: string }) => join(dirname(f.helperPath), 'tickets', `${run.id}.json`);
/** A report the way the callback intake applies it: complete, then wake the task's quantum. */
const reportAndWake = async (
  f: Fixture, taskId: string, payload: Parameters<QueueRuntime['engine']['resolution']['complete']>[0], token: string,
): Promise<void> => {
  await f.runtime.engine.complete(payload, token);
  await f.runtime.engine.wakeTask(taskId).catch(() => {});
};

/** A run's ticket names its authenticated callback token. */
const ticketToken = (f: Fixture, run: Run | { id: string }): string => {
  const ticket = JSON.parse(readFileSync(runTicketPath(f, run), 'utf8')) as { token: string };
  return ticket.token;
};

async function fixture(t: TestContext): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bb-lifecycle-')));
  const repo = join(root, 'repo');
  await git(root, 'init', '--bare', '--initial-branch=main', join(root, 'origin.git'));
  await git(root, 'clone', join(root, 'origin.git'), repo);
  await git(repo, 'config', 'user.name', 'Queue test');
  await git(repo, 'config', 'user.email', 'queue@example.invalid');
  mkdirSync(join(repo, '.paseo'), { recursive: true });
  writeFileSync(join(repo, '.paseo/queue.json'), JSON.stringify({ schema: 'paseo.queue.control.v5', closeout: 'queue', hooks: [] }));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'fixture');
  await git(repo, 'push', 'origin', 'main');

  const dataDir = join(root, 'data');
  const socketPath = join(dataDir, 'callback.sock'), helperPath = join(dataDir, 'worker-report.mjs');
  const paseoObserves: string[] = [];
  const paseoAdapter = fakeAdapter({
    client: { isConnected: true },
    hostId: paseoHost, socketPath, helperPath,
    connect: async () => {}, close: async () => {},
    // The live daemon offers these models, so a host-context leak would reach the
    // reviewer's own observe here rather than stopping at its profile catalog.
    catalog: async () => ({ providers: [{ key: 'codex', label: 'Synthetic provider', available: true, problem: '',
      models: [{ id: 'synthetic-model', label: 'Synthetic model', aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [], features: [] },
        { id: 'synthetic-model-2', label: 'Synthetic model two', aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [], features: [] }] }] }),
    validate: async (task: { planningCommit: string }) => task.planningCommit,
    verifyWorkspace: async (_task: unknown, directory: string) => directory,
    createWorkspace: async () => { throw new Error('the BB-bound task must never use Paseo'); },
    createAgent: async () => { throw new Error('Paseo must never create this task\'s worker'); },
    // Paseo answers not-mine by refusing an identity it does not hold, exactly
    // as the live host does; only the planner thread lives here.
    observe: async (id: string) => {
      paseoObserves.push(id);
      if (id !== 'planner') throw new Error('Agent was not found');
      return { id, workspaceId: 'planner-ws', status: 'idle', active: false, permissions: false, error: '' };
    },
    originAgent: async (id: string) => id === 'planner' ? { id, workspaceId: 'planner-ws', title: 'Planner', archived: false } : null,
    notify: async () => {},
    askPlanner: async () => null,
    archiveAgent: async () => {},
    findOpenBranchPr: async () => [],
    // The live host offers the same-run reviewer continuation and reads the
    // reviewer's identity before sending; reaching it with a BB thread's identity
    // is #226's failure ("Agent was not found").
    verifyPr: async (task: { prHead?: string | null }) => ({ url: prUrl, head: task.prHead ?? 'unused',
      repository: 'example/lifecycle', headRepository: 'example/lifecycle' }),
    continueReviewer: async (_task: unknown, run: Run) => {
      paseoObserves.push(run.agentId!);
      throw new Error('Agent was not found');
    },
  }) as HostAdapter;

  const runtime = new QueueRuntime({ dataDir, adapterFactory: () => paseoAdapter, timers: false });
  await runtime.started;
  await runtime.bootstrap;

  const fake = bbFake();
  fake.rows.set('thr_planner', bbWire('list', { id: 'thr_planner', originPluginId: null, environmentPath: repo, environmentId: 'env_planner', parentThreadId: null, hasPendingInteraction: false, archivedAt: null }));
  const adapter = createBbHostAdapter(bbHost, () => true, dataDir, runtime.store, fake.operations.execute);
  // Every native read and write crosses the real operation executor with recorded BB DTOs.
  const forge = adapter as unknown as Record<string, unknown>;
  forge.hostProcessListing = async () => [];
  forge.hostLoad = () => ({ load: 0, cpus: 1 });
  const merges: string[] = [];
  const liveHead = async (task?: { directory?: string }) => (await git(task?.directory ?? repo, 'rev-parse', 'HEAD')).trim();
  forge.verifyPr = async (task: { directory?: string }) => ({ head: await liveHead(task), url: prUrl });
  forge.verifyPrIdentity = async (task: { directory?: string }) => ({ head: await liveHead(task), url: prUrl });
  forge.verifyCleanQueueWorktree = async () => {};
  forge.verifyReview = async () => 9001;
  forge.publishReview = async () => ({ id: 9001, published: true });
  forge.reconcileFormalReviewPublication = async () => ({ id: 9001, published: false });
  forge.coveringEvidence = async (task: { directory?: string }) => ({ head: await liveHead(task), base, wait: '' });
  forge.authorCommentEvidence = async () => '';
  forge.findOpenBranchPr = async () => [];
  forge.verifyCancelledWorkspacePr = async () => {};
  forge.externalMerge = async () => null;
  forge.rerunFailedWorkflowRuns = async (_t: unknown, runIds: string[]) => runIds;
  forge.mergeGate = async (task: { directory?: string }) => ({ head: await liveHead(task), base, wait: '' });
  forge.requiredChecks = async (task: { directory?: string }) => ({ head: await liveHead(task), base, wait: '' });
  forge.merge = async () => { merges.push('merged'); };
  forge.merged = async (task: { directory?: string }) => {
    const head = await liveHead(task);
    return { merged: merges.length > 0, commit: merges.length > 0 ? head : null, head, base: 'main' };
  };
  forge.syncMain = async (task: { directory?: string }) => liveHead(task);
  forge.verifyCloseout = async () => {};

  runtime.hostRegistry.connect(bbHost, 'bb-endpoint', { adapter, admission: runtime.admission });
  runtime.store.putRepository({ origin: repo, path: repo }, null, '', null, null, null, undefined, undefined, 'bb');
  runtime.store.upsertProject({ key: 'lifecycle', name: 'Lifecycle', repositories: [{ origin: repo, path: repo }] });
  const planner = formatAgentId(paseoHost, 'planner');
  runtime.store.setProjectPlanner({ key: 'lifecycle', agentId: planner, setBy: 'operator (board)' });
  // The worker profile carries the trial's thinking level; the independent
  // reviewer's model lists no option descriptors at all.
  runtime.store.setProfiles([
    { id: 'sol-grind', name: 'Sol grind', provider: 'codex', model: 'synthetic-model', thinkingOptionId: 'high', notes: '' },
    { id: 'luna-review', name: 'Luna review', provider: 'codex', model: 'synthetic-model-2', notes: '' },
  ]);
  runtime.store.setMeta('pool', [
    { profileId: 'sol-grind', enabled: true, group: 'sol', weight: 2, roles: ['worker' as const], scopes: ['general' as const], capability: 'medium' },
    { profileId: 'luna-review', enabled: true, group: 'luna', weight: 2, roles: ['reviewer' as const], scopes: ['general' as const], capability: 'medium' },
  ]);
  runtime.store.setMeta('paused', false);
  await runtime.engine.refresh();

  const close = async () => { await runtime.drain(); };
  return { runtime, repo, root, fake, adapter, planner, helperPath, merges, paseoObserves, close };
}

test('BB ordinary lifecycle: dispatch, helper report, independent review, revision, verdict, merge, closeout and archive', async t => {
 const f = await fixture(t);
 try {
  const result = leadSubmit.output.parse(await f.runtime.submitLead({
   repository: { origin: f.repo, path: f.repo }, title: 'Lifecycle on BB',
   body: '---\ntitle: Lifecycle on BB\nqueue:\n  complexity: medium\n---\n\n## Outcome\n\nRun the ordinary lifecycle on BB.\n',
   baseBranch: 'main', lanes: [], tags: [], agent: f.planner, note: 'Tom authorized this synthetic fixture',
  }));
  assert.ok('taskId' in result, JSON.stringify(result));
  let task = f.runtime.store.task(result.taskId);
  assert.equal(task.hostId, bbHost);
  f.runtime.store.update(task.id, { plannerAgentId: formatAgentId(bbHost, 'thr_planner') });
  await f.runtime.engine.dispatchTask(task.id, false);
  await driveUntil(f, () => Boolean(f.runtime.store.task(task.id).agentId), 'worker dispatched', task.id);
  task = f.runtime.store.task(task.id);
  const workerId = task.agentId!;
  assert.equal(task.phase, 'working');
  const launch = f.fake.calls.find(c => c.method === 'threads.spawn')!.args;
  assert.equal(launch.parentThreadId, 'thr_planner'); assert.equal(launch.parentNotifications, 'off');
  assert.match(launch.input[0].text, /nucleus helper report/);
  // The BB adapter reports through the packaged helper and this run's ticket, never MCP.
  assert.match(launch.input[0].text, /packaged nucleus helper with this run's ticket/);
  assert.equal(launch.visibility, 'visible');
  f.fake.rows.get(workerId).queuedWork = 'waiting';
  const workspaceInventory = await (f.adapter as any).workspaceHost.workspaceThreads([task.workspaceId]);
  assert.ok(workspaceInventory.threads.find((row: { id: string }) => row.id === workerId).activeTurn, 'queued work keeps workspace cleanup busy');
  f.fake.rows.get(workerId).queuedWork = 'none';
  const displacedRunId = randomUUID();
  const displaced = await f.adapter.createAgent({ ...task, runId: displacedRunId }, 'synthetic-retired-token', 'Synthetic displaced worker');
  const displacedTemporary = f.adapter.runTemporaryDirectory!(displacedRunId, task);
  mkdirSync(displacedTemporary, { recursive: true });
  const displacedHead = (await git(task.directory!, 'rev-parse', 'HEAD')).trim(), observedAt = new Date().toISOString();
  f.runtime.store.putRun({ id: displacedRunId, taskId: task.id, hostId: bbHost, role: 'revision', generation: task.coordinatorGeneration,
    head: displacedHead, base: displacedHead, agentId: displaced.id, workspaceId: task.workspaceId!, profile: task.profile!, profileGroup: task.profileGroup!,
    temporaryDirectory: displacedTemporary, status: 'superseded', createdAt: observedAt, lastObservedAt: observedAt,
    active: false, idleSince: observedAt, completion: null, released: true });
  task = f.runtime.store.update(task.id, { retiredWorkers: [{ agentId: displaced.id, runId: displacedRunId, profile: task.profile!, reason: 'Synthetic replacement' }] });
  f.fake.rows.get(displaced.id).status = 'active';
  await f.adapter.reconcileThreadTitles!([task]);
  assert.equal(f.fake.rows.get(displaced.id).archivedAt, null, 'a replaced worker with a live turn stays visible');
  f.fake.rows.get(displaced.id).status = 'idle';
  await f.adapter.reconcileThreadTitles!([task]);
  assert.ok(f.fake.rows.get(displaced.id).archivedAt, 'the replaced worker archives after release and an ended turn');
  assert.equal(f.fake.rows.get(workerId).archivedAt, null, 'the current worker stays visible');
  const worktreeHead = (await git(task.directory!, 'rev-parse', 'HEAD')).trim();
  const report = await helperReport(f, runTicketPath(f, { id: task.runId! }), { status: 'ready_for_review', summary: 'Ready', prNumber: 7, head: worktreeHead });
  assert.equal(report.code, 0, report.err);
  await driveUntil(f, () => Boolean(f.runtime.store.task(task.id).resolution.reviewerAgentId), 'independent reviewer launched', task.id);
  task = f.runtime.store.task(task.id);
  const reviewerId = task.resolution.reviewerAgentId!;
  assert.notEqual(reviewerId, workerId);
  f.fake.rows.get(reviewerId).hasPendingInteraction = true;
  f.fake.interactions.set(reviewerId, [bbWire('interaction', { threadId: reviewerId })]);
  await f.adapter.reconcileThreadTitles!([task]);
  assert.match(f.fake.rows.get(workerId).title, /reviewer needs input/);
  f.fake.rows.get(reviewerId).hasPendingInteraction = false;
  assert.equal(f.fake.rows.get(reviewerId).environmentId, f.fake.rows.get(workerId).environmentId);
  const reviewer = f.runtime.store.runs(task.id).find(r => r.role === 'reviewer' && r.agentId === reviewerId)!;
  await reportAndWake(f, task.id, { eventId: randomUUID(), taskId: task.id, runId: reviewer.id, status: 'changes_required', summary: 'One finding', reviewText: 'Tighten the change.', reviewResponsibility: 'author', prNumber: 7, head: worktreeHead }, ticketToken(f, reviewer));
  await driveUntil(f, () => f.runtime.store.runs(task.id).some(r => r.role === 'revision' && !r.released), 'revision reserved', task.id);
  const revision = f.runtime.store.runs(task.id).findLast(r => r.role === 'revision' && !r.released)!;
  await driveUntil(f, () => f.fake.calls.some(c => c.method === 'threads.send' && c.args.threadId === workerId), 'revision delivered to retained worker', task.id);
  await reportAndWake(f, task.id, { eventId: randomUUID(), taskId: task.id, runId: revision.id, status: 'ready_for_review', summary: 'Finding addressed', prNumber: 7, head: worktreeHead }, ticketToken(f, revision));
  await driveUntil(f, () => f.fake.calls.some(c => c.method === 'threads.send' && c.args.threadId === reviewerId), 'retained reviewer consulted', task.id);
  const currentReview = f.runtime.store.runs(task.id).find(r => r.role === 'reviewer' && r.agentId === reviewerId && !r.released)!;
  await reportAndWake(f, task.id, { eventId: randomUUID(), taskId: task.id, runId: currentReview.id, status: 'ready_to_merge', summary: 'Approved', reviewText: 'The finding is addressed.', prNumber: 7, head: worktreeHead }, ticketToken(f, currentReview));
  await driveUntil(f, () => f.runtime.store.task(task.id).phase === 'done', 'merged and closed', task.id);
  assert.ok(f.merges.length);
  await driveUntil(f, () => Boolean(f.fake.rows.get(workerId).archivedAt), 'worker archived', task.id);
  const workspaceId = task.workspaceId!;
  await driveUntil(f, () => f.runtime.store.task(task.id).resolution.archivedWorkspaceIds.includes(workspaceId), 'workspace archived after published-source proof', task.id);
  assert.equal(await f.adapter.taskWorkspaceArchived!(workspaceId), true);
  assert.equal(existsSync(task.directory!), false, 'core removes only the proved clean, published task worktree');
  assert.equal(f.fake.rows.get('thr_planner').archivedAt, null);
  const archive = f.fake.calls.findIndex(c => c.method === 'threads.archive' && c.args.threadId === workerId);
  assert.ok(f.fake.calls.slice(0, archive).some(c => c.method === 'threads.experimental_listCascade' && c.args.threadIds.includes(workerId)), 'the worker archive has a prior thread-scoped cascade proof');
  assert.deepEqual(f.paseoObserves.filter(id => id !== 'planner'), []);
 } finally { await f.close(); }
});

test('BB unknown worker spawn stays uncreated in attention after empty sweeps and adopts a late exact match', async t => {
 const f = await fixture(t);
 try {
  const result = leadSubmit.output.parse(await f.runtime.submitLead({
   repository: { origin: f.repo, path: f.repo }, title: 'Late BB spawn',
   body: '---\ntitle: Late BB spawn\nqueue:\n  complexity: medium\n---\n\n## Outcome\n\nSynthetic late spawn.\n',
   baseBranch: 'main', lanes: [], tags: [], agent: f.planner, note: 'Tom authorized this synthetic fixture',
  }));
  assert.ok('taskId' in result);
  const taskId = result.taskId;
  f.runtime.store.update(taskId, { plannerAgentId: formatAgentId(bbHost, 'thr_planner') });
  f.fake.controls.loseSpawn = true; f.fake.controls.delaySpawn = true;
  await f.runtime.engine.dispatchTask(taskId, false);
  for (let i = 0; i < 3; i++) await f.runtime.engine.wakeTask(taskId).catch(() => {});
  const unknown = f.runtime.store.task(taskId);
  assert.equal(unknown.agentId, null);
  assert.equal(unknown.phase, 'needs_attention');
  assert.match(unknown.reason, /unknown|not resent|uncreated/i);
  assert.equal(f.fake.calls.filter(c => c.method === 'threads.spawn').length, 1);
  f.fake.land();
  await driveUntil(f, () => Boolean(f.runtime.store.task(taskId).agentId), 'late worker adopted by metadata', taskId);
  assert.equal(f.fake.calls.filter(c => c.method === 'threads.spawn').length, 1);
 } finally { await f.close(); }
});
