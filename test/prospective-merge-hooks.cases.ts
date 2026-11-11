import { fakeAdapter } from './support/fakes';
import { holdLifecycleFollowUps } from './support/hold-lifecycle-follow-ups';
import { test, weighted, weightedTiming } from './support/sharded-test';
import { timingTest } from './support/timing';
const timing = weightedTiming(timingTest);
// Case weights are the maximum isolated seconds observed per case in single-file
// runs at this pin (quiet and loaded host states), so shards aim at about 60
// seconds in isolation even on a loaded host. See docs/knowledge/contracts/orchestration.md.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rm, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { git, command } from '../core/git/index';
import { RepositoryHooks, isolationDataDirFor, isolationRootFor, statusEntries, warmCandidatePathFor } from '../core/hooks/hooks';
import { controlManifestSchema, hookEventV2Schema, hookEventV3Schema, anyHookEventSchema, hookRecordSchema } from '../shared/hooks';
import { submissionSchema, REVISION_BUDGET, type Profile, type Run } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';
import { assertCompleted, cleanupDiagnostic, observeOutcome, type BackgroundOutcome } from './support/background-outcome';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stepEngine } from './support/engine-step';
import { configuredClone, materializeSeed } from './support/git-seed';
import { observedParticipantTimeline } from './support/tool-timeline';

const setupGit = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });

const worker: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
const coordinator: Profile = { id: 'coordinator', name: 'Coordinator', provider: 'test', model: 'coordinator', notes: '', available: true, problem: '', supportedThinking: [] };

/** A repository-neutral prospective-merge hook definition. */
const prospectiveHook = (overrides: Record<string, unknown> = {}) => ({
  id: 'prospective-merge', events: ['task.pre_merge'], target: 'prospective_merge', mode: 'read_only', delivery: 'required',
  program: { kind: 'repository', executable: '.paseo/hooks/gate', argv: [] },
  timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null, ...overrides,
});
const v4Manifest = (hooks: unknown[]) => ({ schema: 'paseo.queue.control.v4', hooks });
const manifestText = (hooks: unknown[]) => JSON.stringify(v4Manifest(hooks), null, 2);

/**
 * A repository-neutral gate: it records the received event beside the candidate
 * root and answers with the requested outcome. `refuseMarker` lets a policy
 * refuse exactly what the prospective tree contains.
 */
function gateScript(ledgerPath: string, options: { outcome?: string; refuseMarker?: string; refusePath?: string; extra?: string } = {}) {
  const { outcome = 'ok', refuseMarker, refusePath = 'docs/roadmap.md', extra = '' } = options;
  const decision = refuseMarker
    ? `let text='';try{text=fs.readFileSync(${JSON.stringify(refusePath)},'utf8');}catch(error){};const refused=text.includes(${JSON.stringify(refuseMarker)});`
    : `const refused=false;`;
  return `#!/usr/bin/env node
const fs=require('fs');
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{
  const event=JSON.parse(raw);
  ${decision}
  const finalOutcome=refused?'blocked':${JSON.stringify(outcome)};
  fs.appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify({schema:event.schema,eventId:event.eventId,event:event.event,target:event.repository.target,envSchema:process.env.PASEO_QUEUE_EVENT_SCHEMA,root:event.repository.root,baseBranch:event.repository.baseBranch,baseCommit:event.repository.baseCommit,head:event.delivery.head,review:event.delivery.review,prNumber:event.delivery.prNumber,mergeCommit:event.delivery.mergeCommit,integrationCommit:event.delivery.integrationCommit,instruction:event.task.instruction,candidate:event.repository.mergeCandidate,outcome:finalOutcome})+'\\n');
  ${extra}
  process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:finalOutcome,summary:'gate '+finalOutcome,metadata:{},changedPaths:[],commitSubjectSuffix:null}));
});
`;
}

interface FixtureOptions {
  manifest?: 'none' | 'v1' | 'v2' | 'v3' | 'v4' | 'v5';
  hooks?: unknown[];
  gate?: { outcome?: string; refuseMarker?: string; refusePath?: string; extra?: string };
  laneContent?: string;
  fixedRoadmap?: string;
  staleRoadmap?: string;
  bulkFiles?: number;
}

/**
 * A repository where the worker branch forks before main repairs a stale
 * roadmap document. The integration base therefore carries content the branch
 * never touched, which is exactly the false-refusal shape spec 015 records.
 */
