import { profile } from './support/fakes';
import { weighted } from './support/sharded-test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  holdsOf, proofExecutionRecordSchema, reviewEntryRecordSchema, submissionSchema, taskControlInputSchema, taskDetailView,
  type Run, type Task,
} from '../shared/contracts';
import { Store, digest, now } from '../core/store/store';
import { Engine } from '../core/engine';
import { briefDigest } from '../core/planning/brief';
import { QueueRuntime } from '../service/runtime-owner';
import { runPrompt } from '../core/dispatch/prompts';
import { Reports } from '../core/intake/report';
import { holdPatch } from '../core/merge/merge-hold';
import { taskControlOperation } from '../core/verbs/task-control-key';
import { normalizeRepositoryOrigin } from '../shared/lanes';
import type { Adapter, AgentObservation } from '../core/host';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { parseNorthstarDocument } from '../core/planning/handoff';
import { proofHeadAdmission, proofInputRedeclarationAllowed, proofSingleFlightRefusal } from '../core/qa/proof-execution';

/**
 * Task 405: the source-immutable author-side proof executor.
 *
 * These exercise the public task-control and durable-operation routes over a
 * real disposable Git fixture, not only engine or store helpers: a workerless
 * review-entry task with its dispatch and merge holds, an explicit owner
 * activation, a genuine Queue-created executor run on the exact published head,
 * authenticated evidence separate from source authorship, one spent allowance,
 * and independent review still required afterwards.
 *
 * The cases register through the shared shard helper in one physical file.
 */

