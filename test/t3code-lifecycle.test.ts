import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { QueueRuntime } from '../service/runtime-owner';
import { git } from '../core/git/index';
import { leadSubmit, taskSchema, submissionSchema, type Profile, type Run, type Task } from '../shared/contracts';
import { formatAgentId } from '../shared/agent-identity';
import { fakeAdapter } from './support/fakes';
import { plannerTicketKey } from '../core/dispatch/participant-tickets';
import { digest } from '../core/store/store';
import { t3Fake, threadProjection, STAMP } from './support/t3code-fake';
import { storedT3Labels } from './support/t3code-labels';
import { WIRE_LABEL_KEYS } from '../shared/wire-labels';
import { createHost, createAdapter } from '../hosts/t3code';
import { archiveFinishedThreads } from '../core/workspaces/thread-archive';
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
  host: ReturnType<typeof createHost>;
  t3: HostAdapter;
  planner: string;
  ticket: { participantId: string; token: string };
  helperPath: string;
  merges: string[];
  /** Every identity the default (Paseo) host was asked to observe. */
  paseoObserves: string[];
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
  const task = taskId ? f.runtime.store.task(taskId) : null;
  assert.ok(ready(), `${label} after ${passes} passes${task ? ` (phase ${task.phase}: ${task.reason})` : ''}`);
}

async function createLiveSibling(f: Fixture, owner: Task): Promise<{ task: Task; workspaceId: string }> {
  const directory = join(f.root, 'sibling-worktree');
  await git(f.repo, 'worktree', 'add', '--detach', directory, 'main');
  const ownerWorkspace = f.host.state.read().workspaces[owner.workspaceId!]!;
  const workspace = await f.host.createWorkspace({ title: 'Sibling task workspace', requestId: 'sibling-workspace', directory,
    project: { projectId: ownerWorkspace.projectId, workspaceRoot: f.repo } });
  assert.equal(f.host.state.read().workspaces[workspace.id]?.projectId, ownerWorkspace.projectId, 'both task handles share the same project registration');
  const head = (await git(directory, 'rev-parse', 'HEAD')).trim();
  const initial = f.runtime.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Live sibling task',
    repoPath: f.repo, planningCommit: head, handoffPath: 'sibling.md', originAgentId: f.planner }), t3Host, 'Sibling handoff', head);
  const runId = randomUUID();
  const worker = await f.host.createAgent({ workspaceId: workspace.id, profile: owner.profile!, title: 'Sibling worker', taskNumber: 998,
    mcpBindingPath: null, attempt: () => ({ requestId: runId, prompt: 'Continue the sibling task',
      labels: storedT3Labels('worker', { taskId: initial.id, runId }), environment: {} }) });
  f.server.threads.get(worker.id)!.runs = [{ id: runId, status: 'running', startedAt: STAMP }];
  const task = f.runtime.store.update(initial.id, { phase: 'working', workspaceId: workspace.id, directory, planningBase: head,
    agentId: worker.id, agentIntent: true, agentActive: true, runId, profile: owner.profile, profileGroup: 'sol',
    resolution: { ...initial.resolution, currentRunId: runId } });
  f.runtime.store.putRun({ id: runId, taskId: task.id, hostId: t3Host, role: 'revision', generation: task.coordinatorGeneration,
    head, base: head, agentId: worker.id, workspaceId: workspace.id, profile: owner.profile!, profileGroup: 'sol', status: 'running',
    createdAt: STAMP, lastObservedAt: STAMP, active: true, idleSince: null, completion: null, released: false });
  return { task, workspaceId: workspace.id };
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
    createWorkspace: async () => { throw new Error('the T3-bound task must never use Paseo'); },
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
    // reviewer's identity before sending; reaching it with a T3 thread's identity
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

  // The fake Nightly transport: real HTTP ticket exchange, real WebSocket RPC,
  // real Nightly config and command shapes (nucleus#1139).
  const server = await t3Fake(t, repo);
  const host = createHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', probeThreadId: 'synthetic-probe',
    statePath: join(dataDir, 'hosts', 't3code.json'), timeoutMs: 5_000 });
  await host.connect();
  // Use a canonical provider with the fake Nightly's native model/option shape.
  // The runtime now validates Nucleus vocabulary before selecting any profile.
  const config = await host.rpc.call('server.getConfig', {}) as { providers: Array<Record<string, unknown>> };
  server.controls.providers = config.providers.map(provider => ({ ...provider, instanceId: 'codex', displayName: 'Codex' }));
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
    { id: 'sol-grind', name: 'Sol grind', provider: 'codex', model: 'synthetic-model', thinkingOptionId: 'high', notes: '' },
    { id: 'luna-review', name: 'Luna review', provider: 'codex', model: 'synthetic-model-2', notes: '' },
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
  return { runtime, repo, root, server, host, t3, planner, ticket: { participantId, token }, helperPath, merges, paseoObserves, close };
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

    // A second live task has its own worktree handle under the same T3 project.
    const { task: sibling, workspaceId: siblingWorkspaceId } = await createLiveSibling(f, task);
    assert.equal(sibling.phase, 'working', 'the sibling task is live before closeout');
    assert.equal(await f.host.workspaceAvailable(siblingWorkspaceId), true, 'the sibling worktree handle is available');

    // A planner tell arrives mid-run: the worker thread is live and the message steers into its turn.
    const workerProjection = f.server.threads.get(workerThreadId)!;
    workerProjection.runs = [{ id: 'worker-run-1', status: 'running', startedAt: STAMP }];
    const tell = await f.runtime.engine.resolution.agentMessage({
      eventId: randomUUID(), participantId: f.ticket.participantId,
      to: { task: task.id, role: 'worker' }, text: 'Planner: keep the change set narrow.',
    }, f.ticket.token);
    assert.equal(tell.status, 'delivered');
    const tellCommand = f.server.commands.filter(command => command.type === 'message.dispatch').at(-1)!;
    assert.equal(tellCommand.threadId, workerThreadId);
    assert.deepEqual(tellCommand.dispatchMode, { type: 'steer_active', targetRunId: 'worker-run-1' });
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
    const reviewerLaunch = f.server.commands.find(command => command.method === 'orchestration.launchThread' && command.threadId === reviewerThreadId)!;
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

    // Closeout cleanup (nucleus#1155): the worker thread is archived, every
    // support thread is removed, and only the task worktree handle is archived.
    const workspaceId = f.runtime.store.task(task.id).workspaceId!;
    await driveUntil(f, () => f.runtime.store.task(task.id).resolution.archivedWorkspaceIds.includes(workspaceId), 'workspace archived', task.id);
    assert.equal(f.runtime.store.task(sibling.id).phase, 'working', 'the sibling task stays live');
    assert.equal(await f.host.workspaceAvailable(siblingWorkspaceId), true, 'the sibling worktree handle stays available');
    assert.equal(await (f.t3 as unknown as { taskWorkspaceArchived(id: string): Promise<boolean> }).taskWorkspaceArchived(workspaceId), true);
    const archiveCommands = f.server.commands.filter(command => command.type === 'thread.archive');
    assert.ok(archiveCommands.some(command => command.threadId === workerThreadId), 'the worker thread was archived');
    assert.equal(archiveCommands.some(command => command.threadId === reviewerThreadId), false, 'a support thread is never archived');
    const removals = f.server.commands.filter(command => command.type === 'thread.delete');
    assert.equal(removals.filter(command => command.threadId === reviewerThreadId).length, 1, 'the reviewer thread was removed once');
    assert.equal(removals.length, new Set(removals.map(command => command.threadId)).size, 'each support thread is removed once');
    for (const command of removals) {
      assert.notEqual(command.threadId, workerThreadId, 'the worker thread is archived, never removed');
      assert.equal(command.onlyIfUnused, undefined, 'the removal is the real one, not the nightly no-op shape');
    }
    assert.equal(f.server.threads.get(reviewerThreadId)!.thread.deletedAt, STAMP);
    const projectArchive = f.server.commands.filter(command => command.method === 'projects.mutate' && command.type === 'project.update' && command.archived === true);
    assert.equal(projectArchive.length, 0, 'the shared native project registration stays untouched');
    // Every host call this lifecycle made named the task's own agents: the
    // default host was never asked about one (#1154).
    assert.deepEqual(f.paseoObserves.filter(id => id !== 'planner'), [], 'no task agent was read on the default host');
  } finally { await f.close(); }
});

