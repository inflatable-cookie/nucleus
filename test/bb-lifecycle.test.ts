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
const paseoHost = 'paseo:primary', bbHost = 'bb:0123456789abcdef0123456789abcdef', t3Host = 't3code:trial';
const base = 'd'.repeat(40), prUrl = 'https://github.com/example/lifecycle/pull/7';
interface Fixture {
 runtime: QueueRuntime; root: string; repo: string; fake: ReturnType<typeof bbFake>; adapter: HostAdapter;
 planner: string; helperPath: string; merges: string[]; paseoObserves: string[]; close(): Promise<void>;
 /** Spec 062 phase 7: the host claim's lifetime is what a reload, a restart and an outage move. */
 dataDir: string; disconnectHost(): void; reconnectHost(next?: HostAdapter): void;
 /** A second adapter over the same recorded state and wire: the plugin and BB restarted. */
 restartAdapter(): HostAdapter;
 /** The T3 host a planner thread can live on (Spec 062 phase 7: T3 dispatches, BB executes). */
 t3Planner: string;
 t3: { asks: Array<{ recipient: string; prompt: string }>; notifications: Array<{ id: string; text: string }>; origins: string[] };
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

  // A second host for the planner: T3 can dispatch a brief that BB executes. It never
  // creates a workspace or an agent here; it only holds the planner thread's asks and
  // notices, so a leak to Paseo or to BB would show as a missing record on this one.
  const t3 = { asks: [] as Array<{ recipient: string; prompt: string }>, notifications: [] as Array<{ id: string; text: string }>, origins: [] as string[] };
  const t3Adapter = fakeAdapter({
    client: { isConnected: true },
    hostId: t3Host, socketPath, helperPath,
    connect: async () => {}, close: async () => {},
    catalog: async () => ({ providers: [] }),
    validate: async (task: { planningCommit: string }) => task.planningCommit,
    verifyWorkspace: async (_task: unknown, directory: string) => directory,
    createWorkspace: async () => { throw new Error('the BB-bound task must never use T3'); },
    createAgent: async () => { throw new Error('T3 must never create this task\'s worker'); },
    observe: async (id: string) => {
      if (id !== 'planner') throw new Error('Agent was not found');
      return { id, workspaceId: 't3-planner-ws', status: 'idle', active: false, permissions: false, error: '' };
    },
    originAgent: async (id: string) => { t3.origins.push(id); return id === 'planner' ? { id, workspaceId: 't3-planner-ws', title: 'T3 planner', archived: false } : null; },
    notify: async (id: string, _messageId: string, text: string) => { t3.notifications.push({ id, text }); },
    askPlanner: async (recipient: string, input: { prompt: string }) => { t3.asks.push({ recipient, prompt: input.prompt }); return null; },
    archiveAgent: async () => {},
    findOpenBranchPr: async () => [],
  }) as HostAdapter;

  const runtime = new QueueRuntime({ dataDir, adapterFactory: () => paseoAdapter, timers: false });
  await runtime.started;
  await runtime.bootstrap;
  runtime.hostRegistry.connect(t3Host, 't3code-endpoint', { adapter: t3Adapter, admission: runtime.admission });

  const fake = bbFake();
  fake.rows.set('thr_planner', bbWire('list', { id: 'thr_planner', originPluginId: null, environmentPath: repo, environmentId: 'env_planner', parentThreadId: null, hasPendingInteraction: false, archivedAt: null }));
  // The plugin's own presence gate: while no executor holds the claim, an operation is
  // "not sent" exactly as the real adapter answers (Spec 062, "Faults").
  let claimed = true;
  const adapter = createBbHostAdapter(bbHost, () => claimed, dataDir, runtime.store, fake.operations.execute);
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