const runGit = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const executorProfile = profile('executor', 'test/executor');
const reviewerProfile = profile('reviewer', 'test/reviewer');
const owner = 'owner-thread';
const selector = 'effigy test unit -- test/proof-fixture.test.ts';
const inputs = [`sha256:${'e'.repeat(64)}`];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ns-proof-execution-')));
  const origin = join(root, 'github.com', 'example', 'repo.git');
  const repo = join(root, 'repo');
  const workspace = join(root, 'workspace');
  execFileSync('git', ['init', '--bare', origin], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  runGit(repo, 'config', 'user.name', 'Queue Fixture');
  runGit(repo, 'config', 'user.email', 'queue@example.test');
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'docs', 'handoff.md'), 'fixture handoff\n');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  runGit(repo, 'add', '.');
  runGit(repo, 'commit', '-m', 'planning');
  const planningCommit = runGit(repo, 'rev-parse', 'HEAD');
  runGit(repo, 'remote', 'add', 'origin', origin);
  runGit(repo, 'push', '-u', 'origin', 'main');
  runGit(repo, 'worktree', 'add', '-b', 'feature/external', workspace, 'main');
  writeFileSync(join(workspace, 'feature.txt'), 'external change\n');
  runGit(workspace, 'add', 'feature.txt');
  runGit(workspace, 'commit', '-m', 'external implementation');
  const head = runGit(workspace, 'rev-parse', 'HEAD');
  runGit(workspace, 'push', '-u', 'origin', 'feature/external');
  const githubRemote = 'ssh://git@github.com/example/repo.git';
  runGit(repo, 'config', 'remote.origin.url', githubRemote);
  runGit(repo, 'config', `url.${origin}.insteadOf`, githubRemote);

  const prUrl = 'https://github.com/example/repo/pull/41';
  const states = new Map<string, AgentObservation>();
  const created: Run[] = [];
  // Task 582: every fresh create mints a distinct agent id, so a run's agentId
  // identifies the thread that served it and a reuse assertion cannot pass
  // because the fixture happened to reuse one name.
  const runAgents = new Map<string, string>();
  const tokens = new Map<string, string>();
  let createFailure = false;
  let createCount = 0;
  /**
   * Task 407: a Queue-held brief whose frontmatter names the one author-side proof.
   * `declare: false` omits queue.proofExecution, which is how a pre-execution
   * declaration is cleared or corrected. `inputs`/`selector` let one amendment
   * change exactly the declaration and nothing else.
   */
  const briefDocument = (options: { declare?: boolean; selector?: string; inputs?: string[]; body?: string } = {}) => `---\ntitle: Prove the external source\nqueue_approval: 'Owner approved'\nqueue:\n  complexity: high${options.declare === false ? '' : `\n  proofExecution:\n    selector: "${options.selector ?? selector}"\n    inputs: [${(options.inputs ?? inputs).map(input => `"${input}"`).join(', ')}]`}\n---\n\n${options.body ?? 'The external author cannot run the native proof; the owner activates the one brief-named execution.'}\n`;
  // The same isolated intake shape in any store: the main engine's and a real
  // QueueRuntime's, so the public runtime route is exercised over the same task.
  const setupTask = (target: Store, options: { dispatchHeld?: boolean; brief?: { text: string; operative: boolean } } = {}) => {
    target.setMeta('paused', false);
    target.setMeta('pool', [
      { profileId: executorProfile.id, enabled: true, group: 'proof', roles: ['worker'], weight: 1, scopes: ['general'] },
      { profileId: reviewerProfile.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
    ]);
    const brief = options.brief ?? null;
    const submission = submissionSchema.parse({
      submissionId: `proof-${randomUUID()}`, title: 'Prove the external source', repoPath: repo, planningCommit,
      ...(brief ? { brief: { text: brief.text, mediaType: 'text/markdown' } } : { handoffPath: 'docs/handoff.md' }), originAgentId: 'origin',
      // A brief-mode task may name the declaration in its frontmatter while the
      // operative field is absent: the shape an earlier Queue version left behind.
      ...(brief && !brief.operative ? {} : { proofExecution: { selector, inputs } }),
    });
    const inserted = target.insert(submission, 'host', brief ? brief.text : 'fixture handoff\n', planningCommit);
    target.update(inserted.id, {
      entrypoint: 'review', prUrl, prHead: head, resumePrNumber: 41,
      workspaceId: 'workspace', directory: workspace, branch: 'feature/external',
      reviewEntry: reviewEntryRecordSchema.parse({ operationId: 'c'.repeat(64), prNumber: 41, repository: 'example/repo',
        branch: 'feature/external', workspaceId: 'workspace', verifiedHead: head, verifiedBase: planningCommit,
        planningCommit, authority: 'Operator takeover', authorDeclaration: { models: ['openai/gpt-5'], githubAuthor: 'external-author',
          authoringSystem: 'external-agent', attestedBy: 'operator', provenance: 'Fixture attestation' },
        checkedAt: now(), preserveWorkspace: true }),
    } as Partial<Task>);
    if (options.dispatchHeld !== false) target.update(inserted.id, holdPatch(target.task(inserted.id), 'dispatch', owner, 'Owner dispatch fence'));
    target.update(inserted.id, holdPatch(target.task(inserted.id), 'merge', owner, 'Owner merge fence'));
    const project = target.projectFor(repo, normalizeRepositoryOrigin('example/repo'))!;
    target.setProjectPlanner({ key: project.key, agentId: owner, setBy: 'test', note: 'Current project planner' });
    return inserted;
  };
  const makeAdapter = () => ({
    hostId: 'host',
    profiles: async () => [executorProfile, reviewerProfile],
    observe: async (id: string) => states.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', model: 'test/executor', provider: 'test' },
    archiveAgent: async () => {}, notify: async () => {}, findAgents: async () => [],
    findRunAgents: async (run: Run) => {
      const agentId = runAgents.get(run.id);
      return agentId ? [{ id: agentId, workspaceId: run.workspaceId }] : [];
    },
    // Admission of an independent review is out of scope here: the fixture records a
    // transient busy workspace so this task's next review waits instead of dispatching.
    inspectReviewEntry: async () => ({ directory: workspace, originWorkspaceId: 'origin-workspace', busyReason: 'Workspace has an active turn or permission request', busyTransient: true }),
    originAgent: async (id: string) => ({ id, workspaceId: 'origin-workspace', title: 'Origin', archived: false }),
    verifyWorkspace: async () => {},
    verifyPr: async () => ({ url: prUrl, head: runGit(workspace, 'rev-parse', 'HEAD') }),
    createRun: async (_task: Task, run: Run, token: string) => {
      createCount++;
      if (createFailure) { createFailure = false; throw new Error('lost agent creation reply'); }
      created.push(run);
      const agentId = `executor-agent-${createCount}`;
      runAgents.set(run.id, agentId);
      tokens.set(run.id, token);
      states.set(agentId, { id: agentId, workspaceId: run.workspaceId, status: 'running', active: true, permissions: false, error: '', model: 'test/executor', provider: 'test' });
      return { id: agentId, workspaceId: run.workspaceId };
    },
    sendRun: async () => {},
    verifyReview: async () => { throw new Error('A proof execution must never verify a review'); },
    publishReview: async () => { throw new Error('A proof execution must never publish a review'); },
    merge: async () => { throw new Error('A proof execution must never merge'); },
  }) as unknown as Adapter;
  const store = new Store(join(root, 'queue.sqlite'));
  const inserted = setupTask(store);
  const adapter = makeAdapter();
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [executorProfile, reviewerProfile];
  const buildRuntime = () => new QueueRuntime({ dataDir: join(root, `runtime-${randomUUID()}`), adapterFactory: () => makeAdapter(), timers: false });
  // Queue #912: the public route acts through the task's one registered host, which must be online.
  const connectHost = (runtime: QueueRuntime) => {
    (runtime.adapter as unknown as { client?: { isConnected: boolean } }).client = { isConnected: true };
    runtime.hostRegistry.connect('host', 'host-endpoint', { adapter: runtime.adapter, admission: runtime.admission });
  };
  const task = () => store.task(inserted.id);
  const sourceHead = () => runGit(workspace, 'rev-parse', 'HEAD');
  const pushRevision = (message = 'executor mutated source') => {
    writeFileSync(join(workspace, 'feature.txt'), `${message}\n`);
    runGit(workspace, 'add', 'feature.txt');
    runGit(workspace, 'commit', '-m', message);
    const next = sourceHead();
    runGit(workspace, 'push', 'origin', 'feature/external');
    return next;
  };
  const pushRemoteOnly = () => {
    const clone = join(root, `remote-writer-${randomUUID()}`);
    runGit(root, 'clone', origin, clone);
    runGit(clone, 'config', 'user.name', 'Remote writer');
    runGit(clone, 'config', 'user.email', 'writer@example.test');
    runGit(clone, 'checkout', 'feature/external');
    writeFileSync(join(clone, 'remote-only.txt'), 'drift\n');
    runGit(clone, 'add', 'remote-only.txt');
    runGit(clone, 'commit', '-m', 'remote-only drift');
    runGit(clone, 'push', 'origin', 'feature/external');
    return runGit(clone, 'rev-parse', 'HEAD');
  };
  const activationFor = (target: Store, taskId: string, version: number, extra: Record<string, unknown> = {}) => taskControlInputSchema.parse({
    taskId, version, action: 'proof', reason: 'The operator activates the one brief-named author-side proof execution', caller: 'operator (board)', ...extra });
  const activation = () => activationFor(store, inserted.id, task().version);
  const releaseDispatchFor = async (engine: Engine, target: Store, taskId: string) => {
    await engine.performTaskControl(taskControlInputSchema.parse({ taskId, version: target.task(taskId).version, action: 'release', kind: 'dispatch' }));
  };
  const releaseDispatch = () => releaseDispatchFor(engine, store, inserted.id);
  // A control's own wake is asynchronous: settle the queued work before reading a
  // version the next control fences on, exactly as an owner re-reads `next`.
  const settle = async (target: Engine) => { await target.wake(); await target.wake(); };
  const reportFor = async (taskId: string, run: Run, body: Record<string, unknown>) => new Reports(engine).report({
    taskId, runId: run.id, eventId: randomUUID(), head: run.head, ...body,
  } as Parameters<Reports['report']>[0], tokens.get(run.id)!);
  const report = async (run: Run, body: Record<string, unknown>) => reportFor(inserted.id, run, body);
  return {
    root, repo, workspace, planningCommit, head, store, engine, adapter, task, created, tokens, states, selector,
    sourceHead, pushRevision, pushRemoteOnly, activation, activationFor, releaseDispatch, releaseDispatchFor, report, reportFor, setupTask,
    briefDocument, buildRuntime, connectHost, settle,

    setCreateFailure: () => { createFailure = true; }, createCount: () => createCount,
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

weighted(9)('a held workerless review-entry activates one Queue-created executor on the exact published head and keeps both holds', async () => {
  const f = fixture();
  try {
    // The dispatch hold blocks ordinary review admission and the proof executor alike.
    await assert.rejects(f.engine.performTaskControl(f.activation()), /dispatch hold owned by owner-thread blocks the proof executor/);
    assert.equal(f.created.length, 0);
    assert.equal(f.store.runs(f.task().id).length, 0);
    await f.releaseDispatch();
    const before = f.task();
    assert.equal(holdsOf(before).merge?.owner, owner, 'the merge hold is untouched by the dispatch release');
    const paused = f.store.getMeta('paused');
    f.store.setMeta('paused', true);
    await assert.rejects(f.engine.performTaskControl(f.activation()), /Nucleus is paused/);
    assert.equal(f.created.length, 0);
    f.store.setMeta('paused', paused);
    const activated = await f.engine.performTaskControl(f.activation());
    const runs = f.store.runs(f.task().id);
    assert.equal(runs.length, 1);
    const run = runs[0]!;
    assert.equal(run.role, 'executor');
    assert.equal(run.head, f.head);
    assert.equal(run.workspaceId, 'workspace');
    assert.equal(run.proofExecution?.selector, f.selector);
    assert.equal(run.proofExecution?.prNumber, 41);
    assert.equal(activated.phase, before.phase, 'activation dispatches no review and changes no phase');
    assert.equal(activated.agentId, null, 'no source author or worker is adopted');
    assert.equal(activated.reviewEntry?.authorDeclaration.models[0], 'openai/gpt-5');
    assert.equal(activated.resolution.review, null);
    assert.equal(activated.resolution.mergedCommit, null);
    // The evidence is the executor's own identity, never the unchanged source author.
    const record = activated.proofExecutions![0]!;
    assert.equal(record.runId, run.id);
    assert.equal(record.agentId, run.agentId);
    assert.equal(record.head, f.head);
    assert.equal(record.selector, f.selector);
    assert.deepEqual(record.inputs, inputs);
    assert.equal(record.authorizedBy.role, 'operator');
    assert.equal(record.status, 'running');
    assert.deepEqual(activated.reviewEntry?.authorDeclaration.models, ['openai/gpt-5']);
    assert.equal(holdsOf(f.task()).merge?.owner, owner, 'the merge hold still stands after activation');
    assert.equal(holdsOf(f.task()).dispatch, undefined);
  } finally { f.close(); }
});

weighted(1)('proof admission accepts the latest legacy revision at the reviewed published head only', () => {
  const f = fixture();
  try {
    const task = f.task();
    const reviewerRunId = randomUUID();
    const reviewCompletion = { eventId: randomUUID(), taskId: task.id, runId: reviewerRunId,
      status: 'blocked' as const, summary: 'Source approved; proof remains', head: f.head, prNumber: 41,
      reviewResponsibility: 'environment' as const, sourceApproved: true as const, awaitingProofs: [selector],
      reviewText: 'The source is approved at the published head.' };
    const reviewedTask = { ...task, prHead: f.head,
      resolution: { ...task.resolution, review: reviewCompletion } };
    const historicalExecutor = { id: randomUUID(), role: 'executor', head: f.planningCommit,
      released: true, completion: null, proofExecution: undefined } as const;
    const reviewer = { id: reviewerRunId, role: 'reviewer', head: f.head,
      released: true, completion: reviewCompletion, proofExecution: undefined } as const;
    const revision = (completion: Record<string, unknown>) => ({ id: randomUUID(), role: 'revision',
      head: f.planningCommit, released: true, completion, proofExecution: undefined } as const);
    const legacyRevision = revision({ eventId: randomUUID(), taskId: task.id, runId: randomUUID(),
      status: 'ready_for_review', summary: 'Published legacy revision', prNumber: 41 });
    const runs = [historicalExecutor, legacyRevision, reviewer] as unknown as Parameters<typeof proofHeadAdmission>[1];
    assert.equal(proofHeadAdmission(reviewedTask, runs, f.head), null);
    assert.equal(proofInputRedeclarationAllowed(reviewedTask, runs, f.head), true);

    const oldHeadRevision = revision({ eventId: randomUUID(), taskId: task.id, runId: randomUUID(),
      status: 'ready_for_review', summary: 'Older revision published another head', head: 'a'.repeat(40), prNumber: 41 });
    const oldRuns = [historicalExecutor, oldHeadRevision, reviewer] as unknown as Parameters<typeof proofHeadAdmission>[1];
    assert.match(proofHeadAdmission(reviewedTask, oldRuns, f.head) ?? '', /requires an authenticated author revision/);
    assert.equal(proofInputRedeclarationAllowed(reviewedTask, oldRuns, f.head), false);

    const noRevisionRuns = [historicalExecutor, reviewer] as unknown as Parameters<typeof proofHeadAdmission>[1];
    assert.match(proofHeadAdmission(reviewedTask, noRevisionRuns, f.head) ?? '', /requires an authenticated author revision/);
    assert.equal(proofInputRedeclarationAllowed(reviewedTask, noRevisionRuns, f.head), false);

    const historicalOwnerReceipt = { ...reviewedTask, resolution: { ...reviewedTask.resolution,
      externalOwnerRevisions: [{ head: f.head }] } } as unknown as Task;
    assert.match(proofHeadAdmission(historicalOwnerReceipt, noRevisionRuns, f.head) ?? '', /requires an authenticated author revision/);
    assert.equal(proofInputRedeclarationAllowed(historicalOwnerReceipt, noRevisionRuns, f.head), false);
  } finally { f.close(); }
});

weighted(1)('a legacy inferred refusal cannot free its exact head', () => {
  const f = fixture();
  try {
    const task = f.task();
    const reviewerRunId = randomUUID();
    const revisionRunId = randomUUID();
    const refusedRunId = randomUUID();
    const approval = { eventId: randomUUID(), taskId: task.id, runId: reviewerRunId,
      status: 'blocked' as const, summary: 'Source approved; proof remains', head: f.head, prNumber: 41,
      sourceApproved: true as const, awaitingProofs: [selector] };
    const reviewedTask = { ...task, prHead: f.head,
      resolution: { ...task.resolution, review: approval },
      proofExecutions: [proofExecutionRecordSchema.parse({ runId: refusedRunId, agentId: 'executor-agent', workspaceId: 'workspace', profile: null,
        operationId: null, selector, inputs, repository: task.repository, prNumber: 41, branch: task.branch, head: f.head,
        briefVersion: null, briefDigest: null, authorizedBy: { role: 'project_owner' as const, caller: null, note: null },
        activatedAt: new Date().toISOString(), settledAt: new Date().toISOString(), status: 'unknown' as const,
        exitCode: null, evidence: '', refusedBeforeSelector: true })] };
    const revision = { id: revisionRunId, role: 'revision', head: f.head, released: true,
      completion: { eventId: randomUUID(), taskId: task.id, runId: revisionRunId,
        status: 'ready_for_review' as const, summary: 'Published at current head', head: f.head, prNumber: 41 } } as const;
    const reviewer = { id: reviewerRunId, role: 'reviewer', head: f.head, released: true, completion: approval } as const;
    const refusedRun = { id: refusedRunId, role: 'executor', head: f.head, released: true,
      completion: { status: 'error' as const, proofResult: undefined } } as const;
    const runs = [revision, reviewer, refusedRun] as unknown as Parameters<typeof proofHeadAdmission>[1];
    assert.match(proofHeadAdmission(reviewedTask, runs, f.head) ?? '', /already reserved at/);
    assert.equal(proofInputRedeclarationAllowed(reviewedTask, runs, f.head), false);
    assert.match(proofSingleFlightRefusal(reviewedTask, runs as unknown as Parameters<typeof proofSingleFlightRefusal>[1], f.head) ?? '', /already reserved at/);
    const started = { ...refusedRun, id: randomUUID(), completion: null, released: false };
    const withStarted = [...runs, started] as unknown as Parameters<typeof proofHeadAdmission>[1];
    assert.match(proofHeadAdmission(reviewedTask, withStarted, f.head) ?? '', /already reserved at/);
    assert.match(proofSingleFlightRefusal(reviewedTask, withStarted as unknown as Parameters<typeof proofSingleFlightRefusal>[1], f.head) ?? '', /already dispatched and unreleased/);
  } finally { f.close(); }
});

weighted(1)('proof admission treats an authenticated exact-head ready review as source approval', () => {
  const f = fixture();
  try {
    const task = f.task();
    const reviewerRunId = randomUUID();
    const reviewCompletion = { eventId: randomUUID(), taskId: task.id, runId: reviewerRunId,
      status: 'ready_to_merge' as const, summary: 'Source approved', head: f.head, prNumber: 41,
      reviewText: 'The source is approved at this head.' };
    const reviewedTask = { ...task, prHead: f.head,
      resolution: { ...task.resolution, review: reviewCompletion } };
    const historicalExecutor = { id: randomUUID(), role: 'executor', head: f.planningCommit,
      released: true, completion: null, proofExecution: undefined } as const;
    const reviewer = { id: reviewerRunId, role: 'reviewer', head: f.head,
      released: true, completion: reviewCompletion, proofExecution: undefined } as const;
    const revision = { id: randomUUID(), role: 'revision', head: f.head, released: true,
      completion: { eventId: randomUUID(), taskId: task.id, runId: randomUUID(),
        status: 'ready_for_review', summary: 'Published at current head', head: f.head, prNumber: 41 },
      proofExecution: undefined } as const;
    const runs = [historicalExecutor, revision, reviewer] as unknown as Parameters<typeof proofHeadAdmission>[1];
    assert.equal(proofHeadAdmission(reviewedTask, runs, f.head), null);
    assert.equal(proofInputRedeclarationAllowed(reviewedTask, runs, f.head), true);
  } finally { f.close(); }
});

weighted(2)('a second activation observes the spent allowance and never repeats the counted proof', async () => {
  const f = fixture();
  try {
    await f.releaseDispatch();
    await f.engine.performTaskControl(f.activation());
    const spent = f.task();
    assert.equal(f.createCount(), 1);
    await assert.rejects(f.engine.performTaskControl(f.activation()), /already reserved at/);
    assert.equal(f.createCount(), 1, 'no second executor is created');
    assert.equal(f.task().proofExecutions!.length, 1);
    assert.equal(f.task().version, spent.version);
  } finally { f.close(); }
});

weighted(8)('a failed proof can run once at a corrected, source-approved head with a new input declaration', async () => {
  const f = fixture();
  try {
    const task = f.setupTask(f.store, { brief: { text: f.briefDocument(), operative: true }, dispatchHeld: false });
    const current = () => f.store.task(task.id);
    const activation = () => f.activationFor(f.store, task.id, current().version);
    const report = (run: Run, body: Record<string, unknown>) => f.reportFor(task.id, run, body);
    await f.engine.performTaskControl(activation());
    f.store.update(task.id, holdPatch(current(), 'dispatch', owner, 'Hold while author repairs the proof failure'));
    const firstRun = f.store.runs(task.id).find(run => run.role === 'executor')!;
    f.states.set(firstRun.agentId!, { id: firstRun.agentId!, workspaceId: 'workspace', status: 'idle', active: false,
      permissions: false, error: '', model: 'test/executor', provider: 'test' });
    const failed = await report(firstRun, { status: 'proof_executed', summary: 'Four cases failed at the original source',
      proofResult: { status: 'failed', selector, exitCode: 1, evidence: 'Four cases failed' } });
    assert.equal((failed as { accepted: boolean }).accepted, true);
    await f.engine.wake(); await f.engine.wake();
    const firstReceipt = current().proofExecutions![0]!;
    assert.equal(firstReceipt.head, f.head);
    assert.equal(firstReceipt.status, 'failed');
    f.store.putRun({ ...f.store.run(firstRun.id)!, released: true, status: 'finished' });

    const correctedHead = f.pushRevision('corrected source');
    const revisionRunId = randomUUID();
    const reviewerRunId = randomUUID();
    const revisionCompletion = { eventId: randomUUID(), taskId: task.id, runId: revisionRunId,
      status: 'ready_for_review' as const, summary: 'Author corrected the four failing cases', head: correctedHead, prNumber: 41 };
    const reviewCompletion = { eventId: randomUUID(), taskId: task.id, runId: reviewerRunId,
      status: 'blocked' as const, summary: 'Source approved; proof remains', head: correctedHead, prNumber: 41,
      reviewResponsibility: 'environment' as const, sourceApproved: true as const, awaitingProofs: [selector],
      reviewText: 'The corrected source is approved; judge the arriving proof.' };
    // Retain released author and reviewer receipts at B without dispatching those unrelated roles.
    f.store.putRun({ ...firstRun, id: revisionRunId, role: 'revision', head: correctedHead,
      completion: revisionCompletion, proofExecution: undefined, released: true, status: 'finished', agentId: 'author-agent' } as Run);
    f.store.putRun({ ...firstRun, id: reviewerRunId, role: 'reviewer', head: correctedHead,
      completion: reviewCompletion, proofExecution: undefined, released: true, status: 'finished', agentId: 'reviewer-agent' } as Run);
    f.store.update(task.id, { prHead: correctedHead, phase: 'awaiting_review', resolution: { ...current().resolution, review: reviewCompletion } });

    const changedInput = `sha256:${'f'.repeat(64)}`;
    const changedBrief = f.briefDocument({ inputs: [changedInput], body: 'Inputs refreshed for the corrected source.' });
    const amended = await f.engine.performTaskControl(amendControl(task.id, current().version, changedBrief));
    assert.deepEqual((amended as Task).proofExecution?.inputs, [changedInput]);
    const selectorChange = f.briefDocument({ selector: 'effigy test unit -- test/other.test.ts', inputs: [changedInput] });
    await assert.rejects(f.engine.performTaskControl(amendControl(task.id, current().version, selectorChange)), /selector is immutable/);

    await f.releaseDispatchFor(f.engine, f.store, task.id);
    await f.engine.performTaskControl(activation());
    const secondRun = f.store.runs(task.id).find(run => run.role === 'executor' && run.head === correctedHead)!;
    assert.ok(secondRun);
    assert.equal(secondRun.agentId, firstRun.agentId, 'the next exact-head proof continues the task\'s retained executor thread');
    assert.deepEqual(secondRun.proofExecution?.inputs, [changedInput]);
    assert.equal(current().proofExecutions!.length, 2);
    assert.deepEqual(current().proofExecutions![0], firstReceipt, 'the original failed receipt remains unchanged');
    const version = current().version;
    await assert.rejects(f.engine.performTaskControl(activation()), /already reserved at/);
    assert.equal(f.store.runs(task.id).filter(run => run.role === 'executor').length, 2);
    assert.equal(current().version, version);
  } finally { f.close(); }
});

weighted(2)('source drift refuses activation before any dispatch and keeps the allowance unspent', async () => {
  const f = fixture();
  try {
    await f.releaseDispatch();
    f.pushRemoteOnly();
    await assert.rejects(f.engine.performTaskControl(f.activation()), /source drifted before the proof executor observed it|not the expected head/);
    assert.equal(f.created.length, 0);
    assert.equal(f.task().proofExecutions!.length, 0);
    assert.equal(f.store.tasks().some(task => f.store.runs(task.id).some(run => run.role === 'executor')), false);
  } finally { f.close(); }
});

weighted(2)('tracked source mutation at the pinned head refuses activation', async () => {
  const f = fixture();
  try {
    await f.releaseDispatch();
    writeFileSync(join(f.workspace, 'README.md'), 'mutated after publication\n');
    await assert.rejects(f.engine.performTaskControl(f.activation()), /requires source identical to the published head/);
    assert.equal(f.created.length, 0);
    assert.equal(f.task().proofExecutions!.length, 0);
  } finally {
    runGit(f.workspace, 'checkout', '--', 'README.md');
    f.close();
  }
});

weighted(4)('an authenticated passing report records separate executor evidence and leaves independent review required', async () => {
  const f = fixture();
  try {
    await f.releaseDispatch();
    await f.engine.performTaskControl(f.activation());
    const run = f.store.runs(f.task().id)[0]!;
    f.states.set(run.agentId!, { id: run.agentId!, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', model: 'test/executor', provider: 'test' });
    const response = await f.report(run, { status: 'proof_executed', summary: 'Ran the brief selector once at the published head',
      proofResult: { status: 'passed', selector, exitCode: 0, evidence: 'effigy test unit -- test/proof-fixture.test.ts: 4 passing' } });
    assert.equal((response as { accepted: boolean }).accepted, true);
    await f.engine.wake(); await f.engine.wake();
    const task = f.task();
    assert.equal(f.store.run(run.id)!.released, true);
    assert.equal(task.proofExecutions![0]!.status, 'passed');
    assert.equal(task.proofExecutions![0]!.settledAt !== null, true);
    assert.equal(task.proofExecutions![0]!.evidence.includes('4 passing'), true);
    assert.equal(task.resolution.review, null, 'a proof execution mints no review');
    assert.equal(task.resolution.mergedCommit, null);
    assert.equal(task.prHead, f.head);
    // The task returns to its pre-activation phase; review dispatch is a separate run.
    assert.equal(task.phase, 'queued');
    assert.equal(f.store.runs(task.id).filter(item => item.role === 'reviewer').length, 0);
    assert.equal(f.store.eventsAll(task.id).some(event => event.kind === 'proof_execution_settled' && /a distinct independent review is still required/.test(event.detail)), true);
    assert.equal(holdsOf(task).merge?.owner, owner);
  } finally { f.close(); }
});

weighted(4)('an owner can retire a settled proof declaration once and cannot name another selector', async () => {
  const f = fixture();
  try {
    const task = f.setupTask(f.store, { brief: { text: f.briefDocument(), operative: true } });
    await f.releaseDispatchFor(f.engine, f.store, task.id);
    const activation = taskControlInputSchema.parse({ taskId: task.id, version: f.store.task(task.id).version, action: 'proof',
      caller: 'operator (board)', reason: 'Run the declared proof once' });
    await f.engine.performTaskControl(activation);
    const run = f.store.runs(task.id)[0]!;
    f.states.set(run.agentId!, { id: run.agentId!, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', model: 'test/executor', provider: 'test' });
    await f.reportFor(task.id, run, { status: 'proof_executed', summary: 'Ran the brief selector once at the published head',
      proofResult: { status: 'failed', selector, exitCode: 1, evidence: 'The old input root is no longer usable.' } });
    await f.engine.wake(); await f.engine.wake();
    const before = f.store.task(task.id);
    const history = structuredClone(before.proofExecutions);
    assert.equal(before.proofExecutions[0]!.status, 'failed');
    assert.equal(before.proofExecutions[0]!.settledAt !== null, true);

    const retiredBrief = f.briefDocument({ declare: false, body: 'The selector is spent; separate proof-only tasks now cover the source.' });
    const amended = await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: before.id, version: before.version,
      action: 'amend_brief', brief: retiredBrief, caller: 'operator (board)', reason: 'Retire the spent selector; current proof runs are separate tasks' }));
    assert.equal(amended.proofExecution, undefined);
    assert.equal(amended.proofExecutionRetired, true);
    assert.deepEqual(amended.proofExecutions, history, 'retirement does not rewrite proof history');
    assert.equal(taskDetailView(amended).proofExecutionRetired, true, 'task detail exposes retirement');
    assert.equal(ownerTaskNext(collectOwnerVerbFacts(f.store, amended)).proofExecutionRetired, true);
    assert.equal(ownerTaskNext(collectOwnerVerbFacts(f.store, amended)).verbs.some(verb => verb.verb === 'proof'), false,
      'task.next does not offer the retired proof action');
    assert.ok(f.store.eventsAll(before.id).some(event => event.kind === 'brief_proof_execution_retired'
      && event.detail.includes('Retire the spent selector')));

    const nextHeadBrief = f.briefDocument({ body: 'A later source-only correction has independent proof coverage.' });
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: amended.id, version: amended.version,
      action: 'amend_brief', brief: nextHeadBrief, caller: 'operator (board)', reason: 'Record a later source correction' })),
    /retired its author-side proof declaration/);
    const unchanged = f.store.task(task.id);
    assert.equal(unchanged.version, amended.version, 'a later declaration is refused without a partial write');
    assert.deepEqual(unchanged.proofExecutions, history);
  } finally { f.close(); }
});