/** The worker thread's completed turn, as the nightly reports it after a handover. */
const completedWorkerRun = (status = 'completed') => [{ id: 'worker-run-1', status, startedAt: STAMP }];

/** Promote one T3-bound task and dispatch its worker. */
async function taskWithWorker(f: Fixture): Promise<{ taskId: string; head: string; workerThreadId: string; workerRunId: string }> {
  const result = leadSubmit.output.parse(await f.runtime.submitLead({
    repository: { origin: f.repo, path: f.repo }, title: 'Reviewer continues on T3',
    body: '---\ntitle: Reviewer continues on T3\nqueue:\n  complexity: medium\n  profileRequests:\n    worker:\n      profileId: sol-grind\n      reason: The trial runs grind work on the grind profile\n---\n\n## Outcome\n\nContinue the retained reviewer on its own host.\n',
    baseBranch: 'main', lanes: [], tags: [], agent: f.planner, note: 'Tom authorized this fixture',
  }));
  assert.ok('taskId' in result, JSON.stringify(result));
  const taskId = result.taskId;
  await f.runtime.engine.dispatchTask(taskId, false);
  await driveUntil(f, () => Boolean(f.runtime.store.task(taskId).agentId), 'worker dispatched', taskId);
  const task = f.runtime.store.task(taskId);
  const head = (await git(task.directory!, 'rev-parse', 'HEAD')).trim();
  return { taskId, head, workerThreadId: task.agentId!, workerRunId: task.runId! };
}

/** Take the task's worker through its handover and as far as a launched reviewer. */
async function taskWithReviewer(f: Fixture): Promise<{ taskId: string; head: string; workerThreadId: string; workerRunId: string; reviewerThreadId: string; reviewerRun: Run }> {
  const { taskId, head, workerThreadId, workerRunId } = await taskWithWorker(f);
  // The worker's own turn, ended by the time its handover is accepted.
  f.server.threads.get(workerThreadId)!.runs = completedWorkerRun();
  const workerReport = await helperReport(f, runTicketPath(f, { id: workerRunId }), {
    status: 'ready_for_review', summary: 'Change set ready', prNumber: 7, head,
  });
  assert.equal(workerReport.code, 0, workerReport.err);
  await f.runtime.engine.wakeTask(taskId).catch(() => {});
  await driveUntil(f, () => Boolean(f.runtime.store.task(taskId).resolution.reviewerAgentId), 'reviewer launched', taskId);
  const reviewerThreadId = f.runtime.store.task(taskId).resolution.reviewerAgentId!;
  const reviewerRun = f.runtime.store.runs(taskId).find(run => run.role === 'reviewer' && run.agentId === reviewerThreadId)!;
  return { taskId, head, workerThreadId, workerRunId, reviewerThreadId, reviewerRun };
}

function releasedRecoveryRun(taskId: string, source: Run, agentId: string, runId = randomUUID()): Run {
  return { ...source, id: runId, taskId, role: 'recovery', agentId, status: 'finished', released: true, active: false,
    completion: { eventId: randomUUID(), taskId, runId, status: 'recovered', summary: 'Recovery action was accepted',
      coordinatorAction: { verb: 'restart', reason: 'Synthetic recorded completion for settlement coverage' } } };
}

test('the sweep settles a recovery thread released from recorded completion without a callback report', async t => {
  const f = await fixture(t);
  try {
    const { taskId, reviewerThreadId, reviewerRun } = await taskWithReviewer(f);
    const projection = f.server.threads.get(reviewerThreadId)!;
    projection.runs.push({ id: 'nightly-recovery-run-1', status: 'completed', startedAt: STAMP });
    const recoveryRun = releasedRecoveryRun(taskId, reviewerRun, reviewerThreadId);
    f.runtime.store.putRun(recoveryRun);

    await f.runtime.engine.auditPass(false);

    const settle = f.server.commands.find(command => command.type === 'thread.settle' && command.threadId === reviewerThreadId);
    assert.equal(settle?.expectedLatestRunId, 'nightly-recovery-run-1', 'the sweep uses T3 projection RunId, not the Nucleus run id');
    assert.equal(projection.thread.settledOverride, 'settled');
  } finally { await f.close(); }
});

test('a slow T3 thread read refuses the retained-worker restart and names the timeout', async t => {
  const f = await fixture(t);
  try {
    const { taskId } = await taskWithWorker(f);
    // The retained worker the owner restart continues: the exact shape the
    // incident reported, on its own T3 thread.
    f.runtime.store.update(taskId, { phase: 'changes_requested', reason: 'The planner asked for the continuation' });
    const task = f.runtime.store.task(taskId);
    assert.ok(task.agentId && task.profile, 'the worker thread is retained');
    // A subscribeThread that outlives the host's read bound: the recorded
    // incident failure, end to end through observe and the owner verb.
    f.server.controls.slowSnapshotMs = 6_000; // the fixture host's read bound is 5 000 ms
    await assert.rejects(
      f.runtime.taskControl({ action: 'restart', taskId, version: task.version, role: 'worker',
        reason: 'Continue the retained worker', caller: f.planner }),
      /The retained worker cannot be observed \(T3RpcError timeout orchestration\.subscribeThread: T3Code timeout: orchestration\.subscribeThread\); restore observation before restarting\. No continuation was sent/);
    assert.equal(f.server.commands.filter(command => command.type === 'message.dispatch').length, 0,
      'a refused restart sends no continuation');
    assert.equal(f.runtime.store.task(taskId).phase, 'changes_requested', 'the refusal changed nothing');
  } finally { f.server.controls.slowSnapshotMs = 0; await f.close(); }
});

