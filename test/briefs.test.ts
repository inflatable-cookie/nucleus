import { observeIdle, createTaskAgent } from './support/fakes';
import { configuredClone, materializeSeed } from './support/git-seed';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CURRENT_SCHEMA, Store, digest } from '../core/store/store';
import { Engine, queuedDispatchOrder } from '../core/engine';
import { Decisions } from '../core/planning/decisions';
import { createTaskDetailCache } from '../core/telemetry/task-detail';
import { workerPrompt } from '../core/dispatch/prompts';
import { STEPS_RETIRED_REASON } from '../core/recovery/retired-steps';
import { runPrompt, checkpointPrompt } from '../core/dispatch/prompts';
import { briefDigest } from '../core/planning/brief';
import { parseNorthstarDocument, prepareHandoff, submissionQueueFields } from '../core/planning/handoff';
import { command, git, validateSubmission, validateDispatch, verifyPublishedPlanning, verifyWorkspace, verifyResume, verifyCheckpoint } from '../core/git/index';
import { submissionSchema, summarizeTask, taskControlInputSchema, type Profile, type Run, type Submission, type Task } from '../shared/contracts';
import type { Adapter } from '../core/host';
import { renderHandoffPrompts } from './fixtures/render-handoff-prompts';

/** Spec 020 acceptance oracle: one named test per row. */
const sections = ['What This Thread Was Doing', 'Why It Matters', 'Current State', 'Boundaries', 'Important Context', 'Suggested Next Move', 'Completion Protocol'];
const briefText = `---
title: Queue-held brief
kind: northstar-handoff
handoff_mode: worker-pr-loop
worker_mode: implementation
dispatch_authority: orchestrator
status: ready-to-launch
base_required: pushed-main
queue_dispatch: northstar-queue
queue_approval: Operator approved this disposable brief
queue:
  scope: mechanical
---
${sections.map(s => `## ${s}\n\nBrief instructions for the worker.\n`).join('\n')}`;
const manifests = {
  v1: { schema: 'paseo.queue.control.v1', hooks: [] },
  v4: { schema: 'paseo.queue.control.v4', hooks: [] },
  v5: { schema: 'paseo.queue.control.v5', closeout: 'queue', hooks: [] },
} as const;

async function repoFixture(t: any, manifest: keyof typeof manifests | null = 'v5') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-brief-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await materializeSeed(configuredClone, root);
  const repo = join(root, 'repo');
  const files: Record<string, string> = { 'README.md': 'fixture\n' };
  if (manifest) files['.paseo/queue.json'] = JSON.stringify(manifests[manifest]);
  const planning = await commit(repo, 'planning', files);
  await git(repo, 'push', 'origin', 'main');
  const briefPath = join(root, 'brief.md');
  await writeFile(briefPath, briefText);
  return { root, repo, planning, briefPath };
}
async function commit(repo: string, message: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}
const briefSubmission = (repo: string, planningCommit: string, extra: Partial<Submission> = {}) => submissionSchema.parse({
  submissionId: `brief-${randomUUID()}`, title: 'Queue-held brief', repoPath: repo, planningCommit,
  brief: { text: briefText }, originAgentId: 'origin', ...extra,
});
const profile: Profile = { id: 'worker', name: 'worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
function engineFixture(shared?: string) {
  const owned = !shared;
  const path = shared ?? join(mkdtempSync(join(tmpdir(), 'nsq-brief-store-')), 'queue.sqlite');
  const store = new Store(path);
  // #912: ingress needs one registered host; this single-host fixture registers it.
  store.setMeta('hostId', 'host');
  const adapter = { profiles: async () => [profile], findAgents: async () => [], observe: observeIdle('ws') } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0); engine.profiles = [profile];
  return { store, engine, path, close: async () => { await engine.stop(); store.close(); if (owned) rmSync(join(path, '..'), { recursive: true, force: true }); } };
}
async function submit(engine: Engine, submission: Submission) {
  const acceptance = await engine.startSubmission(submission, true);
  assert.ok(!('backpressured' in acceptance));
  return engine.awaitOperation(acceptance.operation.id);
}
const runOf = (task: Task, role: Run['role'], extra: Partial<Run> = {}) => ({
  id: `run-${role}`, taskId: task.id, role, generation: 1, head: 'c'.repeat(40), base: task.planningBase, agentId: null,
  workspaceId: 'ws', instruction: null, profile, status: 'running', createdAt: new Date().toISOString(),
  lastObservedAt: null, active: null, idleSince: null, completion: null, released: false, ...extra,
}) as Run;

test('1. brief submission to a v5 repository is pinned by digest and touches nothing in the repository', async t => {
  const f = await repoFixture(t, 'v5');
  const statusBefore = await git(f.repo, 'status', '--porcelain', '--untracked-files=all');
  const prepared = await prepareHandoff({ briefPath: f.briefPath, repoPath: f.repo, originAgentId: 'origin', baseBranch: 'main', dryRun: true });
  assert.equal(prepared.digest, briefDigest(briefText), 'dry run returns the digest');
  assert.equal(prepared.submission.planningCommit, f.planning, 'the planning commit is the clean pushed integration head');
  assert.equal(prepared.submission.handoffPath, '');
  const e = engineFixture();
  try {
    const operation = await submit(e.engine, prepared.submission);
    assert.equal(operation.state, 'succeeded', operation.diagnostic);
    const task = e.store.task(operation.result!.taskId!);
    assert.equal(task.briefVersions.length, 1);
    assert.equal(task.briefVersions[0].digest, briefDigest(briefText));
    assert.equal(task.briefVersions[0].text, briefText);
    assert.equal(task.handoffText, briefText);
    assert.equal(task.instruction, null, 'no committed instruction artifact exists for a brief');
    assert.equal(task.brief?.digest, briefDigest(briefText));
    assert.equal(await git(f.repo, 'status', '--porcelain', '--untracked-files=all'), statusBefore, 'nothing is written to the repository');
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.planning);
    assert.equal(await git(f.repo, 'ls-tree', '-r', '--name-only', 'HEAD', 'docs'), '', 'no handoff is committed');
    // A replay with the same brief resolves the same task.
    const again = await submit(e.engine, prepared.submission);
    assert.equal(again.result!.taskId, task.id);
  } finally { await e.close(); }
  // No manifest is also eligible.
  const bare = await repoFixture(t, null);
  assert.equal((await validateSubmission(briefSubmission(bare.repo, bare.planning))).handoffText, briefText);
});