weighted(3)('a result naming another selector or omitting proofResult is refused', async () => {
  const f = fixture();
  try {
    await f.releaseDispatch();
    await f.engine.performTaskControl(f.activation());
    const run = f.store.runs(f.task().id)[0]!;
    await assert.rejects(f.report(run, { status: 'proof_executed', summary: 'no result field' }), /must carry proofResult/);
    await assert.rejects(f.report(run, { status: 'proof_executed', summary: 'wrong selector',
      proofResult: { status: 'passed', selector: 'cargo test', exitCode: 0 } }), /must name the run's declared selector/);
    assert.equal(f.store.run(run.id)!.completion, null);
  } finally { f.close(); }
});

weighted(2)('source mutation during execution refuses the passing claim and retains conservative evidence', async () => {
  const f = fixture();
  try {
    await f.releaseDispatch();
    await f.engine.performTaskControl(f.activation());
    const run = f.store.runs(f.task().id)[0]!;
    f.pushRevision('executor committed to source');
    await assert.rejects(f.report(run, { status: 'proof_executed', summary: 'claims a pass',
      proofResult: { status: 'passed', selector, exitCode: 0 } }), /must observe the exact published head|source/i);
    assert.equal(f.store.run(run.id)!.completion, null, 'no passing receipt is accepted after source moved');
    const blocked = await f.report(run, { status: 'blocked', summary: 'Source moved during the run' });
    assert.equal((blocked as { accepted: boolean }).accepted, true);
    await f.engine.wake(); await f.engine.wake();
    const task = f.task();
    assert.equal(task.proofExecutions![0]!.status, 'unknown');
    assert.equal(task.proofExecutions![0]!.selectorStart, 'unknown');
    assert.match(task.proofExecutions![0]!.evidence, /Source moved during the run/);
    assert.equal(task.resolution.review, null);
  } finally { await f.engine.stop(); f.close(); }
});

weighted(2)('a lost agent-creation reply is never retried and the allowance stays spent', async () => {
  const f = fixture();
  try {
    await f.releaseDispatch();
    f.setCreateFailure();
    await assert.rejects(f.engine.performTaskControl(f.activation()), /lost agent creation reply/);
    const run = f.store.runs(f.task().id)[0]!;
    assert.equal(run.status, 'uncertain');
    assert.equal(run.agentId, null);
    assert.equal(f.createCount(), 1);
    await assert.rejects(f.engine.performTaskControl(f.activation()), /already reserved at/);
    assert.equal(f.createCount(), 1, 'unknown delivery is observed, never re-dispatched');
    assert.equal(f.store.runs(f.task().id).length, 1);
  } finally { f.close(); }
});

weighted(2)('the durable task-control operation is the activation route and reports the same run', async () => {
  const f = fixture();
  try {
    await f.releaseDispatch();
    // Let the release's own wake settle before taking the version the operation expects.
    await f.engine.wake();
    const control = f.activation();
    const { key, payload } = taskControlOperation(control);
    const accepted = await f.engine.startOperation({ key, kind: 'task_control', payload, taskId: control.taskId, expectedVersion: control.version });
    assert.ok('accepted' in accepted);
    const settled = await f.engine.awaitOperation(accepted.operation.id, 10000);
    assert.equal(settled.state, 'succeeded', String(settled.diagnostic));
    const task = f.task();
    assert.equal(task.proofExecutions!.length, 1);
    const run = f.store.runs(task.id)[0]!;
    assert.equal(task.proofExecutions![0]!.operationId, accepted.operation.id);
    assert.equal(task.proofExecutions![0]!.runId, run.id);
    // Repeating the identical caller key and input returns the same operation.
    const repeated = await f.engine.startOperation({ key, kind: 'task_control', payload, taskId: control.taskId, expectedVersion: control.version });
    assert.ok('accepted' in repeated);
    assert.equal(repeated.operation.id, accepted.operation.id);
    assert.equal(f.createCount(), 1);
  } finally { f.close(); }
});

weighted(1)('a brief frontmatter names the one authorized selector and its input hashes', () => {
  const text = `---\ntitle: External source proof\nqueue_approval: 'Owner approved'\nqueue:\n  complexity: high\n  proofExecution:\n    selector: "effigy test unit -- test/x.test.ts"\n    inputs: ["sha256:${'e'.repeat(64)}"]\n---\n\nBody scope.\n`;
  const metadata = parseNorthstarDocument(text, 'brief') as { queue: { proofExecution?: { selector: string; inputs: string[]; role: string } } };
  assert.equal(metadata.queue.proofExecution?.selector, 'effigy test unit -- test/x.test.ts');
  assert.deepEqual(metadata.queue.proofExecution?.inputs, [`sha256:${'e'.repeat(64)}`]);
  assert.equal(metadata.queue.proofExecution?.role, 'author');
  assert.throws(() => parseNorthstarDocument(`---\ntitle: Bad\nqueue_approval: x\nqueue:\n  proofExecution:\n    selector: ""\n---\n\nBody.\n`, 'brief'), /Invalid brief frontmatter/);
});

weighted(2)('task.next offers the proof activation and then names the spent allowance', async () => {
  const f = fixture();
  try {
    await f.releaseDispatch();
    await f.engine.wake();
    const next = () => ownerTaskNext(collectOwnerVerbFacts(f.store, f.task()));
    const before = next().verbs.find(verb => verb.verb === 'proof')!;
    assert.equal(before.available, true);
    assert.deepEqual(before.args, { action: 'proof', taskId: f.task().id, version: f.task().version });
    assert.deepEqual(before.fill, ['reason']);
    await f.engine.performTaskControl(f.activation());
    const after = next().verbs.find(verb => verb.verb === 'proof')!;
    assert.equal(after.available, false);
    assert.match(after.refusal!, /already reserved at/);
  } finally { f.close(); }
});

weighted(3)('an exhausted awaiting_proof task can extend its budget before activating proof', async () => {
  const f = fixture();
  try {
    await f.releaseDispatch();
    f.store.update(f.task().id, { budgetSince: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString() });
    f.engine.resolution.recordStop(f.task(), 'awaiting_proof', 'Waiting for the declared proof');
    const next = () => ownerTaskNext(collectOwnerVerbFacts(f.store, f.task()));
    assert.equal(next().verbs.find(verb => verb.verb === 'extend_budget')?.available, true);
    const runsBeforeExtension = f.store.runs(f.task().id).length;
    await f.engine.performTaskControl({ taskId: f.task().id, version: f.task().version, action: 'extend_budget',
      reason: 'continue proof', caller: 'operator (board)' });
    assert.equal(f.store.runs(f.task().id).length, runsBeforeExtension, 'extension itself starts no worker turn');
    assert.equal(f.task().resolution.stop?.reason, 'awaiting_proof', 'extension leaves the proof wait in place');
    await f.engine.performTaskControl(f.activation());
    assert.equal(f.store.runs(f.task().id).filter(run => run.role === 'executor').length, 1);
    assert.equal(f.created.length, 1);
  } finally { f.close(); }
});

weighted(3)('the public RuntimeOwner.taskControl route admits a relayed operator activation over its durable operation', async () => {
  const f = fixture();
  const runtime = f.buildRuntime();
  try {
    // The public service loads its profile catalog on start; activation needs it.
    await runtime.started;
    f.connectHost(runtime);
    runtime.engine.profiles = [executorProfile, reviewerProfile];
    // The owner already released the dispatch hold; the merge hold stands.
    const task = f.setupTask(runtime.store, { dispatchHeld: false });
    // A relayed activation carries the recorded operator note, exactly as a relayed merge acceptance does.
    assert.throws(() => taskControlInputSchema.parse({ taskId: task.id, version: task.version, action: 'proof',
      caller: 'relay-thread', relayed: true, reason: 'Relay the activation' }), /operator authorization note/);
    const control = f.activationFor(runtime.store, task.id, runtime.store.task(task.id).version,
      { caller: 'relay-thread', relayed: true, note: 'Tom authorized the one author-side proof execution' });
    const applied = await runtime.taskControl(control) as Task;
    assert.equal(applied.id, task.id);
    const after = runtime.store.task(task.id);
    assert.equal(after.proofExecutions!.length, 1);
    assert.equal(after.proofExecutions![0]!.authorizedBy.role, 'authorized_relay');
    assert.equal(after.proofExecutions![0]!.authorizedBy.note, 'Tom authorized the one author-side proof execution');
    const runs = runtime.store.runs(task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.role, 'executor');
    assert.equal(runs[0]!.head, f.head);
    assert.equal(f.created.length, 1);
    assert.equal(holdsOf(after).merge?.owner, owner, 'the merge hold is untouched by the public activation');
    // The same durable task_control operation `queue.task` accepted settled with the task result.
    const { key } = taskControlOperation(control);
    const operation = runtime.store.operationForKey(key)!;
    assert.equal(operation.kind, 'task_control');
    assert.equal(operation.state, 'succeeded', operation.diagnostic);
    assert.equal(operation.result?.taskId, task.id);
    assert.equal(runtime.store.operations({ taskId: task.id }).filter(item => item.kind === 'task_control').length, 1);
    // A second public call observes the spent allowance and never repeats the counted proof.
    await assert.rejects(runtime.engine.performTaskControl(f.activationFor(runtime.store, task.id, runtime.store.task(task.id).version,
      { caller: 'relay-thread', relayed: true, note: 'Second attempt' })), /already reserved at/);
    assert.equal(f.created.length, 1);
  } finally { await runtime.stop(); f.close(); }
});

weighted(2)('the executor prompt forbids source writes and carries no worker validation or commit instruction', async () => {
  const f = fixture();
  try {
    await f.releaseDispatch();
    await f.engine.performTaskControl(f.activation());
    const task = f.task();
    const run = f.store.runs(task.id)[0]!;
    const prompt = runPrompt(task, run, '/helper', '/ticket', false);
    assert.ok(prompt.includes(selector), 'the bound selector travels to the executor');
    assert.ok(prompt.includes(run.head), 'the exact published head is named');
    assert.match(prompt, /do not edit tracked files, stage, commit, push, switch or rename branches/);
    assert.match(prompt, /proof_executed/);
    for (const forbidden of ['Commit and push finished work', 'Use Effigy selectors for validation', 'A check the operator validation rule requires',
      'run the checks the operator validation rule requires', 'northstar-report']) {
      assert.equal(prompt.includes(forbidden), false, `the executor prompt must not carry: ${forbidden}`);
    }
  } finally { f.close(); }
});

/**
 * Task 407: the accepted brief is the operative proof declaration.
 *
 * These exercise the public amendment envelope (`queue.task` action
 * `amend_brief` through a real QueueRuntime) and then the durable `proof`
 * operation, over the same disposable Git fixture. The reported shape is the
 * Project-C #143 one: a held workerless review-entry task whose brief frontmatter
 * names `queue.proofExecution` while the task's operative field is absent, so
 * the `proof` verb has nothing to activate.
 */
const amendControl = (taskId: string, version: number, brief: string) => taskControlInputSchema.parse({
  taskId, version, action: 'amend_brief', brief, caller: 'operator (board)',
  reason: 'The brief carries the author-side proof declaration',
});
const proofControl = (taskId: string, version: number) => taskControlInputSchema.parse({
  taskId, version, action: 'proof', caller: 'operator (board)',
  reason: 'The operator activates the one brief-named author-side proof execution',
});

weighted(2)('a public amend_brief binds the declaration an existing held brief already names', async () => {
  const f = fixture();
  const runtime = f.buildRuntime();
  try {
    await runtime.started;
    f.connectHost(runtime);
    runtime.engine.profiles = [executorProfile, reviewerProfile];
    const task = f.setupTask(runtime.store, { brief: { text: f.briefDocument(), operative: false } });
    const before = runtime.store.task(task.id);
    assert.deepEqual(before.briefVersions.map(item => item.version), [1]);
    assert.match(before.briefVersions[0]!.text, /proofExecution/);
    assert.equal(before.proofExecution, undefined, 'the old brief names the proof and the operative field was never set');
    // The inconsistency is the reported one: the route is advertised by the brief and absent from the task.
    await assert.rejects(runtime.engine.performTaskControl(proofControl(task.id, before.version)), /names no author-side proof selector/);
    assert.deepEqual(runtime.store.runs(task.id), []);

    // The owner amends the body and keeps the declaration: one versioned write binds both.
    const amendedText = f.briefDocument({ body: 'The external author cannot run the native proof; the owner notes why.' });
    const amended = await runtime.taskControl(amendControl(task.id, before.version, amendedText)) as Task;
    assert.deepEqual(amended.proofExecution, { selector: f.selector, inputs, role: 'author' });
    assert.deepEqual(amended.briefVersions.map(item => item.version), [1, 2]);
    assert.equal(amended.briefVersions[1]!.digest, briefDigest(amendedText));
    assert.equal(amended.handoffText, amendedText);
    assert.equal(amended.version, before.version + 1, 'the brief and the declaration move in one mutation');
    // Task identity, intake, source, PR, head, workspace and both holds stay exact; nothing ran.
    assert.equal(amended.id, before.id);
    assert.equal(amended.number, before.number);
    assert.equal(amended.reviewEntry?.operationId, before.reviewEntry?.operationId);
    assert.deepEqual(amended.reviewEntry?.authorDeclaration, before.reviewEntry?.authorDeclaration);
    assert.equal(amended.prUrl, before.prUrl);
    assert.equal(amended.prHead, before.prHead);
    assert.equal(amended.workspaceId, before.workspaceId);
    assert.equal(amended.directory, before.directory);
    assert.equal(amended.branch, before.branch);
    assert.equal(amended.planningCommit, before.planningCommit);
    assert.equal(amended.agentId, null);
    assert.equal(amended.resolution.review, null);
    assert.deepEqual(amended.proofExecutions, []);
    assert.deepEqual(runtime.store.runs(task.id), []);
    assert.equal(f.created.length, 0);
    assert.equal(holdsOf(amended).dispatch?.owner, owner);
    assert.equal(holdsOf(amended).merge?.owner, owner);
    assert.ok(runtime.store.eventsAll(task.id).some(event => event.kind === 'brief_proof_execution_changed'
      && event.detail.includes(f.selector) && event.detail.includes('no declaration')));

    // The dispatch hold still blocks activation; only the owner's release allows the one reservation.
    await assert.rejects(runtime.taskControl(proofControl(task.id, runtime.store.task(task.id).version)), /dispatch hold owned by owner-thread blocks the proof executor/);
    assert.deepEqual(runtime.store.runs(task.id), []);
    assert.equal(f.created.length, 0);
    await f.releaseDispatchFor(runtime.engine, runtime.store, task.id);
    await f.settle(runtime.engine);
    assert.equal(holdsOf(runtime.store.task(task.id)).merge?.owner, owner, 'the merge hold is untouched');
    const control = proofControl(task.id, runtime.store.task(task.id).version);
    const activated = await runtime.taskControl(control) as Task;
    const runs = runtime.store.runs(task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.role, 'executor');
    assert.equal(runs[0]!.head, f.head);
    assert.equal(runs[0]!.proofExecution?.selector, f.selector);
    assert.deepEqual(runs[0]!.proofExecution?.inputs, inputs);
    assert.equal(runs[0]!.proofExecution?.briefVersion, 2);
    assert.equal(runs[0]!.proofExecution?.briefDigest, briefDigest(amendedText));
    assert.equal(activated.proofExecutions!.length, 1);
    assert.equal(activated.proofExecutions![0]!.runId, runs[0]!.id);
    assert.equal(activated.proofExecutions![0]!.selector, f.selector);
    assert.equal(holdsOf(activated).merge?.owner, owner);
    assert.equal(f.created.length, 1);
    const operation = runtime.store.operationForKey(taskControlOperation(control).key)!;
    assert.equal(operation.state, 'succeeded', operation.diagnostic);
    assert.equal(activated.proofExecutions![0]!.operationId, operation.id);
  } finally { await runtime.stop(); f.close(); }
});

weighted(2)('once the executor is reserved only a body-only amendment is compatible and nothing resets the allowance', async () => {
  const f = fixture();
  const runtime = f.buildRuntime();
  try {
    await runtime.started;
    f.connectHost(runtime);
    runtime.engine.profiles = [executorProfile, reviewerProfile];
    const task = f.setupTask(runtime.store, { brief: { text: f.briefDocument(), operative: false } });
    const bound = await runtime.taskControl(amendControl(task.id, runtime.store.task(task.id).version,
      f.briefDocument({ body: 'Body note before the one reservation.' }))) as Task;
    assert.equal(bound.proofExecution?.selector, f.selector);
    await assert.rejects(runtime.taskControl(proofControl(task.id, runtime.store.task(task.id).version)), /dispatch hold/);
    assert.equal(f.created.length, 0);
    await f.releaseDispatchFor(runtime.engine, runtime.store, task.id);
    await f.settle(runtime.engine);
    await runtime.taskControl(proofControl(task.id, runtime.store.task(task.id).version));
    const reserved = runtime.store.task(task.id);
    assert.equal(runtime.store.runs(task.id).length, 1);
    assert.equal(reserved.proofExecutions!.length, 1);
    const baseline = {
      version: reserved.version, versions: reserved.briefVersions.length, text: reserved.handoffText,
      declaration: reserved.proofExecution, runs: runtime.store.runs(task.id).length, executions: reserved.proofExecutions!.length,
    };
    const amendTo = (options: { declare?: boolean; selector?: string; inputs?: string[]; body?: string }) =>
      runtime.taskControl(amendControl(task.id, runtime.store.task(task.id).version, f.briefDocument(options))) as Promise<unknown>;
    // A different selector, different input hashes and removal are each refused with nothing written.
    for (const options of [
      { body: 'Only the selector moves.', selector: 'effigy test unit -- test/another.test.ts' },
      { body: 'Only the input hashes move.', inputs: [`sha256:${'f'.repeat(64)}`] },
      { body: 'The declaration is removed.', declare: false },
    ]) {
      await assert.rejects(amendTo(options), options.inputs
        ? /input hashes may be re-declared only for a new head/
        : /already reserved an author-side proof execution .*selector is immutable/);
      const after = runtime.store.task(task.id);
      assert.equal(after.version, baseline.version, 'a refused amendment writes nothing');
      assert.equal(after.briefVersions.length, baseline.versions);
      assert.equal(after.handoffText, baseline.text);
      assert.deepEqual(after.proofExecution, baseline.declaration);
      assert.equal(after.proofExecutions!.length, baseline.executions);
      assert.equal(runtime.store.runs(task.id).length, baseline.runs);
    }
    // An exact body-only amendment is compatible: a new brief version, no second credit.
    const bodyOnly = await runtime.taskControl(amendControl(task.id, runtime.store.task(task.id).version,
      f.briefDocument({ body: 'The owner records the one proof outcome in the body.' }))) as Task;
    assert.equal(bodyOnly.briefVersions.length, baseline.versions + 1);
    assert.deepEqual(bodyOnly.proofExecution, baseline.declaration);
    assert.equal(bodyOnly.proofExecutions!.length, baseline.executions);
    assert.equal(runtime.store.runs(task.id).length, baseline.runs, 'no second executor is reserved');
    assert.equal(f.created.length, 1);
    assert.equal(holdsOf(bodyOnly).merge?.owner, owner);
    // The spent allowance is still the authority: a second activation never repeats the counted proof.
    await assert.rejects(runtime.taskControl(proofControl(task.id, runtime.store.task(task.id).version)),
      /already reserved at/);
    assert.equal(f.created.length, 1);
  } finally { await runtime.stop(); f.close(); }
});

weighted(1)('before any reservation an amendment may correct or clear the declaration without minting an execution', async () => {
  const f = fixture();
  try {
    const task = f.setupTask(f.store, { brief: { text: f.briefDocument(), operative: false } });
    const amend = (brief: string) => taskControlInputSchema.parse({ taskId: task.id, version: f.store.task(task.id).version,
      action: 'amend_brief', brief, caller: 'operator (board)', reason: 'Correct the brief declaration before activation' });
    const bound = await f.engine.performTaskControl(amend(f.briefDocument({ body: 'First correction.' })));
    assert.equal(bound.proofExecution?.selector, f.selector);
    // A pre-execution change repins the operative declaration: no allowance, no run, no review credit.
    const corrected = await f.engine.performTaskControl(amend(f.briefDocument({ selector: 'effigy test unit -- test/other.test.ts', body: 'Second correction.' })));
    assert.equal(corrected.proofExecution?.selector, 'effigy test unit -- test/other.test.ts');
    assert.deepEqual(corrected.proofExecutions, []);
    assert.deepEqual(f.store.runs(task.id), []);
    assert.equal(f.created.length, 0);
    // Removing the declaration clears the operative subject: the task now names no proof.
    const cleared = await f.engine.performTaskControl(amend(f.briefDocument({ declare: false, body: 'The proof is not needed after all.' })));
    assert.equal(cleared.proofExecution, undefined);
    assert.deepEqual(cleared.proofExecutions, []);
    await assert.rejects(f.engine.performTaskControl(f.activationFor(f.store, task.id, f.store.task(task.id).version)),
      /names no author-side proof selector/);
    assert.deepEqual(f.store.runs(task.id), []);
    // Nothing was spent or reset: declaring it again is an ordinary amendment, still before any run.
    const redeclared = await f.engine.performTaskControl(amend(f.briefDocument({ body: 'The proof is needed after all.' })));
    assert.equal(redeclared.proofExecution?.selector, f.selector);
    assert.deepEqual(redeclared.proofExecutions, []);
    assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'brief_proof_execution_changed').length, 4);
  } finally { f.close(); }
});

