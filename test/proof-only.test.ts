import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hostRunRecordSchema, submissionSchema, taskControlInputSchema, type Profile, type Run, type Task } from '../shared/contracts';
import { Store } from '../core/store/store';
import { Decisions } from '../core/planning/decisions';
import { Engine } from '../core/engine';
import { Reports } from '../core/intake/report';
import type { Adapter, AgentObservation } from '../core/host';
import { operatorQuestionFor, proofOnlyGoQuestionText } from '../core/questions/operator-question';
import { digest } from '../core/store/store';
import { parseNorthstarDocument } from '../core/planning/handoff';
import { shellCommandInvokesSelector } from '../core/qa/proof-execution';
import { runPrompt } from '../core/dispatch/prompts';
import type { TimelinePage } from '../core/recovery/stall';
import { toolTimelinePage } from './support/tool-timeline';
import { classifyWorkspaceCreation, populateOwnedWorktree, taskCheckoutTarget } from '../core/workspaces/workspace-allocation';
import { validateDispatch, verifyWorkspace as verifyTaskWorkspace } from '../core/git/index';
import { terminalArchiveWorkspaces } from '../core/closeout/workspace-lifecycle';
import { collectOwnerVerbFacts, ownerTaskNext, ownerVerbViews } from '../core/verbs/owner-verbs';
import { escalationVerbChoices, plannerEscalationChoicesFor } from '../core/questions/blocker-ladder';

const runGit = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = 'a'.repeat(40);
const selector = 'effigy test unit -- test/proof-fixture.test.ts';
const inputs = [`sha256:${'e'.repeat(64)}`];
const executorProfile: Profile = { id: 'executor', name: 'executor', provider: 'test', model: 'test/executor', notes: '', available: true, problem: '', supportedThinking: [] };
const reviewerProfile: Profile = { id: 'reviewer', name: 'reviewer', provider: 'test', model: 'test/reviewer', notes: '', available: true, problem: '', supportedThinking: [] };