  let bbToken = runtime.hostRegistry.connect(bbHost, 'bb-endpoint', { adapter, admission: runtime.admission });
  const disconnectHost = () => { claimed = false; runtime.hostRegistry.disconnect(bbHost, bbToken); };
  const reconnectHost = (next: HostAdapter = adapter) => { claimed = true; bbToken = runtime.hostRegistry.connect(bbHost, 'bb-endpoint', { adapter: next, admission: runtime.admission }); };
  const restartAdapter = () => createBbHostAdapter(bbHost, () => claimed, dataDir, runtime.store, fake.operations.execute);
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
  return { runtime, repo, root, fake, adapter, planner, helperPath, merges, paseoObserves, close, dataDir, disconnectHost, reconnectHost, restartAdapter,
    t3Planner: formatAgentId(t3Host, 'planner'), t3 };
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

/**
 * Spec 062 phase 7, Tom's 2026-11-17 amendment: "T3 dispatches, BB executes".
 *
 * A T3 planner thread submits the brief through Nucleus; the task's own planner
 * thread is a BB thread, so the task dispatches to BB and runs its whole lifecycle
 * there — worker report, independent review, merge, closeout, archive — while the
 * origin stays on T3 and the closeout notice returns to that thread. The first
 * dispatch attempt records the finding the amendment asks for: BB parents every role
 * thread to a BB planner thread, so a task with only a T3 planner is refused before
 * any spawn, and the parity table names that step missing. The same table names the
 * other gap this test asserts: a worker's question goes to the task's planner thread,
 * never to the T3 origin. Everything here runs over recorded BB 0.49.0 rows with
 * fixture hosts: the dispatch, review and closeout rules, not isolated execution.
 */
test('BB trial: a T3 planner submits, BB refuses the dispatch without a BB planner thread, then executes end to end and the notice returns to T3', async t => {
 const f = await fixture(t);
 try {
  // The operator sets the T3 planner thread as this project's planner.
  f.runtime.store.setProjectPlanner({ key: 'lifecycle', agentId: f.t3Planner, setBy: 'operator (board)' });
  f.runtime.engine.resolution.agentAskWaitMs = 15_000;
  f.runtime.engine.resolution.agentAskPollMs = 20;
  f.runtime.engine.resolution.delegatedAnswerWaitMs = 8_000;
  const result = leadSubmit.output.parse(await f.runtime.submitLead({
   repository: { origin: f.repo, path: f.repo }, title: 'T3 dispatches BB',
   body: '---\ntitle: T3 dispatches BB\nqueue:\n  complexity: medium\n  notifyOriginOnCloseout: true\n---\n\n## Outcome\n\nProve the T3-to-BB flow.\n',
   baseBranch: 'main', lanes: [], tags: [], agent: f.t3Planner, note: 'Tom authorized this synthetic fixture',
  }));
  assert.ok('taskId' in result, JSON.stringify(result));
  const taskId = result.taskId;
  const submitted = f.runtime.store.task(taskId);
  assert.equal(submitted.originHostId, t3Host, 'the submitting planner stays on its T3 host');
  assert.equal(submitted.hostId, bbHost, 'the trial repository selects the BB host');
  assert.equal(f.runtime.store.leads().find(candidate => candidate.title === 'T3 dispatches BB')?.check?.ok, true, 'the T3 author lead passed its check');
  assert.equal(f.runtime.store.projectPlannerRecipient(f.runtime.store.projectFor(f.repo, f.repo)), f.t3Planner, 'the project planner is the T3 thread');

  // The finding: BB parents every role thread to a BB planner thread, so a T3-only
  // plan is refused before anything is spawned.
  await f.runtime.engine.dispatchTask(taskId, false);
  await driveUntil(f, () => f.runtime.store.task(taskId).phase === 'needs_attention' || Boolean(f.runtime.store.task(taskId).agentId), 'the T3-only dispatch answered', taskId, 120);
  const refused = f.runtime.store.task(taskId);
  assert.equal(refused.agentId, null, 'nothing was spawned on BB for a T3-only plan');
  assert.equal(spawnCount(f), 0, 'no BB spawn was attempted');
  assert.match(refused.reason, /planner thread on this BB host/, 'the refusal names the missing BB planner thread');

  // With the task's planner thread recorded on BB, the same brief executes there.
  const cleared = f.runtime.store.task(taskId);
  f.runtime.store.update(taskId, { plannerAgentId: formatAgentId(bbHost, 'thr_planner'), phase: 'queued', reason: '',
    resolution: { ...cleared.resolution, stop: null, attention: false } }, 'planner_selected', 'BB planner thread recorded; the dispatch refusal cleared');
  await f.runtime.engine.dispatchTask(taskId, false);
  await driveUntil(f, () => Boolean(f.runtime.store.task(taskId).agentId), 'worker dispatched on BB', taskId);
  assert.equal(spawnCount(f), 1, 'the worker thread is a BB spawn');
  assert.deepEqual(f.t3.origins.filter(id => id !== 'planner'), [], 'the T3 adapter created nothing for the task');

  // The worker's question routes to the task's planner thread on BB, as a queued send.
  const runId = f.runtime.store.task(taskId).runId!;
  const pendingAsk = new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
   const child = spawn(process.execPath, [f.helperPath, runTicketPath(f, { id: runId }), 'ask'], { stdio: ['pipe', 'pipe', 'pipe'] });
   let out = '', err = '';
   child.stdout.on('data', chunk => { out += chunk; });
   child.stderr.on('data', chunk => { err += chunk; });
   child.on('error', reject);
   child.on('close', code => resolve({ code, out, err }));
   child.stdin.end(JSON.stringify({ question: 'May the worker extend this task by one budget step?', kind: 'budget', headline: 'Budget extension', choices: ['Extend', 'Finish now'] }));
  });
  await driveUntil(f, () => f.fake.calls.some(call => call.method === 'threads.send' && call.args.threadId === 'thr_planner'), 'the worker ask reached the BB planner thread', taskId, 200);
  // The parity table's other missing step: a worker question is delivered to the
  // task's planner thread, which on a BB-executed task is the BB thread, so nothing
  // reaches the T3 origin thread. The test asserts that gap rather than hiding it.
  assert.equal(f.t3.asks.length, 0, 'a worker question never reaches the T3 origin; it goes to the task planner thread on BB');
  const askEvent = f.runtime.store.eventsAll(taskId).find(event => event.kind === 'agent_ask');
  assert.ok(askEvent, 'the ask is recorded');
  const askId = askEvent!.detail.split(':')[0]!;
  await f.runtime.answerDelegatedQuestion({ questionId: `ns-agent-ask-${askId}`, answer: 'Extend', reason: 'Within the approved outcome', caller: formatAgentId(bbHost, 'thr_planner') });
  const receipt = JSON.parse(await pendingAsk.then(answer => { assert.equal(answer.code, 0, answer.err); return answer.out; })) as { status: string; answer?: string };
  assert.match(receipt.answer ?? '', /Extend/, 'the planner answer reached the waiting helper');

  // The worker reports, the independent reviewer reviews on BB, merge and closeout run there.
  const head = (await git(f.runtime.store.task(taskId).directory!, 'rev-parse', 'HEAD')).trim();
  const report = await helperReport(f, runTicketPath(f, { id: runId }), { status: 'ready_for_review', summary: 'Ready', prNumber: 7, head });
  assert.equal(report.code, 0, report.err);
  await driveUntil(f, () => Boolean(f.runtime.store.task(taskId).resolution.reviewerAgentId), 'independent reviewer launched on BB', taskId);
  const reviewer = f.runtime.store.runs(taskId).find(run => run.role === 'reviewer' && run.agentId === f.runtime.store.task(taskId).resolution.reviewerAgentId)!;
  assert.notEqual(reviewer.agentId, f.runtime.store.task(taskId).agentId, 'the reviewer is independent of the worker');
  assert.equal(f.fake.rows.get(reviewer.agentId!).environmentId, f.fake.rows.get(f.runtime.store.task(taskId).agentId!).environmentId, 'the reviewer shares the task environment');
  await reportAndWake(f, taskId, { eventId: randomUUID(), taskId, runId: reviewer.id, status: 'ready_to_merge', summary: 'Approved', reviewText: 'The change is right.', prNumber: 7, head }, ticketToken(f, reviewer));
  await driveUntil(f, () => f.runtime.store.task(taskId).phase === 'done', 'merged and closed on BB', taskId);
  assert.ok(f.merges.length, 'the BB adapter merged');
  await driveUntil(f, () => Boolean(f.fake.rows.get(f.runtime.store.task(taskId).agentId!)?.archivedAt), 'worker thread archived', taskId);
  assert.equal(f.fake.rows.get('thr_planner').archivedAt, null, 'the planner thread is never archived');
  await driveUntil(f, () => f.runtime.store.task(taskId).resolution.archivedWorkspaceIds.length === 1, 'workspace archived after its published-source proof', taskId);
  assert.equal(f.runtime.store.task(taskId).resolution.archivedWorkspaceIds.length, 1, 'the workspace was archived after its published-source proof');

  // Closeout: the completion notice reaches the T3 origin thread through its own host.
  await f.runtime.engine.resolution.deliverNotices();
  await driveUntil(f, () => f.t3.notifications.some(notification => notification.text.includes('Nucleus completion')), 'the closeout notice reached the T3 origin', taskId, 200);
  assert.ok(f.t3.notifications.some(notification => notification.text.includes('T3 dispatches BB')), 'the notice names the task');
 } finally { await f.close(); }
});