weighted(6)('the amendment is what binds the declaration: the parent-shaped write leaves the proof verb refusing', async () => {
  const f = fixture();
  const runtime = f.buildRuntime();
  try {
    await runtime.started;
    f.connectHost(runtime);
    runtime.engine.profiles = [executorProfile, reviewerProfile];
    const task = f.setupTask(runtime.store, { brief: { text: f.briefDocument(), operative: false } });
    const text = f.briefDocument({ body: 'Mechanism-revert falsification of the binding.' });
    const sealedText = f.briefDocument({ body: 'The same amendment with the binding in place.' });
    // Mechanism revert: the amendment writes the brief exactly as the parent did, with no
    // operative declaration, so this task's binding is the only difference in behaviour.
    const original = runtime.store.update;
    runtime.store.update = function (id, change, kind, detail, expected) {
      return original.call(runtime.store, id, { ...change, proofExecution: undefined }, kind, detail, expected);
    };
    try {
      const reverted = await runtime.taskControl(amendControl(task.id, runtime.store.task(task.id).version, text)) as Task;
      assert.equal(reverted.briefVersions.length, 2, 'the parent still pins the new brief');
      assert.equal(reverted.proofExecution, undefined, 'and leaves the operative declaration absent');
      await assert.rejects(runtime.taskControl(proofControl(task.id, runtime.store.task(task.id).version)),
        /names no author-side proof selector/);
      assert.deepEqual(runtime.store.runs(task.id), []);
    } finally { runtime.store.update = original; }
    // The same amendment through the same public envelope, with this task's binding, reaches the proof route.
    const sealed = await runtime.taskControl(amendControl(task.id, runtime.store.task(task.id).version, sealedText)) as Task;
    assert.equal(sealed.proofExecution?.selector, f.selector);
    await f.releaseDispatchFor(runtime.engine, runtime.store, task.id);
    await f.settle(runtime.engine);
    const activated = await runtime.taskControl(proofControl(task.id, runtime.store.task(task.id).version)) as Task;
    assert.equal(runtime.store.runs(task.id).length, 1);
    assert.equal(activated.proofExecutions!.length, 1);
  } finally { await runtime.stop(); f.close(); }
});