test('a support thread stays active during a later run and settles that run when it finishes', async t => {
  const f = await fixture(t);
  try {
    const { taskId, reviewerThreadId, reviewerRun } = await taskWithReviewer(f);
    const projection = f.server.threads.get(reviewerThreadId)!;
    projection.runs.push({ id: 'nightly-recovery-run-1', status: 'completed', startedAt: STAMP });
    f.runtime.store.putRun(releasedRecoveryRun(taskId, reviewerRun, reviewerThreadId));
    await f.runtime.engine.auditPass(false);
    assert.equal(projection.thread.settledOverride, 'settled');

    // The retained thread wakes for its next fault through a follow-up message,
    // which explicitly unsettles it first; a later run is never settled live.
    await f.t3.notify!(reviewerThreadId, 'retained-recovery-round-2', 'Second fault into the retained thread');
    assert.equal(projection.thread.settledOverride, 'active');
    projection.runs.push({ id: 'nightly-recovery-run-2', status: 'running', startedAt: STAMP });
    f.runtime.store.putRun(releasedRecoveryRun(taskId, reviewerRun, reviewerThreadId));
    const before = f.server.commands.filter(command => command.type === 'thread.settle' && command.threadId === reviewerThreadId).length;
    await f.runtime.engine.auditPass(false);
    assert.equal(f.server.commands.filter(command => command.type === 'thread.settle' && command.threadId === reviewerThreadId).length, before,
      'the active T3 run is never settled');
    assert.equal(projection.thread.settledOverride, 'active');

    projection.runs.at(-1)!.status = 'completed';
    await f.runtime.engine.auditPass(false);
    const settles = f.server.commands.filter(command => command.type === 'thread.settle' && command.threadId === reviewerThreadId);
    assert.equal(settles.length, before + 1);
    assert.equal(settles.at(-1)!.expectedLatestRunId, 'nightly-recovery-run-2');
    assert.equal(projection.thread.settledOverride, 'settled');
  } finally { await f.close(); }
});

test('a refused support settle records a task event and retries on the next sweep', async t => {
  const f = await fixture(t);
  try {
    const { taskId, reviewerThreadId, reviewerRun } = await taskWithReviewer(f);
    const projection = f.server.threads.get(reviewerThreadId)!;
    projection.runs.push({ id: 'nightly-recovery-run-1', status: 'completed', startedAt: STAMP });
    const recoveryRun = releasedRecoveryRun(taskId, reviewerRun, reviewerThreadId);
    f.runtime.store.putRun(recoveryRun);
    f.server.controls.refuseMutation = true;

    await f.runtime.engine.auditPass(false);
    assert.equal(projection.thread.settledOverride, null, 'the failed settle did not change T3');
    assert.ok(f.runtime.store.events(taskId).some(event => event.kind === 'thread_settlement_warning'
      && event.detail.includes(recoveryRun.id)), 'the task records why this settle failed');

    f.server.controls.refuseMutation = false;
    await f.runtime.engine.auditPass(false);
    assert.equal(projection.thread.settledOverride, 'settled', 'the sweep reconciles the prior intent and settles on retry');
  } finally { await f.close(); }
});

test('a T3-bound reviewer checkpoint auto-continues on the T3 host (#226)', async t => {
  const f = await fixture(t);
  try {
    const { taskId, head, reviewerThreadId, reviewerRun } = await taskWithReviewer(f);
    // The reviewer reads across turns: it saves checkpoint 1 of 6 and its turn ends.
    const receipt = await f.runtime.engine.completeReviewProgress({
      eventId: randomUUID(), taskId, runId: reviewerRun.id, status: 'review_in_progress',
      summary: 'Reading the route corpus', head, checkpoint: { covered: ['routes/a.ts'], remaining: ['routes/b.ts'] },
    } as Parameters<QueueRuntime['engine']['completeReviewProgress']>[0], ticketToken(f, reviewerRun));
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.checkpoint?.ordinal, 1);
    f.server.threads.get(reviewerThreadId)!.runs = [];
    // The report's own wake settles before the pass, so the pass is not racing
    // the task's wait write it already scheduled.
    await f.runtime.engine.quiesce().catch(() => {});
    await pause(200);
    const continuedOnT3 = () => f.server.commands.filter(command => command.type === 'message.dispatch' && command.threadId === reviewerThreadId);
    // The audit passes the timers would drive, with no ambient host set: exactly
    // the sweep's own pass after its per-host observation loop. A pass refused
    // for a task version that another pass just moved is the next pass's work.
    for (let pass = 0; pass < 10 && !continuedOnT3().length; pass++) {
      await f.runtime.engine.continueAwaitingReviewers([f.runtime.store.task(taskId)]);
      await pause(50);
    }
    const continued = continuedOnT3();
    const deferred = f.runtime.store.events(taskId).filter(event => event.kind === 'review_auto_continue_deferred').map(event => event.detail);
    assert.equal(continued.length, 1, `the reviewer continued on T3 (deferred: ${JSON.stringify(deferred)})`);
    assert.ok(!f.paseoObserves.includes(reviewerThreadId), 'the reviewer was never looked up on the default host');
  } finally { await f.close(); }
});

test('a T3 worker thread settles when its task moves to review, and wakes again on revision', async t => {
  const f = await fixture(t);
  try {
    const { taskId, head, workerThreadId, reviewerThreadId, reviewerRun } = await taskWithReviewer(f);
    // The accepted handover settles the worker thread the nightly shows as ended.
    const settles = f.server.commands.filter(command => command.type === 'thread.settle');
    assert.equal(settles.length, 1, `one settle for the accepted handover (${JSON.stringify(settles)})`);
    assert.equal(settles[0]!.threadId, workerThreadId);
    assert.equal(settles[0]!.expectedLatestRunId, 'worker-run-1', 'the settle names the run this handover ended');
    assert.equal(f.server.threads.get(workerThreadId)!.thread.settledOverride, 'settled');

    // The reviewer asks for changes; the revision wakes the settled worker thread.
    await reportAndWake(f, taskId, {
      eventId: randomUUID(), taskId, runId: reviewerRun.id, status: 'changes_required',
      summary: 'One finding', reviewText: 'Tighten the change set.', reviewResponsibility: 'author', prNumber: 7, head,
    }, ticketToken(f, reviewerRun));
    await driveUntil(f, () => f.server.commands.some(command => command.type === 'message.dispatch' && command.threadId === workerThreadId),
      'revision sent to the retained worker', taskId);
    assert.equal(f.server.threads.get(workerThreadId)!.thread.settledOverride, 'active', 'the revision unsettles the thread before its message');

    // The worker's next handover settles it again, under that run's own identity.
    const revisionRun = f.runtime.store.runs(taskId).findLast(run => run.role === 'revision');
    assert.ok(revisionRun, 'a revision run was reserved');
    f.server.threads.get(workerThreadId)!.runs = completedWorkerRun();
    const revisionReport = await helperReport(f, runTicketPath(f, revisionRun), {
      status: 'ready_for_review', summary: 'Findings addressed', prNumber: 7, head,
    });
    assert.equal(revisionReport.code, 0, revisionReport.err);
    await f.runtime.engine.wakeTask(taskId).catch(() => {});
    const settlesAfterRevision = f.server.commands.filter(command => command.type === 'thread.settle');
    assert.equal(settlesAfterRevision.length, 2, `the second handover settles again (${JSON.stringify(settlesAfterRevision)})`);
    assert.equal(settlesAfterRevision[1]!.threadId, workerThreadId);
  } finally { await f.close(); }
});