test('Spec 043 retired: a declared-stage brief stays parseable history and submission refuses it before any task exists',async t=>{
  const f=await repoFixture(t,'v5');
  const stagedText=briefText.replace('  scope: mechanical',`  scope: mechanical
  stages:
    - id: final-review
      kind: review
      subject:
        head: candidate
        digests:
          - path: inputs/source.json
      role: reviewer
      independence: []
      gate:
        pass: [source-check]
        insufficient: [optional-note]
      actions: [comment]
      wait: []`);
  await writeFile(f.briefPath,stagedText);
  const prepared=await prepareHandoff({briefPath:f.briefPath,repoPath:f.repo,originAgentId:'origin',baseBranch:'main',dryRun:true});
  assert.equal(prepared.digest,briefDigest(stagedText));
  assert.equal(prepared.submission.brief?.text,stagedText);
  assert.equal(Object.hasOwn(prepared.submission,'stages'),false);
  const e=engineFixture();
  try{
    // Retired (Spec 043, 2026-10-06): the declaration still reads as history but admits no execution.
    assert.deepEqual(parseNorthstarDocument(stagedText,'brief').queue.stages?.map(stage=>stage.id),['final-review']);
    const operation=await submit(e.engine,prepared.submission);
    assert.equal(operation.state,'failed');
    assert.match(operation.diagnostic??'',/Declared steps are retired/);
    assert.equal(e.store.existing(prepared.submission),null,'a refused staged submission writes no task');
  const invalidText=stagedText.replace('kind: review','kind: work');
  await writeFile(f.briefPath,invalidText);
  await assert.rejects(prepareHandoff({briefPath:f.briefPath,repoPath:f.repo,originAgentId:'origin',baseBranch:'main',dryRun:true}),
    error=>{
      assert.equal((error as Error).message,'Invalid brief frontmatter: queue.stages.0.kind: The last stage must be review or verify');
      return true;
    });
}finally{await e.close();}
});

test('a brief queue.dependsOn waits for closeout before dispatch', async t => {
  const f = await repoFixture(t, 'v5');
  const e = engineFixture();
  try {
    const prerequisite = e.store.insert(briefSubmission(f.repo, f.planning), 'host', briefText, f.planning, { held: true });
    const dependentText = briefText.replace('  scope: mechanical', `  scope: mechanical\n  dependsOn:\n    - ${prerequisite.id}`);
    await writeFile(f.briefPath, dependentText);
    const prepared = await prepareHandoff({ briefPath: f.briefPath, repoPath: f.repo, originAgentId: 'origin', baseBranch: 'main', dryRun: true });
    assert.deepEqual(prepared.submission.dependsOn, [prerequisite.id]);
    let workspaces = 0;
    Object.assign(e.engine.adapter, {
      validate: async (task: Task) => task.planningCommit,
      // Spec 053: scope no longer keeps the prerequisite from dispatching, so count only the dependent.
      createWorkspace: async (task: Task) => { if (task.id !== prerequisite.id) workspaces++; return { id: `ws-${task.id}`, directory: f.repo }; },
      verifyWorkspace: async (task: Task) => task.branch,
      createAgent: createTaskAgent,
      // #1001: the release dispatches before the drain, so the drain observes the new worker where it runs.
      observe: async (id: string) => ({ id, workspaceId: `ws-${id.replace(/^agent-/, '')}`, status: 'running', active: true, permissions: false, error: '' }),
    });
    e.store.setMeta('globalLimit', 2);
    e.store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', weight: 1, scopes: ['mechanical'] }]);
    const operation = await submit(e.engine, prepared.submission);
    assert.equal(operation.state, 'succeeded', operation.diagnostic);
    const dependent = e.store.task(operation.result!.taskId!);
    assert.deepEqual(dependent.dependsOn, [prerequisite.id]);
    e.store.setMeta('paused', false);
    await e.engine.wake();
    assert.equal(e.store.task(dependent.id).phase, 'queued');
    // #1001: a queued wait is derived on read; waiting writes no reason to the task.
    assert.match(createTaskDetailCache(e.store)(dependent.id).task.reason, /Waiting for prerequisites/);
    assert.equal(workspaces, 0);
    e.store.update(prerequisite.id, { phase: 'done', reason: 'Closed out' });
    await e.engine.wake();
    assert.equal(e.store.task(dependent.id).phase, 'working');
    assert.equal(workspaces, 1);
  } finally { await e.close(); }
});

/** Spec 022 row 8: a shared checkout that is behind origin plans from the fetched origin head. */
test('8. brief capture while the shared checkout is behind origin reads the pushed head', async t => {
  const f = await repoFixture(t, 'v4');
  // The peer advances origin past the shared checkout and removes the v1–v4
  // manifest there, so only the fetched origin head is brief-eligible.
  const peer = join(f.root, 'peer');
  await command('git', ['clone', join(f.root, 'origin.git'), peer], f.root);
  await git(peer, 'config', 'user.name', 'Queue test');
  await git(peer, 'config', 'user.email', 'queue@example.invalid');
  await command('git', ['rm', '.paseo/queue.json'], peer);
  const pushed = await commit(peer, 'drop the manifest on origin', { 'CHANGELOG.md': 'landed ahead\n' });
  await git(peer, 'push', 'origin', 'main');
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.planning, 'the shared checkout stays one commit behind');

  const prepared = await prepareHandoff({ briefPath: f.briefPath, repoPath: f.repo, originAgentId: 'origin', baseBranch: 'main', dryRun: true });
  assert.equal(prepared.submission.planningCommit, pushed, 'the planning commit is the fetched origin head, not the checkout HEAD');
  // The recorded planning base is the pushed head too, so submission validation
  // passes although the local branch has not moved.
  const validated = await validateSubmission(prepared.submission);
  assert.equal(validated.planningBase, pushed);

  // The same eligibility reads the pushed head at submission: the v4 manifest
  // that still sits on the shared checkout must not refuse the brief.
  const e = engineFixture();
  try {
    const operation = await submit(e.engine, prepared.submission);
    assert.equal(operation.state, 'succeeded', operation.diagnostic);
    const task = e.store.task(operation.result!.taskId!);
    assert.equal(task.planningBase, pushed);
  } finally { await e.close(); }
});

test('2. brief submission to a v1–v4 repository is refused at dry run and at submission', async t => {
  for (const version of ['v1', 'v4'] as const) {
    const f = await repoFixture(t, version);
    await assert.rejects(prepareHandoff({ briefPath: f.briefPath, repoPath: f.repo, originAgentId: 'origin', baseBranch: 'main', dryRun: true }), /Brief mode requires a paseo\.queue\.control\.v5 control manifest/);
    const e = engineFixture();
    try {
      const operation = await submit(e.engine, briefSubmission(f.repo, f.planning));
      assert.equal(operation.state, 'failed');
      assert.match(operation.diagnostic, /Brief mode requires/);
      assert.equal(e.store.tasks().length, 0);
    } finally { await e.close(); }
  }
});

test('3. a submission with both brief and handoffPath, or neither, is refused', async t => {
  const f = await repoFixture(t, 'v5');
  const both = briefSubmission(f.repo, f.planning, { handoffPath: 'docs/handoffs/x.md' });
  await assert.rejects(validateSubmission(both), /exactly one of handoffPath or brief/);
  const neither = { ...briefSubmission(f.repo, f.planning), brief: null };
  await assert.rejects(validateSubmission(neither), /exactly one of handoffPath or brief/);
  const e = engineFixture();
  try {
    assert.equal((await submit(e.engine, both)).state, 'failed');
    assert.equal((await submit(e.engine, neither)).state, 'failed');
    assert.equal(e.store.tasks().length, 0);
  } finally { await e.close(); }
  await assert.rejects(prepareHandoff({ briefPath: f.briefPath, handoffPath: join(f.repo, 'docs/handoffs/x.md'), repoPath: f.repo, originAgentId: 'origin', baseBranch: 'main', dryRun: true }), /exactly one/);
  // A mismatched caller digest is refused too.
  await assert.rejects(validateSubmission(briefSubmission(f.repo, f.planning, { brief: { text: briefText, mediaType: 'text/markdown', digest: `sha256:${'0'.repeat(64)}` } })), /digest does not match/);
});