/**
 * Phase 7 of Spec 062 is the trial: a real repository, run beside Paseo, with the
 * three faults the phase's acceptance names. These drive the same real runtime as
 * the ordinary lifecycle above, so the evidence is the task's own record rather
 * than a projection of it: a plugin reload mid-task, a BB restart mid-task and a
 * host outage during observation each leave the task uncertain, and observation —
 * never a resend — is what moves it on. The isolated-server proof
 * (`effigy proof:bb:trial`) produces the host-level half of the same three faults.
 */
async function dispatchToWorker(f: Fixture, title: string): Promise<{ taskId: string; workerId: string }> {
 const result = leadSubmit.output.parse(await f.runtime.submitLead({
  repository: { origin: f.repo, path: f.repo }, title,
  body: `---\ntitle: ${title}\nqueue:\n  complexity: medium\n---\n\n## Outcome\n\nSynthetic phase 7 fault fixture.\n`,
  baseBranch: 'main', lanes: [], tags: [], agent: f.planner, note: 'Tom authorized this synthetic fixture',
 }));
 assert.ok('taskId' in result, JSON.stringify(result));
 f.runtime.store.update(result.taskId, { plannerAgentId: formatAgentId(bbHost, 'thr_planner') });
 await f.runtime.engine.dispatchTask(result.taskId, false);
 await driveUntil(f, () => Boolean(f.runtime.store.task(result.taskId).agentId), 'worker dispatched', result.taskId);
 const task = f.runtime.store.task(result.taskId);
 assert.ok(task.runId, 'the worker run carries a ticket');
 return { taskId: task.id, workerId: task.agentId! };
}