test('a worker thread whose turn is still ending settles on the next host pass', async t => {
  const f = await fixture(t);
  try {
    const { taskId, head, workerThreadId, workerRunId } = await taskWithWorker(f);
    // The report arrives while the worker's own run is still ending.
    f.server.threads.get(workerThreadId)!.runs = [{ id: 'worker-run-1', status: 'running', startedAt: STAMP }];
    const report = await helperReport(f, runTicketPath(f, { id: workerRunId }), {
      status: 'ready_for_review', summary: 'Change set ready', prNumber: 7, head,
    });
    assert.equal(report.code, 0, report.err);
    assert.equal(f.server.commands.filter(command => command.type === 'thread.settle').length, 0,
      'a live run is never settled, and the handover has not been lost');

    // The turn ends: the ordinary fleet pass — the same one the timers drive —
    // retries the recorded settle on the task's own host.
    f.server.threads.get(workerThreadId)!.runs = completedWorkerRun();
    for (let pass = 0; pass < 5 && !f.server.commands.some(command => command.type === 'thread.settle'); pass++)
      await f.runtime.engine.auditPass(false);
    const settles = f.server.commands.filter(command => command.type === 'thread.settle');
    assert.equal(settles.length, 1, `the recorded settle was sent once the run ended (${JSON.stringify(settles)})`);
    assert.equal(settles[0]!.threadId, workerThreadId);
    assert.equal(settles[0]!.expectedLatestRunId, 'worker-run-1');
    assert.equal(f.server.threads.get(workerThreadId)!.thread.settledOverride, 'settled');
    // The pass scheduled task quanta; let them finish before the store closes.
    await f.runtime.engine.quiesce().catch(() => {});
  } finally { await f.close(); }
});

test('the worker thread is watched and messaged on the task host, never the default host', async t => {
  const f = await fixture(t);
  try {
    const { taskId, workerThreadId } = await taskWithWorker(f);
    // The worker's turn has ended: the idle check reads its own thread.
    f.server.threads.get(workerThreadId)!.runs = completedWorkerRun();
    const readsBefore = f.server.requests.filter(request => request.tag === 'orchestration.subscribeThread').length;
    await f.runtime.engine.reconcile(f.runtime.store.task(taskId));
    assert.ok(f.server.requests.filter(request => request.tag === 'orchestration.subscribeThread').length > readsBefore,
      'the worker reconcile read the worker thread on T3');

    // A planner tell into the task's own thread.
    const tell = await f.runtime.engine.resolution.agentMessage({
      eventId: randomUUID(), participantId: f.ticket.participantId,
      to: { task: taskId, role: 'worker' }, text: 'Planner: keep the change set narrow.',
    }, f.ticket.token);
    assert.equal(tell.status, 'delivered');
    assert.ok(f.server.commands.some(command => command.type === 'message.dispatch' && command.threadId === workerThreadId
      && /Queue message from/.test(command.text)), 'the tell reached the worker thread on T3');

    // None of it named a task agent on the default host.
    assert.deepEqual(f.paseoObserves.filter(id => id !== 'planner'), [], 'no task agent was looked up on the default host');
  } finally { await f.close(); }
});


/**
 * One real fault: a follow-up into the worker thread whose T3 send is cut before
 * its reply. The send is unknown delivery, the run looks stalled, and the task
 * raises the worker incident the ordinary recovery route answers.
 */
async function workerFault(f: Fixture, taskId: string, summary: string, role: 'worker' | 'reviewer' = 'worker'): Promise<void> {
  const task = f.runtime.store.task(taskId);
  const agentId = role === 'worker' ? task.agentId! : task.resolution.reviewerAgentId!;
  const thread = f.server.threads.get(agentId)!;
  // The worker is mid-turn, so the follow-up is delivered now rather than queued.
  thread.runs = [{ id: `fault-turn-${randomUUID()}`, status: 'running', startedAt: STAMP }];
  // The send lands and its reply is unreadable, so delivery is unknown and the
  // socket stays up; whichever pass delivers it fails the same way.
  f.server.controls.postEffectDefect = true;
  try {
    await f.runtime.engine.resolution.agentMessage({ eventId: randomUUID(), participantId: f.ticket.participantId,
      to: { task: taskId, role }, text: summary }, f.ticket.token).catch(() => undefined);
    await f.runtime.engine.wakeTask(taskId).catch(() => undefined);
  } finally {
    f.server.controls.postEffectDefect = false;
    thread.runs = completedWorkerRun();
  }
}

const launchesFor = (f: Fixture, threadId: string) =>
  f.server.commands.filter(command => command.method === 'orchestration.launchThread' && command.threadId === threadId).length;
const dispatchedInto = (f: Fixture, threadId: string) =>
  f.server.commands.filter(command => command.type === 'message.dispatch' && command.threadId === threadId).length;

/** The coordinator's attempt ended without a decision; the sweep owns the next one. */
function endCoordinatorAttempt(f: Fixture, taskId: string, threadId: string): void {
  const run = f.runtime.store.runs(taskId).findLast(item => item.role === 'recovery' && !item.released)!;
  f.runtime.store.putRun({ ...run, released: true, status: 'superseded' });
  f.server.threads.get(threadId)!.runs = [{ id: `attempt-${run.id}`, status: 'completed', startedAt: STAMP }];
}

/** Wait for the ordinary recovery route to dispatch another coordinator attempt. */
async function nextCoordinatorAttempt(f: Fixture, taskId: string, ready: () => boolean): Promise<void> {
  for (let pass = 0; pass < 40 && !ready(); pass++) await f.runtime.engine.wakeTask(taskId).catch(() => undefined);
  assert.ok(ready(), `another coordinator attempt after 40 passes (${f.runtime.store.task(taskId).reason})`);
}