async function prospectiveFixture(t: any, options: FixtureOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-pm-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await materializeSeed(configuredClone, root);
  const repo = join(root, 'repo');
  const gitCommonDir = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const excludePath = join(gitCommonDir, 'info', 'exclude');
  const excluded = await readFile(excludePath, 'utf8').catch(() => '');
  if (!excluded.split(/\r?\n/).includes('.DS_Store'))
    await writeFile(excludePath, `${excluded}${excluded && !excluded.endsWith('\n') ? '\n' : ''}.DS_Store\n`);
  const ledger = join(root, 'gate.jsonl');
  await mkdir(join(repo, 'docs'), { recursive: true });
  await mkdir(join(repo, '.paseo/hooks'), { recursive: true });
  await writeFile(join(repo, 'docs/roadmap.md'), options.staleRoadmap ?? '# Roadmap\n\nstale planning document\n');
  await writeFile(join(repo, 'docs/plan.json'), '{}\n');
  if (options.manifest !== 'none') await writeFile(join(repo, '.paseo/queue.json'), options.manifest === 'v5'
    ? JSON.stringify({ schema: 'paseo.queue.control.v5', closeout: 'queue', hooks: [] })
    : options.manifest && options.manifest !== 'v4'
      ? JSON.stringify({ schema: `paseo.queue.control.${options.manifest}`, hooks: [] })
    : manifestText(options.hooks ?? [prospectiveHook()]));
  await writeFile(join(repo, '.paseo/hooks/gate'), gateScript(ledger, options.gate), { mode: 0o755 });
  await chmod(join(repo, '.paseo/hooks/gate'), 0o755);
  if (options.bulkFiles) {
    await mkdir(join(repo, 'bulk'));
    await Promise.all(Array.from({ length: options.bulkFiles }, (_, index) =>
      writeFile(join(repo, 'bulk', `${index}.txt`), `unchanged fixture file ${index}\n`)));
  }
  // Fixture setup, not the product path: staging thousands of bulk files under the
  // parallel suite can outlast the product git helper's 30-second bound.
  await setupGit(repo, 'add', '-A');
  await setupGit(repo, 'commit', '-m', 'initial policy');
  const fork = await git(repo, 'rev-parse', 'HEAD');
  const directory = join(root, 'task-worktree');
  await git(repo, 'worktree', 'add', '-b', 'ns-task', directory, fork);
  await writeFile(join(directory, 'docs/lane.txt'), options.laneContent ?? 'lane change\n');
  await git(directory, 'add', '-A');
  await git(directory, 'commit', '-m', 'lane change');
  await git(directory, 'push', 'origin', 'ns-task');
  const head = await git(directory, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'docs/roadmap.md'), options.fixedRoadmap ?? '# Roadmap\n\nfixed on main\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'fix roadmap on main');
  await git(repo, 'push', 'origin', 'main');
  const base = await git(repo, 'rev-parse', 'HEAD');
  const storeDir = await mkdtemp(join(tmpdir(), 'nsq-pm-store-'));
  t.after(() => rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const hostRunStateDir = join(storeDir, 'host-run');
  await mkdir(hostRunStateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(hostRunStateDir, 'token.key'), JSON.stringify({ format: 'host.run.keys', version: 1,
    current: { epoch: 1, keyB64: Buffer.alloc(32, 0x53).toString('base64') } }), { mode: 0o600 });
  const dbPath = join(storeDir, 'queue.sqlite');
  const store = new Store(dbPath);
  store.setMeta('hostId', 'host'); // Queue #912: register the host this fixture's ingress uses.
  return { root, repo, directory, base, head, store, dbPath, ledger };
}

function taskAtReviewedHead(store: Store, repo: string, directory: string, head: string, base: string) {
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Prospective merge gate', repoPath: repo, baseBranch: 'main',
    planningCommit: base, handoffPath: 'docs/plan.json', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  return store.update(submitted.id, {
    directory, branch: 'ns-task', workspaceId: 'task-ws', agentId: 'worker', runId: 'initial',
    prUrl: 'https://github.com/example/repo/pull/11', prHead: head, resumePrNumber: 11,
  });
}

const gateRequest = (head: string) => ({
  prUrl: 'https://github.com/example/repo/pull/11', prNumber: 11, head,
  review: 'independent review accepted the exact head', summary: 'independent review accepted the exact head',
});

/** A background execution wakes the task itself; tests observe the durable result. */
async function waitFor(check: () => boolean, timeoutMs = HOOK_TEST_TIMEOUT_MS, message = 'condition', evidence?: () => string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  let detail = '';
  try { detail = evidence ? `; ${evidence()}` : ''; } catch { detail = '; evidence unavailable'; }
  assert.fail(`Timed out waiting for ${message}${detail}`);
}

function grantIntegrationTurn(store: Store, taskId: string, sequence = 1) {
  const task = store.task(taskId);
  return store.update(taskId, { phase: 'verifying', resolution: {
    ...task.resolution, integrationTurn: { sequence, acceptedAt: new Date().toISOString() },
  } });
}

/** Push one unrelated commit to origin's base from a separate clone, so the registered checkout falls behind. */
async function advanceOriginMain(f: { root: string; repo: string }, name: string) {
  const writer = join(f.root, `origin-writer-${name}`);
  await command('git', ['clone', await git(f.repo, 'remote', 'get-url', 'origin'), writer], f.root);
  await git(writer, 'config', 'user.name', 'Queue test');
  await git(writer, 'config', 'user.email', 'queue@example.invalid');
  await writeFile(join(writer, `${name}.txt`), `${name}\n`);
  await git(writer, 'add', '-A');
  await git(writer, 'commit', '-m', `origin ${name}`);
  await git(writer, 'push', 'origin', 'main');
  return git(writer, 'rev-parse', 'HEAD');
}

async function advanceReviewedHead(directory: string) {
  await writeFile(join(directory, 'docs/lane.txt'), `lane ${randomUUID()}\n`);
  await git(directory, 'add', '-A');
  await git(directory, 'commit', '-m', 'revise lane');
  await git(directory, 'push', 'origin', 'ns-task');
  return git(directory, 'rev-parse', 'HEAD');
}

const ledgerLines = async (ledger: string) => {
  try { return (await readFile(ledger, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { return [] as Record<string, any>[]; }
};

/** Compute the tree a real `git merge` would produce for the same parent order. */
async function expectedMergeTree(root: string, repo: string, base: string, head: string) {
  const scratch = join(root, `expected-merge-${Math.random().toString(16).slice(2)}`);
  await command('git', ['clone', '--shared', '--no-checkout', repo, scratch], root);
  await git(scratch, 'config', 'user.name', 'Queue test');
  await git(scratch, 'config', 'user.email', 'queue@example.invalid');
  await git(scratch, 'checkout', '--detach', base);
  await git(scratch, 'merge', '--no-edit', '--no-ff', head);
  const tree = await git(scratch, 'rev-parse', 'HEAD^{tree}');
  await rm(scratch, { recursive: true, force: true });
  return tree;
}

test('v4 adds the prospective-merge target while v1-v3 stay frozen', () => {
  const parsed = controlManifestSchema.parse(v4Manifest([prospectiveHook()]));
  assert.equal(parsed.schema, 'paseo.queue.control.v4');
  assert.equal((parsed.hooks[0] as { target?: string }).target, 'prospective_merge');

  const v3 = { schema: 'paseo.queue.control.v3', hooks: [{ ...prospectiveHook(), target: 'prospective_merge' }] };
  assert.throws(() => controlManifestSchema.parse(v3), /Invalid|prospective_merge/i, 'v3 must not accept the prospective target');

  const reviewed = { ...prospectiveHook({ target: 'reviewed_head' }) };
  assert.equal(controlManifestSchema.safeParse(v4Manifest([reviewed])).success, true, 'v4 keeps the reviewed-head target for compatibility');
  assert.throws(() => controlManifestSchema.parse(v4Manifest([prospectiveHook({ target: 'integration_base' })])), /reviewed_head/);
  assert.throws(() => controlManifestSchema.parse(v4Manifest([prospectiveHook({ mode: 'integration_write', allowedPaths: ['docs/x'], commitSubject: { prefix: 'queue: gate', maxBytes: 80 } })])), /read_only/);
  assert.throws(() => controlManifestSchema.parse(v4Manifest([prospectiveHook({ delivery: 'advisory' })])), /required delivery/);
  assert.throws(() => controlManifestSchema.parse(v4Manifest([prospectiveHook({ events: ['task.pre_merge', 'task.closeout'] })])), /only event|reviewed_head/);
  for (const events of [['task.closeout'], ['task.blocked'], ['task.pre_dispatch']]) {
    assert.throws(() => controlManifestSchema.parse(v4Manifest([prospectiveHook({ events, target: 'prospective_merge' })])), /reviewed head/, `prospective_merge must be limited to task.pre_merge (${events[0]})`);
  }

  const v1 = { schema: 'paseo.queue.control.v1', hooks: [{ id: 'legacy', events: ['task.pre_dispatch'], mode: 'read_only', delivery: 'required', executable: '.paseo/hooks/legacy', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null }] };
  assert.deepEqual(controlManifestSchema.parse(v1), v1);
  const v2 = { schema: 'paseo.queue.control.v2', hooks: [{ id: 'legacy', events: ['task.blocked'], mode: 'read_only', delivery: 'required', program: { kind: 'repository', executable: '.paseo/hooks/legacy', argv: [] }, timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null }] };
  assert.deepEqual(controlManifestSchema.parse(v2), v2);
});

test('event v3 names the accepted head, the integration base and the synthetic candidate', () => {
  const v1Event = {
    schema: 'paseo.queue.event.v1', eventId: 'event-1', hookId: 'legacy', event: 'task.closeout', occurredAt: '2026-09-15T00:00:00.000Z', attempt: 1,
    repository: { root: '/repo', baseBranch: 'main', baseCommit: 'a'.repeat(40) },
    task: { id: 'task', title: 'Task', phase: 'closing', instruction: null },
    delivery: { prUrl: null, prNumber: null, head: null, review: null, mergeCommit: null, integrationCommit: null, summary: 'closeout' },
  };
  assert.deepEqual(hookEventV2Schema.safeParse(v1Event).success, false);
  const candidate = { integrationBase: 'b'.repeat(40), reviewedHead: 'c'.repeat(40), commit: 'd'.repeat(40), tree: 'e'.repeat(40) };
  const v3Event = {
    ...v1Event, schema: 'paseo.queue.event.v3', event: 'task.pre_merge',
    repository: { ...v1Event.repository, baseCommit: candidate.integrationBase, target: 'prospective_merge', mergeCandidate: candidate },
    delivery: { ...v1Event.delivery, head: candidate.reviewedHead },
  };
  assert.deepEqual(hookEventV3Schema.parse(v3Event), v3Event);
  assert.deepEqual(anyHookEventSchema.parse(v3Event), v3Event, 'the compatibility union reads every generation');
  assert.equal(hookEventV2Schema.safeParse(v3Event).success, false, 'a prospective event is not a v2 event');
  assert.equal(anyHookEventSchema.safeParse({ ...v3Event, repository: { ...v3Event.repository, target: 'reviewed_head' } }).success, false);
});

test('a stored occurrence keeps its closed target, and legacy records parse as the integration base', () => {
  const legacy = hookRecordSchema.parse({
    id: 'record', taskId: 'task', hookId: 'legacy', event: 'task.closeout', eventId: 'event', occurrence: 1,
    mode: 'read_only', delivery: 'required', state: 'result',
    manifest: { path: '.paseo/queue.json', commit: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}` },
    program: { kind: 'repository', executable: { path: '.paseo/hooks/gate', commit: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}` }, argv: [] },
    instruction: null, baseBranch: 'main', baseCommit: 'a'.repeat(40), attempt: 1, timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536,
    allowedPaths: [], commitSubject: null, eventDigest: 'digest', createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
  });
  assert.equal(legacy.target, 'integration_base');
  assert.equal(legacy.mergeCandidate, null);
});

weighted(8)('an unchanged stale branch file fixed on main passes the prospective tree', async t => {
  const f = await prospectiveFixture(t, { gate: { refuseMarker: 'stale planning document' } });
  t.after(() => f.store.close());
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base);
  const outcome = await new RepositoryHooks(f.store).prospectiveMergeGate(task, gateRequest(f.head));
  assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
  assert.equal(outcome.kind === 'ok' && outcome.base, f.base);
  const record = f.store.hookEvents(task.id)[0];
  assert.equal(record.state, 'result', record.error);
  assert.equal(record.result?.outcome, 'ok');
  assert.equal(record.target, 'prospective_merge');
  assert.equal(record.baseCommit, f.base, 'the occurrence pins the integration base');
  assert.equal(record.mergeCandidate?.reviewedHead, f.head);
  assert.equal(record.eventPayload?.schema, 'paseo.queue.event.v3');
  assert.equal(record.workspace, null, 'a settled candidate is disposed and the record proves it');
  const [gate] = await ledgerLines(f.ledger);
  assert.equal(gate.target, 'prospective_merge');
  assert.equal(gate.envSchema, 'paseo.queue.event.v3', 'the environment advertises the emitted event generation');
  assert.equal(gate.baseCommit, f.base);
  assert.equal(gate.head, f.head);
  assert.equal(gate.candidate.reviewedHead, f.head);
  const common = await git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  assert.equal(gate.root.startsWith(`${isolationRootFor(isolationDataDirFor(f.store), common)}/`), true, 'the gate runs in the Queue-owned isolation root');
  assert.equal(gate.root.startsWith(`${common}/`), false, 'the candidate is outside the repository');
  assert.notEqual(gate.root, f.directory);
  assert.notEqual(gate.root, f.repo);
  // Neither checkout was written.
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.base);
  assert.equal(await git(f.repo, 'status', '--porcelain'), '');
  assert.equal(await git(f.directory, 'rev-parse', 'HEAD'), f.head);
  assert.equal(await git(f.directory, 'status', '--porcelain'), '');
});

weighted(8)('the candidate is the exact normal merge: parent order and tree match a local merge fixture', async t => {
  const f = await prospectiveFixture(t);
  t.after(() => f.store.close());
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base);
  const outcome = await new RepositoryHooks(f.store).prospectiveMergeGate(task, gateRequest(f.head));
  assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
  const candidate = f.store.hookEvents(task.id)[0].mergeCandidate!;
  const parents = (await git(f.repo, 'rev-list', '--parents', '-n', '1', candidate.commit)).split(' ');
  assert.deepEqual(parents, [candidate.commit, f.base, f.head], 'the candidate merges base then head, exactly like GitHub merge');
  assert.equal(await git(f.repo, 'rev-parse', `${candidate.commit}^{tree}`), candidate.tree);
  assert.equal(candidate.tree, await expectedMergeTree(f.root, f.repo, f.base, f.head), 'the candidate tree matches a real git merge');
  const merged = await git(f.repo, 'show', `${candidate.commit}:docs/lane.txt`);
  assert.equal(merged, 'lane change', 'the candidate carries the lane change');
  assert.equal(await git(f.repo, 'show', `${candidate.commit}:docs/roadmap.md`), '# Roadmap\n\nfixed on main', 'the candidate takes the repaired main version');
});

weighted(13)('a lane defect present in the prospective tree refuses without touching either checkout', async t => {
  const f = await prospectiveFixture(t, { gate: { refuseMarker: 'lane defect', refusePath: 'docs/lane.txt' }, laneContent: 'lane defect\n' });
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
  const outcome = await new RepositoryHooks(f.store).prospectiveMergeGate(task, gateRequest(f.head));
  assert.equal(outcome.kind, 'refused', JSON.stringify(outcome));
  const record = f.store.hookEvents(task.id)[0];
  assert.equal(record.state, 'blocked');
  assert.equal(record.result?.outcome, 'blocked', 'a semantic refusal carries a parsed result');
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.base);
  assert.equal(await git(f.directory, 'rev-parse', 'HEAD'), f.head);
});

weighted(3)('a real merge conflict never runs the hook or changes either checkout', async t => {
  const f = await prospectiveFixture(t);
  t.after(() => f.store.close());
  // Both sides rewrite the same document differently.
  await writeFile(join(f.directory, 'docs/roadmap.md'), '# Roadmap\n\nlane version\n');
  await git(f.directory, 'add', '-A');
  await git(f.directory, 'commit', '-m', 'lane rewrites the roadmap');
  await git(f.directory, 'push', 'origin', 'ns-task');
  const head = await git(f.directory, 'rev-parse', 'HEAD');
  await writeFile(join(f.directory, 'docs/conflict.txt'), 'lane\n');
  await git(f.directory, 'add', '-A'); await git(f.directory, 'commit', '-m', 'lane adds conflict file'); await git(f.directory, 'push', 'origin', 'ns-task');
  const conflictingHead = await git(f.directory, 'rev-parse', 'HEAD');
  await writeFile(join(f.repo, 'docs/conflict.txt'), 'main\n');
  await git(f.repo, 'add', '-A'); await git(f.repo, 'commit', '-m', 'main adds conflict file'); await git(f.repo, 'push', 'origin', 'main');
  const base = await git(f.repo, 'rev-parse', 'HEAD');
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, conflictingHead, base);
  const outcome = await new RepositoryHooks(f.store).prospectiveMergeGate(task, gateRequest(conflictingHead));
  assert.equal(outcome.kind, 'conflict', JSON.stringify(outcome));
  assert.equal((await ledgerLines(f.ledger)).length, 0, 'the hook process never starts for a conflict');
  assert.equal(f.store.hookEvents(task.id).length, 0, 'a conflict creates no occurrence');
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), base);
  assert.equal(await git(f.directory, 'rev-parse', 'HEAD'), conflictingHead);
  assert.equal(await git(f.directory, 'status', '--porcelain'), '');
  assert.ok(head);
});