function fixture(requiresOperatorGo = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ns-proof-only-')));
  const origin = join(root, 'origin.git'), repo = join(root, 'repo'), directory = join(root, 'qualification');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  runGit(repo, 'config', 'user.name', 'Queue Fixture'); runGit(repo, 'config', 'user.email', 'queue@example.test');
  writeFileSync(join(repo, 'README.md'), 'merged source\n'); runGit(repo, 'add', '.'); runGit(repo, 'commit', '-m', 'Merged qualification subject');
  const head = runGit(repo, 'rev-parse', 'HEAD');
  runGit(repo, 'remote', 'add', 'origin', origin); runGit(repo, 'push', '-u', 'origin', 'main');
  runGit(repo, 'worktree', 'add', '--detach', directory, head);
  const githubRemote = 'ssh://git@github.com/example/proof-only.git';
  runGit(repo, 'config', 'remote.origin.url', githubRemote); runGit(repo, 'config', `url.${origin}.insteadOf`, githubRemote);

  const store = new Store(join(root, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('pool', [
    { profileId: executorProfile.id, enabled: true, group: 'proof', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewerProfile.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
  ]);
  const brief = `---\ntitle: Merged qualification\nqueue:\n  proofOnly:\n    commit: ${head}\n  proofExecution:\n    selector: "${selector}"\n    inputs: ["${inputs[0]}"]\n${requiresOperatorGo ? '  requiresOperatorGo: "existing Colima VM and live consumer consumer"\n' : ''}---\n\nRun one qualification against already-merged code.\n`;
  const submission = submissionSchema.parse({ submissionId: `proof-only-${randomUUID()}`, title: 'Merged qualification', repoPath: repo,
    baseBranch: 'main', planningCommit: head, brief: { text: brief, mediaType: 'text/markdown' }, originAgentId: 'operator (board)',
    responsible: true, proofOnly: { commit: head }, proofExecution: { selector, inputs },
    ...(requiresOperatorGo ? { requiresOperatorGo: 'existing Colima VM and live consumer consumer' } : {}) });
  const inserted = store.insert(submission, 'host', brief, head);
  store.update(inserted.id, { workspaceId: 'proof-workspace', directory, branch: '' });

  const states = new Map<string, AgentObservation>();
  const tokens = new Map<string, string>();
  const created: Run[] = [];
  let provisioningFailures = 0;
  let visibleWorkspaces: { id: string; directory: string }[] = [];
  const adapter = {
    hostId: 'host',
    profiles: async () => [executorProfile, reviewerProfile],
    observe: async (id: string) => states.get(id) ?? { id, workspaceId: 'proof-workspace', status: 'idle', active: false, permissions: false, error: '', model: 'test/unknown', provider: 'test' },
    createRun: async (_task: Task, run: Run, token: string) => {
      created.push(run); tokens.set(run.id, token);
      const id = run.role === 'reviewer' ? 'reviewer-agent' : 'executor-agent';
      states.set(id, { id, workspaceId: run.workspaceId, status: 'running', active: true, permissions: false, error: '', model: run.profile?.model ?? 'test/unknown', provider: 'test' });
      return { id, workspaceId: run.workspaceId };
    },
    findWorkspaces: async () => visibleWorkspaces,
    inspectWorkspaceCreation: async () => ({ kind: 'absent' as const }),
    populateTaskWorktree: async (task: Task) => {
      if (provisioningFailures-- > 0) throw new Error('Transport not connected');
      return populateOwnedWorktree({ task, ownedPath: directory, scan: () => ({ state: 'absent' as const }) });
    },
    validate: (task: Task) => validateDispatch(task),
    verifyWorkspace: (task: Task, directory: string) => verifyTaskWorkspace(task, directory),
    createWorkspace: async () => ({ id: 'proof-workspace', directory }),
    sendRun: async () => {}, notify: async () => {}, archiveAgent: async () => {}, findAgents: async () => [],
    verifyReview: async () => { throw new Error('Proof-only reviewer must not publish or verify a PR review'); },
    publishReview: async () => { throw new Error('Proof-only reviewer must not publish a PR review'); },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [executorProfile, reviewerProfile];
  const task = () => store.task(inserted.id);
  const report = async (run: Run, body: Record<string, unknown>) => {
    if (run.agentId) {
      const profile = run.profile?.model ?? 'test/unknown';
      states.set(run.agentId, { id: run.agentId, workspaceId: run.workspaceId, status: 'idle', active: false, permissions: false, error: '', model: profile, provider: 'test' });
    }
    return new Reports(engine).report({ taskId: inserted.id, runId: run.id, eventId: randomUUID(), head: run.head, ...body } as never, tokens.get(run.id)!);
  };
  const settle = async () => { await engine.wake(); await engine.wake(); };
  return { root, repo, directory, head, store, engine, adapter, task, created, states, report, settle,
    failProvisioningOnce: () => { provisioningFailures = 1; },
    showWorkspace: () => { visibleWorkspaces = [{ id: 'proof-workspace', directory }]; },
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

/** Settled failed receipt, blocked reviewer, no closeout verdict — the lost-review shape. */
async function lostReceiptReview(f: ReturnType<typeof fixture>) {
  await f.engine.wake();
  const executor = f.store.runs(f.task().id).find(run => run.role === 'executor');
  assert.ok(executor, `executor dispatched: ${f.task().phase}: ${f.task().reason}`);
  await f.report(executor, { status: 'proof_executed', summary: 'Qualification failed at the merged commit',
    proofResult: { status: 'failed', selector, exitCode: 1, evidence: 'native failure: exit 1' } });
  await f.settle();
  const reviewer = f.store.runs(f.task().id).findLast(run => run.role === 'reviewer');
  assert.ok(reviewer, 'Queue retains a reviewer for the receipt');
  await f.report(reviewer, { status: 'blocked', summary: 'Receipt review could not be recorded',
    reviewText: 'The callback was refused for a run ID mismatch; nothing was recorded.', reviewResponsibility: 'environment' });
  await f.settle();
  assert.equal(f.task().phase, 'blocked', f.task().reason);
  assert.equal(f.task().proofOnlyResult, null);
  return { executor, reviewer };
}

test('proof-only brief schema requires one selector and only permits GO metadata with a merged commit', () => {
  const valid = `---\ntitle: Qualification\nqueue:\n  proofOnly:\n    commit: ${commit}\n  proofExecution:\n    selector: effigy check\n    inputs: []\n---\n\nRun it.\n`;
  assert.deepEqual(parseNorthstarDocument(valid, 'draft').queue.proofOnly, { commit });
  assert.throws(() => parseNorthstarDocument(valid.replace(`  proofExecution:\n    selector: effigy check\n    inputs: []\n`, ''), 'draft'), /proofOnly requires queue\.proofExecution/);
  assert.throws(() => parseNorthstarDocument(valid.replace(`  proofOnly:\n    commit: ${commit}\n`, '').replace('  proofExecution:', '  requiresOperatorGo: live system\n  proofExecution:'), 'draft'), /requiresOperatorGo is only valid with queue\.proofOnly/);
});

test('proof-only checkout target is the immutable proof commit even when the planning base advances', () => {
  const f = fixture();
  try {
    assert.equal(taskCheckoutTarget({ ...f.task(), planningBase: 'b'.repeat(40) }), f.head);
  } finally { f.close(); }
});

/** Advance the integration base past the proof commit and leave the checkout at the new base tip. */
function leaveCheckoutAtBaseTip(f: ReturnType<typeof fixture>) {
  writeFileSync(join(f.repo, 'base-tip.txt'), 'later base commit\n');
  runGit(f.repo, 'add', '.'); runGit(f.repo, 'commit', '-m', 'Advance base beyond proof commit');
  runGit(f.repo, 'push', 'origin', 'main');
  const baseTip = runGit(f.repo, 'rev-parse', 'HEAD');
  runGit(f.directory, 'checkout', '--detach', baseTip);
  assert.notEqual(baseTip, f.head, 'the base tip must differ from the proof commit');
  return baseTip;
}

test('initial dispatch provisions a checkout left at the base tip at the proof commit and admits its executor', async () => {
  const f = fixture();
  try {
    leaveCheckoutAtBaseTip(f);
    f.store.update(f.task().id, { workspaceId: null, directory: null, phase: 'queued', reason: 'Queued for dispatch' }, 'test_reset');
    await f.engine.wake();
    assert.equal(runGit(f.directory, 'rev-parse', 'HEAD'), f.head, 'initial dispatch leaves the checkout at the proof commit');
    assert.equal(runGit(f.directory, 'branch', '--show-current'), '', 'the proof checkout remains detached');
    const executor = f.store.runs(f.task().id).find(run => run.role === 'executor');
    assert.ok(executor, `executor admitted: ${f.task().phase}: ${f.task().reason}`);
    assert.equal(executor!.head, f.head);
    assert.deepEqual(f.created.map(run => run.role), ['executor']);
  } finally { f.close(); }
});

test('owner restart re-detaches a retained checkout left at the base tip and admits its executor', async () => {
  const f = fixture();
  try {
    leaveCheckoutAtBaseTip(f);
    f.store.update(f.task().id, { phase: 'needs_attention', reason: 'Parked before dispatch', workspaceIntent: true }, 'parked');
    f.showWorkspace();
    const restarted = await f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: f.task().id, version: f.task().version, action: 'restart', caller: 'operator (board)',
      reason: 'Owner restarts the parked qualification' }));
    assert.equal(restarted.phase, 'queued');
    assert.equal(runGit(f.directory, 'rev-parse', 'HEAD'), f.head, 'the restart leaves the checkout at the proof commit');
    assert.equal(runGit(f.directory, 'branch', '--show-current'), '');
    await f.settle();
    const executor = f.store.runs(f.task().id).find(run => run.role === 'executor');
    assert.ok(executor, `executor admitted after restart: ${f.task().phase}: ${f.task().reason}`);
    assert.equal(executor!.head, f.head);
  } finally { f.close(); }
});

test('recovery re-provisions a bound checkout left at the base tip and admits its executor', async () => {
  const f = fixture();
  try {
    leaveCheckoutAtBaseTip(f);
    f.store.update(f.task().id, { phase: 'dispatching', reason: 'Recovering dispatch', workspaceIntent: true }, 'dispatch_intent');
    const recover = (f.engine as unknown as { recoverProofOnlyDispatch(task: Task): Promise<void> }).recoverProofOnlyDispatch.bind(f.engine);
    await recover(f.task());
    assert.equal(f.task().workspaceId, 'proof-workspace');
    assert.equal(runGit(f.directory, 'rev-parse', 'HEAD'), f.head, 'recovery leaves the checkout at the proof commit');
    assert.equal(runGit(f.directory, 'branch', '--show-current'), '');
    const executor = f.store.runs(f.task().id).find(run => run.role === 'executor');
    assert.ok(executor, `executor admitted after recovery: ${f.task().phase}: ${f.task().reason}`);
    assert.equal(executor!.head, f.head);
  } finally { f.close(); }
});

test('every task checkout-target call site resolves through taskCheckoutTarget', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sources = new Map<string, string>();
  const walk = (dir: string, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.ts')) sources.set(`${prefix}${entry.name}`, readFileSync(join(dir, entry.name), 'utf8'));
    }
  };
  for (const dir of ['core', 'server']) {
    if (existsSync(join(root, dir))) walk(join(root, dir), `${dir}/`);
  }
  assert.ok(sources.has('core/workspaces/checkout-target.ts'), 'checkout target helper must be scanned');
  // The provisioning fallback chain lives only in the helper: no other module
  // re-derives the task checkout target from the proof commit and the planning
  // fields. (Expected-head chains such as run.head's `proofOnly?.commit ??
  // prHead ?? planningBase` read a different invariant and stay where they are.)
  const provisioningChain = /\.proofOnly\?\.commit \?\? \w+(?:\.\w+)*\.planningBase \?\? \w+(?:\.\w+)*\.planningCommit/;
  for (const [name, source] of sources) {
    if (name === 'core/workspaces/checkout-target.ts') {
      assert.match(source, /export function taskCheckoutTarget/);
      assert.match(source, /task\.proofOnly\?\.commit \?\? task\.planningBase \?\? task\.planningCommit/);
      continue;
    }
    assert.doesNotMatch(source, provisioningChain,
      `${name} must resolve the task checkout target through taskCheckoutTarget, not its own fallback`);
  }
  // Git commands that place a checkout appear only in files whose checkout
  // targets are documented here. A new call site must either provision task
  // checkouts through the helper or justify its own target in this list.
  const taskProvisioning = ['core/workspaces/workspace-allocation.ts', 'core/git/index.ts'];
  const otherTargets = new Map([
    ['core/workspaces/workspace-lifecycle.ts', 'recoverTaskWorkspace re-adds a worker checkout at the accepted PR head'],
    ['core/hooks/hooks.ts', 'the integration checkout that lifecycle hooks run against sits at the base'],
    ['core/merge/prospective-merge.ts', 'task 1032 extracted isolated synthetic merge-candidate checkouts from hooks.ts'],
    ['core/workspaces/siblings.ts', 'prerequisite sibling checkouts sit at the base'],
    ['core/qa/project-qa-supervisor.ts', 'project QA checkouts sit at the QA base'],
  ]);
  for (const [name, source] of sources) {
    if (!/worktree", "add|checkout", "--detach/.test(source)) continue;
    if (taskProvisioning.includes(name)) {
      assert.match(source, /taskCheckoutTarget/, `${name} provisions task checkouts and must use the helper`);
      assert.doesNotMatch(source, /\.proofOnly[?!]\.commit/,
        `${name} must read the checkout target from taskCheckoutTarget, never resolve the proof commit directly`);
      continue;
    }
    assert.ok(otherTargets.has(name),
      `${name} places a checkout; task targets must resolve through taskCheckoutTarget, or this file's non-task target must be recorded in this test`);
  }
  // verifyWorkspace resolves the proof-only checkout target before any
  // planning-base handling can move the checkout.
  const gitSource = sources.get('core/git/index.ts')!;
  const body = gitSource.slice(gitSource.indexOf('export async function verifyWorkspace'));
  const proofBranch = body.indexOf('if (task.proofOnly)');
  assert.ok(proofBranch >= 0, 'verifyWorkspace must carry a proof-only checkout resolution');
  const proofTarget = body.indexOf('taskCheckoutTarget(task)', proofBranch);
  assert.ok(proofTarget > proofBranch, 'the proof-only branch must resolve the checkout target through the helper');
  const planningHandling = body.indexOf('task.planningBase', proofTarget);
  assert.ok(planningHandling > proofTarget, 'the proof-only resolution must precede the planning-base handling');
});

test('proof-only provisioning retries a transport interruption and launches only its executor route', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.repo, 'node_modules', 'proof-fixture'), { recursive: true });
    writeFileSync(join(f.repo, '.git', 'info', 'exclude'), 'node_modules/\n');
    writeFileSync(join(f.repo, 'node_modules', 'proof-fixture', 'index.js'), 'proof dependencies present\n');
    f.store.update(f.task().id, { workspaceId: null, directory: null, workspaceIntent: true, phase: 'dispatching' }, 'dispatch_intent');
    f.failProvisioningOnce();
    const recover = (f.engine as unknown as { recoverProofOnlyDispatch(task: Task): Promise<void> }).recoverProofOnlyDispatch.bind(f.engine);
    await assert.rejects(recover(f.task()), /Transport not connected/);
    assert.equal(f.store.runs(f.task().id).length, 0, 'a transport failure during provisioning must not launch a worker or coordinator');
    await recover(f.task());
    assert.equal(f.task().workspaceId, 'proof-workspace');
    assert.equal(f.task().directory, f.directory);
    assert.equal(runGit(f.directory, 'rev-parse', 'HEAD'), f.head);
    assert.equal(lstatSync(join(f.directory, 'node_modules')).isSymbolicLink(), true);
    assert.equal(readFileSync(join(f.directory, 'node_modules', 'proof-fixture', 'index.js'), 'utf8'), 'proof dependencies present\n');
    assert.equal(runGit(f.directory, 'branch', '--show-current'), '', 'the proof checkout remains detached');
    assert.deepEqual(f.created.map(run => run.role), ['executor']);
    assert.equal(f.created[0]!.head, f.head);
  } finally { f.close(); }
});