test('a second fault continues the retained T3 recovery coordinator instead of opening a new thread (#1155)', async t => {
  const f = await fixture(t);
  try {
    const { taskId, workerThreadId } = await taskWithWorker(f);

    // A real host fault: the ordinary recovery route launches a coordinator on T3.
    await workerFault(f, taskId, 'The worker could not take the follow-up');
    await driveUntil(f, () => Boolean(f.runtime.store.task(taskId).coordinatorAgentId), 'recovery coordinator dispatched', taskId);
    const coordinatorThreadId = f.runtime.store.task(taskId).coordinatorAgentId!;
    assert.notEqual(coordinatorThreadId, workerThreadId);
    assert.equal(launchesFor(f, coordinatorThreadId), 1, 'the coordinator opened one thread');
    const firstAttempt = f.runtime.store.runs(taskId).findLast(run => run.role === 'recovery')!;
    assert.equal(firstAttempt.agentId, coordinatorThreadId);
    const firstEpisodeId = f.runtime.store.task(taskId).resolution.recovery?.id;
    assert.ok(firstEpisodeId, 'the first recovery episode is open');
    const launchesBefore = f.server.commands.filter(command => command.method === 'orchestration.launchThread').length;
    const dispatchesBefore = dispatchedInto(f, coordinatorThreadId);
    // The coordinator's own turn ended before it reported.
    f.server.threads.get(coordinatorThreadId)!.runs = [{ id: `nightly-${firstAttempt.id}`, status: 'completed', startedAt: STAMP }];

    // Its recovered report is accepted (return the worker to work). The action's
    // own T3 send lands with an unreadable reply, so the continuation is unknown
    // delivery: a distinct second fault, after the first episode was accepted.
    await reportAndWake(f, taskId, { eventId: randomUUID(), taskId, runId: firstAttempt.id, status: 'recovered',
      summary: 'The retained worker can continue', coordinatorGeneration: firstAttempt.generation,
      coordinatorAction: { verb: 'move', to: 'work', instruction: 'Continue the work', reason: 'The retained worker can continue' } },
      ticketToken(f, firstAttempt));
    // The accepted report's own settle lost its reply to the same defect; the host
    // sweep reconciles it before the thread's next round, as for any support report.
    for (let pass = 0; pass < 20 && !f.server.commands.some(command => command.type === 'thread.settle' && command.threadId === coordinatorThreadId); pass++) {
      await (f.t3 as unknown as { reconcileReportedSettlements(): Promise<void> }).reconcileReportedSettlements().catch(() => undefined);
      await pause(50);
    }

    await driveUntil(f, () => f.runtime.store.run(firstAttempt.id)?.released === true
      && f.runtime.store.task(taskId).resolution.recovery === null,
      'the first episode was accepted and completed', taskId);
    assert.ok(f.runtime.store.eventsAll(taskId).some(event => event.kind === 'coordinator_action_applied'),
      'the coordinator report was accepted, not refused');
    assert.ok(f.server.commands.some(command => command.type === 'thread.settle' && command.threadId === coordinatorThreadId),
      'the accepted report settles the retained coordinator thread');
    await archiveFinishedThreads(f.runtime.store, f.t3, taskId);
    assert.equal(f.server.commands.some(command => command.type === 'thread.archive' && command.threadId === coordinatorThreadId), false,
      'the settled recovery thread is not archived while the task is open');
    assert.equal(f.runtime.store.task(taskId).coordinatorAgentId, coordinatorThreadId, 'the task keeps its retained recovery thread');

    // A distinct second fault: the restarted worker stopped without a result, so
    // the task needs attention again and its own recovery route continues the
    // kept thread. The route below is the engine's own (`recovery.route`), the
    // same call the task quantum makes; the fixture only supplies the fault.
    f.server.threads.get(workerThreadId)!.runs = completedWorkerRun();
    const faulted = f.runtime.store.task(taskId);
    f.runtime.store.update(taskId, { phase: 'needs_attention', reason: 'The retained worker stopped without a result',
      resolution: { ...faulted.resolution, attention: true, recovery: null, recoveryActive: false, stop: null } },
      'fixture_second_fault', 'The retained worker stopped without a result');
    await f.runtime.engine.resolution.recovery.route(f.runtime.store.task(taskId)).catch(() => undefined);
    await driveUntil(f, () => dispatchedInto(f, coordinatorThreadId) > dispatchesBefore,
      'the second fault is dispatched into the retained coordinator', taskId);
    assert.ok(f.server.commands.some(command => command.type === 'thread.unsettle' && command.threadId === coordinatorThreadId),
      'the settled thread is explicitly unsettled before its next attempt');
    assert.equal(f.server.commands.filter(command => command.method === 'orchestration.launchThread').length, launchesBefore,
      'no new coordinator thread is opened');
    assert.equal(launchesFor(f, coordinatorThreadId), 1, 'the retained thread served both faults');
    const attempts = f.runtime.store.runs(taskId).filter(run => run.role === 'recovery');
    assert.ok(attempts.length >= 2, 'a second recovery attempt was recorded');
    assert.deepEqual(new Set(attempts.map(run => run.agentId)), new Set([coordinatorThreadId]),
      'every attempt used the one retained coordinator thread');
  } finally { await f.close(); }
});

test('a removed coordinator thread and a routed coordinator profile each open a fresh T3 thread (#1155)', async t => {
  const f = await fixture(t);
  try {
    const { taskId } = await taskWithWorker(f);
    await workerFault(f, taskId, 'The worker could not take the follow-up');
    await driveUntil(f, () => Boolean(f.runtime.store.task(taskId).coordinatorAgentId), 'recovery coordinator dispatched', taskId);
    const removed = f.runtime.store.task(taskId).coordinatorAgentId!;
    const firstProfile = f.runtime.store.runs(taskId).findLast(run => run.role === 'recovery' && run.agentId === removed)?.profile?.id;

    // The retained thread was removed (by hand or by a host change): the next
    // attempt selects a fresh coordinator instead of waiting for it.
    endCoordinatorAttempt(f, taskId, removed);
    f.server.threads.delete(removed); // no inventory row and no readable projection
    await nextCoordinatorAttempt(f, taskId, () => {
      const bound = f.runtime.store.task(taskId).coordinatorAgentId;
      return Boolean(bound && bound !== removed);
    });
    const replacement = f.runtime.store.task(taskId).coordinatorAgentId!;
    assert.equal(launchesFor(f, replacement), 1, 'the replacement opened its own thread');

    // A recorded coordinator route that names another profile needs a new thread.
    endCoordinatorAttempt(f, taskId, replacement);
    // The recorded route names a profile other than the retained thread's own.
    const routed = firstProfile === 'sol-grind' ? 'luna-review' : 'sol-grind';
    const current = f.runtime.store.task(taskId);
    f.runtime.store.update(taskId, { resolution: { ...current.resolution, recovery: null, recoveryActive: false },
      profileRequests: { ...current.profileRequests, coordinator: { profileId: routed, reason: 'Route the coordinator to the review profile',
        required: true, ownerRoute: true, signoff: { status: 'approved', decisionId: null, by: 'operator (board)',
          at: new Date().toISOString(), note: '' } } } }, 'fixture_coordinator_route');
    await nextCoordinatorAttempt(f, taskId, () => {
      const bound = f.runtime.store.task(taskId).coordinatorAgentId;
      return Boolean(bound && bound !== replacement);
    });
    const routedThread = f.runtime.store.task(taskId).coordinatorAgentId!;
    const routedRun = f.runtime.store.runs(taskId).findLast(run => run.role === 'recovery' && run.agentId === routedThread)!;
    assert.equal(routedRun.profile?.id, routed, `the recorded route selected its profile (the first was ${firstProfile})`);
    assert.equal(launchesFor(f, routedThread), 1);
  } finally { await f.close(); }
});