/** One sweep reconciles the run record from its effects; one observation pass reads the host. */
async function recoverByObservation(f: Fixture, taskId: string): Promise<void> {
 await f.runtime.engine.wakeTask(taskId).catch(() => {});
 await f.runtime.engine.resolution.observe();
}

/**
 * The worker's ordinary report after the fault, and the lane's answer to it. The
 * engine holds the review behind the worker's workspace release (its 60 s grace
 * after a live turn ends), so this asserts the accepted completion and the lane's
 * place, never the reviewer launch: the reviewer path is the ordinary lifecycle
 * tests' work and the recorded finding's.
 */
async function reportWorkerAfterFault(f: Fixture, taskId: string): Promise<void> {
 const task = f.runtime.store.task(taskId);
 assert.ok(task.runId, 'the worker run still carries its ticket');
 const head = (await git(task.directory!, 'rev-parse', 'HEAD')).trim();
 const report = await helperReport(f, runTicketPath(f, { id: task.runId }), { status: 'ready_for_review', summary: 'Ready after the fault', prNumber: 7, head });
 assert.equal(report.code, 0, report.err);
 for (let i = 0; i < 6; i++) await f.runtime.engine.resolution.observe();
 const reported = f.runtime.store.task(taskId);
 assert.ok(reported.completion, 'the faulted host accepted the worker report');
 assert.equal(reported.agentId, task.agentId, 'the accepted report names the same worker thread');
 assert.match(reported.reason, /waiting for the worker to release the workspace/, 'the review is held behind the worker release, not behind uncertainty about the host');
}

const spawnCount = (f: Fixture) => f.fake.calls.filter(c => c.method === 'threads.spawn').length;
/** Spawns by the role their plugin metadata names: a worker resend and a reviewer launch look different. */
const roleSpawns = (f: Fixture, role: string) => f.fake.calls.filter(c => c.method === 'threads.spawn'
  && (c.args.pluginMetadata?.nucleus as { role?: string } | undefined)?.role === role).length;
/** A live turn keeps its activity stamp current; a frozen row reads as stalled to the engine. */
const touchWorker = (f: Fixture, workerId: string) => { f.fake.rows.get(workerId).updatedAt = Date.now(); };

/**
 * The fault must land on live work, not on an idle thread: the fake row is active and
 * one observation pass records that turn, so the task, the run and the adapter all
 * agree a worker is mid-task when the next line takes the host away.
 */
