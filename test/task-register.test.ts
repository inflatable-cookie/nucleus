import { formatAgentId } from '../shared/agent-identity';
import { fakeAdapter } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Engine } from '../core/engine';
import { Store, digest } from '../core/store/store';
import { git, verifyResume, WORKER_PR_IDENTITY_REFUSAL, WorkerSourceRefusal } from '../core/git/index';
import { reviewPublicationBody } from '../core/forge/index';
import { assertRegistrationUnowned, registerTask, type RegistrationAdapter } from '../core/host/registration';
import { submissionSchema, summarizeTask, taskRegistrationSchema, type PoolEntry, type Profile, type Run, type Task } from '../shared/contracts';
import { pipelineColumn } from '../shared/pipeline-board';
import type { Adapter, AgentObservation } from '../core/host';
import { toolTimelinePage } from './support/tool-timeline';

/**
 * Spec 058 slice 4: any thread registers itself as a responsible task.
 * `task.register` records a task whose worker is the calling thread, bound to
 * the worktree it is already in. From then on it follows the same responsible
 * lifecycle as a planned task: PR, retained reviewer, merge and closeout.
 *
 * The caller is the authenticated calling thread, never a typed name: the
 * input carries no agent, workspace or branch field, the CLI overwrites caller
 * from PASEO_AGENT_ID, and the service binds the task to that thread's own
 * live worktree. Refusals name their reason.
 */

const head = 'c'.repeat(40), base = 'b'.repeat(40);
test('registration compares native agent and workspace identities within their proven host', () => {
  const store = new Store(':memory:');
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'existing', title: 'Existing', repoPath: '/repo', planningCommit: base,
      handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host-a', 'handoff', base);
    store.update(task.id, { agentId: 'same', workspaceId: 'workspace', branch: 'first' });
    const claim = { agentId: 'same', workspaceId: 'workspace', branch: 'other', repoPath: '/repo' };
    assert.throws(() => assertRegistrationUnowned(store, { ...claim, hostId: 'host-a' }), /already belongs/);
    assert.doesNotThrow(() => assertRegistrationUnowned(store, { ...claim, hostId: 'host-b' }));
    assert.throws(() => assertRegistrationUnowned(store, claim), /already belongs/);
    assert.throws(() => assertRegistrationUnowned(store, { ...claim, hostId: 'host-b', branch: 'first' }), /already belongs/);
  } finally { store.close(); }
});
const profile = (id: string, model: string): Profile => ({ id, name: id, model, provider: 'fixture', available: true, problem: '', notes: '', supportedThinking: [] });

async function gitDirs() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ns-register-')));
  const repo = join(dir, 'repo'), work = join(dir, 'work'), origin = join(dir, 'origin.git');
  await git(dir, 'init', '--bare', origin);
  await git(dir, 'init', '-b', 'main', repo);
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), 'repo\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'plan');
  await git(repo, 'remote', 'add', 'origin', origin);
  await git(repo, 'push', 'origin', 'main');
  await git(repo, 'worktree', 'add', '-b', 'feature', work, 'main');
  // The lifecycle below runs against real git: the reported PR head is the
  // worktree's actual head, so manifest and source reads resolve.
  const commit = await git(work, 'rev-parse', 'HEAD');
  return { dir, repo, work, origin, commit };
}

function poolFor(profiles: Profile[]): PoolEntry[] {
  return profiles.map(entry => entry.id === 'reviewer'
    ? { profileId: entry.id, enabled: true, group: 'review', roles: ['reviewer'], scopes: ['general'], weight: 1, capability: 'medium', cost: 'low' } as PoolEntry
    : { profileId: entry.id, enabled: true, group: 'author', roles: ['worker'], scopes: ['general'], weight: 1, capability: 'low' } as PoolEntry);
}