test('a displaced reviewer stays settled until closeout and its late callback is refused (#1155)', async t => {
  const f = await fixture(t);
  try {
    const { taskId, head, reviewerThreadId, reviewerRun } = await taskWithReviewer(f);
    // The reviewer's turn ended before the owner deliberately replaces the reader.
    f.server.threads.get(reviewerThreadId)!.runs = [{ id: `nightly-${reviewerRun.id}`, status: 'completed', startedAt: STAMP }];
    const current = f.runtime.store.task(taskId);
    await f.runtime.taskControl({ action: 'restart', taskId, version: current.version, role: 'reviewer', fresh: true,
      reason: 'Replace the reader', caller: f.planner });

    // A fresh reviewer reads the same head on its own thread.
    await driveUntil(f, () => {
      const next = f.runtime.store.task(taskId).resolution.reviewerAgentId;
      return Boolean(next && next !== reviewerThreadId);
    }, 'a fresh reviewer launched', taskId);
    const replacement = f.runtime.store.task(taskId).resolution.reviewerAgentId!;
    assert.equal(launchesFor(f, replacement), 1);
    assert.equal(f.runtime.store.run(reviewerRun.id)?.released, true, 'the displaced run is released');

    // Nothing is archived or removed while the task is open (brief v3): the
    // displaced thread stays settled and visible.
    assert.equal(f.server.commands.some(command => command.type === 'thread.archive' && command.threadId === reviewerThreadId), false);
    assert.equal(f.server.commands.some(command => command.type === 'thread.delete' && command.threadId === reviewerThreadId), false);
    assert.equal(f.server.threads.get(reviewerThreadId)!.thread.settledOverride, 'settled',
      'the displaced thread is settled, not removed');

    // A late callback from the displaced reader is refused, never applied.
    assert.throws(() => f.runtime.engine.complete({ eventId: randomUUID(), taskId, runId: reviewerRun.id,
      status: 'ready_to_merge', summary: 'Late verdict', reviewText: 'The displaced reader approves.', prNumber: 7, head },
      ticketToken(f, reviewerRun)));

    // It is removed at closeout like the rest of the support set, exactly once.
    const latest = f.runtime.store.task(taskId);
    f.runtime.store.update(taskId, { phase: 'done', resolution: { ...latest.resolution, mergedCommit: 'd'.repeat(40) } });
    await archiveFinishedThreads(f.runtime.store, f.t3, taskId);
    assert.equal(f.server.commands.filter(command => command.type === 'thread.delete' && command.threadId === reviewerThreadId).length, 1,
      'the displaced thread is removed at closeout');
    await archiveFinishedThreads(f.runtime.store, f.t3, taskId);
    assert.equal(f.server.commands.filter(command => command.type === 'thread.delete' && command.threadId === reviewerThreadId).length, 1,
      'and never twice');
  } finally { await f.close(); }
});