test('a proof-only qualification runs once at a detached merged commit and closes on retained reviewer pass', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, 'base-tip.txt'), 'later base commit\n');
    runGit(f.repo, 'add', '.'); runGit(f.repo, 'commit', '-m', 'Advance base beyond proof commit');
    runGit(f.repo, 'push', 'origin', 'main');
    const baseTip = runGit(f.repo, 'rev-parse', 'HEAD');
    runGit(f.repo, 'worktree', 'remove', '--force', f.directory);
    runGit(f.repo, 'worktree', 'add', '--detach', f.directory, baseTip);
    const populated = await populateOwnedWorktree({ task: f.task(), ownedPath: f.directory, scan: () => ({ state: 'absent' }) });
    assert.equal(populated.populated, false, 'a clean wrong-commit checkout is repaired in place');
    assert.equal(runGit(f.directory, 'rev-parse', 'HEAD'), f.head);
    assert.equal(runGit(f.directory, 'branch', '--show-current'), '');
    assert.deepEqual(await classifyWorkspaceCreation({ task: f.task(), ownedPath: f.directory, scan: () => ({ state: 'absent' }) }),
      { kind: 'found_done', directory: f.directory });
    assert.equal(runGit(f.repo, 'merge-base', '--is-ancestor', f.head, 'origin/main'), '');
    assert.notEqual(f.head, baseTip, 'the proof commit is an ancestor, not the base tip');
    assert.equal(f.task().entrypoint, 'proof'); assert.equal(f.task().branch, '');
    await f.engine.resolution.proofExecution(f.task(), { authorizedBy: { role: 'queue_dispatch', caller: null, note: 'promoted merged qualification' }, operationId: null });
    const executor = f.store.runs(f.task().id).filter(run => run.role === 'executor');
    assert.equal(executor.length, 1); assert.equal(executor[0]!.head, f.head); assert.equal(executor[0]!.proofExecution?.prNumber, null);
    await f.report(executor[0]!, { status: 'proof_executed', summary: 'Qualification passed at the merged commit',
      proofResult: { status: 'passed', selector, exitCode: 0, evidence: 'All qualification cases passed.' } });
    await f.settle();
    const reviewer = f.store.runs(f.task().id).findLast(run => run.role === 'reviewer');
    assert.ok(reviewer, 'Queue retains a reviewer for the receipt');
    assert.equal(reviewer!.agentId, 'reviewer-agent');
    assert.match(reviewer!.instruction ?? '', /Judge only (?:the )?immutable Nucleus proof receipt|Judge only Nucleus's settled executor receipt/);
    const prompt = runPrompt(f.task(), reviewer!, '/helper', '/ticket');
    assert.match(prompt, /Judge only Nucleus's settled executor receipt/);
    assert.doesNotMatch(prompt, /gh pr review|PR review: required|pull request number:/i);
    assert.doesNotMatch(prompt, /PR: null|PR review: required|validation policy/i);
    await f.report(reviewer!, { status: 'ready_to_merge', summary: 'Receipt proves the qualification passed', reviewText: 'The settled receipt matches the declared selector, inputs and merged commit.' });
    await f.settle();
    const task = f.task();
    assert.equal(task.phase, "done");
    assert.equal(task.proofOnlyResult?.status, "passed");
    assert.match(
      task.proofOnlyResult?.evidence ?? "",
      /^Qualification result passed; executor receipt status passed:/,
    );
    assert.equal(task.proofOnlyResult?.commit, f.head);
    assert.equal(task.proofOnlyResult?.executionRunId, executor[0]!.id);
    assert.equal(task.proofOnlyResult?.reviewerRunId, reviewer!.id);
    assert.equal(task.prUrl, null);
    assert.equal(task.resolution.mergedCommit, null);
    // Task 740: a pass still holding this verdict finds it applied and changes nothing.
    const settled = f.store.run(reviewer!.id)!;
    await (f.engine.resolution as unknown as { advanceReviewerResult: (t: typeof task, run: typeof settled, c: NonNullable<typeof settled.completion>) => Promise<void> })
      .advanceReviewerResult(task, settled, settled.completion!);
    assert.equal(f.task().version, task.version, 'a second apply writes nothing');
    assert.equal(f.store.runs(task.id).filter(run => run.role === 'executor').length, 1);
    assert.deepEqual(terminalArchiveWorkspaces(task, f.store.runs(task.id))[0], {
      id: 'proof-workspace', directory: f.directory, head: f.head, reportSource: false,
    }, 'the completed qualification archives its original immutable commit');
    // effigy#666, 2026-11-07: an owner accepted an interrupted run. It has a report
    // acceptance and no result, and is still a detached checkout with no branch.
    const accepted = { ...task, proofOnlyResult: undefined, reportAcceptance: { by: 'owner' } } as unknown as typeof task;
    assert.deepEqual(terminalArchiveWorkspaces(accepted, f.store.runs(task.id))[0], {
      id: 'proof-workspace', directory: f.directory, head: f.head, reportSource: false,
    }, 'an accepted proof-only task archives its commit, never as a report-only source');
  } finally { f.close(); }
});

test('two connections interleaving before a proof-only verdict applies close it once (task 740)', async () => {
  const f = fixture();
  const other = new Store(join(f.root, 'queue.sqlite'));
  try {
    other.db.exec('PRAGMA busy_timeout=0');
    const otherEngine = new Engine(other, f.adapter, 0);
    otherEngine.profiles = f.engine.profiles;
    // The test drives the application itself, so the report's own wake stays out of the race.
    (f.engine as unknown as { wakeTask: () => Promise<void> }).wakeTask = async () => {};
    const taskId = f.task().id;
    await f.engine.resolution.proofExecution(f.task(), { authorizedBy: { role: 'queue_dispatch', caller: null, note: 'promoted merged qualification' }, operationId: null });
    const executor = f.store.runs(taskId).find(run => run.role === 'executor')!;
    await f.report(executor, { status: 'proof_executed', summary: 'Qualification passed at the merged commit',
      proofResult: { status: 'passed', selector, exitCode: 0, evidence: 'All qualification cases passed.' } });
    await f.settle();
    const reviewer = f.store.runs(taskId).findLast(run => run.role === 'reviewer')!;
    await f.report(reviewer, { status: 'ready_to_merge', summary: 'Receipt proves the qualification passed', reviewText: 'The settled receipt matches the merged commit.' });
    const reported = f.store.run(reviewer.id)!;
    assert.ok(reported.completion);
    assert.equal(f.task().proofOnlyResult, null, 'the verdict has not applied yet');
    type Applying = { advanceReviewerResult: (t: Task, run: Run, c: NonNullable<Run['completion']>) => Promise<void> };
    const apply = (engine: Engine, store: Store) => (engine.resolution as unknown as Applying)
      .advanceReviewerResult(store.task(taskId), store.run(reviewer.id)!, reported.completion!);
    const closes = () => f.store.eventsAll(taskId).filter(event => event.kind === 'proof_only_qualification_closed').length;
    // The other connection attempts its application after this one has read the
    // fence and just before this one writes the result.
    const write = f.store.update;
    let raced: Promise<unknown> | null = null;
    f.store.update = function (this: Store, ...args: Parameters<Store['update']>) {
      f.store.update = write;
      raced = apply(otherEngine, other).catch(error => error);
      return write.apply(this, args);
    } as Store['update'];
    await apply(f.engine, f.store);
    assert.ok(raced, 'the other connection attempted its application mid-write');
    await raced;
    assert.equal(closes(), 1);
    const closed = f.task();
    assert.equal(closed.proofOnlyResult?.reviewerRunId, reviewer.id);
    // Once the writer commits, the other connection finds the durable result.
    await apply(otherEngine, other);
    assert.equal(closes(), 1);
    assert.equal(f.task().version, closed.version, 'a later application writes nothing');
    await otherEngine.stop();
  } finally { other.close(); f.close(); }
});