weighted(4)('base movement invalidates the result without a semantic refusal and rebuilds one current candidate', async t => {
  const f = await prospectiveFixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
  let calls = 0;
  const hooks = new RepositoryHooks(f.store, { run: async request => {
    calls += 1;
    if (calls === 1) {
      // Unrelated integration work lands while the candidate hook is running.
      await writeFile(join(f.repo, 'docs/other.txt'), 'unrelated main work\n');
      await git(f.repo, 'add', '-A');
      await git(f.repo, 'commit', '-m', 'unrelated main work');
      await git(f.repo, 'push', 'origin', 'main');
    }
    return { pid: null, code: 0, signal: null, timedOut: false, stdoutExceeded: false, stderrExceeded: false, durationMs: 1, stderr: Buffer.alloc(0),
      stdout: Buffer.from(JSON.stringify({ schema: 'paseo.queue.hook-result.v1', eventId: JSON.parse(request.stdin.toString('utf8')).eventId, outcome: 'ok', summary: 'gate ok', metadata: {}, changedPaths: [], commitSubjectSuffix: null })) };
  } });
  const outcome = await hooks.prospectiveMergeGate(task, gateRequest(f.head));
  const movedBase = await git(f.repo, 'rev-parse', 'HEAD');
  assert.notEqual(movedBase, f.base);
  assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
  assert.equal(outcome.kind === 'ok' && outcome.base, movedBase, 'the gate rebuilt at the moved base');
  assert.equal(calls, 2, 'exactly one current candidate is rebuilt per pass');
  const records = f.store.hookEvents(task.id);
  assert.equal(records.length, 2, 'the stale occurrence is retained beside the current one');
  const stale = records.find(record => record.mergeCandidate?.integrationBase === f.base)!;
  assert.equal(stale.state, 'failed');
  assert.match(stale.summary, /Superseded without a semantic finding/);
  assert.equal(f.store.events(task.id).some(event => event.kind === 'pre_merge_refused'), false, 'base movement is never a semantic refusal');
  assert.equal(f.store.events(task.id).filter(event => event.kind === 'pre_merge_candidate_stale').length, 1);
  const current = records.find(record => record.mergeCandidate?.integrationBase === movedBase)!;
  assert.equal(current.state, 'result');
  assert.equal(current.mergeCandidate?.commit === stale.mergeCandidate?.commit, false);
});

weighted(41)('the same candidate reuses its settled occurrence while a changed head mints a fresh one', async t => {
  const f = await prospectiveFixture(t);
  t.after(() => f.store.close());
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base);
  const hooks = new RepositoryHooks(f.store);
  const first = await hooks.prospectiveMergeGate(task, gateRequest(f.head));
  const again = await hooks.prospectiveMergeGate(f.store.task(task.id), gateRequest(f.head));
  assert.equal(first.kind === 'ok' && first.records[0].eventId, again.kind === 'ok' && again.records[0].eventId, 'an unchanged candidate reuses its occurrence');
  assert.equal((await ledgerLines(f.ledger)).length, 1, 'the gate executes once per exact candidate');

  await writeFile(join(f.directory, 'docs/lane.txt'), 'lane change two\n');
  await git(f.directory, 'add', '-A');
  await git(f.directory, 'commit', '-m', 'second lane change');
  await git(f.directory, 'push', 'origin', 'ns-task');
  const head = await git(f.directory, 'rev-parse', 'HEAD');
  const changed = await hooks.prospectiveMergeGate(f.store.task(task.id), gateRequest(head));
  assert.equal(changed.kind, 'ok', JSON.stringify(changed));
  const records = f.store.hookEvents(task.id);
  assert.equal(records.length, 2, 'a changed head mints a fresh candidate');
  assert.notEqual(records[0].mergeCandidate?.commit, records[1].mergeCandidate?.commit);
  assert.equal((await ledgerLines(f.ledger)).length, 2);
});

weighted(15)('an owned integration turn reuses one warm checkout for distinct exact candidates', async t => {
  const f = await prospectiveFixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
  const hooks = new RepositoryHooks(f.store);
  const common = await git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const warm = warmCandidatePathFor(isolationDataDirFor(f.store), common);
  const first = await hooks.prospectiveMergeGate(task, gateRequest(f.head));
  assert.equal(first.kind, 'ok', JSON.stringify(first));
  assert.equal((await stat(warm)).isDirectory(), true);
  const firstRecord = first.kind === 'ok' && first.records[0];
  assert.equal(firstRecord && firstRecord.workspace, null, 'settled records release the checkout lease');
  const head = await advanceReviewedHead(f.directory);
  const second = await hooks.prospectiveMergeGate(f.store.task(task.id), gateRequest(head));
  assert.equal(second.kind, 'ok', JSON.stringify(second));
  const records = f.store.hookEvents(task.id);
  assert.equal(records.length, 2);
  assert.notEqual(records[0].mergeCandidate?.commit, records[1].mergeCandidate?.commit);
  assert.equal(await git(warm, 'rev-parse', 'HEAD'), records[1].mergeCandidate?.commit);
  assert.equal(await git(warm, 'rev-list', '--parents', '-n', '1', 'HEAD'),
    `${records[1].mergeCandidate?.commit} ${f.base} ${head}`);
  assert.equal(await git(warm, 'rev-parse', 'HEAD^{tree}'), records[1].mergeCandidate?.tree);
  const delivered = await ledgerLines(f.ledger);
  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered.map(line => line.root), [warm, warm]);
  assert.deepEqual(delivered.map(line => line.candidate), records.map(record => record.mergeCandidate));
  assert.equal(f.store.events(task.id).filter(event => event.kind === 'pre_merge_warm_candidate_fallback').length, 0);
  assert.equal(f.store.events(task.id).filter(event => event.kind === 'pre_merge_candidate_build_duration').length, 2);
});