weighted(5)('a stale version fences a concurrent amend and proof pair to one binding and one allowance', async () => {
  const f = fixture();
  try {
    const task = f.setupTask(f.store, { brief: { text: f.briefDocument(), operative: false } });
    const stale = f.store.task(task.id).version;
    const bound = await f.engine.performTaskControl(amendControl(task.id, stale, f.briefDocument({ body: 'The owner amends first.' })));
    assert.equal(bound.proofExecution?.selector, f.selector);
    // The proof activation that read the pre-amendment version reserves nothing and names the re-read.
    await assert.rejects(f.engine.performTaskControl(f.activationFor(f.store, task.id, stale)), /Task changed; refresh before retrying \(the task is now version/);
    assert.deepEqual(f.store.runs(task.id), []);
    assert.equal(f.created.length, 0);
    // The reverse order is fenced the same way: the reservation moves the version, so the
    // amendment that read the pre-reservation version writes nothing and keeps the binding.
    await f.releaseDispatchFor(f.engine, f.store, task.id);
    await f.settle(f.engine);
    const beforeProof = f.store.task(task.id);
    await f.engine.performTaskControl(f.activationFor(f.store, task.id, beforeProof.version));
    const reserved = f.store.task(task.id);
    const runs = f.store.runs(task.id).length;
    await assert.rejects(f.engine.performTaskControl(amendControl(task.id, beforeProof.version,
      f.briefDocument({ selector: 'effigy test unit -- test/fenced.test.ts' }))), /Task changed; refresh before retrying/);
    const after = f.store.task(task.id);
    assert.deepEqual(after.proofExecution, reserved.proofExecution);
    assert.deepEqual(after.proofExecutions, reserved.proofExecutions);
    assert.equal(after.briefVersions.length, reserved.briefVersions.length);
    assert.equal(f.store.runs(task.id).length, runs);
    assert.equal(f.created.length, 1);
  } finally { f.close(); }
});

weighted(5)('an uncertain, failed or historical executor reservation also makes the declaration immutable', async () => {
  const f = fixture();
  try {
    const amend = (taskId: string, brief: string) => taskControlInputSchema.parse({ taskId, version: f.store.task(taskId).version,
      action: 'amend_brief', brief, caller: 'operator (board)', reason: 'Change the declaration after a reservation' });
    // A lost creation reply reserves the executor without a settled record: the run itself is the fence.
    const lost = f.setupTask(f.store, { brief: { text: f.briefDocument(), operative: false } });
    await f.engine.performTaskControl(amend(lost.id, f.briefDocument({ body: 'Bind before the lost reply.' })));
    assert.equal(f.store.task(lost.id).proofExecution?.selector, f.selector);
    await f.releaseDispatchFor(f.engine, f.store, lost.id);
    await f.settle(f.engine);
    f.setCreateFailure();
    await assert.rejects(f.engine.performTaskControl(f.activationFor(f.store, lost.id, f.store.task(lost.id).version)), /lost agent creation reply/);
    const lostRun = f.store.runs(lost.id)[0]!;
    assert.equal(lostRun.role, 'executor');
    assert.equal(lostRun.status, 'uncertain');
    assert.deepEqual(f.store.task(lost.id).proofExecutions, [], 'an uncertain creation records no settled execution');
    const beforeLost = f.store.task(lost.id);
    await assert.rejects(f.engine.performTaskControl(amend(lost.id, f.briefDocument({ selector: 'effigy test unit -- test/moved.test.ts', body: 'Move the selector.' }))),
      /already reserved an author-side proof execution .*selector is immutable/);
    await assert.rejects(f.engine.performTaskControl(amend(lost.id, f.briefDocument({ declare: false, body: 'Remove the declaration.' }))),
      /already reserved an author-side proof execution .*selector is immutable/);
    const afterLost = f.store.task(lost.id);
    assert.equal(afterLost.version, beforeLost.version);
    assert.equal(afterLost.briefVersions.length, beforeLost.briefVersions.length);
    assert.equal(afterLost.proofExecution?.selector, f.selector);
    assert.equal(f.store.runs(lost.id).length, 1);

    // A result with unknown start also reserves its recorded selector.
    const failed = f.setupTask(f.store, { brief: { text: f.briefDocument(), operative: false } });
    await f.engine.performTaskControl(amend(failed.id, f.briefDocument({ body: 'Bind before the failed run.' })));
    await f.releaseDispatchFor(f.engine, f.store, failed.id);
    await f.settle(f.engine);
    await f.engine.performTaskControl(f.activationFor(f.store, failed.id, f.store.task(failed.id).version));
    const failedRun = f.store.runs(failed.id)[0]!;
    assert.equal(failedRun.role, 'executor');
    const blocked = await f.reportFor(failed.id, failedRun, { status: 'blocked', summary: 'The selector result is unavailable' });
    assert.equal((blocked as { accepted: boolean }).accepted, true);
    await f.settle(f.engine);
    const settledFailed = f.store.task(failed.id);
    assert.equal(settledFailed.proofExecutions![0]!.status, 'unknown');
    await assert.rejects(f.engine.performTaskControl(amend(failed.id, f.briefDocument({ declare: false, body: 'Remove the failed declaration.' }))),
      /already reserved an author-side proof execution \(.*unknown\).*selector is immutable/);
    assert.equal(f.store.task(failed.id).proofExecutions!.length, 1, 'the failed execution stays recorded');
    assert.equal(f.store.task(failed.id).proofExecution?.selector, f.selector);
    // Model the operative declaration after a qualified #549 re-declaration:
    // the immutable failed proof record retains its original inputs, but the
    // current declaration now names the revised input set.
    const redeclaredInputs = [`sha256:${'f'.repeat(64)}`];
    f.store.update(failed.id, { proofExecution: { ...settledFailed.proofExecution!, inputs: redeclaredInputs } });
    const current = f.store.task(failed.id);
    assert.deepEqual(current.proofExecutions![0]!.inputs, inputs);
    assert.deepEqual(current.proofExecution?.inputs, redeclaredInputs);
    // Keeping the current declaration is body-only even though the historical
    // reservation still records the earlier inputs.
    const bodyOnly = await f.engine.performTaskControl(amend(failed.id, f.briefDocument({ inputs: redeclaredInputs,
      body: 'The failed proof is recorded in the body.' })));
    assert.equal(bodyOnly.proofExecutions!.length, 1);
    assert.deepEqual(bodyOnly.proofExecution?.inputs, redeclaredInputs);
    assert.equal(bodyOnly.briefVersions.length, current.briefVersions.length + 1);
    // A further input change without another qualified head still follows #549.
    await assert.rejects(f.engine.performTaskControl(amend(failed.id, f.briefDocument({ inputs: [`sha256:${'a'.repeat(64)}`],
      body: 'Attempt another input change.' }))), /input hashes may be re-declared only for a new head/);
    assert.equal(f.store.runs(failed.id).length, 1);
  } finally { f.close(); }
});

weighted(2)('schema and merge fences refuse a declaration amendment without a partial write', async () => {
  const f = fixture();
  try {
    const amend = (taskId: string, brief: string) => taskControlInputSchema.parse({ taskId, version: f.store.task(taskId).version,
      action: 'amend_brief', brief, caller: 'operator (board)', reason: 'Record the proof declaration' });
    const task = f.setupTask(f.store, { brief: { text: f.briefDocument(), operative: false } });
    const before = f.store.task(task.id);
    // The existing brief parser validates the declaration; a malformed one writes nothing.
    const malformed = f.briefDocument({ body: 'Malformed declaration.' }).replace(/ {4}selector: ".*"/, '    selector: ""');
    await assert.rejects(f.engine.performTaskControl(amend(task.id, malformed)), /Invalid brief frontmatter/);
    const afterMalformed = f.store.task(task.id);
    assert.equal(afterMalformed.version, before.version);
    assert.equal(afterMalformed.briefVersions.length, before.briefVersions.length);
    assert.equal(afterMalformed.proofExecution, undefined);
    // Once merging has started, no declaration is bound: the existing refusal still comes first.
    const merged = f.setupTask(f.store, { brief: { text: f.briefDocument(), operative: false } });
    f.store.update(merged.id, { resolution: { ...f.store.task(merged.id).resolution, mergedCommit: 'b'.repeat(40) } });
    const beforeMerge = f.store.task(merged.id);
    await assert.rejects(f.engine.performTaskControl(amend(merged.id, f.briefDocument({ body: 'Too late.' }))), /refused once the task has merged/);
    const afterMerge = f.store.task(merged.id);
    assert.equal(afterMerge.proofExecution, undefined);
    assert.equal(afterMerge.briefVersions.length, beforeMerge.briefVersions.length);
    assert.deepEqual(afterMerge.proofExecutions, []);
  } finally { f.close(); }
});

weighted(2)('a concurrent amendment and durable proof activation leave one binding and one allowance', async () => {
  const f = fixture();
  try {
    const task = f.setupTask(f.store, { brief: { text: f.briefDocument(), operative: false } });
    await f.engine.performTaskControl(amendControl(task.id, f.store.task(task.id).version, f.briefDocument({ body: 'Bind before the race.' })));
    await f.releaseDispatchFor(f.engine, f.store, task.id);
    await f.settle(f.engine);
    const control = f.activationFor(f.store, task.id, f.store.task(task.id).version);
    const { key, payload } = taskControlOperation(control);
    const acceptance = await f.engine.startOperation({ key, kind: 'task_control', payload, taskId: control.taskId, expectedVersion: control.version });
    assert.ok('accepted' in acceptance);
    // The owner's amendment carries the same version the activation was accepted at; the
    // two namespaced writes cannot both land, and whichever loses writes nothing.
    const raced = await f.engine.performTaskControl(amendControl(task.id, control.version,
      f.briefDocument({ selector: 'effigy test unit -- test/raced.test.ts', body: 'Raced amendment.' }))).then(() => 'amended', (error: Error) => error.message);
    const settled = await f.engine.awaitOperation(acceptance.operation.id, 10000);
    const after = f.store.task(task.id);
    const executorRuns = f.store.runs(task.id).filter(run => run.role === 'executor');
    assert.equal(executorRuns.length <= 1, true, 'one reservation at most');
    assert.equal(after.proofExecutions!.length, executorRuns.length, 'a record and its run never diverge');
    assert.equal((raced === 'amended') !== (settled.state === 'succeeded'), true, `one write won: ${raced} / ${settled.state} ${settled.diagnostic ?? ''}`);
    if (settled.state === 'succeeded') {
      // The reservation won: the declaration it bound is the one the recorded execution names.
      assert.equal(after.proofExecution?.selector, f.selector);
      assert.equal(executorRuns[0]!.proofExecution?.selector, f.selector);
      assert.match(raced, /Task changed|already reserved/);
    } else {
      // The amendment won: the activation reserved nothing and the corrected declaration stands unspent.
      assert.equal(after.proofExecution?.selector, 'effigy test unit -- test/raced.test.ts');
      assert.deepEqual(after.proofExecutions, []);
      assert.equal(f.created.length, 0);
      // The activation is fenced either at the control's own version check or inside the
      // reservation transaction; both name the changed brief and reserve nothing.
      assert.match(settled.diagnostic ?? '', /Task changed|Proof-execution source or brief reservation changed during admission/);
    }
  } finally { f.close(); }
});

/**
 * Task 582: the replacement half. A retained executor thread continues the
 * next proof head only while it is healthy and still running its own model;
 * these cases share the failed-first-proof shape and differ only in how the
 * retained thread's observation proves it cannot continue. The fixture mints
 * a distinct agent id per fresh create, so "a new executor appeared" is read
 * from the run bindings themselves, never from a shared name.
 */
const correctedSecondHead = async (f: ReturnType<typeof fixture>, task: Task) => {
  const current = () => f.store.task(task.id);
  const report = (run: Run, body: Record<string, unknown>) => f.reportFor(task.id, run, body);
  await f.engine.performTaskControl(f.activationFor(f.store, task.id, current().version));
  f.store.update(task.id, holdPatch(current(), 'dispatch', owner, 'Hold while author repairs the proof failure'));
  const firstRun = f.store.runs(task.id).find(run => run.role === 'executor')!;
  f.states.set(firstRun.agentId!, { id: firstRun.agentId!, workspaceId: 'workspace', status: 'idle', active: false,
    permissions: false, error: '', model: 'test/executor', provider: 'test' });
  const failed = await report(firstRun, { status: 'proof_executed', summary: 'Four cases failed at the original source',
      proofResult: { status: 'failed', selector, exitCode: 1, evidence: 'Four cases failed' } });
  assert.equal((failed as { accepted: boolean }).accepted, true);
  await f.engine.wake(); await f.engine.wake();
  f.store.putRun({ ...f.store.run(firstRun.id)!, released: true, status: 'finished' });
  const correctedHead = f.pushRevision('corrected source');
  const revisionRunId = randomUUID();
  const reviewerRunId = randomUUID();
  const revisionCompletion = { eventId: randomUUID(), taskId: task.id, runId: revisionRunId,
    status: 'ready_for_review' as const, summary: 'Author corrected the four failing cases', head: correctedHead, prNumber: 41 };
  const reviewCompletion = { eventId: randomUUID(), taskId: task.id, runId: reviewerRunId,
    status: 'blocked' as const, summary: 'Source approved; proof remains', head: correctedHead, prNumber: 41,
    reviewResponsibility: 'environment' as const, sourceApproved: true as const, awaitingProofs: [selector],
    reviewText: 'The corrected source is approved; judge the arriving proof.' };
  // Retain released author and reviewer receipts at B without dispatching those unrelated roles.
  f.store.putRun({ ...firstRun, id: revisionRunId, role: 'revision', head: correctedHead,
    completion: revisionCompletion, proofExecution: undefined, released: true, status: 'finished', agentId: 'author-agent' } as Run);
  f.store.putRun({ ...firstRun, id: reviewerRunId, role: 'reviewer', head: correctedHead,
    completion: reviewCompletion, proofExecution: undefined, released: true, status: 'finished', agentId: 'reviewer-agent' } as Run);
  f.store.update(task.id, { prHead: correctedHead, phase: 'awaiting_review', resolution: { ...current().resolution, review: reviewCompletion } });
  const changedInput = `sha256:${'f'.repeat(64)}`;
  await f.engine.performTaskControl(amendControl(task.id, current().version, f.briefDocument({ inputs: [changedInput], body: 'Inputs refreshed for the corrected source.' })));
  await f.releaseDispatchFor(f.engine, f.store, task.id);
  return { firstRun, correctedHead };
};

weighted(3)('a second proof replaces the retained executor whose session now runs a different model', async () => {
  const f = fixture();
  try {
    const task = f.setupTask(f.store, { brief: { text: f.briefDocument(), operative: true }, dispatchHeld: false });
    const current = () => f.store.task(task.id);
    const { firstRun } = await correctedSecondHead(f, task);
    // The retained thread answers, but on a different model than the profile it
    // was created with: continuing it would carry another model's context.
    f.states.set(firstRun.agentId!, { id: firstRun.agentId!, workspaceId: 'workspace', status: 'idle', active: false,
      permissions: false, error: '', model: 'test/replacement-model', provider: 'test' });
    await f.engine.performTaskControl(f.activationFor(f.store, task.id, current().version));
    const secondRun = f.store.runs(task.id).find(run => run.role === 'executor' && run.head === current().prHead)!;
    assert.ok(secondRun);
    assert.notEqual(secondRun.agentId, firstRun.agentId, 'a model-changed session never continues the retained executor thread');
    assert.equal(f.created.length, 2, 'a fresh executor agent was created');
    assert.equal(current().proofExecutions!.length, 2);
    const secondReceipt = current().proofExecutions!.at(-1)!;
    assert.equal(secondReceipt.runId, secondRun.id);
    assert.equal(secondReceipt.agentId, secondRun.agentId);
    assert.equal(secondRun.agentId, 'executor-agent-2', 'the fresh create minted its own agent identity');
  } finally { f.close(); }
});

weighted(3)('a second proof replaces the retained executor on observed provider exhaustion', async () => {
  const f = fixture();
  try {
    const task = f.setupTask(f.store, { brief: { text: f.briefDocument(), operative: true }, dispatchHeld: false });
    const current = () => f.store.task(task.id);
    const { firstRun } = await correctedSecondHead(f, task);
    f.states.set(firstRun.agentId!, { id: firstRun.agentId!, workspaceId: 'workspace', status: 'error', active: false,
      permissions: false, error: 'usage_limit_reached: the subscription usage limit was reached', model: 'test/executor', provider: 'test' });
    await f.engine.performTaskControl(f.activationFor(f.store, task.id, current().version));
    const secondRun = f.store.runs(task.id).find(run => run.role === 'executor' && run.head === current().prHead)!;
    assert.ok(secondRun);
    assert.notEqual(secondRun.agentId, firstRun.agentId, 'provider exhaustion never continues the retained executor thread');
    assert.equal(f.created.length, 2, 'a fresh executor agent was created');
    const secondReceipt = current().proofExecutions!.at(-1)!;
    assert.equal(secondReceipt.runId, secondRun.id);
    assert.equal(secondReceipt.agentId, secondRun.agentId);
  } finally { f.close(); }
});