test('proof-only provisioning refuses to move a dirty checkout from the required commit', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, 'base-tip.txt'), 'later base commit\n');
    runGit(f.repo, 'add', '.'); runGit(f.repo, 'commit', '-m', 'Advance base beyond proof commit');
    const baseTip = runGit(f.repo, 'rev-parse', 'HEAD');
    runGit(f.directory, 'checkout', '--detach', baseTip);
    writeFileSync(join(f.directory, 'README.md'), 'operator changes stay intact\n');
    await assert.rejects(populateOwnedWorktree({ task: f.task(), ownedPath: f.directory, scan: () => ({ state: 'absent' }) }), /dirty; refusing to change/);
    assert.equal(runGit(f.directory, 'rev-parse', 'HEAD'), baseTip);
    assert.equal(readFileSync(join(f.directory, 'README.md'), 'utf8'), 'operator changes stay intact\n');
  } finally { f.close(); }
});

test('release-kind GO holds a live proof and a failed receipt closes with its failing evidence', async () => {
  const f = fixture(true);
  try {
    await f.engine.resolution.launch(f.task(), 'reviewer', { profile: reviewerProfile });
    const preflight = f.store.runs(f.task().id).findLast(run => run.role === 'reviewer')!;
    await f.report(preflight, { status: 'blocked', summary: 'Waiting for operator release GO', head: f.head, reviewResponsibility: 'environment' });
    await f.settle();
    const question = operatorQuestionFor(f.store, f.task());
    assert.equal(question?.kind, 'release'); assert.equal(question?.choices[0]?.label, 'GO — run the qualification');
    assert.equal(f.store.runs(f.task().id).filter(run => run.role === 'executor').length, 0);
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.task().id, version: f.task().version,
      action: 'proof', caller: 'operator (board)', reason: 'Try to skip the GO question' })), /requires the operator GO/);
    assert.equal(f.store.runs(f.task().id).filter(run => run.role === 'executor').length, 0);

    const exactQuestion = proofOnlyGoQuestionText(f.task());
    f.store.event(f.task().id, 'operator_question', `${question!.id}: kind release; stop blocked; head ${f.head}; question ${digest(exactQuestion)} (${exactQuestion.length} chars); options GO — run the qualification | Do not run the qualification`);
    f.store.event(f.task().id, 'operator_question_answered', `${question!.id}: GO — run the qualification — answered by operator`);
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.task().id, version: f.task().version, action: 'proof',
      caller: 'reviewer-agent', relayed: true, note: `Operator answered release question ${question!.id}: GO — run the qualification` }));
    const executor = f.store.runs(f.task().id).find(run => run.role === 'executor')!;
    assert.ok(executor); assert.equal(executor.head, f.head); assert.equal(f.task().proofExecutions.length, 1);
    const prompt = runPrompt(f.task(), executor, '/helper', '/ticket');
    assert.match(prompt, new RegExp(question!.id));
    assert.match(prompt, /Authenticated release GO evidence/);
    assert.match(prompt, /mode 0600/);
    await f.report(executor, { status: 'proof_executed', summary: 'Two qualification cases failed',
      proofResult: { status: 'failed', selector, exitCode: 1, evidence: 'case: Colima consumer did not reconnect' } });
    await f.settle();
    assert.equal(f.task().phase, 'reviewing', f.task().reason);
    assert.equal(f.store.runs(f.task().id).filter(run => run.role === 'reviewer').length, 2, `${f.task().phase}: ${f.task().reason}`);
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.task().id, version: f.task().version,
      action: 'proof', caller: 'reviewer-agent', relayed: true, note: `Operator answered release question ${question!.id}: GO — run the qualification` })), /proof-only qualification is not waiting for operator GO|one execution/);
    assert.equal(f.store.runs(f.task().id).filter(run => run.role === 'executor').length, 1, 'a settled qualification never re-runs');
    const reviewer = f.store.runs(f.task().id).findLast(run => run.role === 'reviewer')!;
    assert.equal(reviewer.agentId, 'reviewer-agent', 'the same retained reviewer judges the receipt');
    assert.match(reviewer.instruction ?? '', /Judge only the immutable Nucleus proof receipt/);
    assert.match(reviewer.instruction ?? '', /Colima consumer did not reconnect/);
    await f.report(reviewer, { status: 'changes_required', summary: 'Qualification failed', reviewText: 'The receipt records the failed Colima consumer case; brief a fix for it.', reviewResponsibility: 'author' });
    await f.settle();
    const task = f.task();
    assert.equal(task.phase, "done");
    assert.equal(task.proofOnlyResult?.status, "failed");
    assert.match(
      task.proofOnlyResult?.evidence ?? "",
      /^Qualification result failed; executor receipt status failed:/,
    );
    assert.match(
      task.proofOnlyResult?.evidence ?? "",
      /Colima consumer did not reconnect/,
    );
    assert.equal(
      f.store.runs(task.id).filter((run) => run.role === "executor").length,
      1,
    );
    await assert.rejects(
      f.engine.performTaskControl(
        taskControlInputSchema.parse({
          taskId: task.id,
          version: f.task().version,
          action: "proof",
          caller: "reviewer-agent",
          relayed: true,
          note: `Operator answered release question ${question!.id}: GO — run the qualification`,
        }),
      ),
      /is done; proof execution is closed/,
    );
    assert.equal(
      f.store.runs(task.id).filter((run) => run.role === "executor").length,
      1,
      "a closed proof-only task never gains a second execution",
    );
  } finally {
    f.close();
  }
});

test('a proof-only qualification parked on its release GO waits on the operator, not the planner (effigy#697)', async () => {
  const f = fixture(true);
  try {
    await f.engine.resolution.launch(f.task(), 'reviewer', { profile: reviewerProfile });
    const preflight = f.store.runs(f.task().id).findLast(run => run.role === 'reviewer')!;
    await f.report(preflight, { status: 'blocked', summary: 'Waiting for operator release GO', head: f.head, reviewResponsibility: 'environment' });
    await f.settle();
    const task = f.task();
    assert.equal(operatorQuestionFor(f.store, task)?.kind, 'release');
    assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'planner_escalation').length, 0, 'no planner escalation opens while the GO is open');
    assert.match(task.resolution.stop?.detail ?? '', /^Waiting with the operator: the release GO/);
    assert.equal(escalationVerbChoices(ownerVerbViews(collectOwnerVerbFacts(f.store, task))).length, 0, 'the planner ladder offers no route or restart');
    const verbs = ownerTaskNext(collectOwnerVerbFacts(f.store, task)).verbs;
    for (const verb of ['route', 'restart', 'move', 'retry_effect']) {
      const views = verbs.filter(view => view.verb === verb);
      assert.ok(views.length, `${verb} is listed`);
      assert.ok(views.every(view => view.available !== true && !view.forceArgs && view.refusal?.includes('release GO')), `${verb} names the GO`);
    }
    assert.match(verbs.find(view => view.verb === 'proof')?.refusal ?? '', /release GO/);
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: task.id, version: task.version, action: 'route',
      role: 'reviewer', profileId: reviewerProfile.id, reason: 'Try a fresh reviewer', caller: 'operator (board)' })), /release GO/);
    assert.equal(f.store.runs(task.id).filter(run => run.role === 'reviewer').length, 1, 'no second reviewer run starts');
    assert.equal(f.store.runs(task.id).filter(run => run.role === 'executor').length, 0, 'no executor starts before the GO');
  } finally { f.close(); }
});