test('4. dispatch after main advanced uses the new base with planning ancestry intact', async t => {
  const f = await repoFixture(t, 'v5');
  const peer = join(f.root, 'peer');
  await command('git', ['clone', join(f.root, 'origin.git'), peer], f.root);
  await git(peer, 'config', 'user.name', 'Queue test');
  await git(peer, 'config', 'user.email', 'queue@example.invalid');
  const landed = await commit(peer, 'landed elsewhere', { 'src/other.ts': 'export {};\n' });
  await git(peer, 'push', 'origin', 'main');
  const store = new Store(':memory:');
  try {
    const task = store.insert(briefSubmission(f.repo, f.planning), 'host', briefText, f.planning);
    assert.equal(await validateDispatch(task), landed, 'dispatch fast-forwards and uses the advanced base');
    await git(f.repo, 'merge-base', '--is-ancestor', f.planning, landed);
  } finally { store.close(); }
});

test('5. a planning commit not on the pushed base is refused', async t => {
  const f = await repoFixture(t, 'v5');
  const unpushed = await commit(f.repo, 'local only', { 'notes.md': 'draft\n' });
  await assert.rejects(verifyPublishedPlanning(briefSubmission(f.repo, unpushed)), /Push the integration commit/);
  await git(f.repo, 'reset', '-q', '--hard', f.planning);
  await git(f.repo, 'checkout', '-q', '-b', 'side');
  const side = await commit(f.repo, 'side branch', { 'side.md': 'side\n' });
  await git(f.repo, 'checkout', '-q', 'main');
  await assert.rejects(validateSubmission(briefSubmission(f.repo, side)), /not on the integration branch/);
  await assert.rejects(verifyPublishedPlanning(briefSubmission(f.repo, side)));
});

test('5b. an unreadable published-planning ancestry is named, not reported as an unpushed base', async t => {
  const f = await repoFixture(t, 'v5');
  // The base and its remote branch both read; only the planning commit is absent
  // from the object store, so the ancestry read is unknown rather than a no.
  await assert.rejects(verifyPublishedPlanning(briefSubmission(f.repo, 'f'.repeat(40))), /Git ancestry is unreadable/);
});

