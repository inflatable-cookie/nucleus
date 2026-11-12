import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { QueueRuntime } from '../service/runtime-owner';
import { git } from '../core/git/index';
import { leadSubmit, type Profile, type Run } from '../shared/contracts';
import { formatAgentId } from '../shared/agent-identity';
import { fakeAdapter } from './support/fakes';
import { plannerTicketKey } from '../core/dispatch/participant-tickets';
import { digest } from '../core/store/store';
import { t3Fake, STAMP } from './support/t3code-fake';
import { createHost, createAdapter } from '../hosts/t3code';
import { HostPolicies } from '../core/host/host-policies';
import type { HostPolicyConstructor, Adapter as HostAdapter } from '../core/host';

const Policy = HostPolicies as unknown as HostPolicyConstructor;
const paseoHost = 'paseo:primary', t3Host = 't3code:lifecycle';
const base = 'd'.repeat(40);
const prUrl = 'https://github.com/example/lifecycle/pull/7';

interface Fixture {
  runtime: QueueRuntime;
  repo: string;
  root: string;
  server: Awaited<ReturnType<typeof t3Fake>>;
  t3: HostAdapter;
  planner: string;
  ticket: { participantId: string; token: string };
  helperPath: string;
  merges: string[];
  close: () => Promise<void>;
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
  assert.ok(ready(), `${label} after ${passes} passes (phase ${f.runtime.store.task(taskId ?? '').phase}: ${f.runtime.store.task(taskId ?? '').reason})`);
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 't3-lifecycle-')));
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
  const paseoAdapter = fakeAdapter({
    client: { isConnected: true },
    hostId: paseoHost, socketPath, helperPath,
    connect: async () => {}, close: async () => {},
    catalog: async () => ({ providers: [] }),
    validate: async (task: { planningCommit: string }) => task.planningCommit,
    verifyWorkspace: async (_task: unknown, directory: string) => directory,
    createWorkspace: async () => { throw new Error('the T3-bound task must never use Paseo'); },
    createAgent: async () => { throw new Error('Paseo must never create this task\'s worker'); },
    observe: async (id: string) => ({ id, workspaceId: 'planner-ws', status: 'idle', active: false, permissions: false, error: '' }),
    originAgent: async (id: string) => id === 'planner' ? { id, workspaceId: 'planner-ws', title: 'Planner', archived: false } : null,
    notify: async () => {},
    askPlanner: async () => null,
    archiveAgent: async () => {},
    findOpenBranchPr: async () => [],
    verifyPr: async () => ({ url: prUrl, head: 'unused', repository: 'example/lifecycle', headRepository: 'example/lifecycle' }),
  }) as HostAdapter;

  const runtime = new QueueRuntime({ dataDir, adapterFactory: () => paseoAdapter, timers: false });
  await runtime.started;
  await runtime.bootstrap;

  // The fake Nightly transport: real HTTP ticket exchange, real WebSocket RPC,
  // real Nightly config and command shapes (nucleus#1139).
  const server = await t3Fake(t, repo);
  const host = createHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', probeThreadId: 'synthetic-probe',
    statePath: join(dataDir, 'hosts', 't3code.json'), timeoutMs: 5_000 });
  await host.connect();
  const t3 = createAdapter(Policy, host, { socketPath, helperPath });
  // The forge is a fixture: the lifecycle proof is about the T3 paths, so the
  // PR and merge gates answer locally like every other lifecycle test.
  const forge = t3 as unknown as Record<string, unknown>;
  const merges: string[] = [];
  // The forge echoes the worktree's live head: the completion head, the run
  // heads and every gate answer stay the same real commit, so the closeout
  // content proofs hold against the local worktree.
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

  runtime.hostRegistry.connect(t3Host, 't3code-endpoint', { adapter: t3, admission: runtime.admission });
  runtime.store.putRepository({ origin: repo, path: repo }, null, '', null, null, null, undefined, undefined, 't3code');
  runtime.store.upsertProject({ key: 'lifecycle', name: 'Lifecycle', repositories: [{ origin: repo, path: repo }] });
  const planner = formatAgentId(paseoHost, 'planner');
  runtime.store.setProjectPlanner({ key: 'lifecycle', agentId: planner, setBy: 'operator (board)' });
  // The worker profile carries the trial's thinking level; the independent
  // reviewer's model lists no option descriptors at all.
  runtime.store.setProfiles([
    { id: 'sol-grind', name: 'Sol grind', provider: 'synthetic-provider', model: 'synthetic-model', thinkingOptionId: 'high', notes: '' },
    { id: 'luna-review', name: 'Luna review', provider: 'synthetic-provider', model: 'synthetic-model-2', notes: '' },
  ]);
  runtime.store.setMeta('pool', [
    { profileId: 'sol-grind', enabled: true, group: 'sol', weight: 2, roles: ['worker' as const], scopes: ['general' as const], capability: 'medium' },
    { profileId: 'luna-review', enabled: true, group: 'luna', weight: 2, roles: ['reviewer' as const], scopes: ['general' as const], capability: 'medium' },
  ]);
  runtime.store.setMeta('paused', false);
  await runtime.engine.refresh();

  // The planner's participant ticket, the way the runtime issues it.
  const participantId = randomUUID(), token = 'planner-participant-token';
  const plannerRecord = runtime.store.projectByKey('lifecycle')!.planner!;
  runtime.store.setMeta(`plannerParticipantId:${participantId}`, 'lifecycle');
  runtime.store.setMeta(plannerTicketKey('lifecycle'), { participantId, projectKey: 'lifecycle', agentId: planner,
    setAt: plannerRecord.setAt, hostId: paseoHost, nativeAgentId: 'planner', tokenHash: digest(token), path: '/unused', delivery: 'self' });
  const ticketPath = join(root, 'planner-ticket.json');
  writeFileSync(ticketPath, JSON.stringify({ socketPath, participantId, token }), { mode: 0o600 });

  const close = async () => {
    await runtime.drain();
    host.close();
  };
  return { runtime, repo, root, server, t3, planner, ticket: { participantId, token }, helperPath, merges, close };
}