test('a proof-only task without requiresOperatorGo demands no GO evidence and runs its selector (574)', async () => {
  const f = fixture();
  try {
    await f.engine.wake();
    const executor = f.store.runs(f.task().id).find(run => run.role === 'executor')!;
    assert.ok(executor, `executor dispatched: ${f.task().phase}: ${f.task().reason}`);
    assert.equal(executor.head, f.head);
    assert.equal(executor.proofExecution?.goEvidence, undefined, 'no GO evidence is bound without requiresOperatorGo');
    const prompt = runPrompt(f.task(), executor, '/helper', '/ticket');
    assert.match(prompt, /Run exactly ONE brief-named selector/);
    assert.doesNotMatch(prompt, /GO evidence|queue-proof-go|mode 0600/, 'the executor prompt demands no GO evidence');
    await f.report(executor, { status: 'proof_executed', summary: 'The synthetic diagnostic ran once at the merged commit',
      proofResult: { status: 'passed', selector, exitCode: 0, evidence: 'One diagnostic case passed.' } });
    assert.equal(f.store.eventsAll(f.task().id).filter(event => event.kind === 'run_result_applied' && event.detail === executor.id).length, 1);
    await f.settle();
    const reviewer = f.store.runs(f.task().id).findLast(run => run.role === 'reviewer')!;
    assert.ok(reviewer, 'Queue retains a reviewer for the receipt');
    assert.match(reviewer.instruction ?? '', /Judge only (?:the )?immutable Nucleus proof receipt|Judge only Nucleus's settled executor receipt/);
    await f.report(reviewer, { status: 'ready_to_merge', summary: 'Receipt proves the diagnostic ran', reviewText: 'The receipt matches the declared selector, inputs and merged commit.' });
    await f.settle();
    assert.equal(f.task().phase, 'done');
    assert.equal(f.task().proofOnlyResult?.status, 'passed');
    assert.equal(f.task().proofOnlyResult?.commit, f.head);
    assert.equal(f.store.runs(f.task().id).filter(run => run.role === 'executor').length, 1);
  } finally { f.close(); }
});

test('a blocked executor without start evidence stays unknown and spends its allowance', async () => {
  const f = fixture();
  try {
    await f.engine.wake();
    const executor = f.store.runs(f.task().id).find(run => run.role === 'executor')!;
    await f.report(executor, { status: 'blocked', summary: 'No result was returned.' });
    const receipt = f.task().proofExecutions[0]!;
    assert.equal(receipt.status, 'unknown');
    assert.equal(receipt.selectorStart, 'unknown');
    assert.equal(receipt.refusedBeforeSelector, false);
    const proof = ownerTaskNext(collectOwnerVerbFacts(f.store, f.task())).verbs.find(verb => verb.verb === 'proof');
    assert.equal(proof?.available, false);
  } finally { f.close(); }
});

test('a killed executor retains positive selector-start timeline evidence', async () => {
  const f = fixture();
  try {
    await f.engine.wake();
    const executor = f.store.runs(f.task().id).find(run => run.role === 'executor')!;
    const entry = { timestamp: new Date().toISOString(), item: { type: 'tool_call', callId: 'selector', name: 'exec',
      status: 'failed', detail: { type: 'shell', command: selector } } };
    f.adapter.agentTimelinePage = async () => toolTimelinePage([entry]);
    await f.report(executor, { status: 'error', summary: 'Provider terminated the shell with exit 143.' });
    const receipt = f.task().proofExecutions[0]!;
    assert.equal(receipt.status, 'unknown');
    assert.equal(receipt.selectorStart, 'started');
    assert.match(receipt.selectorStartEvidence ?? '', /Tool timeline/);
    assert.equal(receipt.refusedBeforeSelector, false);
  } finally { f.close(); }
});

test('a matching Effigy admission establishes selector start when the timeline is unavailable', async () => {
  const f = fixture();
  try {
    await f.engine.wake();
    const executor = f.store.runs(f.task().id).find(run => run.role === 'executor')!;
    const at = new Date().toISOString();
    f.store.putHostRun(hostRunRecordSchema.parse({ id: 'admission', epoch: 1, caller: 'queue:effigy-admission',
      repository: { origin: null, path: f.directory }, selector: selector.replace(/^effigy\s+/, ''),
      runClass: 'heavy', classSource: 'manifest', priority: 'interactive', state: 'running',
      submittedAt: at, capacityDeadlineAt: at, runTimeoutMs: 60000,
      budgetFallback: { cpu: 1, memoryBytes: 100 }, budget: { cpu: 1, memoryBytes: 100, wallMs: null, source: 'fallback' },
      position: null, admittedAt: at, launchedAt: at, settledAt: null, capacitySample: null,
      pid: null, processGroupId: null, startIdentity: null, settlement: null, wallMs: null, cpuMs: null,
      containers: [], capacityReleasedAt: null, capacityReleaseReason: null }));
    await f.report(executor, { status: 'error', summary: 'Provider terminated the shell.' });
    const receipt = f.task().proofExecutions[0]!;
    assert.equal(receipt.selectorStart, 'started');
    assert.match(receipt.selectorStartEvidence ?? '', /Effigy admission admission/);
    assert.equal(receipt.status, 'unknown');
  } finally { f.close(); }
});

test('a lost native release question is restored as one board decision and its answer authorizes proof-only GO', async () => {
  const f = fixture(true);
  try {
    await f.engine.resolution.launch(f.task(), 'reviewer', { profile: reviewerProfile });
    const reviewer = f.store.runs(f.task().id).findLast(run => run.role === 'reviewer')!;
    await f.report(reviewer, { status: 'blocked', summary: 'Waiting for operator release GO', head: f.head, reviewResponsibility: 'environment' });
    await f.settle();
    f.store.update(f.task().id, { profile: { ...reviewerProfile, provider: 'codex' } }, 'fixture_native_question_provider');
    const adapter = f.adapter as Adapter;
    adapter.raiseTaskDecision = async (_task, input) => await new Promise<string>((_resolve, reject) => {
      input.signal.addEventListener('abort', () => reject(Error('native question observation stopped')), { once: true });
    });
    adapter.pendingQuestions = async () => [];

    await f.engine.resolution.raiseOperatorQuestions();
    const question = operatorQuestionFor(f.store, f.task())!;
    assert.equal(f.store.eventsAll(f.task().id).filter(event => event.kind === 'operator_question').length, 1);
    await f.engine.resolution.raiseOperatorQuestions();
    const link = f.store.eventsAll(f.task().id).find(event => event.kind === 'operator_question_decision');
    assert.ok(link, 'a missing native surface is restored on the board');
    assert.match(link.detail, new RegExp(`^${question.id}: decision `));
    const decisionId = link.detail.match(/decision ([^;]+)/)![1]!;
    const decision = new Decisions(f.store).get({ id: decisionId });
    assert.equal(decision.status, 'open');
    assert.equal(decision.question, question.question);
    assert.deepEqual(decision.options, question.choices.map(choice => choice.label));
    // Tom, 2026-11-13: a headline never starts mid-sentence; the first sentence wins.
    assert.match(decision.headline ?? '', /· The proof-only qualification for merged commit/);
    assert.doesNotMatch(decision.headline ?? '', /Should .* run the qualification\?$/);
    assert.deepEqual(decision.choices?.map(choice => choice.consequence), [
      'Runs once on the existing qualification workspace; no install or consumer.',
      'Keeps the proof-only task from running this qualification.',
    ]);
    assert.equal(decision.recommended, 'GO — run the qualification');
    assert.deepEqual(decision.links.tasks, [f.task().id]);

    const answerText = 'GO — run the qualification';
    const operatorQuote = 'Tom said: "Go for effigy"';
    const answered = new Decisions(f.store).answer({ id: decisionId, version: decision.version,
      answer: answerText, answeredBy: 'planner-agent', relayed: true, note: operatorQuote });
    f.engine.resolution.operatorDecisionAnswered(answered);
    for (let index = 0; index < 20 && !f.store.eventsAll(f.task().id).some(event => event.kind === 'operator_question_answered'); index++)
      await new Promise(resolve => setTimeout(resolve, 0));
    const recorded = f.store.eventsAll(f.task().id).find(event => event.kind === 'operator_question_answered');
    assert.match(recorded?.detail ?? '', new RegExp(`^${question.id}: GO`));
    for (let index = 0; index < 200 && !f.store.eventsAll(f.task().id).some(event => ['operator_question_applied', 'operator_question_refused'].includes(event.kind)); index++)
      await new Promise(resolve => setTimeout(resolve, 5));
    const application = f.store.eventsAll(f.task().id).find(event => ['operator_question_applied', 'operator_question_refused'].includes(event.kind));
    assert.equal(application?.kind, 'operator_question_applied', application?.detail ?? 'question answer did not settle');
    assert.equal(f.store.runs(f.task().id).filter(run => run.role === 'executor').length, 1,
      'the original question id now satisfies proof-only GO');
    const executor = f.store.runs(f.task().id).find(run => run.role === 'executor')!;
    const prompt = runPrompt(f.task(), executor, '/helper', '/ticket');
    assert.match(prompt, new RegExp(decisionId));
    assert.match(prompt, new RegExp(question.id));
    assert.match(prompt, new RegExp(answerText));
    assert.match(prompt, /planner-agent \(relaying the operator\)/);
    assert.ok(prompt.includes(JSON.stringify(operatorQuote)), 'the literal operator quote is present in the JSON receipt evidence');
    assert.match(prompt, new RegExp(answered.answer!.answeredAt));
    await f.engine.resolution.raiseOperatorQuestions();
    assert.equal(f.store.eventsAll(f.task().id).filter(event => event.kind === 'operator_question_decision').length, 1,
      'the decision is raised once');
  } finally { f.close(); }
});

test('proof-only GO stays on the board, links its project, and retries a busy answer when the task is free', async () => {
  const f = fixture(true);
  try {
    await f.engine.resolution.launch(f.task(), 'reviewer', { profile: reviewerProfile });
    const reviewer = f.store.runs(f.task().id).findLast(run => run.role === 'reviewer')!;
    await f.report(reviewer, { status: 'blocked', summary: 'Waiting for operator release GO', head: f.head, reviewResponsibility: 'environment' });
    await f.settle();

    const adapter = f.adapter as Adapter;
    adapter.raiseTaskDecision = async () => { throw Error('proof-only GO must not prompt an agent'); };
    await f.engine.resolution.raiseOperatorQuestions();
    const link = f.store.eventsAll(f.task().id).find(event => event.kind === 'operator_question_decision');
    assert.ok(link, 'the operator decision is raised on the board');
    assert.equal(f.store.eventsAll(f.task().id).filter(event => event.kind === 'queue_ask_payload').length, 0,
      'proof-only GO does not create an agent relay prompt');
    const decisionId = link.detail.match(/decision ([^;]+)/)![1]!;
    const decision = new Decisions(f.store).get({ id: decisionId });
    assert.equal(decision.projectKey, f.store.projectFor(f.task().repoPath, f.task().repository!)?.key,
      'the project-filtered decision list can find this task decision');

    const original = f.engine.resolution.applyOperatorControl!;
    let attempts = 0;
    f.engine.resolution.applyOperatorControl = async input => {
      attempts++;
      if (attempts === 1) throw Error('Worker running');
      return original(input);
    };
    const answered = new Decisions(f.store).answer({ id: decisionId, version: decision.version,
      answer: 'GO — run the qualification', answeredBy: 'operator (board)', relayed: false, note: '' });
    f.engine.resolution.operatorDecisionAnswered(answered);
    for (let index = 0; index < 100 && !f.store.eventsAll(f.task().id).some(event => event.kind === 'operator_question_refused'); index++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.store.eventsAll(f.task().id).filter(event => event.kind === 'operator_question_refused').length, 1,
      'the first busy application is durably recorded');
    assert.equal(f.store.runs(f.task().id).filter(run => run.role === 'executor').length, 0);

    const nextProof = ownerTaskNext(collectOwnerVerbFacts(f.store, f.task())).verbs.find(verb => verb.verb === 'proof');
    assert.equal(nextProof?.available, true, JSON.stringify(nextProof));
    assert.equal(nextProof?.args?.action, 'proof');

    await f.engine.resolution.resumeResponsibleAnsweredQuestions();
    assert.equal(attempts, 2, 'the GO control is applied again once the task is free');
    assert.equal(f.store.eventsAll(f.task().id).filter(event => event.kind === 'operator_question_applied').length, 1);
    assert.equal(f.store.runs(f.task().id).filter(run => run.role === 'executor').length, 1);
    const goEvidence = f.store.runs(f.task().id).find(run => run.role === 'executor')!.proofExecution!.goEvidence!;
    const quote = JSON.parse(goEvidence.quote!);
    assert.equal(quote.answer, 'GO — run the qualification', 'the board answer is preserved verbatim');
    assert.equal(quote.answeredBy, 'operator (board)');
    assert.equal(quote.answeredAt, answered.answer!.answeredAt);
  } finally { f.close(); }
});

test('concurrent proof dispatch triggers produce exactly one executor and one allowance (task 560)', async () => {
  const f = fixture();
  try {
    const task = f.task();
    const dispatch = () => f.engine.resolution.proofExecution(task, {
      authorizedBy: { role: 'queue_dispatch', caller: null, note: 'concurrent dispatch triggers' }, operationId: null });
    const outcomes = await Promise.allSettled([dispatch(), dispatch()]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1, 'one trigger wins the reservation');
    const rejected = outcomes.filter(outcome => outcome.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.match(String((rejected[0] as PromiseRejectedResult).reason?.message ?? (rejected[0] as PromiseRejectedResult).reason),
      /already dispatched and unreleased|already reserved at|already spent its one execution/);
    const executors = f.store.runs(f.task().id).filter(run => run.role === 'executor');
    assert.equal(executors.length, 1, 'a second executor is never dispatched');
    assert.equal(f.task().proofExecutions.length, 1, 'the allowance is spent exactly once');
    assert.equal(f.task().proofExecutions[0]!.runId, executors[0]!.id);
    assert.equal(f.task().proofExecutions[0]!.status, 'running');
    // A later sequential trigger still refuses before sending anything.
    await assert.rejects(f.engine.resolution.proofExecution(f.task(), {
      authorizedBy: { role: 'queue_dispatch', caller: null, note: 'late sequential trigger' }, operationId: null }),
      /already dispatched and unreleased|already spent its one execution|already reserved at/);
    assert.equal(f.store.runs(f.task().id).filter(run => run.role === 'executor').length, 1);
  } finally { f.close(); }
});

test('a released superseded executor refuses late evidence without spending another allowance (task 1005)', async () => {
  const f = fixture();
  try {
    await f.engine.resolution.proofExecution(f.task(), {
      authorizedBy: { role: 'queue_dispatch', caller: null, note: 'promoted merged qualification' }, operationId: null });
    const first = f.store.runs(f.task().id).find(run => run.role === 'executor')!;
    assert.ok(first.agentId, 'the superseded run actually executed');
    const phaseBefore = f.task().phase;
    // A rival dispatch stole the current run (the pre-fix double-launch
    // shape); the orphaned run settles through the ordinary superseded-idle
    // rule with its history kept.
    f.store.update(f.task().id, { resolution: { ...f.task().resolution, currentRunId: null } }, 'test_orphan_executor');
    f.states.set(first.agentId!, { id: first.agentId!, workspaceId: first.workspaceId, status: 'idle', active: false,
      permissions: false, error: '', model: 'test/executor', provider: 'test' });
    assert.equal(await f.engine.settleSupersededIdleRuns(f.task().id, 'test superseded-idle settlement'), 1);
    assert.equal(f.store.run(first.id)!.status, 'superseded');
    assert.equal(f.store.run(first.id)!.released, true);
    // Task 1005 deliberately revokes every released credential. A late report
    // cannot authenticate or change the task's proof evidence.
    await assert.rejects(f.report(first, { status: 'proof_executed', summary: 'Qualification selector failed twice at the merged commit',
      proofResult: { status: 'failed', selector, exitCode: 125, evidence: 'exit 125: the consumer did not reconnect' } }), /Unauthorized callback/);
    const record = f.task().proofExecutions.find(item => item.runId === first.id)!;
    assert.equal(record.status, 'running', 'an unauthenticated claim records no evidence');
    assert.equal(f.store.run(first.id)!.completion, null);
    assert.equal(f.store.run(first.id)!.status, 'superseded');
    assert.equal(f.task().phase, phaseBefore);
    assert.equal(f.task().resolution.currentRunId, null);
    assert.equal(f.task().proofExecutions.length, 1);
    assert.equal(f.store.runs(f.task().id).filter(run => run.role === 'executor').length, 1);
    // The spent allowance still fences a repeat.
    await assert.rejects(f.engine.resolution.proofExecution(f.task(), {
      authorizedBy: { role: 'queue_dispatch', caller: null, note: 'repeat after historical settlement' }, operationId: null }),
      /already spent its one execution/);
  } finally { f.close(); }
});

test('a superseded run historical passed report never satisfies proof-only closeout (task 560)', async () => {
  const f = fixture();
  try {
    await f.engine.resolution.proofExecution(f.task(), {
      authorizedBy: { role: 'queue_dispatch', caller: null, note: 'promoted merged qualification' }, operationId: null });
    const first = f.store.runs(f.task().id).find(run => run.role === 'executor')!;
    f.store.update(f.task().id, { resolution: { ...f.task().resolution, currentRunId: null } }, 'test_orphan_executor');
    f.states.set(first.agentId!, { id: first.agentId!, workspaceId: first.workspaceId, status: 'idle', active: false,
      permissions: false, error: '', model: 'test/executor', provider: 'test' });
    assert.equal(await f.engine.settleSupersededIdleRuns(f.task().id, 'test superseded-idle settlement'), 1);
    // Historical evidence already in the store remains auditable, but a
    // released credential cannot submit a new claim (task 1005).
    await assert.rejects(f.report(first, { status: 'proof_executed', summary: 'Claims every qualification case passed',
      proofResult: { status: 'passed', selector, exitCode: 0, evidence: 'claims all cases passed' } }), /Unauthorized callback/);
    f.store.update(f.task().id, { proofExecutions: f.task().proofExecutions.map(item => item.runId === first.id
      ? { ...item, status: 'passed', historical: true, exitCode: 0, evidence: 'claims all cases passed', settledAt: new Date().toISOString() } : item) }, 'test_historical_receipt');
    const record = f.task().proofExecutions.find(item => item.runId === first.id)!;
    assert.equal(record.status, 'passed');
    assert.equal(record.historical, true, 'the record is marked historical evidence');
    assert.equal(f.store.run(first.id)!.completion, null, 'no completion can credit the claim as a pass');
    // The retained reviewer judges the receipt and approves it: closeout still
    // closes failed, because historical evidence is never a pass.
    f.store.update(f.task().id, { phase: 'awaiting_review', reason: 'Historical receipt awaits the retained reviewer' }, 'test_awaiting_review');
    await f.settle();
    const reviewer = f.store.runs(f.task().id).findLast(run => run.role === 'reviewer');
    assert.ok(reviewer, `the retained reviewer judges the historical receipt: ${f.task().phase}: ${f.task().reason}`);
    await f.report(reviewer!, { status: 'ready_to_merge', summary: 'Approves the historical receipt', reviewText: 'The receipt claims a pass at the merged commit.' });
    await f.settle();
    const task = f.task();
    assert.equal(task.phase, 'done');
    assert.equal(task.proofOnlyResult?.status, 'failed', 'historical evidence can never satisfy proof-only closeout');
    assert.match(task.proofOnlyResult?.evidence ?? '', /historical evidence only/i);
    assert.equal(task.proofOnlyResult?.executionRunId, first.id);
    assert.equal(task.proofExecutions.length, 1, 'no second allowance is spent');
    assert.equal(f.store.runs(task.id).filter(run => run.role === 'executor').length, 1, 'no second executor is dispatched');
    // Settled history is never rewritten: a later report from the same run is stale.
    await assert.rejects(f.report(first, { status: 'proof_executed', summary: 'A second claim arrives later',
      proofResult: { status: 'failed', selector, exitCode: 2, evidence: 'a later claim' } }), /Unauthorized callback/);
    assert.equal(f.task().proofExecutions.find(item => item.runId === first.id)!.evidence.includes('claims all cases passed'), true,
      'the first settled history stands');
  } finally { f.close(); }
});

test('timeline-only evidence settles a released superseded run and its credential stays revoked (tasks 560, 1005)', async () => {
  const f = fixture();
  try {
    await f.engine.resolution.proofExecution(f.task(), {
      authorizedBy: { role: 'queue_dispatch', caller: null, note: 'promoted merged qualification' }, operationId: null });
    const first = f.store.runs(f.task().id).find(run => run.role === 'executor')!;
    f.store.update(f.task().id, { resolution: { ...f.task().resolution, currentRunId: null } }, 'test_orphan_executor');
    f.states.set(first.agentId!, { id: first.agentId!, workspaceId: first.workspaceId, status: 'idle', active: false,
      permissions: false, error: '', model: 'test/executor', provider: 'test' });
    assert.equal(await f.engine.settleSupersededIdleRuns(f.task().id, 'test superseded-idle settlement'), 1);
    const ranEntry = { timestamp: new Date().toISOString(), item: { type: 'tool_call', callId: 'q1', name: 'exec',
      status: 'completed', detail: { type: 'shell', command: `timeout 600 ${selector}` } } };
    let page: TimelinePage | null = null;
    f.engine.adapter.agentTimelinePage = async () => page;
    // Inconclusive reads settle nothing: a gap, and a call that has not finished.
    page = toolTimelinePage([ranEntry], { gap: true });
    await f.settle();
    assert.equal(f.task().proofExecutions[0]!.status, 'running', 'a gap-ridden timeline is never evidence');
    page = toolTimelinePage([{ ...ranEntry, item: { ...ranEntry.item, status: 'running' } }] as typeof ranEntry[]);
    await f.settle();
    assert.equal(f.task().proofExecutions[0]!.status, 'running', 'a running call proves nothing about the result');
    // A terminal command that merely mentions the selector is not evidence it ran.
    page = toolTimelinePage([{ ...ranEntry, item: { ...ranEntry.item, detail: { ...ranEntry.item.detail, command: `echo ${selector}` } } }]);
    await f.settle();
    assert.equal(f.task().proofExecutions[0]!.status, 'running', 'a textual mention is never an invocation');
    // An expansion containing the selector executes nothing either.
    page = toolTimelinePage([{ ...ranEntry, item: { ...ranEntry.item, detail: { ...ranEntry.item.detail, command: 'echo ${x:-' + selector + '}' } } }]);
    await f.settle();
    assert.equal(f.task().proofExecutions[0]!.status, 'running', 'an expansion containing the selector never runs it');
    // Complete coverage showing the selector ran settles the record as
    // historical evidence with status unknown: it ran, no result was reported.
    page = toolTimelinePage([ranEntry]);
    await f.settle();
    let record = f.task().proofExecutions[0]!;
    assert.equal(record.status, 'unknown');
    assert.equal(record.historical, true);
    assert.equal(record.exitCode, null);
    assert.match(record.evidence, /Timeline-only evidence/);
    assert.match(record.evidence, /shell command/);
    assert.equal(f.store.run(first.id)!.completion, null);
    assert.ok(f.store.eventsAll(f.task().id).some(event => event.kind === 'proof_execution_historical' && /timeline-only/.test(event.detail)));
    // Task 1005 revokes the released credential: a later claim cannot upgrade
    // timeline evidence or rewrite the historical receipt.
    await assert.rejects(f.report(first, { status: 'proof_executed', summary: 'The selector failed with exit 125',
      proofResult: { status: 'failed', selector, exitCode: 125, evidence: 'exit 125: the consumer did not reconnect' } }), /Unauthorized callback/);
    record = f.task().proofExecutions[0]!;
    assert.equal(record.status, 'unknown');
    assert.equal(record.exitCode, null);
    assert.match(record.evidence, /Timeline-only evidence/);
    assert.equal(record.historical, true);
    assert.equal(f.store.run(first.id)!.completion, null);
    assert.equal(f.task().proofExecutions.length, 1, 'no second allowance is spent');
  } finally { f.close(); }
});

test('timeline settlement requires an invocation of the selector, not a textual mention (task 560)', () => {
  assert.equal(shellCommandInvokesSelector(selector, selector), true, 'the selector run directly invokes itself');
  assert.equal(shellCommandInvokesSelector(`timeout 600 ${selector}`, selector), true, 'a transparent launcher still starts the selector');
  assert.equal(shellCommandInvokesSelector(`cd /repo && ${selector}`, selector), true, 'a connector puts the next command at invocation position');
  assert.equal(shellCommandInvokesSelector(`env CI=1 timeout 300 ${selector} --reporter dot`, selector), true, 'assignments and launchers are transparent');
  assert.equal(shellCommandInvokesSelector(`mkdir -p out; ${selector} > out/proof.log`, selector), true, 'a semicolon connector and trailing redirections keep the invocation');
  assert.equal(shellCommandInvokesSelector(`echo ${selector}`, selector), false, 'an echo mentioning the selector never invokes it');
  assert.equal(shellCommandInvokesSelector(`echo "queued: ${selector}"`, selector), false, 'a quoted mention is literal text');
  assert.equal(shellCommandInvokesSelector(`true # ${selector}`, selector), false, 'a comment mentioning the selector is dropped before matching');
  assert.equal(shellCommandInvokesSelector(`touch logs/2026-11-02-${selector}.txt`, selector), false, 'a fragment inside a larger word is not an invocation');
  assert.equal(shellCommandInvokesSelector(`sh -c "${selector}"`, selector), false, 'an unreadable wrapper is a miss, never a guess');
  assert.equal(shellCommandInvokesSelector('effigy check', selector), false, 'another selector does not match');
  assert.equal(shellCommandInvokesSelector('echo effigy-check', selector), false, 'an unrelated word never matches');
  // Parameter and arithmetic expansions execute nothing: an expansion that
  // merely contains the selector text is a mention, never an invocation.
  assert.equal(shellCommandInvokesSelector('echo ${npm}', 'npm'), false, 'a parameter expansion holding the selector name never runs it');
  assert.equal(shellCommandInvokesSelector('echo $((npm-1))', 'npm'), false, 'an arithmetic expansion never runs the selector');
  assert.equal(shellCommandInvokesSelector('echo $npm', 'npm'), false, 'a bare variable mention never runs the selector');
  assert.equal(shellCommandInvokesSelector('echo ${x:-' + selector + '}', selector), false, 'an expansion containing the full selector text is still a mention');
  // Command substitutions and boundary brace groups really execute their contents.
  assert.equal(shellCommandInvokesSelector('echo $(npm run build)', 'npm'), true, 'a command substitution genuinely runs its body');
  assert.equal(shellCommandInvokesSelector('{ npm; }', 'npm'), true, 'a boundary brace group genuinely runs its body');
});

test('operator accepts a passing receipt after an unrelated reviewer finding, retaining the failed outcome', async () => {
  const f = fixture();
  try {
    await f.engine.resolution.proofExecution(f.task(), { authorizedBy: { role: 'queue_dispatch', caller: null, note: 'qualification' }, operationId: null });
    const executor = f.store.runs(f.task().id).find(run => run.role === 'executor')!;
    await f.report(executor, { status: 'proof_executed', summary: 'All checks passed', proofResult: { status: 'passed', selector, exitCode: 0, evidence: 'Input hashes, readiness, start-once and D1 passed.' } });
    await f.settle();
    const reviewer = f.store.runs(f.task().id).findLast(run => run.role === 'reviewer')!;
    await f.report(reviewer, { status: 'changes_required', summary: 'Profile preference', reviewText: 'Worker profile preference does not bind the executor.', reviewResponsibility: 'author' });
    await f.settle();
    const before = f.task();
    assert.equal(before.proofOnlyResult?.status, "failed");
    assert.match(
      before.proofOnlyResult?.evidence ?? "",
      /^Qualification result failed; executor receipt status passed:/,
    );
    const command = {
      taskId: before.id,
      version: before.version,
      action: "accept_receipt",
      reason: "Finding does not concern the receipt",
    };
    await assert.rejects(
      f.engine.performTaskControl(
        taskControlInputSchema.parse({ ...command, caller: "planner" }),
      ),
      /operator/,
    );
    const accepted = await f.engine.performTaskControl(
      taskControlInputSchema.parse({ ...command, caller: "operator (board)" }),
    );
    assert.equal(accepted.proofOnlyResult?.status, "passed");
    assert.deepEqual(
      accepted.proofReceiptAcceptance?.originalResult,
      before.proofOnlyResult,
    );
    assert.deepEqual(accepted.resolution.reviews, before.resolution.reviews);
    assert.equal(accepted.proofReceiptAcceptance?.runId, executor.id);
    assert.equal(f.store.runs(before.id).length, 2);
    const events = f.store.eventsAll(before.id).length;
    await f.engine.performTaskControl(taskControlInputSchema.parse({ ...command, caller: 'operator (board)' }));
    assert.equal(f.task().version, accepted.version);
    assert.equal(f.store.eventsAll(before.id).length, events);
    assert.ok(f.store.eventsAll(before.id).some(event => event.kind === 'proof_receipt_accepted' && event.detail.includes('profile preference')));
  } finally { f.close(); }
});

test('receipt acceptance explains missing, historical, failed and mismatched evidence', async () => {
  const { receiptAcceptanceRefusal } = await import('../core/review/proof-receipt-acceptance');
  const f = fixture();
  try {
    const base = f.task();
    const receipt = { runId: 'run', head: f.head, selector, inputs, settledAt: '2026-11-08T00:00:00Z', status: 'passed', exitCode: 0, historical: false };
    const task = { ...base, phase: 'done', proofOnlyResult: { status: 'failed', commit: f.head, selector, executionRunId: 'run', reviewerRunId: 'review', evidence: 'finding' }, proofExecutions: [receipt] } as unknown as Task;
    assert.equal(receiptAcceptanceRefusal(task), null);
    const withReceipt = (change: Record<string, unknown>) => ({ ...task, proofExecutions: [{ ...receipt, ...change }] } as Task);
    assert.match(receiptAcceptanceRefusal({ ...task, proofExecutions: [] })!, /No executor receipt/);
    assert.match(receiptAcceptanceRefusal(withReceipt({ historical: true }))!, /historical/);
    assert.match(receiptAcceptanceRefusal(withReceipt({ runId: 'other' }))!, /superseded/);
    for (const status of ['failed', 'unknown']) assert.match(receiptAcceptanceRefusal(withReceipt({ status }))!, /failed, unknown/);
    assert.match(receiptAcceptanceRefusal(withReceipt({ settledAt: null }))!, /unsettled/);
    assert.match(receiptAcceptanceRefusal(withReceipt({ head: 'b'.repeat(40) }))!, /commit/);
    assert.match(receiptAcceptanceRefusal(withReceipt({ selector: 'other' }))!, /selector/);
    assert.match(receiptAcceptanceRefusal(withReceipt({ inputs: [] }))!, /inputs/);
  } finally { f.close(); }
});

test('a proof-only task whose receipt review was lost gets a fresh receipt reviewer from move to=review, and next stops offering the spent proof', async () => {
  const f = fixture();
  try {
    const { executor, reviewer } = await lostReceiptReview(f);
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.task()));
    const proof = next.verbs.find(verb => verb.verb === 'proof');
    assert.equal(proof?.available, false, JSON.stringify(proof));
    assert.match(proof?.refusal ?? '', /already spent its one execution/);
    const review = next.verbs.find(verb => verb.verb === 'move' && verb.available && verb.args?.to === 'review');
    assert.ok(review, JSON.stringify(next.verbs.filter(verb => verb.verb === 'move')));
    assert.match(String(review.note ?? ''), /receipt is the subject/);
    const work = next.verbs.find(verb => verb.verb === 'move' && (verb.args?.to === 'work' || verb.refusal?.startsWith('move work:')));
    assert.equal(work?.available, false);
    assert.match(work?.refusal ?? '', /has no worker/);

    const choices = plannerEscalationChoicesFor(f.task());
    assert.ok(!choices.includes('Return to the worker with a new approach'));
    assert.ok(choices.includes('Stop and keep the work'));
    const question = f.store.eventsAll(f.task().id).find(event => event.kind === 'planner_escalation_question')?.detail ?? '';
    assert.match(question, /Its receipt review reported/);
    assert.doesNotMatch(question, /Return to the worker with a new approach/);
    assert.match(question, /move to=review/);
    assert.ok(f.task().resolution.stop?.suggestedVerbs?.includes('move'), JSON.stringify(f.task().resolution.stop?.suggestedVerbs));
    assert.ok(!f.task().resolution.stop?.suggestedVerbs?.includes('proof'), 'spent proof is not the suggested exit');
    const offered = escalationVerbChoices(ownerVerbViews(collectOwnerVerbFacts(f.store, f.task())));
    assert.ok(offered.some(item => /Move to review/i.test(item.label)), JSON.stringify(offered));
    assert.ok(!offered.some(item => /Return to the worker/i.test(item.label)));

    await f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: f.task().id, version: f.task().version, action: 'move', to: 'review',
      reason: 'Judge the settled receipt', caller: 'operator (board)' }));
    await f.engine.wake();
    const nextReviewer = f.store.runs(f.task().id).findLast(run => run.role === 'reviewer' && run.id !== reviewer.id);
    assert.ok(nextReviewer, `fresh receipt reviewer starts (${f.task().phase}: ${f.task().reason})`);
    assert.equal(nextReviewer.head, f.head);
    assert.match(nextReviewer.instruction ?? '', /Judge only (?:the )?immutable Nucleus proof receipt|Judge only Nucleus's settled executor receipt/);
    assert.equal(f.store.runs(f.task().id).filter(run => run.role === 'executor').length, 1);
    assert.equal(f.store.runs(f.task().id).find(run => run.role === 'executor')!.id, executor.id);
    assert.equal(f.task().proofOnlyResult, null);
    assert.equal(f.task().phase, 'reviewing');
  } finally { f.close(); }
});