async function startActiveTurn(f: Fixture, taskId: string, workerId: string): Promise<void> {
 const row = f.fake.rows.get(workerId);
 row.status = 'active';
 row.runtime.displayStatus = 'active';
 touchWorker(f, workerId);
 await f.runtime.engine.wakeTask(taskId).catch(() => {});
 await f.runtime.engine.resolution.observe();
 const task = f.runtime.store.task(taskId);
 assert.equal(task.agentActive, true, 'the worker turn is recorded as active before the fault');
 assert.equal(task.idleSince, null, 'a live turn has no idle stamp before the fault');
}

/** The worker's turn ends, observed: the ordinary reporting path from here on. */
async function endActiveTurn(f: Fixture, taskId: string, workerId: string): Promise<void> {
 const row = f.fake.rows.get(workerId);
 row.status = 'idle';
 row.runtime.displayStatus = 'idle';
 for (let i = 0; i < 2; i++) await f.runtime.engine.wakeTask(taskId).catch(() => {});
}

test('BB trial: a plugin reload mid-task defers observation and recovers the same run without resending the spawn', async t => {
 const f = await fixture(t);
 try {
  const { taskId, workerId } = await dispatchToWorker(f, 'Reload mid-task');
  assert.equal(spawnCount(f), 1, 'one worker thread exists before the reload');
  await startActiveTurn(f, taskId, workerId);
  const before = structuredClone(f.runtime.store.task(taskId));
  // A reload releases the old executor connection before the new declaration
  // arrives: the host is offline, by its own record, for that window.
  f.disconnectHost();
  await pause(50);
  const whileOffline = f.fake.calls.length;
  for (let i = 0; i < 4; i++) { touchWorker(f, workerId); await f.runtime.engine.wakeTask(taskId).catch(() => {}); await f.runtime.engine.resolution.observe(); }
  assert.equal(f.fake.calls.length, whileOffline, 'no host read or write is attempted while no executor holds the claim');
  const deferred = f.runtime.store.task(taskId);
  assert.equal(deferred.phase, 'working');
  assert.equal(deferred.agentId, workerId);
  assert.equal(deferred.completion, null);
  assert.equal(deferred.agentActive, before.agentActive);
  assert.equal(deferred.idleSince, before.idleSince, 'a reload never reads a live run as idle');
  assert.equal(deferred.lastObservedAt, before.lastObservedAt, 'an unread run records no observation');
  // The same plugin comes back: its claim is re-taken and the run is observed again.
  f.reconnectHost();
  await recoverByObservation(f, taskId);
  assert.equal(spawnCount(f), 1, 'the spawn was not resent after the reload');
  assert.ok(f.fake.calls.slice(whileOffline).some(c => c.method === 'threads.list' || c.method === 'threads.get'), 'the run was recovered by a fresh observation');
  const recovered = f.runtime.store.task(taskId);
  assert.notEqual(recovered.lastObservedAt, before.lastObservedAt, 'the recovered observation is recorded');
  assert.equal(recovered.completion, null, 'the reload does not invent a completion');
  assert.equal(recovered.agentActive, true, 'the same live turn is read as active after the reload');
  assert.equal(recovered.idleSince, null, 'the reload never stamps the live turn idle');
  await endActiveTurn(f, taskId, workerId);
  await reportWorkerAfterFault(f, taskId);
  assert.equal(roleSpawns(f, 'worker'), 1, 'the reload never spawned a second worker');
 } finally { await f.close(); }
});