test('a task that finished before this rule is cleaned up by the next sweep, exactly once (#1155 catch-up)', async t => {
  const f = await fixture(t);
  try {
    const { taskId, head, reviewerThreadId, workerThreadId, reviewerRun } = await taskWithReviewer(f);
    // The task closed out before the closeout-cleanup rule rolled: it is done and
    // merged, and its threads were never archived or removed.
    const current = f.runtime.store.task(taskId);
    // Copied stored trial shapes: the worker has no role label, while the
    // retained recovery thread carries nucleus.role=recovery. IDs are synthetic.
    const workerLabels = f.host.state.read().agents[workerThreadId]!.labels;
    assert.deepEqual(workerLabels, storedT3Labels('worker', { taskId, runId: current.runId! }));
    assert.equal(Object.hasOwn(workerLabels, WIRE_LABEL_KEYS.role), false);
    const recoveryRunId = randomUUID();
    const recoveryLabels = storedT3Labels('recovery', { taskId, runId: recoveryRunId });
    const recovery = await f.host.createAgent({ workspaceId: current.workspaceId!, profile: current.profile!,
      title: 'Synthetic retained recovery', mcpBindingPath: null,
      attempt: () => ({ requestId: recoveryRunId, prompt: 'Synthetic completed recovery', labels: recoveryLabels, environment: {} }) });
    f.runtime.store.putRun({ id: recoveryRunId, taskId, hostId: t3Host, role: 'recovery', generation: current.coordinatorGeneration,
      head, base: current.planningBase, workspaceId: current.workspaceId!, agentId: recovery.id, profile: current.profile,
      status: 'finished', createdAt: STAMP, lastObservedAt: STAMP, active: false, idleSince: null, released: true,
      completion: { taskId, runId: recoveryRunId, eventId: randomUUID(), status: 'recovered', head, summary: 'Recovery applied' } });
    await f.host.settleReportedThread(recovery.id, recoveryRunId);
    assert.deepEqual(f.host.state.read().agents[recovery.id]!.labels, recoveryLabels);
    assert.equal(recoveryLabels[WIRE_LABEL_KEYS.role], 'recovery');
    assert.equal(Object.values(f.host.state.read().intents).some(intent =>
      intent.payload.includes('thread.settle') && intent.payload.includes(recovery.id)), false,
      'an already settled recovery with no native run needs no settlement receipt');
    const verdict = { taskId, runId: reviewerRun.id, eventId: randomUUID(), status: 'ready_to_merge' as const,
      head, summary: 'Approved', reviewText: 'The reviewed change meets the brief.' };
    f.runtime.store.putRun({ ...reviewerRun, status: 'finished', active: false, released: true, completion: verdict });
    f.runtime.store.update(taskId, { phase: 'done', coordinatorAgentId: recovery.id, resolution: { ...current.resolution, currentRunId: null,
      mergedCommit: head, review: verdict } });
    assert.equal(f.runtime.store.getMeta(`finishedTaskThreadCleanup:${taskId}`), undefined);
    assert.equal(f.server.commands.some(command => command.type === 'thread.archive' || command.type === 'thread.delete'), false,
      'nothing has cleaned its threads yet');

    // Older completed rows and permanently pending candidates must not hide the
    // target behind a fixed prefix or a bounded earliest-pending batch.
    const completed = f.runtime.store.task(taskId);
    const insert = f.runtime.store.db.prepare('INSERT INTO tasks(id,submission,input_hash,data) VALUES(?,?,?,?)');
    f.runtime.store.transaction(() => {
      for (let index = 0; index < 505; index++) {
        const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
        const agentId = index < 501 ? null : `unowned-history-${index}`;
        const historical = { ...completed, id, agentId, retiredWorkers: [],
          coordinatorAgentId: undefined, resolution: { ...completed.resolution,
            reviewerAgentId: null, currentRunId: null } };
        insert.run(id, `synthetic-history-${index}`, digest(id), JSON.stringify(taskSchema.parse(historical)));
        if (index < 250) f.runtime.store.setMeta(`finishedTaskThreadCleanup:${id}`, STAMP);
        if (agentId) f.server.threads.set(agentId, threadProjection(agentId, f.repo));
      }
    });

    // The real safety sweep selects the finished task directly and applies the
    // closeout rule: the worker archived, the support thread removed.
    const sweep = await f.runtime.engine.auditPass(false);
    assert.equal(sweep.fault, null, 'the real sweep completes without a fixture or host failure');
    assert.ok(f.server.commands.some(command => command.type === 'thread.archive' && command.threadId === workerThreadId),
      'the worker thread is archived');
    assert.equal(f.server.commands.filter(command => command.type === 'thread.delete' && command.threadId === reviewerThreadId).length, 1,
      'the reviewer thread is removed once');
    assert.equal(f.server.commands.filter(command => command.type === 'thread.delete' && command.threadId === recovery.id).length, 1,
      'the stored-shape recovery thread is removed once');
    assert.equal(f.server.commands.filter(command => command.type === 'thread.delete' && command.threadId === workerThreadId).length, 0,
      'the worker without a role label is archived, never deleted');
    assert.ok(f.runtime.store.getMeta(`finishedTaskThreadCleanup:${taskId}`), 'completion is recorded per task');
    for (let index = 501; index < 505; index++)
      assert.equal(f.runtime.store.getMeta(`finishedTaskThreadCleanup:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
        undefined, 'an unowned historical candidate stays pending without starving later tasks');

    // Finish presentation already queued by the first pass before measuring
    // whether later passes add any work or history for the cleaned task.
    await f.runtime.engine.drainProjections({ cleanup: false });
    const commands = f.server.commands.length;
    const history = f.runtime.store.eventsAll(taskId);
    const nativeRead = f.host.rpc.readStream.bind(f.host.rpc);
    const deletedReads: string[] = [];
    f.host.rpc.readStream = (method, payload, accept) => {
      const id = (payload as { threadId?: string }).threadId;
      if (method === 'orchestration.subscribeThread' && (id === recovery.id || id === reviewerThreadId)) deletedReads.push(id);
      return nativeRead(method, payload, accept);
    };
    for (let pass = 0; pass < 3; pass++) assert.equal((await f.runtime.engine.auditPass(false)).fault, null);
    assert.deepEqual(deletedReads, [], 'later real sweeps never read a confirmed deleted thread');
    assert.equal(f.server.commands.length, commands, 'later sweeps send no commands');
    assert.deepEqual(f.runtime.store.eventsAll(taskId), history, 'later sweeps add no settlement warnings or task history');
  } finally { await f.close(); }
});

for (const boundary of ['rpc', 'reservation'] as const)
test(`the real sweep retries a deletion proven not sent at ${boundary} and records completion once`, async t => {
  const f = await fixture(t);
  try {
    const head = (await git(f.repo, 'rev-parse', 'HEAD')).trim();
    const initial = f.runtime.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Synthetic finished recovery',
      repoPath: f.repo, planningCommit: head, handoffPath: 'synthetic.md', originAgentId: f.planner }), t3Host, 'Synthetic handoff', head);
    const task = f.runtime.store.update(initial.id, { phase: 'done',
      resolution: { ...initial.resolution, mergedCommit: head } });
    const workspace = await f.host.createWorkspace({ title: 'Synthetic recovery workspace', requestId: randomUUID(), directory: f.repo, project: { projectId: 'synthetic-project' } });
    const profile: Profile = { id: 'sol-grind', name: 'Sol grind', provider: 'codex', model: 'synthetic-model',
      available: true, problem: '', notes: '', supportedThinking: [] };
    const runId = randomUUID();
    const recovery = await f.host.createAgent({ workspaceId: workspace.id, profile, title: 'Synthetic recovery', mcpBindingPath: null,
      attempt: () => ({ requestId: runId, prompt: 'Synthetic completed recovery',
        labels: storedT3Labels('recovery', { taskId: task.id, runId }), environment: {} }) });
    f.runtime.store.putRun({ id: runId, taskId: task.id, hostId: t3Host, role: 'recovery', generation: task.coordinatorGeneration,
      head, base: head, workspaceId: workspace.id, agentId: recovery.id, profile, status: 'finished', createdAt: STAMP,
      lastObservedAt: STAMP, active: false, idleSince: STAMP, completion: null, released: true });
    const nativeCall = f.host.rpc.call.bind(f.host.rpc);
    const nativeOrigin = f.host.originAgent.bind(f.host);
    if (boundary === 'rpc') {
      f.host.rpc.call = (method, payload) => {
        if (method === 'orchestration.dispatchCommand' && (payload as { type?: string }).type === 'thread.delete') f.host.rpc.close();
        return nativeCall(method, payload);
      };
    } else {
      f.host.originAgent = async id => {
        const origin = await nativeOrigin(id);
        f.host.close(); // Successful terminal observation, but no intent reserved or command sent.
        return origin;
      };
    }
    assert.equal((await f.runtime.engine.auditPass(false)).fault, null);
    const key = f.runtime.store.threadArchiveKey(recovery.id, t3Host)!;
    assert.equal(f.runtime.store.getMeta<{ status: string }>(key)?.status, 'ready');
    assert.equal(f.server.commands.filter(command => command.type === 'thread.delete').length, 0, 'the native boundary proved no write');
    const nativeIntent = Object.values(f.host.state.read().intents).find(intent => JSON.parse(intent.payload).payload.type === 'thread.delete');
    assert.equal(nativeIntent?.status, boundary === 'rpc' ? 'refused' : undefined, 'the native ledger proves this occurrence was unsent');
    assert.equal(f.runtime.store.getMeta(`finishedTaskThreadCleanup:${task.id}`), undefined);

    f.host.rpc.call = nativeCall;
    f.host.originAgent = nativeOrigin;
    await f.host.connect();
    assert.equal((await f.runtime.engine.auditPass(false)).fault, null);
    assert.equal(f.server.commands.filter(command => command.type === 'thread.delete').length, 1, 'the next sweep delivers it once');
    const completed = f.runtime.store.getMeta(`finishedTaskThreadCleanup:${task.id}`);
    assert.ok(completed);
    assert.equal((await f.runtime.engine.auditPass(false)).fault, null);
    assert.equal(f.server.commands.filter(command => command.type === 'thread.delete').length, 1);
    assert.equal(f.runtime.store.getMeta(`finishedTaskThreadCleanup:${task.id}`), completed);
  } finally { await f.close(); }
});


test('real sweeps retire a lost support settle after deletion without stream reads and let another task progress', async t => {
  const f = await fixture(t);
  try {
    const { taskId, head, reviewerThreadId, reviewerRun } = await taskWithReviewer(f);
    const reads: string[] = [], nativeRead = f.host.rpc.readStream.bind(f.host.rpc);
    f.host.rpc.readStream = (method, payload, accept) => {
      if (method === 'orchestration.subscribeThread') reads.push((payload as { threadId: string }).threadId);
      return nativeRead(method, payload, accept);
    };
    f.server.threads.get(reviewerThreadId)!.runs.push({ id: 'lost-native-review', status: 'completed', startedAt: STAMP });
    f.server.controls.disconnectAfterEffect = true;
    await assert.rejects(f.host.settleReportedThread(reviewerThreadId, reviewerRun.id));
    f.server.controls.disconnectAfterEffect = false;
    await f.host.connect();
    assert.ok(reads.includes(reviewerThreadId), 'the spy sees the real projection stream boundary before deletion');
    const settleKey = Object.keys(f.host.state.read().intents).find(key => {
      const wire = JSON.parse(f.host.state.read().intents[key].payload);
      return wire.payload.type === 'thread.settle' && wire.payload.threadId === reviewerThreadId;
    })!;
    assert.equal(f.host.state.read().intents[settleKey].status, 'unknown');
    const current = f.runtime.store.task(taskId);
    const verdict = { taskId, runId: reviewerRun.id, eventId: randomUUID(), status: 'ready_to_merge' as const, head,
      summary: 'Approved', reviewText: 'Accepted synthetic review' };
    f.runtime.store.putRun({ ...reviewerRun, released: true, active: false, status: 'finished', completion: verdict });
    f.runtime.store.update(taskId, { phase: 'done', resolution: { ...current.resolution, currentRunId: null, mergedCommit: head, review: verdict } });
    // The terminal lane can finish before the next presentation reconciliation.
    await archiveFinishedThreads(f.runtime.store, f.t3, taskId);
    await f.runtime.engine.drainProjections({ cleanup: false });
    assert.equal(f.host.state.read().intents[settleKey].status, 'moot');
    assert.equal(f.host.state.read().intents[settleKey].result, undefined, 'retirement never invents successful delivery');
    const beforeReads = reads.filter(id => id === reviewerThreadId).length;
    const beforeCommands = f.server.commands.filter(command => command.threadId === reviewerThreadId).length;
    const history = f.runtime.store.eventsAll(taskId);

    const initial = f.runtime.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Other finished task',
      repoPath: f.repo, planningCommit: head, handoffPath: 'synthetic.md', originAgentId: f.planner }), t3Host, 'Synthetic handoff', head);
    const other = f.runtime.store.update(initial.id, { phase: 'done', workspaceId: current.workspaceId,
      resolution: { ...initial.resolution, mergedCommit: head } });
    const otherRunId = randomUUID();
    const otherAgent = await f.host.createAgent({ workspaceId: current.workspaceId!, profile: current.profile!,
      title: 'Other finished recovery', mcpBindingPath: null,
      attempt: () => ({ requestId: otherRunId, prompt: 'Completed synthetic recovery', environment: {},
        labels: storedT3Labels('recovery', { taskId: other.id, runId: otherRunId }) }) });
    f.runtime.store.putRun({ ...reviewerRun, id: otherRunId, taskId: other.id, role: 'recovery', agentId: otherAgent.id,
      generation: other.coordinatorGeneration, status: 'finished', active: false, released: true, completion: null });
    for (let pass = 0; pass < 3; pass++) assert.equal((await f.runtime.engine.auditPass(false)).fault, null);
    assert.equal(reads.filter(id => id === reviewerThreadId).length, beforeReads, 'no later stream reads of the deleted thread');
    assert.equal(f.server.commands.filter(command => command.threadId === reviewerThreadId).length, beforeCommands, 'no presentation replay');
    assert.deepEqual(f.runtime.store.eventsAll(taskId), history, 'no repeated warnings or task history');
    assert.ok(f.runtime.store.getMeta(`finishedTaskThreadCleanup:${other.id}`), 'the other task completes cleanup');
    assert.equal(f.server.commands.filter(command => command.type === 'thread.delete' && command.threadId === otherAgent.id).length, 1);
  } finally { await f.close(); }
});

test('attention surfaces the worker thread and the return to review settles it again (#1181)', async t => {
  const f = await fixture(t);
  try {
    const { taskId, head, workerThreadId, workerRunId } = await taskWithWorker(f);
    // The worker's own turn, ended by the time its handover is accepted.
    f.server.threads.get(workerThreadId)!.runs = completedWorkerRun();
    const workerReport = await helperReport(f, runTicketPath(f, { id: workerRunId }), {
      status: 'ready_for_review', summary: 'Change set ready', prNumber: 7, head,
    });
    assert.equal(workerReport.code, 0, workerReport.err);
    await f.runtime.engine.wakeTask(taskId).catch(() => {});
    await driveUntil(f, () => f.server.commands.some(command => command.type === 'thread.settle' && command.threadId === workerThreadId),
      'worker settled on handover', taskId);
    assert.equal(f.server.threads.get(workerThreadId)!.thread.settledOverride, 'settled');

    // The task needs attention: the sweep unsettles the worker thread so it
    // shows in T3's main list. Only the worker thread surfaces.
    const unsettles = () => f.server.commands.filter(command => command.type === 'thread.unsettle' && command.threadId === workerThreadId);
    const unsettledCount = unsettles().length;
    f.runtime.store.update(taskId, { phase: 'needs_attention', reason: 'The retained worker stopped without a result',
      resolution: { ...f.runtime.store.task(taskId).resolution, attention: true, recovery: null, recoveryActive: false, stop: null } });
    await f.runtime.engine.auditPass(false);
    assert.equal(unsettles().length, unsettledCount + 1, 'attention unsettles the worker thread exactly once');
    assert.equal(f.server.threads.get(workerThreadId)!.thread.settledOverride, 'active');

    // The task returns to review: the ordinary settle puts the thread back.
    const settles = () => f.server.commands.filter(command => command.type === 'thread.settle' && command.threadId === workerThreadId);
    const settledCount = settles().length;
    f.runtime.store.update(taskId, { phase: 'awaiting_review', reason: 'Attention cleared; back to review',
      resolution: { ...f.runtime.store.task(taskId).resolution, attention: false } });
    await f.runtime.engine.auditPass(false);
    assert.equal(settles().length, settledCount + 1, 'the return to review settles the worker thread again');
    assert.equal(f.server.threads.get(workerThreadId)!.thread.settledOverride, 'settled');
    // Let the pass's scheduled task quanta finish before the store closes.
    await f.runtime.engine.quiesce().catch(() => {});
  } finally { await f.close(); }
});

test('attention during review neither settles nor unsettles the worker twice (#1181 review)', async t => {
  const f = await fixture(t);
  try {
    const { taskId, head, workerThreadId, workerRunId } = await taskWithWorker(f);
    // The worker's own turn, ended by the time its handover is accepted.
    f.server.threads.get(workerThreadId)!.runs = completedWorkerRun();
    const workerReport = await helperReport(f, runTicketPath(f, { id: workerRunId }), {
      status: 'ready_for_review', summary: 'Change set ready', prNumber: 7, head,
    });
    assert.equal(workerReport.code, 0, workerReport.err);
    await f.runtime.engine.wakeTask(taskId).catch(() => {});
    await driveUntil(f, () => f.server.commands.some(command => command.type === 'thread.settle' && command.threadId === workerThreadId),
      'worker settled on handover', taskId);
    assert.equal(f.server.threads.get(workerThreadId)!.thread.settledOverride, 'settled');

    // A review-phase escalation keeps the phase but raises attention (a
    // reviewer reminder while awaiting review). The worker surfaces once, and
    // later sweeps must not settle-then-unsettle it again every pass.
    const settles = () => f.server.commands.filter(command => command.type === 'thread.settle' && command.threadId === workerThreadId);
    const unsettles = () => f.server.commands.filter(command => command.type === 'thread.unsettle' && command.threadId === workerThreadId);
    f.runtime.store.update(taskId, { phase: 'awaiting_review', reason: 'Reviewer reminder raised attention',
      resolution: { ...f.runtime.store.task(taskId).resolution, attention: true } });
    await f.runtime.engine.auditPass(false);
    assert.equal(f.server.threads.get(workerThreadId)!.thread.settledOverride, 'active');
    const settledCount = settles().length, unsettledCount = unsettles().length;
    await f.runtime.engine.auditPass(false);
    assert.equal(settles().length, settledCount, 'no fresh worker settle while attention is active');
    assert.equal(unsettles().length, unsettledCount, 'no fresh worker unsettle while already surfaced');
    // Let the pass's scheduled task quanta finish before the store closes.
    await f.runtime.engine.quiesce().catch(() => {});
  } finally { await f.close(); }
});