test('route role=reviewer starts a fresh receipt reviewer for a proof-only task waiting on a lost receipt review', async () => {
  const f = fixture();
  try {
    const { executor, reviewer } = await lostReceiptReview(f);
    await f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: f.task().id, version: f.task().version, action: 'route', role: 'reviewer',
      profileId: reviewerProfile.id, reason: 'Start a receipt reviewer', caller: 'operator (board)' }));
    await f.engine.wake();
    const nextReviewer = f.store.runs(f.task().id).findLast(run => run.role === 'reviewer' && run.id !== reviewer.id);
    assert.ok(nextReviewer, `routed receipt reviewer starts (${f.task().phase}: ${f.task().reason})`);
    assert.equal(nextReviewer.head, f.head);
    assert.equal(nextReviewer.profile?.id, reviewerProfile.id);
    assert.match(nextReviewer.instruction ?? '', /Judge only (?:the )?immutable Nucleus proof receipt|Judge only Nucleus's settled executor receipt/);
    assert.equal(f.store.runs(f.task().id).filter(run => run.role === 'executor').length, 1);
    assert.equal(f.store.runs(f.task().id).find(run => run.role === 'executor')!.id, executor.id);
    assert.equal(f.task().proofOnlyResult, null);
  } finally { f.close(); }
});