test('BB trial: a BB restart mid-task keeps the recorded environment and recovers by observation', async t => {
 const f = await fixture(t);
 try {
  const { taskId, workerId } = await dispatchToWorker(f, 'Restart mid-task');
  const task = f.runtime.store.task(taskId);
  const handles = Object.values(f.runtime.store.getMeta<Record<string, { environmentId?: string }>>('bbWorkspaces') ?? {});
  const environmentId = handles[0]?.environmentId;
  assert.ok(environmentId, 'the workspace handle recorded its environment before the restart');
  assert.equal(f.fake.rows.get(workerId).environmentId, environmentId);
  // Mid-task: the thread is running its turn when the server goes away.
  await startActiveTurn(f, taskId, workerId);
  const before = structuredClone(f.runtime.store.task(taskId));
  f.disconnectHost();
  await pause(50);
  const callsAtOutage = f.fake.calls.length;
  await f.runtime.engine.wakeTask(taskId).catch(() => {});
  assert.equal(f.fake.calls.length, callsAtOutage, 'nothing is read while the restarting host has no executor');
  assert.equal(f.runtime.store.task(taskId).lastObservedAt, before.lastObservedAt);
  // The restart: BB's rows and the service's recorded handle both survive, and the
  // plugin re-declares with no memory of its own.
  const restarted = f.restartAdapter();
  f.reconnectHost(restarted);
  await recoverByObservation(f, taskId);
  const observed = await restarted.observe(workerId);
  assert.equal(observed.workspaceId, task.workspaceId, 'the restarted plugin resolves the same recorded run workspace');
  assert.equal(observed.active, true, 'the live BB turn is read as active, not idle, after the restart');
  assert.equal(spawnCount(f), 1, 'the restart never resends the spawn');
  const recovered = f.runtime.store.task(taskId);
  assert.equal(recovered.completion, null);
  assert.equal(recovered.idleSince, null, 'the restarted observation does not read the active turn as idle');
  assert.notEqual(recovered.lastObservedAt, before.lastObservedAt, 'the recovered observation is recorded');
  // The worker's ordinary report still lands on the same run and ticket, so the
  // restarted host never forced a second spawn or a new ticket.
  await endActiveTurn(f, taskId, workerId);
  const head = (await git(task.directory!, 'rev-parse', 'HEAD')).trim();
  const report = await helperReport(f, runTicketPath(f, { id: task.runId! }), { status: 'ready_for_review', summary: 'Ready after a restart', prNumber: 7, head });
  assert.equal(report.code, 0, report.err);
  assert.equal(f.runtime.store.task(taskId).runId, task.runId, 'the restarted task kept its run ticket');
  assert.equal(roleSpawns(f, 'worker'), 1, 'the accepted report never resends the worker spawn');
  // The completion is recorded and the review waits for the worker's lease; the
  // lifecycle from here is the ordinary one the first test drives end to end.
  assert.ok(f.runtime.store.task(taskId).completion, 'the restarted host accepted the worker report');
  for (let i = 0; i < 6; i++) await f.runtime.engine.resolution.observe();
  assert.match(f.runtime.store.task(taskId).reason, /waiting for the worker to release the workspace/, 'the lane holds on the worker release, not on host uncertainty');
 } finally { await f.close(); }
});

test('BB trial: a host outage during observation leaves the task untouched and observation recovers it', async t => {
 const f = await fixture(t);
 try {
  const { taskId, workerId } = await dispatchToWorker(f, 'Outage during observation');
  await startActiveTurn(f, taskId, workerId);
  const before = structuredClone(f.runtime.store.task(taskId));
  // The outage: the host is gone while the worker is mid-turn.
  f.disconnectHost();
  await pause(50);
  const callsAtOutage = f.fake.calls.length;
  for (let i = 0; i < 3; i++) { touchWorker(f, workerId); await f.runtime.engine.wakeTask(taskId).catch(() => {}); await f.runtime.engine.resolution.observe(); }
  assert.equal(f.fake.calls.length, callsAtOutage, 'an observation during the outage reads nothing from the host');
  const during = f.runtime.store.task(taskId);
  assert.equal(during.phase, before.phase, 'the lane stays where it is');
  assert.equal(during.reason, before.reason);
  assert.equal(during.agentId, before.agentId);
  assert.equal(during.completion, null, 'the outage is never a run result');
  assert.equal(during.agentActive, before.agentActive);
  assert.equal(during.idleSince, before.idleSince, 'an unreadable run is never read as idle');
  assert.equal(during.lastObservedAt, before.lastObservedAt, 'no observation is recorded from the outage');
  // The host returns; the worker's ordinary report recovers the run by observation.
  f.reconnectHost();
  await recoverByObservation(f, taskId);
  assert.equal(spawnCount(f), 1, 'the outage never resends the spawn');
  const recovered = f.runtime.store.task(taskId);
  assert.notEqual(recovered.lastObservedAt, before.lastObservedAt, 'the host is observed again once it is back');
  assert.equal(recovered.agentActive, true, 'the live turn survived the outage and is read as active');
  assert.equal(recovered.idleSince, null, 'the outage never stamps the live turn idle');
  await endActiveTurn(f, taskId, workerId);
  await reportWorkerAfterFault(f, taskId);
  assert.equal(roleSpawns(f, 'worker'), 1, 'the outage never spawned a second worker');
  assert.equal(f.fake.rows.get(workerId).archivedAt, null, 'the worker thread stays visible for the review');
 } finally { await f.close(); }
});