test('an ordinary task runs its whole lifecycle on T3: thinking level, helper report, planner tell, review, revision, merge, closeout, archive', async t => {
  const f = await fixture(t);
  try {
    // Promotion onto the T3 host.
    const result = leadSubmit.output.parse(await f.runtime.submitLead({
      repository: { origin: f.repo, path: f.repo }, title: 'Lifecycle on T3',
      body: '---\ntitle: Lifecycle on T3\nqueue:\n  complexity: medium\n  notifyOriginOnCloseout: true\n  profileRequests:\n    worker:\n      profileId: sol-grind\n      reason: The trial runs grind work on the grind profile\n---\n\n## Outcome\n\nRun the whole ordinary lifecycle on T3.\n',
      baseBranch: 'main', lanes: [], tags: [], agent: f.planner, note: 'Tom authorized this fixture',
    }));
    assert.ok('taskId' in result, JSON.stringify(result));
    let task = f.runtime.store.task(result.taskId);
    assert.equal(task.hostId, t3Host);

    // Dispatch: workspace registration and the worker launch on the real T3 adapter.
    await f.runtime.engine.dispatchTask(task.id, false);
    await driveUntil(f, () => Boolean(f.runtime.store.task(task.id).agentId), 'worker dispatched');
    task = f.runtime.store.task(task.id);
    assert.equal(task.phase, 'working');
    assert.equal(task.profile?.thinkingOptionId, 'high', 'the worker carries the profile thinking level');
    const launches = f.server.commands.filter(command => command.method === 'orchestration.launchThread');
    assert.equal(launches.length, 1, 'exactly one worker launch');
    // The profile's thinking level rides the nightly's model options.
    assert.deepEqual(launches[0]!.modelSelection.options, [{ id: 'reasoningEffort', value: 'high' }]);
    const workerThreadId = task.agentId!;
    assert.notEqual(launches[0]!.threadId, 'synthetic-probe');

    // A planner tell arrives mid-run: the worker thread is live and the message queues behind its turn.
    const workerProjection = f.server.threads.get(workerThreadId)!;
    workerProjection.runs = [{ id: 'worker-run-1', status: 'running', startedAt: STAMP }];
    const tell = await f.runtime.engine.resolution.agentMessage({
      eventId: randomUUID(), participantId: f.ticket.participantId,
      to: { task: task.id, role: 'worker' }, text: 'Planner: keep the change set narrow.',
    }, f.ticket.token);
    assert.equal(tell.status, 'delivered');
    const tellCommand = f.server.commands.filter(command => command.type === 'message.dispatch').at(-1)!;
    assert.equal(tellCommand.threadId, workerThreadId);
    assert.deepEqual(tellCommand.dispatchMode, { type: 'queue_after_active' });
    assert.match(tellCommand.text, /Queue message from the lifecycle planner/);
    workerProjection.runs = [];

    // The worker reports ready for review through the packaged helper, with the
    // real worktree head so the closeout content proofs hold.
    const worktreeHead = (await git(task.directory!, 'rev-parse', 'HEAD')).trim();
    const workerTicket = runTicketPath(f, { id: task.runId! });
    const workerReport = await helperReport(f, workerTicket, {
      status: 'ready_for_review', summary: 'Change set ready', prNumber: 7, head: worktreeHead,
    });
    assert.equal(workerReport.code, 0, workerReport.err);

    // The reviewer launches on T3; a profile without a thinking level sends no options.
    await driveUntil(f, () => Boolean(f.runtime.store.task(task.id).resolution.reviewerAgentId), 'reviewer launched', task.id);
    task = f.runtime.store.task(task.id);
    const reviewerThreadId = task.resolution.reviewerAgentId!;
    const reviewerLaunch = f.server.commands.filter(command => command.method === 'orchestration.launchThread')[1]!;
    assert.equal(reviewerLaunch.threadId, reviewerThreadId);
    assert.equal(reviewerLaunch.modelSelection.model, 'synthetic-model-2');
    assert.equal(reviewerLaunch.modelSelection.options, undefined);

    // The review verdict requests changes; a revision round is reserved.
    const reviewerRun = f.runtime.store.runs(task.id).find(run => run.role === 'reviewer' && run.agentId === reviewerThreadId)!;
    const reviewerProjection = f.server.threads.get(reviewerThreadId)!;
    reviewerProjection.runs.push({ id: 'nightly-review-round-1', status: 'completed', startedAt: STAMP });
    // The T3 write can fail after the Nucleus report receipt is committed. That
    // uncertainty is adapter-owned and must not reject or hold the task report.
    f.server.controls.refuseMutation = true;
    await reportAndWake(f, task.id, {
      eventId: randomUUID(), taskId: task.id, runId: reviewerRun.id, status: 'changes_required',
      summary: 'One finding', reviewText: 'Tighten the change set.', reviewResponsibility: 'author',
      prNumber: 7, head: worktreeHead,
    }, ticketToken(f, reviewerRun));
    f.server.controls.refuseMutation = false;
    assert.equal(f.runtime.store.run(reviewerRun.id)?.completion?.status, 'changes_required', 'the task accepts the reviewer report despite a failed settle');
    assert.equal(reviewerProjection.thread.settledOverride, null, 'the refused settle made no T3 change');
    await (f.t3 as unknown as { reconcileReportedSettlements(): Promise<void> }).reconcileReportedSettlements();
    assert.equal(reviewerProjection.thread.settledOverride, 'settled', 'the durable intent retries on reconciliation');
    await driveUntil(f, () => f.runtime.store.runs(task.id).some(run => run.role === 'revision'), 'revision reserved', task.id);
    const revisionRun = f.runtime.store.runs(task.id).findLast(run => run.role === 'revision');
    assert.ok(revisionRun, 'revision reserved');
    // The retained worker was addressed for the revision on its own thread.
    await driveUntil(f, () => f.server.commands.some(command => command.type === 'message.dispatch'
      && command.threadId === workerThreadId && command !== tellCommand), 'revision sent to the retained worker', task.id);

    // The worker reports the findings addressed through the revision run's own
    // ticket; the retained reviewer takes round two.
    await reportAndWake(f, task.id, {
      eventId: randomUUID(), taskId: task.id, runId: revisionRun.id, status: 'ready_for_review',
      summary: 'Findings addressed', prNumber: 7, head: worktreeHead,
    }, ticketToken(f, revisionRun));
    await driveUntil(f, () => f.server.commands.some(command => command.type === 'message.dispatch'
      && command.threadId === reviewerThreadId), 'retained reviewer consulted for round two', task.id);
    assert.equal(reviewerProjection.thread.settledOverride, 'active', 'the retained reviewer is explicitly unsettled before its next round');

    // The verdict accepts: the reviewer reports ready to merge at the same head.
    const reviewerRunAfterRound = f.runtime.store.runs(task.id).find(run => run.role === 'reviewer' && run.agentId === reviewerThreadId && !run.released)
      ?? f.runtime.store.runs(task.id).find(run => run.role === 'reviewer' && run.agentId === reviewerThreadId)!;
    reviewerProjection.runs.push({ id: 'nightly-review-round-2', status: 'completed', startedAt: STAMP });
    await reportAndWake(f, task.id, {
      eventId: randomUUID(), taskId: task.id, runId: reviewerRunAfterRound.id, status: 'ready_to_merge',
      summary: 'Findings addressed; approves', reviewText: 'The findings are addressed.',
      prNumber: 7, head: worktreeHead,
    }, ticketToken(f, reviewerRunAfterRound));
    assert.equal(reviewerProjection.thread.settledOverride, 'settled', 'the retained reviewer is settled after its next report');

    // The closeout: this queue control closes Nucleus-owned at the merged
    // commit, so a coordinator closeout thread is optional; the task reaches
    // done at the synchronized integration commit either way.
    let closeoutRun: Run | undefined;
    await driveUntil(f, () => {
      closeoutRun = f.runtime.store.runs(task.id).findLast(run => run.role === 'closeout');
      const latest = f.runtime.store.task(task.id);
      return Boolean(closeoutRun) || (latest.phase === 'done' && Boolean(latest.resolution.mergedCommit));
    }, 'closeout reached', task.id);
    if (closeoutRun) {
      await reportAndWake(f, task.id, {
        eventId: randomUUID(), taskId: task.id, runId: closeoutRun.id, status: 'closed',
        summary: 'Merged and closed', head: worktreeHead,
      }, ticketToken(f, closeoutRun));
    }
    await driveUntil(f, () => {
      const latest = f.runtime.store.task(task.id);
      return latest.phase === 'done' && Boolean(latest.resolution.mergedCommit);
    }, 'task merged and done', task.id);
    assert.ok(f.merges.length >= 1, 'the merge gate ran');

    // Closeout archive: threads archived, the native project archived once, observed positively.
    const workspaceId = f.runtime.store.task(task.id).workspaceId!;
    await driveUntil(f, () => f.runtime.store.task(task.id).resolution.archivedWorkspaceIds.includes(workspaceId), 'workspace archived', task.id);
    assert.equal(await (f.t3 as unknown as { taskWorkspaceArchived(id: string): Promise<boolean> }).taskWorkspaceArchived(workspaceId), true);
    const archiveCommands = f.server.commands.filter(command => command.type === 'thread.archive');
    assert.ok(archiveCommands.some(command => command.threadId === workerThreadId), 'the worker thread was archived');
    assert.ok(archiveCommands.some(command => command.threadId === reviewerThreadId), 'the reviewer thread was archived');
    const projectArchive = f.server.commands.filter(command => command.method === 'projects.mutate' && command.type === 'project.update' && command.archived === true);
    assert.equal(projectArchive.length, 1, 'the native project archive was sent exactly once');
    assert.equal(projectArchive[0]!.projectId, 'synthetic-project');
  } finally { await f.close(); }
});