// The six warm-checkout damage scenarios each build their own real fixture, so
// they register independently at their measured isolated weights instead of
// hiding six expensive fixtures behind one indivisible parent (milestone
// 5f82e054 at ccea47c2: that weight-11 parent alone ran 51-107 s and overflowed
// its physical shard). Weights are the maximum isolated seconds observed for
// each case across single-file runs at this pin (loaded and quiet host states);
// the loaded rerun measured roughly 10.1/12.6/25.1/8.3/16.4/34.4 s.
// Dirt is what the hook itself leaves behind: build output, caches and ignored
// files. Falling back on it meant the warm checkout was never reused, so every
// pass paid for a fresh clone. Identity and ownership stay trust anchors and
// still fall back, because cleaning cannot make a foreign checkout Queue's own.
const WARM_DAMAGE_LINEAGE = 'a warm checkout repairs dirt and bookkeeping pins but refuses a foreign identity';
const warmDamageCase = (damage: 'dirty' | 'ignored' | 'foreign' | 'remote' | 'pin' | 'missing', weight: number) =>
  weighted(weight)(`${WARM_DAMAGE_LINEAGE}: ${damage}`, async t => {
    const f = await prospectiveFixture(t);
    t.after(() => f.store.close());
    const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
    const hooks = new RepositoryHooks(f.store);
    const warm = warmCandidatePathFor(isolationDataDirFor(f.store), await git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    assert.equal((await hooks.prospectiveMergeGate(task, gateRequest(f.head))).kind, 'ok');
    if (damage === 'dirty') await writeFile(join(warm, 'docs/lane.txt'), 'dirty\n');
    if (damage === 'ignored') {
      await writeFile(join(warm, '.git/info/exclude'), 'ignored.tmp\n');
      await writeFile(join(warm, 'ignored.tmp'), 'hook-local evidence\n');
    }
    if (damage === 'foreign') await git(warm, 'config', '--local', 'queue.warmOwner', '/foreign/repo/.git');
    if (damage === 'remote') await git(warm, 'remote', 'set-url', 'origin', '/foreign/origin.git');
    if (damage === 'pin') await git(warm, 'config', '--local', 'queue.warmCommit', f.base);
    if (damage === 'missing') await rm(warm, { recursive: true, force: true });
    const head = await advanceReviewedHead(f.directory);
    const result = await hooks.prospectiveMergeGate(f.store.task(task.id), gateRequest(head));
    assert.equal(result.kind, 'ok', JSON.stringify(result));
    const line = (await ledgerLines(f.ledger))[1];
    const repairable = damage === 'dirty' || damage === 'ignored' || damage === 'pin';
    assert.equal(line.root === warm, repairable, `${damage} ${repairable ? 'is repaired in place' : 'falls back to a fresh candidate'}`);
    assert.equal(line.candidate.reviewedHead, head);
    assert.equal(line.candidate.integrationBase, f.base);
    const fallbacks = f.store.events(task.id).filter(event => event.kind === 'pre_merge_warm_candidate_fallback').length;
    assert.equal(fallbacks, damage === 'foreign' || damage === 'remote' ? 1 : 0);
    if (damage === 'ignored') assert.equal((await statusEntries(warm)).length, 0, 'the repaired checkout is clean');
    if (damage === 'missing') {
      const nextHead = await advanceReviewedHead(f.directory);
      assert.equal((await hooks.prospectiveMergeGate(f.store.task(task.id), gateRequest(nextHead))).kind, 'ok');
      assert.equal((await ledgerLines(f.ledger))[2].root, warm, 'the next candidate can restore the warm checkout');
    }
  });
warmDamageCase('dirty', 13);
warmDamageCase('ignored', 15);
warmDamageCase('foreign', 26);
warmDamageCase('remote', 24);
warmDamageCase('pin', 17);
warmDamageCase('missing', 35);

weighted(12)('without integration-turn ownership the candidate remains disposable', async t => {
  const f = await prospectiveFixture(t);
  t.after(() => f.store.close());
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base);
  const result = await new RepositoryHooks(f.store).prospectiveMergeGate(task, gateRequest(f.head));
  assert.equal(result.kind, 'ok', JSON.stringify(result));
  const warm = warmCandidatePathFor(isolationDataDirFor(f.store), await git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  assert.equal((await ledgerLines(f.ledger))[0].root === warm, false);
  assert.equal(f.store.events(task.id).some(event => event.kind === 'pre_merge_warm_candidate_created'), false);
});

weighted(34)('a later integration turn cannot use the warm checkout while an earlier turn owns the repository', async t => {
  const f = await prospectiveFixture(t);
  t.after(() => f.store.close());
  const first = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
  const later = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id, 2);
  const warm = warmCandidatePathFor(isolationDataDirFor(f.store), await git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  assert.equal((await new RepositoryHooks(f.store).prospectiveMergeGate(later, gateRequest(f.head))).kind, 'ok');
  assert.notEqual((await ledgerLines(f.ledger))[0].root, warm);
  assert.equal((await new RepositoryHooks(f.store).prospectiveMergeGate(first, gateRequest(f.head))).kind, 'ok');
  assert.equal((await ledgerLines(f.ledger))[1].root, warm);
});

weighted(8)('separate repositories keep separate warm checkouts', async t => {
  const first = await prospectiveFixture(t);
  const second = await prospectiveFixture(t);
  t.after(() => { first.store.close(); second.store.close(); });
  const firstTask = grantIntegrationTurn(first.store, taskAtReviewedHead(first.store, first.repo, first.directory, first.head, first.base).id);
  const secondTask = grantIntegrationTurn(second.store, taskAtReviewedHead(second.store, second.repo, second.directory, second.head, second.base).id);
  assert.equal((await new RepositoryHooks(first.store).prospectiveMergeGate(firstTask, gateRequest(first.head))).kind, 'ok');
  assert.equal((await new RepositoryHooks(second.store).prospectiveMergeGate(secondTask, gateRequest(second.head))).kind, 'ok');
  const firstRoot = (await ledgerLines(first.ledger))[0].root;
  const secondRoot = (await ledgerLines(second.ledger))[0].root;
  assert.notEqual(firstRoot, secondRoot);
  assert.equal(firstRoot, warmCandidatePathFor(isolationDataDirFor(first.store), await git(first.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')));
  assert.equal(secondRoot, warmCandidatePathFor(isolationDataDirFor(second.store), await git(second.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')));
});

timing(48)('warm and fresh paths produce the same candidate and policy outcome', { timeout: 240_000 }, async t => {
  const f = await prospectiveFixture(t, { bulkFiles: 5000 });
  t.after(() => f.store.close());
  const warmTask = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
  assert.equal((await new RepositoryHooks(f.store).prospectiveMergeGate(warmTask, gateRequest(f.head))).kind, 'ok');
  const head = await advanceReviewedHead(f.directory);
  assert.deepEqual(await statusEntries(f.repo, false), [], 'the integration fixture stays clean before the warm gate');
  const warmStart = Date.now();
  const warmHooks = new RepositoryHooks(f.store);
  const warm = await warmHooks.prospectiveMergeGate(f.store.task(warmTask.id), gateRequest(head));
  const warmStageMs = Date.now() - warmStart;
  const freshTask = taskAtReviewedHead(f.store, f.repo, f.directory, head, f.base);
  const freshStart = Date.now();
  const fresh = await new RepositoryHooks(f.store).prospectiveMergeGate(freshTask, gateRequest(head));
  const freshStageMs = Date.now() - freshStart;
  assert.equal(warm.kind, 'ok', JSON.stringify(warm));
  assert.equal(fresh.kind, 'ok', JSON.stringify(fresh));
  const warmRecord = f.store.hookEvents(warmTask.id)[1];
  const freshRecord = f.store.hookEvents(freshTask.id)[0];
  assert.deepEqual(warmRecord.mergeCandidate, freshRecord.mergeCandidate);
  assert.equal(warmRecord.result?.outcome, freshRecord.result?.outcome);
  const delivered = await ledgerLines(f.ledger);
  assert.equal(delivered.length, 3);
  assert.deepEqual([delivered[1], delivered[2]].map(line => [line.target, line.baseCommit, line.head, line.candidate, line.outcome]),
    [delivered[1], delivered[1]].map(line => [line.target, line.baseCommit, line.head, line.candidate, line.outcome]));
  const duration = (id: string, kind: string) => f.store.events(id).find(event => event.kind === kind)?.detail;
  t.diagnostic(`same local fixture: warm stage ${warmStageMs}ms, build ${duration(warmTask.id, 'pre_merge_candidate_build_duration')}, hook ${duration(warmTask.id, 'pre_merge_hook_duration')}; fresh stage ${freshStageMs}ms, build ${duration(freshTask.id, 'pre_merge_candidate_build_duration')}, hook ${duration(freshTask.id, 'pre_merge_hook_duration')}`);
});

weighted(3)('a lane that rewrites the required gate program holds instead of executing it', async t => {
  const f = await prospectiveFixture(t);
  t.after(() => f.store.close());
  await writeFile(join(f.directory, '.paseo/hooks/gate'), '#!/usr/bin/env node\nprocess.stdout.write("{}");\n');
  await chmod(join(f.directory, '.paseo/hooks/gate'), 0o755);
  await git(f.directory, 'add', '-A');
  await git(f.directory, 'commit', '-m', 'lane rewrites the gate');
  await git(f.directory, 'push', 'origin', 'ns-task');
  const head = await git(f.directory, 'rev-parse', 'HEAD');
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, head, f.base);
  const outcome = await new RepositoryHooks(f.store).prospectiveMergeGate(task, gateRequest(head));
  assert.equal(outcome.kind, 'hold', JSON.stringify(outcome));
  const record = f.store.hookEvents(task.id)[0];
  assert.equal(record.state, 'blocked');
  assert.match(record.error, /changes the pinned hook program/);
  assert.equal(record.result, null, 'a program drift is an operational hold, never a finding');
  assert.equal((await ledgerLines(f.ledger)).length, 0);
});

weighted(16)('a restart reconciles the pinned occurrence instead of duplicating the gate', async t => {
  const f = await prospectiveFixture(t, { gate: { extra: "fs.writeFileSync('docs/plan.json','mutated');" } });
  t.after(() => f.store.close());
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base);
  const hooks = new RepositoryHooks(f.store);
  const first = await hooks.prospectiveMergeGate(task, gateRequest(f.head));
  assert.equal(first.kind, 'hold', JSON.stringify(first));
  const uncertain = f.store.hookEvents(task.id)[0];
  assert.equal(uncertain.state, 'uncertain');
  const candidatePath = uncertain.workspace!.path;
  // A repeated lifecycle pass resumes the same occurrence instead of minting a second one.
  const again = await hooks.prospectiveMergeGate(f.store.task(task.id), gateRequest(f.head));
  assert.equal(again.kind, 'hold', JSON.stringify(again));
  assert.equal(f.store.hookEvents(task.id).length, 1, 'an open occurrence is never duplicated');
  assert.equal(f.store.hookEvents(task.id)[0].eventId, uncertain.eventId);
  // Restart during the same occurrence: durable running intent with no live process
  // reconciles to retryable intent while the pinned candidate is provably intact.
  await git(candidatePath, 'checkout', '--', 'docs/plan.json');
  const current = f.store.hookEvents(task.id)[0];
  f.store.putHookEvent({ ...current, state: 'running', processId: null, attempt: 1 });
  const reconciled = await hooks.reconcile(f.store.hookEvent(current.id)!);
  assert.equal(reconciled.state, 'intent', reconciled.error);
  assert.equal(reconciled.eventId, uncertain.eventId);
});

weighted(23)('mutation and transport failure inside the candidate are operational holds without a finding', async t => {
  const f = await prospectiveFixture(t, { gate: { extra: "fs.writeFileSync('docs/plan.json','mutated');" } });
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
  const outcome = await new RepositoryHooks(f.store).prospectiveMergeGate(task, gateRequest(f.head));
  assert.equal(outcome.kind, 'hold', JSON.stringify(outcome));
  const record = f.store.hookEvents(task.id)[0];
  assert.equal(record.state, 'uncertain');
  assert.equal(record.result, null);
  assert.ok(record.workspace?.path, 'an uncertain candidate keeps its checkout for reconciliation');
  assert.equal((await stat(record.workspace!.path)).isDirectory(), true);
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.base);
  const head = await advanceReviewedHead(f.directory);
  const next = await new RepositoryHooks(f.store).prospectiveMergeGate(f.store.task(task.id), gateRequest(head));
  assert.equal(next.kind, 'hold', JSON.stringify(next));
  const delivered = await ledgerLines(f.ledger);
  assert.equal(delivered.length, 2);
  assert.notEqual(delivered[0].root, delivered[1].root, 'an uncertain warm checkout is never assigned to the next candidate');
});

// The 'schema 12 derives the closed target and candidate' case is retired with
// the pre-49 migration ladder (PR 747): native admission refuses schema 11
// outright, so the rebuild-on-reopen migration can never run.

weighted(26)('both pre-merge targets stay independently addressable under one v4 manifest', async t => {
  const f = await prospectiveFixture(t, {
    hooks: [
      { id: 'branch-local', events: ['task.pre_merge'], target: 'reviewed_head', mode: 'read_only', delivery: 'required', program: { kind: 'repository', executable: '.paseo/hooks/gate', argv: [] }, timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null },
      prospectiveHook(),
    ],
  });
  t.after(() => f.store.close());
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base);
  const hooks = new RepositoryHooks(f.store);
  const reviewed = await hooks.emit('task.pre_merge', task, {
    event: 'task.pre_merge', baseCommit: f.head,
    delivery: { prUrl: task.prUrl, prNumber: 11, head: f.head, review: 'accepted', summary: 'accepted' },
  }, hook => hook.target === 'reviewed_head');
  assert.equal(reviewed.records.length, 1, 'the reviewed-head emission addresses only its own target');
  assert.equal(reviewed.records[0].target, 'reviewed_head');
  assert.equal(reviewed.records[0].eventPayload?.schema, 'paseo.queue.event.v2');
  assert.equal(reviewed.records[0].baseCommit, f.head);

  const outcome = await hooks.prospectiveMergeGate(f.store.task(task.id), gateRequest(f.head));
  assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
  const prospective = f.store.hookEvents(task.id).find(record => record.target === 'prospective_merge')!;
  assert.equal(prospective.baseCommit, f.base);
  assert.equal(prospective.eventPayload?.schema, 'paseo.queue.event.v3');
  assert.equal((await ledgerLines(f.ledger)).length, 2, 'each target executes once, in its own root');
});

weighted(6)('telemetry distinguishes prospective-merge occurrences and stale candidate rebuilds', async t => {
  const f = await prospectiveFixture(t);
  t.after(() => f.store.close());
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base);
  let calls = 0;
  const hooks = new RepositoryHooks(f.store, { run: async request => {
    calls += 1;
    if (calls === 1) {
      await writeFile(join(f.repo, 'docs/other.txt'), 'unrelated main work\n');
      await git(f.repo, 'add', '-A'); await git(f.repo, 'commit', '-m', 'unrelated main work'); await git(f.repo, 'push', 'origin', 'main');
    }
    return { pid: null, code: 0, signal: null, timedOut: false, stdoutExceeded: false, stderrExceeded: false, durationMs: 1, stderr: Buffer.alloc(0),
      stdout: Buffer.from(JSON.stringify({ schema: 'paseo.queue.hook-result.v1', eventId: JSON.parse(request.stdin.toString('utf8')).eventId, outcome: 'ok', summary: 'gate ok', metadata: {}, changedPaths: [], commitSubjectSuffix: null })) };
  } });
  const outcome = await hooks.prospectiveMergeGate(task, gateRequest(f.head));
  assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
  const { deriveTaskTelemetry } = await import('../core/telemetry/telemetry');
  const events = f.store.events(task.id);
  const telemetry = deriveTaskTelemetry(f.store.task(task.id), events, f.store.runs(task.id), f.store.notices(task.id), f.store.hookEvents(task.id));
  assert.equal(telemetry.interventions.prospectiveMergeHooks, 2, 'one occurrence per evaluated candidate');
  assert.equal(telemetry.interventions.staleCandidateRebuilds, 1, 'stale rebuilds stay separate from semantic refusals');
  // A superseded stale occurrence follows the existing failed-required convention,
  // exactly as an automatic base-advance replay supersession does.
  assert.equal(telemetry.interventions.hookHolds, 1);
  assert.equal(telemetry.interventions.revisions, 0);
});

timing(12)('a long background validation holds no lane slot, so two submissions settle while it runs', { timeout: 60_000 }, async t => {
  const f = await resolutionFixture(t, { manifest: 'none' });
  try {
    const ledger = join(f.root, 'long-validation-runs.txt');
    const command = { argv: [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(ledger)},'run\\n');setTimeout(()=>{},3000)`], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 4096 };
    f.store.putRepository({ origin: null, path: f.repo }, null, '', command);
    await f.engine.wake();
    await waitFor(() => Boolean(f.current().resolution.projectValidation?.pid), HOOK_TEST_TIMEOUT_MS, 'the background validation process to record its PID', () => validationEvidence(() => f.current().resolution.projectValidation));
    assert.equal(f.current().resolution.projectValidation?.state, 'running', validationEvidence(() => f.current().resolution.projectValidation));
    // There is no global lane cap: an unrelated lane runs immediately while the
    // long validation is still in flight.
    let unrelatedRan = false;
    await f.engine.scheduleLane('lane:unrelated', 2, () => { unrelatedRan = true; });
    assert.equal(unrelatedRan, true, `an unrelated lane is not parked behind the validation; ${validationEvidence(() => f.current().resolution.projectValidation)}`);
    const started = Date.now();
    const submissions = [0, 1].map(index => submissionSchema.parse({
      submissionId: `under-validation-${index}`, title: `Submission while validating ${index}`, repoPath: f.repo,
      baseBranch: 'main', planningCommit: f.base, handoffPath: 'docs/plan.json', originAgentId: 'origin',
    }));
    const receipts = await Promise.all(submissions.map(submission => f.engine.startSubmission(submission)));
    const settled = await Promise.race([
      Promise.all(receipts.map(receipt => 'accepted' in receipt ? f.engine.awaitOperation(receipt.operation.id, 8_000) : Promise.resolve(null))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('submissions starved behind the project validation')), 9_000)),
    ]);
    for (const operation of settled) assert.equal(operation?.state, 'succeeded', `${operation?.diagnostic}; ${validationEvidence(() => f.current().resolution.projectValidation)}`);
    assert.ok(Date.now() - started < 5_000, `both submissions settled while the validation was still running; ${validationEvidence(() => f.current().resolution.projectValidation)}`);
    assert.equal(f.current().resolution.projectValidation?.state, 'running', `the validation had not finished; ${validationEvidence(() => f.current().resolution.projectValidation)}`);
    await waitFor(() => f.current().resolution.projectValidation?.state === 'passed', HOOK_TEST_TIMEOUT_MS, 'the validation to finish', () => validationEvidence(() => f.current().resolution.projectValidation));
  } finally { await f.close(); }
});

weighted(4)('a background validation that meets a merge conflict returns the worker instead of looping', async t => {
  // Live, 2026-09-29 (project-k #55): the conflict was decided in the background chain before any
  // run was recorded; the outcome was dropped and the same candidate was rebuilt for 2.5 hours.
  const f = await resolutionFixture(t, { manifest: 'none' });
  try {
    f.store.putRepository({ origin: null, path: f.repo }, null, '', validationCommand("process.stdout.write('never runs')"));
    await writeFile(join(f.directory, 'docs/conflict.txt'), 'lane\n');
    await git(f.directory, 'add', '-A'); await git(f.directory, 'commit', '-m', 'lane adds a conflicting document'); await git(f.directory, 'push', 'origin', 'ns-task');
    const head = await git(f.directory, 'rev-parse', 'HEAD');
    await writeFile(join(f.repo, 'docs/conflict.txt'), 'main\n');
    await git(f.repo, 'add', '-A'); await git(f.repo, 'commit', '-m', 'main adds the same document'); await git(f.repo, 'push', 'origin', 'main');
    f.store.update(f.taskId, { prHead: head, resolution: { ...f.current().resolution, review: { ...f.current().resolution.review!, head } } });
    const release = holdLifecycleFollowUps(f.engine, () => f.current().phase === 'changes_requested');
    await f.engine.wake();
    await waitFor(() => f.current().phase === 'changes_requested', HOOK_TEST_TIMEOUT_MS, 'the conflict to reach the task', () => validationEvidence(() => f.current().resolution.projectValidation));
    assert.match(f.current().reason, /Prospective merge conflict/, validationEvidence(() => f.current().resolution.projectValidation));
    assert.equal(f.current().resolution.projectValidation, null, `no validation ran; ${validationEvidence(() => f.current().resolution.projectValidation)}`);
    assert.equal(f.store.events(f.taskId).filter(event => event.kind === 'project_validation_candidate_intent').length, 1, `the candidate is built once, not relaunched; ${validationEvidence(() => f.current().resolution.projectValidation)}`);
    assert.equal(f.mergeCount(), 0, validationEvidence(() => f.current().resolution.projectValidation));
    release();
  } finally { await f.close(); }
});
weighted(2)('a lost background validation remains held after restart until explicit resubmission', async t => {
  const f = await resolutionFixture(t, { manifest: 'none' });
  try {
    const command = validationCommand("process.stdout.write('rerun reached the task')");
    f.store.putRepository({ origin: null, path: f.repo }, null, '', command);
    const { createHash } = await import('node:crypto');
    const lost = { argv: command.argv, digest: createHash('sha256').update(JSON.stringify(command.argv)).digest('hex'), exitCode: null, durationMs: 0,
      outputTail: 'This lost validation requires explicit resubmission', base: f.base, head: f.head, state: 'hold' as const,
      queueBuild: '', settingsRevision: 0, hostRunId: 'lost-validation-run', hostRunEpoch: 1, resubmissionRequired: true,
      pid: null, admission: null, capacityWait: null, capacityUnavailable: false };
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, projectValidation: lost } });
    const outcome = await new RepositoryHooks(f.store).projectValidationGate(f.store.task(f.taskId), f.head, command);
    assert.equal(outcome.kind, 'hold', validationEvidence(() => f.current().resolution.projectValidation));
    assert.equal(f.current().resolution.projectValidation?.hostRunId, 'lost-validation-run', validationEvidence(() => f.current().resolution.projectValidation));
    assert.equal(f.current().resolution.projectValidation?.resubmissionRequired, true, validationEvidence(() => f.current().resolution.projectValidation));
    assert.equal(f.store.events(f.taskId).some(event => event.kind === 'project_validation_intent'), false,
      `a lost run stays held instead of automatically creating a new run ID; ${validationEvidence(() => f.current().resolution.projectValidation)}`);
  } finally { await f.close(); }
});

async function resolutionFixture(t: any, options: FixtureOptions & { mergeGateBase?: (repo: string) => Promise<string> } = {}) {
  const f = await prospectiveFixture(t, options);
  f.store.setMeta('paused', false);
  f.store.setMeta('lastRetentionAt', Date.now());
  f.store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = f.store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Prospective merge gate', repoPath: f.repo, baseBranch: 'main',
    planningCommit: f.base, handoffPath: 'docs/plan.json', originAgentId: 'origin',
  }), 'host', 'handoff', f.base);
  f.store.update(submitted.id, {
    phase: 'verifying', workspaceIntent: true, agentIntent: true, workspaceId: 'task-ws', directory: f.directory,
    branch: 'ns-task', agentId: 'worker', runId: 'initial', profile: worker,
    prUrl: 'https://github.com/example/repo/pull/11', prHead: f.head, resumePrNumber: 11,
    resolution: {
      ...submitted.resolution,
      integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
      review: { eventId: 'review', taskId: submitted.id, runId: 'review-run', status: 'ready_to_merge', summary: 'independent review accepted the exact head', head: f.head, reviewCommentId: 11 },
      mergeBase: f.base,
    },
  });
  const states = new Map<string, AgentObservation>();
  states.set('worker', { id: 'worker', workspaceId: 'task-ws', status: 'idle', active: false, permissions: false, error: '' });
  const runs: Run[] = [];
  let merges = 0;
  const adapter: Adapter & ResolutionAdapter = fakeAdapter({
    profiles: async () => [worker, coordinator], validate: async () => f.head, verifyWorkspace: async () => 'main',
    createWorkspace: async () => { throw new Error('No workspace expected'); },
    createAgent: async () => { throw new Error('No worker dispatch expected'); },
    observe: async id => { const state = states.get(id); if (!state) throw new Error('Agent was not found'); return state; },
    agentTimelinePage: observedParticipantTimeline(states),
    verifyPr: async () => ({ head: f.store.task(submitted.id).prHead!, url: 'https://github.com/example/repo/pull/11' }),
    createRun: async (_task, run) => { runs.push(run); const id = `agent-${run.id}`; states.set(id, { id, workspaceId: run.workspaceId, status: 'running', active: true, permissions: false, error: '' }); return { id, workspaceId: run.workspaceId }; },
    sendRun: async (_task, run) => { runs.push(run); states.set(run.agentId!, { ...states.get(run.agentId!)!, active: true, status: 'running' }); },
    findRunAgents: async () => [], verifyReview: async () => {},
    mergeGate: async () => ({ head: f.store.task(submitted.id).prHead!, base: await git(f.repo, 'rev-parse', 'HEAD'), wait: '' }),
    merge: async () => { merges += 1; },
    merged: async () => ({ merged: true, commit: f.head, head: f.head, base: 'main' }), syncMain: async () => f.head,
    verifyCloseout: async () => undefined, notify: async () => {},
  });
  const engine = new Engine(f.store, adapter, 0);
  engine.profiles = [worker, coordinator];
  return { ...f, store: f.store, engine, adapter, taskId: submitted.id, runs, mergeCount: () => merges, current: () => f.store.task(submitted.id), close: async () => { await engine.stop(); f.store.close(); } };
}

weighted(6)('a prospective refusal returns the retained worker through one semantic revision', async t => {
  const f = await resolutionFixture(t, { gate: { refuseMarker: 'lane defect', refusePath: 'docs/lane.txt' }, laneContent: 'lane defect\n' });
  try {
    await stepEngine(f.engine);
    const refused = f.current();
    assert.equal(refused.phase, 'changes_requested', refused.reason);
    assert.match(refused.reason, /Repository pre-merge refusal at the prospective merge/);
    assert.equal(refused.resolution.attention, false);
    assert.equal(refused.resolution.mergeIntent, false);
    assert.equal(refused.resolution.pendingRevisionCause, 'pre_merge');
    assert.equal(refused.resolution.review?.status, 'ready_to_merge', 'the accepted review stays as evidence');
    assert.equal(f.mergeCount(), 0, 'a refusal never merges');
    const record = f.store.hookEvents(f.taskId)[0];
    assert.equal(record.state, 'blocked');
    assert.equal(record.result?.outcome, 'blocked');
    assert.equal(record.baseCommit, f.base);
    assert.ok(f.store.events(f.taskId).some(event => event.kind === 'pre_merge_refused'));
    assert.equal(f.store.notices(f.taskId).filter(notice => notice.kind === 'attention').length, 0, 'a semantic refusal does not notify Chatterbox');

    await f.engine.wake();
    const revision = f.runs.findLast(run => run.role === 'revision');
    assert.ok(revision, 'the retained worker receives the refusal');
    assert.equal(revision!.revisionCause, 'pre_merge', 'the refusal returns the retained worker through one semantic revision');
    assert.equal(revision!.agentId, 'worker');
    assert.equal(f.current().resolution.revisionRuns, 0, 'a refusal continues the open round without consuming a review round');
  } finally { await f.close(); }
});

weighted(3)('a prospective conflict uses the worker-update path before any hook runs', async t => {
  const f = await resolutionFixture(t);
  try {
    await writeFile(join(f.directory, 'docs/conflict.txt'), 'lane\n');
    await git(f.directory, 'add', '-A'); await git(f.directory, 'commit', '-m', 'lane adds a conflicting document'); await git(f.directory, 'push', 'origin', 'ns-task');
    const head = await git(f.directory, 'rev-parse', 'HEAD');
    await writeFile(join(f.repo, 'docs/conflict.txt'), 'main\n');
    await git(f.repo, 'add', '-A'); await git(f.repo, 'commit', '-m', 'main adds the same document'); await git(f.repo, 'push', 'origin', 'main');
    const base = await git(f.repo, 'rev-parse', 'HEAD');
    f.store.update(f.taskId, { prHead: head, resolution: { ...f.current().resolution, review: { ...f.current().resolution.review!, head } } });
    await stepEngine(f.engine);
    const refused = f.current();
    assert.equal(refused.phase, 'changes_requested', refused.reason);
    assert.match(refused.reason, /Repository pre-merge refusal at the prospective merge/);
    assert.equal(refused.resolution.pendingRevisionCause, 'pre_merge');
    assert.equal(f.store.hookEvents(f.taskId).length, 0, 'a conflict creates no hook occurrence');
    assert.equal((await ledgerLines(f.ledger)).length, 0, 'the hook never runs for a conflict');
    assert.equal(f.mergeCount(), 0);
    assert.notEqual(base, f.base);
  } finally { await f.close(); }
});

weighted(10)('a passing prospective gate proceeds to mechanical verification and one merge', async t => {
  const f = await resolutionFixture(t);
  try {
    // One sweep per lifecycle step (#346) so the passed gate is observed before the merge.
    await stepEngine(f.engine);
    const passed = f.current();
    assert.equal(passed.phase, 'merging', passed.reason);
    assert.ok(passed.resolution.mechanicalVerification, 'a pass continues to mechanical verification');
    assert.equal(passed.resolution.mechanicalVerification!.base, f.base, 'mechanical verification pins the candidate base');
    assert.equal(f.store.hookEvents(f.taskId)[0].state, 'result');
    await stepEngine(f.engine);
    assert.equal(f.mergeCount(), 1, 'the reviewed head merges exactly once');
    assert.equal(f.store.hookEvents(f.taskId).length, 1, 'merge does not re-run the gate');
  } finally { await f.close(); }
});

weighted(20)('a prospective refusal at the cap continues the open round without parking', async t => {
  const f = await resolutionFixture(t, { gate: { refuseMarker: 'lane defect', refusePath: 'docs/lane.txt' }, laneContent: 'lane defect\n' });
  try {
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, revisionRuns: REVISION_BUDGET } });
    await stepEngine(f.engine);
    assert.equal(f.current().phase, 'changes_requested', f.current().reason);
    assert.equal(f.current().resolution.pendingRevisionCause, 'pre_merge');
    assert.equal(f.store.events(f.taskId).filter(event => event.kind === 'revision_budget_exhausted').length, 0, 'a pre-merge refusal never parks at the revision cap');
    await f.engine.wake();
    const revision = f.runs.findLast(run => run.role === 'revision');
    assert.ok(revision, 'the retained worker still receives the refusal at the cap');
    assert.equal(revision!.revisionCause, 'pre_merge');
    assert.equal(f.current().resolution.revisionRuns, REVISION_BUDGET, 'a pre-merge refusal consumes no review round');
    assert.equal(f.mergeCount(), 0);
    assert.equal(f.store.hookEvents(f.taskId)[0].state, 'blocked');
  } finally { await f.close(); }
});

weighted(8)('a base race between the hook and the merge gate rebuilds instead of spending revision authority', async t => {
  const f = await resolutionFixture(t);
  try {
    let gateCalls = 0;
    let advanced = false;
    f.adapter.mergeGate = async () => {
      gateCalls += 1;
      if (gateCalls === 1 && !advanced) {
        advanced = true;
        // Unrelated integration work lands after the candidate hook passed.
        await writeFile(join(f.repo, 'docs/other.txt'), 'unrelated main work\n');
        await git(f.repo, 'add', '-A'); await git(f.repo, 'commit', '-m', 'unrelated main work'); await git(f.repo, 'push', 'origin', 'main');
      }
      return { head: f.current().prHead!, base: await git(f.repo, 'rev-parse', 'HEAD'), wait: '' };
    };
    // One sweep (#346): observe the rebuilt candidate before the follow-up merges it.
    await stepEngine(f.engine);
    const passed = f.current();
    const movedBase = await git(f.repo, 'rev-parse', 'HEAD');
    assert.equal(passed.phase, 'merging', passed.reason);
    assert.equal(passed.resolution.mechanicalVerification!.base, movedBase, 'the rebuild pins the new base');
    assert.equal(f.current().resolution.revisionRuns, 0, 'a stale candidate spends no revision authority');
    assert.equal(f.current().resolution.pendingRevisionCause, null);
    assert.ok(f.store.events(f.taskId).some(event => event.kind === 'pre_merge_candidate_stale'), 'the stale candidate rebuild is recorded');
    const candidates = f.store.hookEvents(f.taskId).map(record => record.mergeCandidate!.integrationBase);
    assert.equal(candidates.includes(f.base), true, 'the stale candidate stays as evidence');
    assert.equal(candidates.includes(movedBase), true, 'the rebuilt candidate answers for the current base');
  } finally { await f.close(); }
});

weighted(12)('an origin-ahead integration base is fast-forwarded and the prospective merge proceeds with no owner action', async t => {
  const f = await resolutionFixture(t);
  try {
    const originBase = await advanceOriginMain(f, 'ahead');
    assert.notEqual(await git(f.repo, 'rev-parse', 'HEAD'), originBase, 'the registered checkout starts behind origin');
    await stepEngine(f.engine);
    const passed = f.current();
    assert.equal(passed.phase, 'merging', passed.reason);
    assert.equal(passed.resolution.attention, false, 'no owner action is needed');
    assert.equal(passed.resolution.mechanicalVerification!.base, originBase, 'the gate pins the renewed base');
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), originBase, 'the registered checkout fast-forwarded to origin');
    assert.equal(f.store.events(f.taskId).filter(event => event.kind === 'integration_base_renewed').length, 1);
    await stepEngine(f.engine);
    assert.equal(f.mergeCount(), 1, 'the reviewed head merges exactly once');
  } finally { await f.close(); }
});

weighted(12)('an integration base that origin keeps moving past parks for an operator after the renewal bound', async t => {
  const f = await resolutionFixture(t);
  try {
    const hooks = f.engine.resolution.hooks!;
    const integrationBase = hooks.integrationBase.bind(hooks);
    let pushes = 0;
    // Every base read finds origin one commit ahead, as on a busy board where main moves faster than the gate.
    hooks.integrationBase = async task => { pushes += 1; await advanceOriginMain(f, `race-${pushes}`); return integrationBase(task); };
    await stepEngine(f.engine);
    const parked = f.current();
    assert.equal(parked.phase, 'verifying', parked.reason);
    // The stale-base hold is repository contention: it waits out the grace and only then reaches attention for a human.
    assert.equal(parked.resolution.attention, false, parked.reason);
    assert.match(parked.reason, /Local integration base differs from origin/);
    const renewed = f.store.events(f.taskId).filter(event => event.kind === 'integration_base_renewed');
    assert.equal(renewed.length, 3, 'renewals stop at the bound');
    assert.equal(pushes, 4, 'the gate read the base once more after the last renewal and parked');
    assert.equal(f.store.events(f.taskId).filter(event => event.kind === 'integration_base_renewal_refused').length, 0);
    assert.equal(f.mergeCount(), 0);
  } finally { await f.close(); }
});

weighted(6)('a dirty integration checkout behind origin still parks without renewing', async t => {
  const f = await resolutionFixture(t);
  try {
    await advanceOriginMain(f, 'dirty');
    await writeFile(join(f.repo, 'untracked-operator-file.txt'), 'operator work\n');
    await stepEngine(f.engine);
    const parked = f.current();
    assert.equal(parked.phase, 'verifying', parked.reason);
    assert.equal(parked.resolution.attention, false, 'dirt is contention, waiting for its owner to clean up');
    assert.match(parked.reason, /tracked or untracked changes/);
    assert.equal(f.store.events(f.taskId).filter(event => event.kind === 'integration_base_renewed' || event.kind === 'integration_base_renewal_refused').length, 0, 'cleanliness is never renewed');
    assert.equal(f.mergeCount(), 0);
  } finally { await f.close(); }
});

weighted(6)('a locally ahead integration base is refused by the renewal and never fast-forwarded', async t => {
  const f = await resolutionFixture(t);
  try {
    await git(f.repo, 'commit', '--allow-empty', '-m', 'local main work not pushed');
    const localHead = await git(f.repo, 'rev-parse', 'HEAD');
    await stepEngine(f.engine);
    const parked = f.current();
    assert.equal(parked.phase, 'verifying', parked.reason);
    // Unpushed local commits are repository contention: they wait out the grace instead of parking for attention.
    assert.equal(parked.resolution.attention, false, parked.reason);
    assert.match(parked.reason, /Local integration base differs from origin/);
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), localHead, 'the unpushed commit is not rewritten');
    assert.equal(f.store.events(f.taskId).filter(event => event.kind === 'integration_base_renewal_refused').length, 1);
    assert.equal(f.store.events(f.taskId).filter(event => event.kind === 'integration_base_renewed').length, 0);
    assert.equal(f.mergeCount(), 0);
  } finally { await f.close(); }
});

weighted(20)('the candidate checkout lives under the Queue-owned isolation root and settled candidates are disposed', async t => {
  const isolated = await prospectiveFixture(t, { gate: { extra: "fs.writeFileSync('docs/plan.json','mutated');" } });
  t.after(() => isolated.store.close());
  const common = await git(isolated.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const task = taskAtReviewedHead(isolated.store, isolated.repo, isolated.directory, isolated.head, isolated.base);
  const held = await new RepositoryHooks(isolated.store).prospectiveMergeGate(task, gateRequest(isolated.head));
  assert.equal(held.kind, 'hold', JSON.stringify(held));
  const uncertain = isolated.store.hookEvents(task.id)[0];
  const isolatedRoot = isolationRootFor(isolationDataDirFor(isolated.store), common);
  assert.equal(uncertain.workspace!.path.startsWith(`${isolatedRoot}/`), true, 'the candidate is Queue-owned');
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(isolatedRoot), [uncertain.workspace!.path.slice(isolatedRoot.length + 1)], 'an uncertain candidate keeps exactly its own checkout');

  const settled = await prospectiveFixture(t);
  t.after(() => settled.store.close());
  const settledTask = taskAtReviewedHead(settled.store, settled.repo, settled.directory, settled.head, settled.base);
  const passed = await new RepositoryHooks(settled.store).prospectiveMergeGate(settledTask, gateRequest(settled.head));
  assert.equal(passed.kind, 'ok', JSON.stringify(passed));
  const settledCommon = isolationRootFor(isolationDataDirFor(settled.store), await git(settled.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  assert.deepEqual(await readdir(settledCommon).catch(() => []), [], 'a settled candidate leaves no Queue-owned checkout behind');
  assert.equal(await git(settled.directory, 'rev-parse', 'HEAD'), settled.head, 'the worker workspace is preserved');
  assert.equal(await git(settled.directory, 'status', '--porcelain'), '');
});

function ancestorDirectories(start: string): string[] {
  const dirs: string[] = [];
  for (let dir = dirname(start); ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir) break;
  }
  return dirs;
}

/** Markers Vite and Vitest walk up the tree to find a workspace root. */
const WORKSPACE_ROOT_MARKERS = ['package.json', 'pnpm-workspace.yaml', 'bun.lock', 'package-lock.json', 'yarn.lock'] as const;

weighted(12)('a new warm candidate lives outside the repository and cannot see a working-tree file by walking up', async t => {
  const f = await prospectiveFixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
  const result = await new RepositoryHooks(f.store).prospectiveMergeGate(task, gateRequest(f.head));
  assert.equal(result.kind, 'ok', JSON.stringify(result));
  const common = await git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const warm = warmCandidatePathFor(isolationDataDirFor(f.store), common);
  assert.equal((await stat(warm)).isDirectory(), true);
  assert.equal(warm.startsWith(`${f.repo}/`), false);
  assert.equal(warm.startsWith(`${common}/`), false);
  await mkdir(join(f.repo, 'node_modules'), { recursive: true });
  await writeFile(join(f.repo, 'node_modules', 'sentinel'), 'from-repo');
  await writeFile(join(f.repo, 'walk-sentinel.txt'), 'from-repo');
  const repoGit = await realpath(common);
  for (const dir of ancestorDirectories(warm)) {
    assert.equal(existsSync(join(dir, 'node_modules', 'sentinel')), false, dir);
    assert.equal(existsSync(join(dir, 'walk-sentinel.txt')), false, dir);
    const gitMarker = join(dir, '.git');
    if (existsSync(gitMarker)) assert.notEqual(await realpath(gitMarker).catch(() => ''), repoGit, dir);
  }
});

weighted(6)('Vite and Vitest workspace-root search finds no project above a Queue-owned candidate', async t => {
  const f = await prospectiveFixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
  const result = await new RepositoryHooks(f.store).prospectiveMergeGate(task, gateRequest(f.head));
  assert.equal(result.kind, 'ok', JSON.stringify(result));
  const common = await git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const warm = warmCandidatePathFor(isolationDataDirFor(f.store), common);
  assert.equal((await stat(warm)).isDirectory(), true);
  for (const name of WORKSPACE_ROOT_MARKERS) await writeFile(join(f.repo, name), 'from-repo\n');
  const repoGit = await realpath(common);
  for (const dir of ancestorDirectories(warm)) {
    for (const name of WORKSPACE_ROOT_MARKERS) assert.equal(existsSync(join(dir, name)), false, `${dir}/${name}`);
    assert.equal(existsSync(join(dir, '.git')), false, `${dir}/.git`);
    assert.notEqual(await realpath(dir).catch(() => ''), repoGit, dir);
  }
});

/**
 * Bounded evidence from a recorded project validation, for assertion messages
 * only: a failed assertion names how the run settled (milestone 2b5183b3 lost it).
 * The record is read inside the guard: a failed read, or missing or malformed
 * fields, read as unknown, so evidence never replaces the assertion.
 */
const validationEvidence = (read: () => unknown): string => {
  try {
    const record = read();
    if (!record || typeof record !== 'object') return `projectValidation ${record === null ? 'null' : 'absent'}`;
    const r = record as Record<string, unknown>;
    const telemetry = r.hostRunTelemetry && typeof r.hostRunTelemetry === 'object' ? r.hostRunTelemetry as Record<string, unknown> : {};
    const field = (value: unknown) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).slice(0, 80) : 'unknown';
    const tail = typeof r.outputTail === 'string' ? JSON.stringify(r.outputTail.slice(-500)) : 'unknown';
    return `projectValidation state=${field(r.state)} exitCode=${field(r.exitCode)} durationMs=${field(r.durationMs)} outcome=${field(telemetry.outcome)} wallMs=${field(telemetry.wallMs)} cpuMs=${field(telemetry.cpuMs)} tail=${tail}`;
  } catch { return 'projectValidation evidence unavailable'; }
};

const validationCommand = (script: string) => ({ argv: [process.execPath, '-e', script], timeoutMs: 2000, maxOutputBytes: 4096, terminationGraceMs: 30_000 });

for (const manifest of ['none', 'v5'] as const) {
  weighted(manifest === 'none' ? 8 : 5)(`project validation exits 0 on the prospective candidate and records its result (${manifest})`, async t => {
    const f = await prospectiveFixture(t, { manifest });
    t.after(() => f.store.close());
    const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
    const command = validationCommand("const fs=require('fs');if(!fs.readFileSync('docs/roadmap.md','utf8').includes('fixed on main'))process.exit(3)");
    const outcome = await new RepositoryHooks(f.store).projectValidationGate(task, f.head, command);
    assert.deepEqual(outcome, { kind: 'ok', base: f.base }, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
    const recorded = f.store.task(task.id).resolution.projectValidation!;
    assert.equal(recorded.state, 'passed', validationEvidence(() => recorded));
    assert.equal(recorded.exitCode, 0, validationEvidence(() => recorded));
    assert.deepEqual(recorded.argv, command.argv, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
    assert.equal(recorded.base, f.base, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
    assert.equal(recorded.head, f.head, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
    assert.match(recorded.digest, /^[a-f0-9]{64}$/, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
    f.store.update(task.id, { phase: 'done' });
    assert.deepEqual(f.store.outcome(task.id)?.validation?.project, recorded, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
  });
}

weighted(7)('project validation nonzero exit records a bounded semantic finding', async t => {
  const f = await prospectiveFixture(t, { manifest: 'none' });
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
  const command = { ...validationCommand("process.stdout.write('x'.repeat(3000)+'refusal marker');process.exit(7)"), maxOutputBytes: 8192 };
  const outcome = await new RepositoryHooks(f.store).projectValidationGate(task, f.head, command);
  assert.equal(outcome.kind, 'refused', validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
  assert.match(outcome.kind === 'refused' ? outcome.detail : '', /refusal marker$/, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
  assert.ok((outcome.kind === 'refused' ? outcome.detail : '').length <= 2000, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
  assert.equal(f.store.task(task.id).resolution.projectValidation?.exitCode, 7, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
});

weighted(10)('project validation output past its limit keeps the tail and lets the exit code decide', async t => {
  // Project-K's fresh-checkout CI prints far more than its 64 KB limit; the old runner killed it and held every candidate.
  const noisy = (code: number) => ({ argv: [process.execPath, '-e', `for(let i=0;i<400;i++)process.stdout.write('line '+i+' '+'x'.repeat(200)+'\\n');process.stderr.write('e'.repeat(9000)+'final marker ${code}');process.exit(${code})`], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 4096 });
  for (const code of [0, 5]) {
    const f = await prospectiveFixture(t, { manifest: 'none' });
    t.after(() => f.store.close());
    const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
    const outcome = await new RepositoryHooks(f.store).projectValidationGate(task, f.head, noisy(code));
    const recorded = f.store.task(task.id).resolution.projectValidation!;
    assert.equal(recorded.exitCode, code, validationEvidence(() => recorded));
    assert.equal(recorded.state, code === 0 ? 'passed' : 'refused', validationEvidence(() => recorded));
    assert.equal(outcome.kind, code === 0 ? 'ok' : 'refused', validationEvidence(() => recorded));
    assert.ok(recorded.outputTail.length <= 2000, validationEvidence(() => recorded));
    assert.doesNotMatch(recorded.outputTail, /exceeded its limit/, validationEvidence(() => recorded));
    assert.match(recorded.outputTail, new RegExp(`final marker ${code}$`), validationEvidence(() => recorded));
  }
});

weighted(3)('a running validation whose process is gone holds as lost; one whose process lives still holds', async t => {
  // Contract 010 (#117): a lost run is never retried automatically; it waits for an explicit resubmission.
  for (const [pid, expected] of [[2_147_000_000, 'hold'], [process.pid, 'hold']] as const) {
    const f = await prospectiveFixture(t, { manifest: 'none' });
    t.after(() => f.store.close());
    const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
    const command = validationCommand("process.exit(0)");
    const { createHash } = await import('node:crypto');
    const running = { argv: command.argv, digest: createHash('sha256').update(JSON.stringify(command.argv)).digest('hex'), exitCode: null, durationMs: 0, outputTail: '', base: f.base, head: f.head, state: 'running' as const, queueBuild: '', settingsRevision: 0, pid, admission: null, capacityWait: null, capacityUnavailable: false };
    f.store.update(task.id, { resolution: { ...f.store.task(task.id).resolution, projectValidation: running } });
    const outcome = await new RepositoryHooks(f.store).projectValidationGate(f.store.task(task.id), f.head, command);
    assert.equal(outcome.kind, expected, `pid ${pid}; ${validationEvidence(() => f.store.task(task.id).resolution.projectValidation)}`);
  }
});

weighted(9)('project validation timeout, launch failure and candidate dirt are operational holds', async t => {
  for (const script of ["setTimeout(()=>{},10000)", "require('fs').writeFileSync('dirty.txt','x')"]) {
    const f = await prospectiveFixture(t, { manifest: 'none' });
    t.after(() => f.store.close());
    const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
    const command = { ...validationCommand(script), timeoutMs: 80 };
    const outcome = await new RepositoryHooks(f.store).projectValidationGate(task, f.head, command);
    assert.equal(outcome.kind, 'hold', validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
    assert.equal(f.store.task(task.id).resolution.revisionRuns, 0, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
  }
  const f = await prospectiveFixture(t, { manifest: 'none' });
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
  const outcome = await new RepositoryHooks(f.store).projectValidationGate(task, f.head, { argv: ['/does-not-exist'], timeoutMs: 100, maxOutputBytes: 4096, terminationGraceMs: 30_000 });
  assert.equal(outcome.kind, 'hold', validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
  assert.match(f.store.task(task.id).resolution.projectValidation?.outputTail ?? '', /launch failed/, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
});

weighted(11)('project validation discards a moved base and runs on its fresh candidate', async t => {
  const f = await prospectiveFixture(t, { manifest: 'none' });
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
  const release = join(f.root, 'release-validation');
  const script = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(f.ledger)},'run\\n');if(fs.readFileSync(${JSON.stringify(f.ledger)},'utf8').trim().split('\\n').length===1){const wait=()=>fs.existsSync(${JSON.stringify(release)})?process.exit(0):setTimeout(wait,10);wait();}`;
  const pending = new RepositoryHooks(f.store).projectValidationGate(task, f.head, { ...validationCommand(script), timeoutMs: HOOK_TEST_TIMEOUT_MS });
  try {
    await waitFor(() => existsSync(f.ledger), HOOK_TEST_TIMEOUT_MS, 'the first validation to start', () => validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
    await writeFile(join(f.repo, 'docs', 'another.md'), 'new base\n');
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-m', 'move base during validation');
    await git(f.repo, 'push', 'origin', 'main');
  } finally { await writeFile(release, 'release\n'); }
  const outcome = await pending;
  assert.equal(outcome.kind, 'ok', validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
  assert.notEqual(outcome.kind === 'ok' ? outcome.base : null, f.base, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
  assert.equal((await readFile(f.ledger, 'utf8')).trim().split('\n').length, 2, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
});

weighted(2)('project validation is absent when no command is set', async t => {
  const f = await prospectiveFixture(t, { manifest: 'none' });
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
  assert.equal(f.store.canonicalRepository(f.repo)?.validation, undefined, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
  assert.deepEqual(await new RepositoryHooks(f.store).prospectiveMergeGate(task, gateRequest(f.head)), { kind: 'none' }, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
});

for (const manifest of ['v1', 'v2', 'v3', 'v4'] as const) {
  weighted({ v1: 2, v2: 2, v3: 2, v4: 1 }[manifest])(`project validation is ignored for ${manifest} manifest repositories`, async t => {
    const f = await prospectiveFixture(t, { manifest });
    t.after(() => f.store.close());
    const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
    const outcome = await new RepositoryHooks(f.store).projectValidationGate(task, f.head, validationCommand('process.exit(9)'));
    assert.deepEqual(outcome, { kind: 'none' }, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
    assert.equal(f.store.task(task.id).resolution.projectValidation, null, validationEvidence(() => f.store.task(task.id).resolution.projectValidation));
  });
}

weighted(7)('project validation records a new argv digest after the command changes', async t => {
  const f = await prospectiveFixture(t, { manifest: 'none' });
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
  const hooks = new RepositoryHooks(f.store);
  await hooks.projectValidationGate(task, f.head, validationCommand('process.exit(0)'));
  const firstRecord = f.store.task(task.id).resolution.projectValidation;
  const first = firstRecord?.digest;
  await hooks.projectValidationGate(f.store.task(task.id), f.head, validationCommand("process.stdout.write('changed')"));
  const second = f.store.task(task.id).resolution.projectValidation;
  const evidence = `first: ${validationEvidence(() => firstRecord)}; second: ${validationEvidence(() => second)}`;
  assert.notEqual(second?.digest, first, evidence);
  assert.equal(second?.outputTail, 'changed', evidence);
});

weighted(17)('project validation reuses a settled result only while the Queue build and settings revision are unchanged', async t => {
  const f = await prospectiveFixture(t, { manifest: 'none' });
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, taskAtReviewedHead(f.store, f.repo, f.directory, f.head, f.base).id);
  const ledger = join(f.root, 'validation-runs.txt');
  const command = validationCommand(`require('fs').appendFileSync(${JSON.stringify(ledger)},'run\\n')`);
  const hooks = new RepositoryHooks(f.store, { queueBuild: 'build-a' });
  const evidence = () => validationEvidence(() => f.store.task(task.id).resolution.projectValidation);
  assert.equal((await hooks.projectValidationGate(task, f.head, command)).kind, 'ok', evidence());
  assert.equal((await hooks.projectValidationGate(f.store.task(task.id), f.head, command)).kind, 'ok', evidence());
  assert.equal((await readFile(ledger, 'utf8')).trim().split('\n').length, 1, `an unchanged environment reuses the settled result; ${evidence()}`);
  f.store.putRepository({ origin: null, path: f.repo }, null, 'settings changed', command);
  assert.equal((await hooks.projectValidationGate(f.store.task(task.id), f.head, command)).kind, 'ok', evidence());
  assert.equal((await readFile(ledger, 'utf8')).trim().split('\n').length, 2, `a settings revision reruns validation; ${evidence()}`);
  const rebuilt = new RepositoryHooks(f.store, { queueBuild: 'build-b' });
  assert.equal((await rebuilt.projectValidationGate(f.store.task(task.id), f.head, command)).kind, 'ok', evidence());
  assert.equal((await readFile(ledger, 'utf8')).trim().split('\n').length, 3, `a Queue build change reruns validation; ${evidence()}`);
});

weighted(5)('project validation exit 0 advances the merge gate and records the command on the task', async t => {
  const f = await resolutionFixture(t, { manifest: 'none' });
  try {
    const command = validationCommand("process.stdout.write('validated')");
    f.store.putRepository({ origin: null, path: f.repo }, null, '', command);
    await f.engine.wake();
    // The background validation wakes the task itself, and lifecycle follow-ups
    // carry it on past merging (#346), so the observation is "past the gate".
    const advanced = () => ['merging', 'syncing', 'closing', 'done'].includes(f.current().phase);
    await waitFor(advanced, HOOK_TEST_TIMEOUT_MS, 'the background validation to advance the merge gate', () => validationEvidence(() => f.current().resolution.projectValidation));
    assert.ok(advanced(), `${f.current().phase}: ${f.current().reason}; ${validationEvidence(() => f.current().resolution.projectValidation)}`);
    assert.equal(f.current().resolution.projectValidation?.state, 'passed', validationEvidence(() => f.current().resolution.projectValidation));
    assert.equal(f.current().resolution.projectValidation?.outputTail, 'validated', validationEvidence(() => f.current().resolution.projectValidation));
  } finally { await f.close(); }
});

weighted(8)('project validation exit nonzero returns the retained worker with output tail', async t => {
  const f = await resolutionFixture(t, { manifest: 'none' });
  try {
    f.store.putRepository({ origin: null, path: f.repo }, null, '', validationCommand("process.stdout.write('fix the fixture');process.exit(6)"));
    const release = holdLifecycleFollowUps(f.engine, () => f.current().phase === 'changes_requested');
    await f.engine.wake();
    await waitFor(() => f.current().phase === 'changes_requested', HOOK_TEST_TIMEOUT_MS, 'the background refusal to reach the task', () => validationEvidence(() => f.current().resolution.projectValidation));
    assert.equal(f.current().phase, 'changes_requested', `${f.current().reason}; ${validationEvidence(() => f.current().resolution.projectValidation)}`);
    assert.match(f.current().reason, /fix the fixture/, validationEvidence(() => f.current().resolution.projectValidation));
    assert.equal(f.current().resolution.pendingRevisionCause, 'pre_merge', validationEvidence(() => f.current().resolution.projectValidation));
    release();
    await f.engine.wake();
    assert.equal(f.current().resolution.revisionRuns, 0, 'the refusal continues the open round without consuming a review round');
  } finally { await f.close(); }
});

weighted(8)('project validation discards a moved reviewed head without spending a revision', async t => {
  const f = await resolutionFixture(t, { manifest: 'none' });
  let pending: Promise<BackgroundOutcome> | undefined, failed = false;
  try {
    let remoteHead = f.head;
    f.adapter.verifyPr = async () => ({ head: remoteHead, url: 'https://github.com/example/repo/pull/11' });
    f.store.putRepository({ origin: null, path: f.repo }, null, '', validationCommand('setTimeout(()=>{},250)'));
    pending = observeOutcome(f.engine.wake());
    await waitFor(() => f.store.events(f.taskId).some(event => event.kind === 'project_validation_intent'), HOOK_TEST_TIMEOUT_MS, 'the background validation to record its intent', () => validationEvidence(() => f.current().resolution.projectValidation));
    remoteHead = 'a'.repeat(40);
    await assertCompleted(pending, 'the background wake');
    await waitFor(() => f.current().resolution.attention === true, HOOK_TEST_TIMEOUT_MS, 'the changed reviewed head to be observed', () => validationEvidence(() => f.current().resolution.projectValidation));
    assert.equal(f.current().resolution.attention, true, `${f.current().reason}; ${validationEvidence(() => f.current().resolution.projectValidation)}`);
    // The next quantum proves the reviewed head again, so a settled validation
    // never becomes a merge of a head the PR no longer carries.
    assert.match(f.current().reason, /reviewed head/, validationEvidence(() => f.current().resolution.projectValidation));
    assert.equal(f.current().resolution.revisionRuns, 0, validationEvidence(() => f.current().resolution.projectValidation));
    assert.equal(f.mergeCount(), 0, validationEvidence(() => f.current().resolution.projectValidation));
  } catch (error) { failed = true; throw error; } finally {
    await f.close();
    const note = failed ? await cleanupDiagnostic(pending, 'the background wake') : null;
    if (note) process.stderr.write(`[prospective-merge-hooks] secondary: ${note}\n`);
  }
});