/** Full engine fixture: real git worktrees, stubbed Paseo surface for review and merge. */
async function fixture() {
  const { dir, repo, work, commit } = await gitDirs();
  const store = new Store(join(dir, 'queue.sqlite'));
  const profiles = ['author', 'reviewer'].map(id => profile(id, id));
  const [author, reviewer] = profiles;
  store.setMeta('pool', poolFor(profiles));
  store.setMeta('paused', false);
  store.patchRepository({ origin: null, path: repo }, {});
  const caller = 'caller-thread', workspace = 'caller-workspace';
  const callerObservation: AgentObservation = { id: caller, workspaceId: workspace, status: 'running', active: true, permissions: false, error: '', model: author.model };

  const states = new Map<string, AgentObservation>(), tokens = new Map<string, string>();
  let remoteHead = commit;
  let rejectFirstPr = false;
  const creates: Run[] = [], sends: Run[] = [];
  let mergeCalls = 0;
  let registrationToken = '';
  const idle = (id: string) => states.set(id, { id, workspaceId: states.get(id)?.workspaceId ?? workspace, status: 'idle', active: false, permissions: false, error: '', model: states.get(id)?.model });
  const adapter = fakeAdapter({
    hostId: 'host',
    profiles: async () => profiles, validate: async () => base, verifyWorkspace: async () => 'feature',
    createWorkspace: async () => { throw Error('fixtures do not create workspaces'); },
      findRunAgents: async () => [],
    createAgent: async () => { throw Error('fixtures do not create agents'); },
    createRun: async (_task: unknown, run: Run, token: string) => { creates.push(run); tokens.set(run.id, token); const id = `agent-${run.id}`; idle(id); states.set(id, { ...states.get(id)!, status: 'running', active: true, model: run.profile?.model }); return { id, workspaceId: run.workspaceId }; },
    sendRun: async (_task: unknown, run: Run, token: string) => { sends.push(run); tokens.set(run.id, token); states.set(run.agentId!, { ...states.get(run.agentId!)!, status: 'running', active: true }); },
    observe: async (id: string) => {
      if (id === caller) return states.get(id) ?? callerObservation;
      return states.get(id) ?? { id, workspaceId: workspace, status: 'idle', active: false, permissions: false, error: '' };
    },
    prepareRegistration: (_task: unknown, token: string) => { registrationToken = token; },
    inspectRegistration: async (callerAgentId: string) => {
      if (callerAgentId !== caller) throw Error('Agent was not found');
      return { workspaceId: workspace, directory: work, repoPath: repo, observation: callerObservation };
    },
     notify: async () => {},
    verifyPr: async (_task: unknown, number: number) => {
      if (rejectFirstPr && number === 1) throw new WorkerSourceRefusal('pr_identity', WORKER_PR_IDENTITY_REFUSAL);
      return { head: remoteHead, url: `https://github.com/example/repo/pull/${number}`, repository: 'example/repo', headRepository: 'example/repo' };
    },
    verifyPrIdentity: async (_task: unknown, number: number) => ({ head: remoteHead, url: `https://github.com/example/repo/pull/${number}`, repository: 'example/repo', headRepository: 'example/repo' }),
    verifyResume: async () => {}, verifyCleanQueueWorktree: async () => {}, verifyReview: async () => {},
    verifyContinuedProgress: async (_task: unknown, _number: number, expected: string) => { if (expected !== remoteHead) throw Error('progress source changed'); },
    agentTimelinePage: async () => toolTimelinePage([]),
    publishReview: async (publicationStore: Store, task: Task, run: Run, status: string, text: string) => {
      const hash = digest(reviewPublicationBody(task, run, status, text, publicationStore.run(run.id)?.completion?.verdicts ?? []));
      const id = creates.filter(item => item.role === 'reviewer').length;
      publicationStore.setMeta(`reviewPublication:${run.id}`, { hash, commentId: id });
      return id;
    },
    mergeGate: async () => ({ head: remoteHead, base, wait: '' }), merged: async () => ({ merged: false, commit: null, head: remoteHead, base: 'main' }),
    merge: async () => { mergeCalls++; }, syncMain: async () => base, verifyCloseout: async () => {},
    continueReviewer: async () => ({ sent: true as const }),
  } as unknown as Adapter & RegistrationAdapter & { supportsCoordinatorRecovery?: boolean });
  adapter.supportsCoordinatorRecovery = true;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = profiles;
  engine.resolution.worktreeValidationProbe = () => ({ state: 'absent' });

  const finding = (status: string) => `Authenticated findings for ${status}: `
    + 'The change is small, reviewed in full, and matches the registered brief. '.repeat(40)
    + `End of authenticated findings for ${status}.`;
  const register = (overrides = {}) => registerTask(store, adapter, profiles,
    { title: 'Registered work', description: 'Do the thing already in progress', complexity: 'medium', caller, ...overrides });
  const settle = async (passes = 2) => { for (let pass = 0; pass < passes; pass++) { await engine.wake(); await engine.quiesce(); } };
  return {
    dir, repo, work, head: commit, store, engine, adapter, profiles, author, reviewer, caller, workspace, callerObservation,
    register, settle, idle, states, creates, sends, finding,
    token: () => registrationToken, runToken: (runId: string) => tokens.get(runId)!,
    rejectFirstPr(value: boolean) { rejectFirstPr = value; },
    get mergeCalls() { return mergeCalls; },
    setHead(value: string) { remoteHead = value; },
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('a fixture thread registers from its own worktree and merges through the responsible lifecycle', async () => {
  const f = await fixture();
  try {
    const result = await f.register();
    const task = result.task;
    assert.equal(task.phase, 'working');
    assert.equal(task.responsible, true);
    assert.equal(task.agentId, f.caller);
    assert.equal(task.workspaceId, f.workspace);
    assert.equal(task.directory, f.work);
    assert.equal(task.branch, 'feature');
    assert.equal(task.runId, result.runId);
    assert.equal(task.originAgentId, f.caller);
    assert.equal(task.complexity, 'medium');
    // The operator sees the registered task on the board as working.
    const boardTask = f.store.tasks().find(item => item.id === task.id)!;
    assert.equal(boardTask.phase, 'working');
    assert.equal(boardTask.responsible, true);
    assert.equal(pipelineColumn({kind:'task',id:task.id,lanes:boardTask.lanes,value:summarizeTask(boardTask)}), 'Working');
    const events = f.store.eventsAll(task.id).map(event => event.kind);
    assert.ok(events.includes('registered'), 'registration is recorded');
    // The worker opens a PR and reports through the same path as a planned task.
    f.idle(f.caller);
    assert.equal((await f.engine.complete({
      taskId: task.id, runId: task.runId!, eventId: randomUUID(), status: 'ready_for_review',
      summary: 'PR opened', prNumber: 1, head: f.head,
    }, f.token())).accepted, true);
    await f.settle(2);
    const reviewing = f.store.task(task.id);
    const runId = reviewing.resolution.currentRunId!;
    assert.ok(runId, 'a reviewer run follows the worker report');
    const run = f.store.run(runId)!;
    assert.equal(run.role, 'reviewer');
    f.idle(run.agentId!);
    assert.equal((await f.engine.complete({
      taskId: task.id, runId, eventId: randomUUID(), status: 'ready_to_merge',
      summary: 'Reviewed in full', head: f.head, reviewText: f.finding('ready_to_merge'),
    }, f.runToken(runId))).accepted, true);
    await f.settle(4);
    const merged = f.store.task(task.id);
    assert.equal(f.mergeCalls, 1);
    assert.ok(merged.resolution.mergeIntent);
    assert.equal(merged.responsible, true);
    assert.equal(f.store.runs(task.id).filter(item => item.role === 'recovery').length, 0, 'no coordinator in the responsible lifecycle');
  } finally { await f.close(); }
});

test('a responsible worker repairs a refused PR report and reports the replacement itself', async () => {
  const f = await fixture();
  try {
    const { task } = await f.register();
    f.rejectFirstPr(true);
    f.idle(f.caller);
    assert.equal((await f.engine.complete({ taskId: task.id, runId: task.runId!, eventId: randomUUID(),
      status: 'ready_for_review', summary: 'Opened the wrong branch PR', prNumber: 1, head: f.head }, f.token())).accepted, true);
    await f.settle(3);

    const repair = f.store.task(task.id);
    assert.equal(repair.phase, 'changes_requested', repair.reason);
    assert.equal(repair.resolution.revisionPrRepair, true);
    assert.match(f.store.eventsAll(task.id).findLast(event => event.kind === 'responsible_pr_report_refused')?.detail ?? '', /PR #1; returned to the responsible worker/);
    assert.equal(f.store.runs(task.id).filter(run => run.role === 'recovery').length, 0);
    const revision = f.store.run(repair.resolution.currentRunId!)!;
    assert.equal(revision.role, 'revision');
    assert.match(revision.instruction ?? '', /PR must be open, ready, and match the task's branch and base/);

    f.rejectFirstPr(false);
    f.idle(revision.agentId!);
    assert.equal((await f.engine.complete({ taskId: task.id, runId: revision.id, eventId: randomUUID(),
      status: 'ready_for_review', summary: 'Replacement PR opened on the registered branch', prNumber: 2, head: revision.head }, f.runToken(revision.id))).accepted, true);
    await f.settle(3);
    const corrected = f.store.task(task.id);
    assert.equal(corrected.phase, 'reviewing');
    assert.equal(corrected.completion?.prNumber, 2);
    assert.equal(corrected.prUrl, 'https://github.com/example/repo/pull/2');
    assert.equal(f.store.runs(task.id).filter(run => run.role === 'recovery').length, 0);
  } finally { await f.close(); }
});

test('a worktree opened in Paseo as its own project registers against its main checkout', async () => {
  const f = await fixture();
  try {
    // Paseo reports the worktree itself as the project root (effigy #512 slice C); Git knows its main checkout.
    const ownProject = { ...f.adapter, inspectRegistration: async () => ({ workspaceId: f.workspace, directory: f.work, repoPath: f.work, observation: f.callerObservation }) };
    const result = await registerTask(f.store, ownProject, f.profiles, { title: 'Work', description: 'Desc', complexity: 'medium', caller: f.caller });
    assert.equal(result.task.repoPath, f.repo);
    assert.equal(result.directory, f.work);
  } finally { await f.close(); }
});

test('a branch cut before the latest base commit registers at its fork point and resumes', async () => {
  const f = await fixture();
  try {
    // effigy #527: main moved on after the worktree branched; the tip is not in the branch.
    writeFileSync(join(f.repo, 'LATER.md'), 'later\n');
    await git(f.repo, 'add', '.');
    await git(f.repo, 'commit', '-m', 'later base');
    await git(f.repo, 'push', 'origin', 'main');
    const { task } = await f.register();
    assert.equal(task.planningCommit, f.head);
    assert.equal(await verifyResume(f.store.task(task.id)), f.head);
  } finally { await f.close(); }
});

test('registration refuses an unauthenticated caller with the reason', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      registerTask(f.store, f.adapter, f.profiles, { title: 'Work', description: 'Desc', complexity: 'medium', caller: 'ghost-thread' }),
      /not a live Paseo thread: Agent was not found/);
    assert.equal(f.store.tasks().length, 0, 'nothing is written');
  } finally { await f.close(); }
});

test('registration refuses the registered checkout and a dirty tree, each with its reason', async () => {
  const f = await fixture();
  try {
    const checkoutAdapter = { ...f.adapter, inspectRegistration: async () => ({ workspaceId: f.workspace, directory: f.repo, repoPath: f.repo, observation: f.callerObservation }) };
    await assert.rejects(
      registerTask(f.store, checkoutAdapter, f.profiles, { title: 'Work', description: 'Desc', complexity: 'medium', caller: f.caller }),
      /registered checkout is refused/);
    writeFileSync(join(f.work, 'uncommitted.txt'), 'dirty\n');
    try {
      await assert.rejects(f.register(), /worktree is dirty; commit its changes on its branch and register again/);
    } finally {
      rmSync(join(f.work, 'uncommitted.txt'));
    }
    assert.equal(f.store.tasks().length, 0, 'nothing is written');
  } finally { await f.close(); }
});

test('registration refuses a detached head and a worktree outside any registered repository', async () => {
  const f = await fixture();
  try {
    const detached = join(f.dir, 'detached');
    await git(f.repo, 'worktree', 'add', '--detach', detached, 'main');
    try {
      const detachedAdapter = { ...f.adapter, inspectRegistration: async () => ({ workspaceId: 'other-workspace', directory: detached, repoPath: f.repo, observation: { ...f.callerObservation, workspaceId: 'other-workspace' } }) };
      await assert.rejects(
        registerTask(f.store, detachedAdapter, f.profiles, { title: 'Work', description: 'Desc', complexity: 'medium', caller: f.caller }),
        /not a detached head/);
    } finally {
      await git(f.repo, 'worktree', 'remove', '--force', detached);
    }
    const foreign = join(f.dir, 'foreign');
    await git(f.dir, 'init', '-b', 'main', foreign);
    await git(foreign, 'config', 'user.email', 'test@example.com');
    await git(foreign, 'config', 'user.name', 'Test');
    writeFileSync(join(foreign, 'file.txt'), 'foreign\n');
    await git(foreign, 'add', '.');
    await git(foreign, 'commit', '-m', 'foreign');
    const foreignAdapter = { ...f.adapter, inspectRegistration: async () => ({ workspaceId: 'foreign-workspace', directory: foreign, repoPath: foreign, observation: { ...f.callerObservation, workspaceId: 'foreign-workspace' } }) };
    await assert.rejects(
      registerTask(f.store, foreignAdapter, f.profiles, { title: 'Work', description: 'Desc', complexity: 'medium', caller: f.caller }),
      /no registered repository/);
    assert.equal(f.store.tasks().length, 0, 'nothing is written');
  } finally { await f.close(); }
});

test('registration refuses the Paseo bridge path, where no caller identity is reliable', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      registerTask(f.store, f.adapter, f.profiles, { title: 'Work', description: 'Desc', complexity: 'medium', caller: f.caller }, { via: 'paseo' }),
      /refuses the Paseo bridge/);
    assert.equal(f.store.tasks().length, 0, 'nothing is written');
  } finally { await f.close(); }
});