test('6. worker, revision and reviewer prompts carry the brief; handoff-mode prompts match the reviewed snapshot', () => {
  const store = new Store(':memory:');
  try {
    const inserted = store.insert(briefSubmission('/repo', 'a'.repeat(40)), 'host', briefText, 'a'.repeat(40));
    // Both `completion` and `resolution.review` are strict accepted Completions, so
    // the fixture carries the completion identity instead of the bare objects it used
    // before (resolution.review became a Completion in commit a5f2a2be, 2026-10-02).
    const task = store.update(inserted.id, { runId: 'initial', workspaceId: 'ws', directory: '/worktree', prUrl: 'https://github.com/example/repo/pull/7',
      completion: { eventId: 'initial-ready', taskId: inserted.id, runId: 'initial', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
      resolution: { ...inserted.resolution, review: { eventId: 'review-findings', taskId: inserted.id, runId: 'review-run', status: 'changes_required', summary: 'Fix links', head: 'a'.repeat(40), reviewCommentId: 1, reviewResponsibility: 'author' }, revisionInstruction: { id: 'scoped-1', text: 'Scoped ruling', createdAt: '2026-09-13T00:00:00.000Z', runId: 'run-revision' } } });
    const prompts = [workerPrompt(task, true), workerPrompt(task, false), runPrompt(task, runOf(task, 'revision', { instruction: 'Scoped ruling' }), '/helper', '/ticket', true), runPrompt(task, runOf(task, 'reviewer'), '/helper', '/ticket', true),
      checkpointPrompt(task, { ordinal: 1, createdAt: 'now', summary: 'Parser landed', head: 'e'.repeat(40) } as any)];
    for (const prompt of prompts) {
      assert.ok(prompt.includes(briefText), 'the brief text travels inline');
      assert.match(prompt, /Nucleus holds this brief\. It is not a repository file: do not commit it/);
      assert.ok(prompt.includes(briefDigest(briefText)));
      assert.doesNotMatch(prompt, /Committed handoff:|Read the committed handoff/);
    }
    assert.match(prompts[2], /Nucleus-held brief above, the public review findings/);
    assert.match(prompts[2], /Review findings: Fix links/, 'review findings are unchanged');
  } finally { store.close(); }
  const frozen = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/handoff-prompts.json'), 'utf8')) as Record<string, string>;
  // This is the reviewed canonical handoff-mode baseline, not a historical pre-brief snapshot.
  assert.deepEqual(renderHandoffPrompts(), frozen, 'handoff-mode prompts match the reviewed canonical snapshot');
});

test('7. continuation after a stopped worker passes on ancestry and keeps dirty work', async t => {
  const f = await repoFixture(t, 'v5');
  const store = new Store(':memory:');
  try {
    const inserted = store.insert(briefSubmission(f.repo, f.planning), 'host', briefText, f.planning);
    const worktree = join(f.root, 'worktree');
    await git(f.repo, 'worktree', 'add', '-q', '-b', inserted.branch, worktree, f.planning);
    const task = store.update(inserted.id, { directory: worktree });
    assert.equal(await verifyWorkspace(task, worktree), task.branch, 'a fresh worktree passes on ancestry');
    await commit(worktree, 'worker progress', { 'src/work.ts': 'export const done = 1;\n' });
    await writeFile(join(worktree, 'src/work.ts'), 'export const done = 2;\n');
    const retainedHead = await git(worktree, 'rev-parse', 'HEAD');
    const dispatchBase = await commit(f.repo, 'main advanced after dispatch', { 'README.md': 'main advanced\n' });
    assert.notEqual(retainedHead, dispatchBase, 'the retained branch remains on its own descendant');
    assert.equal(await verifyResume({ ...task, planningBase: dispatchBase }), retainedHead, 'resume accepts a planning descendant without resetting to the newer dispatch base');
    assert.equal(await readFile(join(worktree, 'src/work.ts'), 'utf8'), 'export const done = 2;\n', 'dirty work is kept');
    assert.match(await git(worktree, 'status', '--porcelain'), /src\/work\.ts/);
    await assert.rejects(verifyResume({ ...task, planningCommit: 'f'.repeat(40) }), /planning identity changed/);
    await assert.rejects(verifyResume({ ...task, handoffText: 'tampered' }), /does not match its pinned version/);
  } finally { store.close(); }
});

test('review-entry brief workers preserve intake ancestry when planning is newer than the PR head', async t => {
  const f = await repoFixture(t, 'v5');
  const store = new Store(':memory:');
  try {
    const intakeBase = f.planning;
    const externalBranch = `external-${randomUUID()}`;
    await git(f.repo, 'switch', '-c', externalBranch, intakeBase);
    const foreignHead = await commit(f.repo, 'external PR work', { 'src/external.ts': 'export const external = true;\n' });
    await git(f.repo, 'switch', 'main');
    const planning = await commit(f.repo, 'later planning commit', { 'docs/planning.md': 'approved\n' });
    const inserted = store.insert(briefSubmission(f.repo, planning), 'host', briefText, planning);
    const worktree = join(f.root, 'review-worker');
    await git(f.repo, 'worktree', 'add', '-q', '-b', inserted.branch, worktree, foreignHead);
    const reviewEntry = {
      operationId: 'a'.repeat(64), prNumber: 41, repository: 'example/repo', branch: externalBranch,
      workspaceId: 'external-workspace', verifiedHead: foreignHead, verifiedBase: planning, dispatchBase: planning,
      planningCommit: planning, authority: 'review existing PR',
      authorDeclaration: { models: ['test/model'], githubAuthor: 'author', authoringSystem: 'test', attestedBy: 'operator', provenance: 'fixture' },
      checkedAt: new Date().toISOString(), preserveWorkspace: true, directory: worktree,
      workspaceMode: 'shared_canonical', briefDigest: briefDigest(briefText), briefVersion: 1,
    };
    const task = { ...inserted, directory: worktree, branch: inserted.branch, reviewEntry } as Task;
    assert.notEqual(foreignHead, planning, 'the external PR head predates the planning commit');
    assert.equal(await verifyWorkspace(task, worktree), task.branch, 'revision workspace accepts its recorded intake lineage');
    assert.equal(await verifyResume(task), foreignHead, 'revision continuation accepts the same intake lineage');
    const changedIntake = { ...task, reviewEntry: { ...reviewEntry, verifiedHead: 'f'.repeat(40) } } as Task;
    await assert.rejects(verifyResume(changedIntake), /review-entry worker head/);
    await assert.rejects(verifyCheckpoint(changedIntake, foreignHead), /review-entry worker head/);

    const ordinary = { ...task, reviewEntry: null } as Task;
    await assert.rejects(verifyWorkspace(ordinary, worktree));
    await assert.rejects(verifyResume(ordinary), /planning identity changed/);
  } finally { store.close(); }
});

test('8. amend_brief pins a new version for the next run before merge and is refused after merge', async t => {
  const e = engineFixture();
  try {
    const inserted = e.store.insert(briefSubmission('/repo', 'a'.repeat(40)), 'host', briefText, 'a'.repeat(40));
    const refusedSubmission = submissionSchema.parse({ ...briefSubmission('/repo', 'a'.repeat(40)), submissionId: 'explicit-false', responsible: false });
    assert.throws(() => e.engine.startSubmission(refusedSubmission), /responsible: false is no longer supported/);
    const falseAmendment = briefText.replace('  scope: mechanical', '  scope: mechanical\n  responsible: false');
    await assert.rejects(e.engine.performTaskControl({ taskId: inserted.id, version: inserted.version, action: 'amend_brief', brief: falseAmendment, reason: 'Try old lifecycle' }), /responsible: false is no longer supported/);
    assert.equal(e.store.task(inserted.id).briefVersions.length, 1, 'a refused lifecycle amendment writes nothing');
    e.store.putRun(runOf(inserted, 'reviewer', { id: 'before' }));
    assert.equal(e.store.run('before')!.briefVersion, 1, 'a run records the version it was given');
    assert.throws(() => taskControlInputSchema.parse({ taskId: inserted.id, version: inserted.version, action: 'amend_brief', brief: 'x' }), /reason/);
    const invalidStages=briefText.replace('  scope: mechanical',`  scope: mechanical
  stages:
    - id: unfinished
      kind: work
      subject: {head: candidate, digests: []}
      role: worker
      independence: []
      gate: {pass: [], insufficient: []}
      actions: [push]
      wait: []`);
    // Frontmatter parses first, so an invalid declaration still fails on its schema error (engine.ts:2098).
    // A valid declaration is then refused as retired (engine.ts:2100).
    await assert.rejects(e.engine.performTaskControl({taskId:inserted.id,version:inserted.version,action:'amend_brief',brief:invalidStages,reason:'Add stages'}),
      /Invalid brief frontmatter: queue.stages.0.kind: The last stage must be review or verify/);
    assert.equal(e.store.task(inserted.id).briefVersions.length,1,'a refused stage amendment writes nothing');
    const stagedAmendment=briefText.replace('  scope: mechanical',`  scope: mechanical
  stages:
    - id: final-review
      kind: review
      subject: {head: candidate, digests: []}
      role: reviewer
      independence: []
      gate: {pass: [source-check], insufficient: []}
      actions: [comment]
      wait: []`)+`\nAmended scope ruling.\n`;
    await assert.rejects(e.engine.performTaskControl({taskId:inserted.id,version:inserted.version,action:'amend_brief',brief:stagedAmendment,reason:'Operator narrowed the scope'}),
      /Declared steps are retired/);
    assert.equal(e.store.task(inserted.id).briefVersions.length,1,'a refused staged amendment writes nothing');
    // The ordinary path: an owner amends to a plain completion brief, which pins the next version.
    const amendedText=briefText+`\nAmended scope ruling.\n`;
    const overtaken = new Decisions(e.store).add({ question: 'Should this task keep its old scope?', askedBy: 'planner', tasks: [inserted.id] });
    const amended = await e.engine.performTaskControl({ taskId: inserted.id, version: inserted.version, action: 'amend_brief', brief: amendedText, reason: 'Operator narrowed the scope', overtakes: [overtaken.id] });
    assert.deepEqual(amended.briefVersions.map(version => version.version), [1, 2], 'earlier versions are kept');
    assert.equal(amended.briefVersions[1].digest, briefDigest(amendedText));
    assert.equal(amended.handoffText, amendedText);
    assert.equal(Object.hasOwn(amended,'stages'),false);
    assert.ok(e.store.eventsAll(inserted.id).some(event => event.kind === 'brief_amended' && event.detail.includes('Operator narrowed the scope')));
    assert.equal(new Decisions(e.store).get({ id: overtaken.id }).overtakenBy?.[0]?.kind, 'brief_amendment');
    assert.equal(new Decisions(e.store).get({ id: overtaken.id }).overtakenBy?.[0]?.id, inserted.id);
    e.store.putRun(runOf(amended, 'revision', { id: 'after' }));
    assert.equal(e.store.run('after')!.briefVersion, 2, 'the next run is given the new version');
    assert.equal(e.store.run('before')!.briefVersion, 1);
    const prompt = workerPrompt({ ...amended, runId: 'next' }, true);
    assert.ok(prompt.includes(amendedText));
    assert.match(prompt, /This brief was amended to version 2\. Amendment reason: Operator narrowed the scope/);
    await assert.rejects(e.engine.performTaskControl({ taskId: amended.id, version: amended.version, action: 'amend_brief', brief: amendedText, reason: 'again' }), /identical/);
    await assert.rejects(e.engine.performTaskControl({ taskId: amended.id, version: amended.version, action: 'amend_brief', reason: 'Re-pin the instruction' }), /use amend_brief/);
    const merged = e.store.update(amended.id, { resolution: { ...amended.resolution, mergedCommit: 'b'.repeat(40) } });
    await assert.rejects(e.engine.performTaskControl({ taskId: merged.id, version: merged.version, action: 'amend_brief', brief: 'late', reason: 'too late' }), /refused once the task has merged/);
    assert.equal(e.store.task(merged.id).briefVersions.length, 2);
    const handoffTask = e.store.insert(submissionSchema.parse({ submissionId: 'handoff', title: 'H', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'docs/handoffs/h.md', originAgentId: 'origin' }), 'host', 'plan', 'a'.repeat(40));
    await assert.rejects(e.engine.performTaskControl({ taskId: handoffTask.id, version: handoffTask.version, action: 'amend_brief', brief: 'x', reason: 'y' }), /requires a Nucleus-held brief/);
  } finally { await e.close(); }
});

test('8b. amend_brief takes approval from leadProvenance and still requires queue_approval on a direct brief', async () => {
  const e = engineFixture();
  try {
    const leadText = briefText.replace(/^queue_approval:.*\n/m, '');
    assert.doesNotMatch(leadText, /queue_approval/);
    const approval = { version: 1, digest: briefDigest(leadText), approver: 'operator', approvedAt: new Date().toISOString(), note: 'Checked', relayed: false };
    const lead = e.store.insert(briefSubmission('/repo', 'a'.repeat(40), { brief: { text: leadText, mediaType: 'text/markdown' }, planningSource: { kind: 'lead', id: 'lead-1' }, leadProvenance: { version: 1, approval, earlierDigests: [] } }), 'host', leadText, 'a'.repeat(40));
    assert.ok(lead.leadProvenance);
    const amendedText = `${leadText}\nAmended scope ruling.\n`;
    const amended = await e.engine.performTaskControl({ taskId: lead.id, version: lead.version, action: 'amend_brief', brief: amendedText, reason: 'Operator ruling' });
    assert.deepEqual(amended.briefVersions.map(version => version.version), [1, 2]);
    assert.equal(amended.handoffText, amendedText);
    const direct = e.store.insert(briefSubmission('/repo', 'a'.repeat(40)), 'host', briefText, 'a'.repeat(40));
    await assert.rejects(e.engine.performTaskControl({ taskId: direct.id, version: direct.version, action: 'amend_brief', brief: leadText + '\nx\n', reason: 'No approval line' }), /queue_approval/);
  } finally { await e.close(); }
});

test('8d. amend_brief queues the new brief to a live worker and answers an open ask', async () => {
  const e = engineFixture();
  try {
    const queued: Array<{ agentId: string; messageId: string; text: string }> = [];
    e.engine.adapter.enqueueMessage = async (agentId, messageId, text) => {
      queued.push({ agentId, messageId, text });
    };
    const inserted = e.store.insert(briefSubmission('/repo', 'a'.repeat(40)), 'host', briefText, 'a'.repeat(40));
    const live = e.store.update(inserted.id, { phase: 'working', agentId: 'worker', runId: 'initial', workspaceId: 'ws' });
    const askId = 'ask-open-1';
    e.store.event(live.id, 'agent_ask', `${askId}: kind process; run initial (revision); agent worker; question abc (3 chars); choices none`);
    const amendedText = `${briefText}\nAmended scope ruling.\n`;
    const amended = await e.engine.performTaskControl({
      taskId: live.id, version: live.version, action: 'amend_brief', brief: amendedText, reason: 'Operator narrowed the scope',
    });
    assert.equal(amended.briefVersions.at(-1)?.version, 2);
    const events = e.store.eventsAll(live.id);
    assert.ok(events.some(event => event.kind === 'agent_ask_answered' && event.detail.startsWith(`${askId}: answered by brief amendment:`)));
    assert.ok(events.some(event => event.kind === 'brief_amendment_delivery_intent' && event.detail.includes('role worker')));
    for (let i = 0; i < 20 && queued.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.agentId, 'worker');
    assert.equal(queued[0]!.messageId, `ns-brief-amendment-${live.id}-v2-worker`);
    assert.match(queued[0]!.text, /amended this task's Nucleus-held brief to version 2/);
    assert.ok(queued[0]!.text.includes(amendedText));
    assert.ok(e.store.eventsAll(live.id).some(event => event.kind === 'brief_amendment_delivered'));
  } finally { await e.close(); }
});

test('8e. amend_brief withdraws the board decision linked to an operator-only ask', async () => {
  const e = engineFixture();
  try {
    const inserted = e.store.insert(briefSubmission('/repo', 'a'.repeat(40)), 'host', briefText, 'a'.repeat(40));
    const live = e.store.update(inserted.id, { phase: 'working', agentId: 'worker', runId: 'initial', workspaceId: 'ws' });
    const askId = 'ask-operator-1';
    e.store.event(live.id, 'agent_ask', `${askId}: kind scope; run initial (revision); agent worker; question Should the task change scope? (28 chars); choices none`);
    const open = new Decisions(e.store).add({ question: 'Should the task change scope?', askedBy: 'worker', tasks: [live.id] });
    e.store.event(live.id, 'agent_ask_decision', `${askId}: decision ${open.id}; classified operator`);
    const amendedText = `${briefText}\nAmended scope ruling.\n`;
    await e.engine.performTaskControl({
      taskId: live.id, version: live.version, action: 'amend_brief', brief: amendedText, reason: 'Operator narrowed the scope',
      caller: 'operator (board)',
    });
    const events = e.store.eventsAll(live.id);
    assert.ok(events.some(event => event.kind === 'agent_ask_answered' && event.detail.startsWith(`${askId}: answered by brief amendment:`)));
    assert.equal(events.some(event => event.kind === 'agent_ask_superseded' && event.detail.startsWith(`${askId}:`)), false);
    const decision = new Decisions(e.store).get({ id: open.id });
    assert.equal(decision.status, 'withdrawn');
    assert.match(decision.withdrawal?.reason ?? '', /brief amendment to version 2/);
    assert.throws(
      () => new Decisions(e.store).answer({ id: open.id, version: decision.version, answer: 'Keep the old scope', answeredBy: 'operator (board)', relayed: false, note: '' }),
      /Decision is withdrawn/,
    );
  } finally { await e.close(); }
});

test('8c. the declared stage preflight refuses any declared plan as retired, and amend_brief writes no version', async () => {
  const e = engineFixture();
  try {
    const inserted = e.store.insert(briefSubmission('/repo', 'a'.repeat(40)), 'host', briefText, 'a'.repeat(40));
    const reviewer: Profile = { id: 'deepseek', name: 'deepseek', provider: 'test', model: 'deepseek/deepseek-v3', notes: '', available: true, problem: '', supportedThinking: [] };
    e.engine.profiles = [profile, reviewer];
    e.store.setMeta('pool', [{ profileId: 'deepseek', enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] }]);
    const stageFields = `  stages:\n    - id: final-verify\n      kind: verify\n      subject: {head: candidate, digests: []}\n      role: reviewer\n      independence: []\n      gate: {pass: [source-check], insufficient: []}\n      actions: [comment]\n      profile: {id: deepseek, reason: "Fresh verifier"}\n      wait: []`;
    const withProfile = (id: string) => briefText.replace('  scope: mechanical', `  scope: mechanical\n${stageFields.replace('id: deepseek, reason', `id: ${id}, reason`)}`) + `\nAmendment.\n`;
    // Retired (Spec 043, 2026-10-06): the preflight refuses any declared plan, so the catalog distinction no longer applies.
    assert.equal(e.engine.briefStageProfileRefusal(withProfile('not-in-catalog'), 'mechanical'), STEPS_RETIRED_REASON);
    assert.equal(e.engine.briefStageProfileRefusal(withProfile('deepseek'), 'mechanical'), STEPS_RETIRED_REASON);
    await assert.rejects(e.engine.performTaskControl({ taskId: inserted.id, version: inserted.version, action: 'amend_brief', brief: withProfile('deepseek'), reason: 'Add a verifier' }),
      /Declared steps are retired/);
    assert.equal(e.store.task(inserted.id).briefVersions.length, 1, 'a refused declared amendment writes nothing');
  } finally { await e.close(); }
});

test('9. the outcome row holds the final brief text, its digest and earlier digests', async () => {
  const e = engineFixture();
  try {
    const inserted = e.store.insert(briefSubmission('/repo', 'a'.repeat(40)), 'host', briefText, 'a'.repeat(40));
    const finalText = `${briefText}\nFinal ruling.\n`;
    const amended = await e.engine.performTaskControl({ taskId: inserted.id, version: inserted.version, action: 'amend_brief', brief: finalText, reason: 'Final ruling' });
    e.store.update(amended.id, { phase: 'done', reason: 'Closed' });
    const row = e.store.outcome(amended.id)!;
    assert.deepEqual(row.brief, { digest: briefDigest(finalText), mediaType: 'text/markdown', text: finalText, source: 'queue', version: 2, earlierDigests: [briefDigest(briefText)] });
  } finally { await e.close(); }
});

test('10. handoff-mode tasks keep their identity hash, records and outcome shape', () => {
  const store = new Store(':memory:');
  try {
    const submission = submissionSchema.parse({ submissionId: 'legacy', title: 'Legacy', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'docs/handoffs/l.md', originAgentId: 'origin' });
    const task = store.insert(submission, 'host', 'handoff bytes', 'a'.repeat(40));
    // The submission hash formula, applied to the same handoff submission:
    // absent responsible materializes to its default at its schema position.
    const materialized = submissionSchema.parse({ ...submission, responsible: true });
    const { skipPRReview, dependsOn, notifyOriginOnCloseout, completionNotificationAgentIds, instruction, brief, lanes, draftProvenance, leadProvenance, ...rest } = materialized;
    const legacyHash = digest(JSON.stringify({ ...rest }));
    const row = store.db.prepare('SELECT input_hash FROM tasks WHERE id=?').get(task.id) as { input_hash: string };
    assert.equal(row.input_hash, legacyHash);
    assert.equal(task.brief, null);
    assert.deepEqual(task.briefVersions, []);
    store.putRun(runOf(task, 'reviewer'));
    assert.equal(store.run('run-reviewer')!.briefVersion, undefined, 'handoff-mode runs gain no brief field');
    store.update(task.id, { phase: 'done', reason: 'Closed' });
    assert.deepEqual(store.outcome(task.id)!.brief, { digest: `sha256:${digest('handoff bytes')}`, mediaType: 'text/markdown', text: 'handoff bytes', source: 'handoff', version: null, earlierDigests: [] });
  } finally { store.close(); }
});

test('11. restart keeps pinned brief versions and old stores migrate unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-brief-restart-'));
  const path = join(dir, 'queue.sqlite');
  try {
    let e = engineFixture(path);
    const inserted = e.store.insert(briefSubmission('/repo', 'a'.repeat(40)), 'host', briefText, 'a'.repeat(40));
    await e.engine.performTaskControl({ taskId: inserted.id, version: inserted.version, action: 'amend_brief', brief: `${briefText}\nv2\n`, reason: 'Second' });
    // An old-store row: a handoff task written before brief mode, without the new fields.
    const legacy = e.store.insert(submissionSchema.parse({ submissionId: 'old', title: 'Old', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'docs/handoffs/o.md', originAgentId: 'origin' }), 'host', 'old bytes', 'a'.repeat(40));
    const { brief: _b, briefVersions: _v, briefRuns: _r, ...oldShape } = e.store.task(legacy.id);
    e.store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(oldShape), legacy.id);
    await e.close();
    e = engineFixture(path);
    try {
      const restored = e.store.task(inserted.id);
      assert.deepEqual(restored.briefVersions.map(version => [version.version, version.reason]), [[1, 'Submitted'], [2, 'Second']]);
      assert.equal(restored.handoffText, `${briefText}\nv2\n`);
      const migrated = e.store.task(legacy.id);
      assert.equal(migrated.brief, null);
      assert.deepEqual(migrated.briefVersions, []);
      assert.equal(migrated.handoffPath, 'docs/handoffs/o.md');
      assert.equal(migrated.handoffText, 'old bytes');
    } finally { await e.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('a lean brief needs only title, approval and queue routing, in any section structure', async t => {
  const f = await repoFixture(t, 'v5');
  const lean = `---
title: Lean brief
queue_approval: "Operator approved this disposable brief"
queue:
  scope: general
---

## Outcome

What will be true.

## Acceptance

How a reviewer knows.
`;
  await writeFile(f.briefPath, lean);
  const prepared = await prepareHandoff({ briefPath: f.briefPath, repoPath: f.repo, originAgentId: 'origin', baseBranch: 'main', dryRun: true });
  assert.equal(prepared.submission.title, 'Lean brief');
  assert.equal(prepared.approval, 'Operator approved this disposable brief');
  // Old-style briefs with full handoff frontmatter still pass.
  await writeFile(f.briefPath, briefText);
  await prepareHandoff({ briefPath: f.briefPath, repoPath: f.repo, originAgentId: 'origin', baseBranch: 'main', dryRun: true });
  // Missing approval and an empty body are refused.
  await writeFile(f.briefPath, '---\ntitle: No approval\n---\n\n## Outcome\n\nx\n');
  await assert.rejects(prepareHandoff({ briefPath: f.briefPath, repoPath: f.repo, originAgentId: 'origin', baseBranch: 'main', dryRun: true }), /queue_approval/);
  await writeFile(f.briefPath, '---\ntitle: Empty\nqueue_approval: ok\n---\n\n');
  await assert.rejects(prepareHandoff({ briefPath: f.briefPath, repoPath: f.repo, originAgentId: 'origin', baseBranch: 'main', dryRun: true }), /Brief body is empty/);
});

test('brief frontmatter maps queue.mergeHold to an initially held but dispatchable task', () => {
  const withHold=briefText.replace('scope: mechanical','scope: mechanical\n  mergeHold: true\n  mergeHoldReason: Waiting on an external receipt');
  const metadata=parseNorthstarDocument(withHold,'brief');
  const submission=submissionSchema.parse({submissionId:'merge-hold',title:metadata.title,repoPath:'/repo',planningCommit:'a'.repeat(40),brief:{text:withHold},originAgentId:'origin',...submissionQueueFields(metadata.queue)});
  const store=new Store(':memory:');
  try {
    const task=store.insert(submission,'host',withHold,'a'.repeat(40));
    assert.equal(task.mergeHold,true);
    assert.equal(task.held,true);
    assert.deepEqual(queuedDispatchOrder([{...task,phase:'queued'}]).map(candidate=>candidate.id),[task.id]);
  } finally { store.close(); }
});

test('Spec 040 row 2: a brief with queue.mergeHold and no mergeHoldReason is refused at check and submit', async t => {
  const noReason=briefText.replace('scope: mechanical','scope: mechanical\n  mergeHold: true');
  assert.throws(()=>parseNorthstarDocument(noReason,'brief'),/mergeHoldReason/);
  assert.throws(()=>parseNorthstarDocument(noReason,'draft'),/mergeHoldReason/);
  const f=await repoFixture(t);
  await writeFile(f.briefPath,noReason);
  await assert.rejects(prepareHandoff({ briefPath: f.briefPath, repoPath: f.repo, originAgentId: 'origin', baseBranch: 'main', dryRun: true }), /mergeHoldReason/);
  await assert.rejects(prepareHandoff({ briefPath: f.briefPath, repoPath: f.repo, originAgentId: 'origin', baseBranch: 'main', dryRun: false }), /mergeHoldReason/);
});

test('amend_brief applies a changed merge hold and refuses retired verdict and gate frontmatter', async () => {
  const e=engineFixture();
  try {
    const inserted=e.store.insert(briefSubmission('/repo','a'.repeat(40)),'host',briefText,'a'.repeat(40));
    // queue.reviewContinuationIds is retired and inert: a historical amendment
    // carrying it parses cleanly, writes nothing to the task and records no gate-change event.
    const continuationText=briefText.replace('scope: mechanical','scope: mechanical\n  reviewContinuationIds: [scope]');
    const withContinuation=await e.engine.performTaskControl({taskId:inserted.id,version:inserted.version,action:'amend_brief',brief:continuationText,reason:'Historical continuation list rides along'});
    assert.equal(withContinuation.reviewContinuationIds,undefined);
    assert.equal(withContinuation.briefVersions.length,2);
    assert.equal(e.store.eventsAll(inserted.id).filter(event=>event.kind.startsWith('brief_')&&event.kind.endsWith('_changed')).length,0);
    const amendedText=briefText.replace('scope: mechanical','scope: mechanical\n  mergeHold: true\n  mergeHoldReason: Waiting on an external receipt');
    const amended=await e.engine.performTaskControl({taskId:withContinuation.id,version:withContinuation.version,action:'amend_brief',brief:amendedText,reason:'Hold for an external receipt'});
    assert.equal(amended.mergeHold,true);
    assert.equal(amended.held,true);
    assert.equal(amended.brief?.digest,briefDigest(amendedText));
    const changes=e.store.eventsAll(inserted.id).filter(event=>event.kind.startsWith('brief_')&&event.kind.endsWith('_changed'));
    assert.deepEqual(changes.map(event=>event.kind),['brief_merge_hold_changed']);
    assert.ok(changes.every(event=>event.detail.includes('Hold for an external receipt')));
    // Retired verdict, gate and manual-verification keys are refused with the replacement named.
    for (const key of ['reviewVerdicts: [scope, evidence]','reviewPassGate: [scope]','manualVerification: true']) {
      const retiredText=briefText.replace('scope: mechanical',`scope: mechanical\n  ${key}`);
      await assert.rejects(
        e.engine.performTaskControl({taskId:amended.id,version:amended.version,action:'amend_brief',brief:retiredText,reason:'Retired key'}),
        /is no longer available/);
    }
  } finally { await e.close(); }
});

test('an unchanged brief mergeHold frontmatter does not reapply a released hold', async () => {
  const e=engineFixture();
  try {
    const submittedText=briefText.replace('scope: mechanical','scope: mechanical\n  mergeHold: true\n  mergeHoldReason: Waiting on an external receipt');
    const inserted=e.store.insert(briefSubmission('/repo','a'.repeat(40),{brief:{text:submittedText,mediaType:'text/markdown'}}),'host',submittedText,'a'.repeat(40));
    const released=e.store.update(inserted.id,{held:false,mergeHold:false});
    const amendedText=`${submittedText}\nMore context.\n`;
    const amended=await e.engine.performTaskControl({taskId:inserted.id,version:released.version,action:'amend_brief',brief:amendedText,reason:'Clarified the task'});
    assert.equal(amended.held,false);
    assert.equal(amended.mergeHold,false);
    assert.ok(!e.store.eventsAll(inserted.id).some(event=>event.kind==='brief_merge_hold_changed'));
  } finally { await e.close(); }
});

test('amend_brief is refused as soon as merge intent starts', async () => {
  const e=engineFixture();
  try {
    const inserted=e.store.insert(briefSubmission('/repo','a'.repeat(40)),'host',briefText,'a'.repeat(40));
    const merging=e.store.update(inserted.id,{phase:'merging',resolution:{...inserted.resolution,mergeIntent:true}});
    await assert.rejects(e.engine.performTaskControl({taskId:merging.id,version:merging.version,action:'amend_brief',brief:`${briefText}\nToo late.\n`,reason:'Late amendment'}),/once merging has started/);
  } finally { await e.close(); }
});

test('hold tolerates stale versions advanced only by observations, but not a substantive change', async () => {
  const e=engineFixture();
  try {
    const observationTask=e.store.insert(briefSubmission('/repo','a'.repeat(40)),'host',briefText,'a'.repeat(40));
    const observed=e.store.update(observationTask.id,{lastObservedAt:new Date().toISOString(),agentActive:false,lastAgentStatus:'idle',idleSince:new Date().toISOString()});
    const held=await e.engine.performTaskControl({taskId:observationTask.id,version:observationTask.version,action:'hold',reason:'Test hold'});
    assert.equal(held.held,true);
    assert.equal(held.version,observed.version+1);

    const changedTask=e.store.insert(briefSubmission('/repo','a'.repeat(40)),'host',briefText,'a'.repeat(40));
    const changed=e.store.update(changedTask.id,{reason:'Substantive update'});
    const laterObservation=e.store.update(changed.id,{lastObservedAt:new Date().toISOString(),agentActive:false,lastAgentStatus:'idle',idleSince:new Date().toISOString()});
    await assert.rejects(e.engine.performTaskControl({taskId:changedTask.id,version:changedTask.version,action:'hold',reason:'Test hold'}),/Task changed/);
    assert.equal(e.store.task(changedTask.id).version,laterObservation.version);
  } finally { await e.close(); }
});

test('amend_brief accepts a brief pinned before queue_approval was required', async () => {
  // Project-A #1763–#1765, 2026-10-01: amending legacy briefs failed with
  // "Invalid brief frontmatter: queue_approval" because the old pinned text was reparsed strictly.
  const e=engineFixture();
  try {
    const inserted=e.store.insert(briefSubmission('/repo','a'.repeat(40)),'host',briefText,'a'.repeat(40));
    const legacy=briefText.replace(/^queue_approval:.*\n/m,'');
    assert.notEqual(legacy,briefText,'the fixture drops queue_approval');
    const current=inserted.briefVersions.at(-1)!;
    const pinned=e.store.update(inserted.id,{brief:{...inserted.brief!,text:legacy},handoffText:legacy,
      briefVersions:[...inserted.briefVersions.slice(0,-1),{...current,text:legacy}]});
    const amendedText=briefText.replace('scope: mechanical','scope: mechanical\n  mergeHold: true\n  mergeHoldReason: Waiting on an external receipt');
    const amended=await e.engine.performTaskControl({taskId:pinned.id,version:pinned.version,action:'amend_brief',brief:amendedText,reason:'Add a merge hold to a legacy brief'});
    assert.equal(amended.mergeHold,true);
    assert.ok(e.store.eventsAll(pinned.id).some(event=>event.kind==='brief_merge_hold_changed'));
  } finally { await e.close(); }
});

test('Spec 051: queue.interactive in a brief reaches the task, its worker prompt and the board card', async () => {
  const e = engineFixture();
  try {
    const interactiveText = briefText.replace('scope: mechanical', 'scope: mechanical\n  interactive: true');
    const fields = submissionQueueFields(parseNorthstarDocument(interactiveText, 'brief').queue!);
    assert.equal(fields.interactive, true);
    const task = e.store.insert(briefSubmission('/repo', 'a'.repeat(40), { brief: { text: interactiveText, mediaType: 'text/markdown' }, ...fields } as Partial<Submission>), 'host', interactiveText, 'a'.repeat(40));
    assert.equal(task.interactive, true);
    for (const mcp of [true, false]) {
      const prompt = workerPrompt({ ...task, runId: 'run' }, mcp);
      assert.match(prompt, /INTERACTIVE TASK/);
      assert.match(prompt, /Their direct instructions in this thread are your authority/);
      assert.match(prompt, /Only when the operator tells you to submit, /);
      assert.doesNotMatch(prompt, /Before ending your turn, /);
    }
    const plain = e.store.insert(briefSubmission('/repo', 'a'.repeat(40)), 'host', briefText, 'a'.repeat(40));
    assert.equal(plain.interactive, undefined, 'absent keeps legacy identity');
    assert.doesNotMatch(workerPrompt({ ...plain, runId: 'run' }, true), /INTERACTIVE TASK/);
    assert.equal(summarizeTask(task).interactive, true);
    assert.equal(summarizeTask(plain).interactive, undefined);
  } finally { await e.close(); }
});

test('Spec 051: amend_brief turns interactive on before dispatch and refuses the change after', async () => {
  const e = engineFixture();
  try {
    const inserted = e.store.insert(briefSubmission('/repo', 'a'.repeat(40)), 'host', briefText, 'a'.repeat(40));
    const interactiveText = briefText.replace('scope: mechanical', 'scope: mechanical\n  interactive: true');
    const amended = await e.engine.performTaskControl({ taskId: inserted.id, version: inserted.version, action: 'amend_brief', brief: interactiveText, reason: 'Work with it directly' });
    assert.equal(amended.interactive, true);
    assert.ok(e.store.eventsAll(inserted.id).some(event => event.kind === 'brief_interactive_changed'));
    // An amendment without the key leaves the mode alone, even after dispatch.
    const dispatched = e.store.update(inserted.id, { phase: 'working', agentId: 'worker-agent' });
    const untouched = await e.engine.performTaskControl({ taskId: dispatched.id, version: dispatched.version, action: 'amend_brief', brief: briefText.replace('Brief instructions', 'Clarified instructions'), reason: 'Clarify' });
    assert.equal(untouched.interactive, true);
    const off = briefText.replace('scope: mechanical', 'scope: mechanical\n  interactive: false');
    await assert.rejects(e.engine.performTaskControl({ taskId: untouched.id, version: untouched.version, action: 'amend_brief', brief: off, reason: 'Stop interacting' }), /changes only before dispatch/);
  } finally { await e.close(); }
});

test('brief versions live in their own table, so an ordinary update never rewrites them; a schema 42 store migrates (Tom 2026-10-21)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-brief-versions-'));
  const path = join(dir, 'queue.sqlite');
  let e = engineFixture(path);
  try {
    const inserted = e.store.insert(briefSubmission('/repo', 'a'.repeat(40)), 'host', briefText, 'a'.repeat(40));
    const second = await e.engine.performTaskControl({ taskId: inserted.id, version: inserted.version, action: 'amend_brief', brief: `${briefText}\nSecond.\n`, reason: 'Second ruling' });
    const third = await e.engine.performTaskControl({ taskId: second.id, version: second.version, action: 'amend_brief', brief: `${briefText}\nThird.\n`, reason: 'Third ruling' });
    const versions = third.briefVersions;
    assert.deepEqual(versions.map(version => version.version), [1, 2, 3]);
    const row = () => JSON.parse(String((e.store.db.prepare('SELECT data FROM tasks WHERE id=?').get(inserted.id) as { data: string }).data));
    const stored = () => e.store.db.prepare('SELECT version,data FROM task_brief_versions WHERE taskId=? ORDER BY version').all(inserted.id).map(r => ({ ...r }));
    assert.equal(Object.hasOwn(row(), 'briefVersions'), false, 'the task row carries no brief versions');
    const before = stored();
    assert.deepEqual(before.map(r => r.version), [1, 2, 3]);
    e.store.update(inserted.id, { reason: 'An ordinary observation' });
    assert.deepEqual(stored(), before, 'an ordinary update leaves every stored version untouched');
    assert.equal(Object.hasOwn(row(), 'briefVersions'), false);
    assert.deepEqual(e.store.task(inserted.id).briefVersions, versions);
    // Read versions are shared history: an in-place edit throws instead of hiding a change from storage (Sol, #573).
    const read = e.store.task(inserted.id);
    assert.throws(() => (read.briefVersions as typeof versions).push({ ...versions[0], version: 4 }), TypeError);
    assert.throws(() => { (read.briefVersions[0] as { text: string }).text = 'edited'; }, TypeError);
    // A rewrite reaches only the version it changes; a dropped version leaves the table.
    const rewritten = { ...versions[1], text: 'Rewritten', digest: briefDigest('Rewritten') };
    e.store.update(inserted.id, { briefVersions: [versions[0], rewritten] });
    assert.deepEqual(stored().map(r => r.version), [1, 2]);
    assert.equal(stored()[0].data, before[0].data);
    assert.deepEqual(e.store.task(inserted.id).briefVersions, [versions[0], rewritten]);
    e.store.update(inserted.id, { briefVersions: versions });
    assert.deepEqual(stored(), before);

    await e.close(); e = engineFixture(path);
    assert.deepEqual(e.store.task(inserted.id).briefVersions, versions, 'a restart reads the versions back');

    e.store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
    e.store.setMeta('schema', 50);
    await e.close(); e = engineFixture(path);
    assert.equal(e.store.getMeta('schema'), CURRENT_SCHEMA);
    assert.equal(Object.hasOwn(row(), 'briefVersions'), false, 'upgrade keeps the versions out of the row');
    assert.deepEqual(stored(), before, 'upgrade keeps each version as stored');
    assert.deepEqual(e.store.task(inserted.id).briefVersions, versions);
    e.store.putRun(runOf(e.store.task(inserted.id), 'revision', { id: 'migrated' }));
    assert.equal(e.store.run('migrated')!.briefVersion, 3, 'a run still records the current version');
  } finally { await e.close(); rmSync(dir, { recursive: true, force: true }); }
});