test('registration needs a complexity size and never takes identity from typed input', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      registerTask(f.store, f.adapter, f.profiles, { title: 'Work', description: 'Desc', caller: f.caller } as unknown as Parameters<typeof registerTask>[3]),
      /queue\.complexity is required/);
    // The schema takes no agent, workspace or branch field: the binding cannot
    // be steered from input.
    assert.throws(() => taskRegistrationSchema.parse({ title: 'Work', description: 'Desc', complexity: 'medium', caller: f.caller, agentId: 'someone-else' }), /Unrecognized key/);
    assert.throws(() => taskRegistrationSchema.parse({ title: 'Work', description: 'Desc', complexity: 'medium', caller: f.caller, workspaceId: 'elsewhere' }), /Unrecognized key/);
    assert.throws(() => taskRegistrationSchema.parse({ title: 'Work', description: 'Desc', complexity: 'medium', caller: f.caller, branch: 'elsewhere' }), /Unrecognized key/);
    assert.throws(() => submissionSchema.parse({ submissionId: 'x', title: 'Work', repoPath: f.repo, planningCommit: head, originAgentId: f.caller, responsible: 'yes' }), /responsible/);
  } finally { await f.close(); }
});

test('concurrent registrations claim one worker and worktree exactly once', async () => {
  const f = await fixture();
  try {
    const input = { title: 'Registered work', description: 'Do the thing already in progress', complexity: 'medium' as const, caller: f.caller };
    const [first, second] = await Promise.allSettled([
      registerTask(f.store, f.adapter, f.profiles, input),
      registerTask(f.store, f.adapter, f.profiles, input),
    ]);
    const won = [first, second].filter(result => result.status === 'fulfilled');
    const lost = [first, second].filter(result => result.status === 'rejected');
    assert.equal(won.length, 1, 'exactly one concurrent registration wins');
    assert.equal(lost.length, 1, 'exactly one concurrent registration loses');
    assert.match(String((lost[0] as PromiseRejectedResult).reason), /already belongs to queue task/);
    assert.equal(f.store.tasks().length, 1, 'the worker and worktree are claimed once');
  } finally { await f.close(); }
});

test('a second registration of the same workspace, agent or branch resumes the existing task instead', async () => {
  const f = await fixture();
  try {
    const first = await f.register();
    await assert.rejects(f.register(), new RegExp(`already belongs to queue task ${first.task.id}`));
    assert.equal(f.store.tasks().length, 1);
  } finally { await f.close(); }
});


test('qualified registration callers keep the worker native and the origin qualified', async () => {
 const f=await fixture();try {
  const hostId=f.adapter.hostId;
  const caller=formatAgentId(hostId,f.caller);
  const result=await f.register({caller});
  assert.equal(result.task.originAgentId,caller);
  assert.equal(result.task.notificationAgentId,caller);
  assert.equal(result.task.agentId,f.caller);
  assert.equal(result.workerAgentId,f.caller);
 } finally {await f.close();}
});
