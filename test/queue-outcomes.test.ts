import { configuredClone, materializeSeed } from './support/git-seed';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CURRENT_SCHEMA, Store, digest } from '../core/store/store';
import { Engine } from '../core/engine';
import { git, command } from '../core/git/index';
import { controlManifestSchema, RESERVED_VALIDATION_MESSAGE, type ControlManifest } from '../shared/hooks';
import { classifyCloseoutAuthority, parseManifestBytes } from '../core/hooks/hooks';
import { submissionSchema, type Profile, type Run } from '../shared/contracts';
import { requestDisposition, type DispositionDeps } from '../core/verbs/disposition';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';

const worker: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
const coordinator: Profile = { id: 'coordinator', name: 'Coordinator', provider: 'test', model: 'coordinator', notes: '', available: true, problem: '', supportedThinking: [] };
const reviewer: Profile = { id: 'reviewer', name: 'Reviewer', provider: 'test', model: 'reviewer', notes: '', available: true, problem: '', supportedThinking: [] };

const v4CloseoutHook = (id = 'ledger') => ({
  id, events: ['task.closeout'], target: 'integration_base', mode: 'integration_write', delivery: 'required',
  program: { kind: 'repository' as const, executable: `.paseo/hooks/${id}`, argv: [] },
  timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: ['docs/ledger.json'],
  commitSubject: { prefix: 'queue: hook', maxBytes: 80 },
});
const v5 = (closeout: 'queue' | 'hooks', hooks: unknown[] = []) => ({ schema: 'paseo.queue.control.v5', closeout, hooks });
const v1Hook = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, events: ['task.closeout'], mode: 'read_only', delivery: 'required',
  executable: `.paseo/hooks/${id}`, argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536,
  allowedPaths: [], commitSubject: null, ...overrides,
});
const v1Write = () => v1Hook('ledger', { mode: 'integration_write', delivery: 'required', allowedPaths: ['docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 } });

test('1. v1–v4 keep manifest authority; a missing manifest now selects Queue closeout (Spec 022)', () => {
  assert.equal(classifyCloseoutAuthority(null), 'queue', 'manifest absence defaults to Queue closeout');
  assert.equal(classifyCloseoutAuthority(null, 'agent'), 'agent', 'a project override of agent keeps the closeout agent without a manifest');
  assert.equal(classifyCloseoutAuthority(null, 'queue'), 'queue', 'an explicit queue override matches the default');
  assert.equal(classifyCloseoutAuthority(null, null), 'queue', 'no override matches the default');
  const v1 = controlManifestSchema.parse({ schema: 'paseo.queue.control.v1', hooks: [v1Write()] });
  assert.equal(classifyCloseoutAuthority(v1), 'hook');
  const v1Empty = controlManifestSchema.parse({ schema: 'paseo.queue.control.v1', hooks: [] });
  assert.equal(classifyCloseoutAuthority(v1Empty), 'agent', 'a manifest still governs its own repository');
  assert.equal(classifyCloseoutAuthority(v1Empty, 'queue'), 'agent', 'a project override never touches a manifest repository');
  const v2 = controlManifestSchema.parse({
    schema: 'paseo.queue.control.v2',
    hooks: [{ id: 'ledger', events: ['task.closeout'], mode: 'integration_write', delivery: 'required',
      program: { kind: 'repository', executable: '.paseo/hooks/ledger', argv: [] }, timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536,
      allowedPaths: ['docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 } }],
  });
  assert.equal(classifyCloseoutAuthority(v2), 'hook');
  const v3 = controlManifestSchema.parse({
    schema: 'paseo.queue.control.v3',
    hooks: [{ ...v4CloseoutHook(), target: 'integration_base' }],
  });
  assert.equal(classifyCloseoutAuthority(v3), 'hook');
  const v4 = controlManifestSchema.parse({ schema: 'paseo.queue.control.v4', hooks: [v4CloseoutHook()] });
  assert.equal(classifyCloseoutAuthority(v4), 'hook');
  assert.throws(() => controlManifestSchema.parse({ schema: 'paseo.queue.control.v1', closeout: 'queue', hooks: [] }));
});

const parseError = (value: unknown) => { try { controlManifestSchema.parse(value); return ''; } catch (error) { return JSON.stringify(error); } };

test('5. v5 queue closeout plus any task.closeout hook is refused', () => {
  const invalid = { schema: 'paseo.queue.control.v5', closeout: 'queue', hooks: [v4CloseoutHook()] };
  assert.match(parseError(invalid), /cannot be combined with a task\.closeout hook/);
  const observer = { ...v4CloseoutHook(), mode: 'read_only', allowedPaths: [], commitSubject: null };
  assert.match(parseError({ schema: 'paseo.queue.control.v5', closeout: 'queue', hooks: [observer] }), /task\.closeout/);
});

test('6. v5 reserved validation key is refused with the item-3 message', () => {
  const withValidation = { schema: 'paseo.queue.control.v5', closeout: 'queue', hooks: [], validation: { mode: 'plain' } };
  assert.throws(() => controlManifestSchema.parse(withValidation), new RegExp(RESERVED_VALIDATION_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.throws(() => parseManifestBytes(Buffer.from(JSON.stringify(withValidation))), /Spec 042 item 3/);
});

test('v5 closeout queue and hooks selection', () => {
  const queue = controlManifestSchema.parse(v5('queue'));
  assert.equal(classifyCloseoutAuthority(queue), 'queue');
  const omitted = controlManifestSchema.parse({ schema: 'paseo.queue.control.v5' });
  assert.equal((omitted as { closeout: string }).closeout, 'hooks');
  assert.equal(classifyCloseoutAuthority(omitted as ControlManifest), 'agent');
  const hooks = controlManifestSchema.parse(v5('hooks', [v4CloseoutHook()]));
  assert.equal(classifyCloseoutAuthority(hooks), 'hook');
  const hooksEmpty = controlManifestSchema.parse(v5('hooks'));
  assert.equal(classifyCloseoutAuthority(hooksEmpty), 'agent');
});

/** Spec 022 row 1: no manifest and no project override closes out in Queue with nothing written. */
test('2a. no manifest and no override: Queue closeout with no run, workspace, hook, commit or push', async t => {
  const f = await closeoutFixture(t, { withManifest: false });
  try {
    const before = await git(f.repo, 'rev-parse', 'HEAD');
    const remoteBefore = await git(f.repo, 'rev-parse', 'refs/remotes/origin/main');
    await f.engine.wake();
    const done = f.current();
    assert.equal(done.phase, 'done', done.reason);
    assert.equal(f.creates.length, 0, 'no closeout run is created');
    assert.equal(f.store.runs(f.taskId).length, 0);
    assert.equal(f.store.hookEvents(f.taskId).length, 0);
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), before, 'nothing is committed');
    assert.equal(await git(f.repo, 'rev-parse', 'refs/remotes/origin/main'), remoteBefore, 'nothing is pushed');
    const row = f.store.outcome(f.taskId)!;
    assert.equal(row.outcome, 'done');
    assert.equal(row.closeout?.authority, 'queue');
    assert.equal(row.closeout?.commit, null);
  } finally { await f.close(); }
});

/** Spec 022 row 2: a project closeout override of agent keeps the closeout agent, exactly as before. */
test('2b. no manifest with a project closeout override of agent runs the agent closeout', async t => {
  const f = await closeoutFixture(t, { withManifest: false });
  try {
    f.store.putRepository({ origin: null, path: f.repo }, 'agent', 'this repository keeps its closeout records');
    await f.engine.wake();
    assert.equal(f.store.runs(f.taskId)[0]?.role, 'closeout');
    await f.reportCloseout(f.head);
    assert.equal(f.current().phase, 'done', f.current().reason);
    const row = f.store.outcome(f.taskId)!;
    assert.equal(row.closeout?.authority, 'agent');
    assert.equal(row.closeout?.commit, f.head);
  } finally { await f.close(); }
});

/** Spec 022 row 3: a manifest governs its repository; a project override is ignored there. */
test('2c. a project override never changes a manifest repository authority', async t => {
  const empty = await closeoutFixture(t, { manifest: { schema: 'paseo.queue.control.v1', hooks: [] } });
  try {
    empty.store.putRepository({ origin: null, path: empty.repo }, 'queue', 'override is ignored on manifest repositories');
    await empty.engine.wake();
    assert.equal(empty.store.runs(empty.taskId)[0]?.role, 'closeout', 'an empty v1 manifest keeps the closeout agent despite a queue override');
    await empty.reportCloseout(empty.head);
    assert.equal(empty.store.outcome(empty.taskId)!.closeout?.authority, 'agent');
  } finally { await empty.close(); }

  const hook = await closeoutFixture(t, {
    manifest: { schema: 'paseo.queue.control.v1', hooks: [v1Write()] },
    hooks: { '.paseo/hooks/ledger': { content: ledgerScript, mode: 0o755 } },
  });
  try {
    hook.store.putRepository({ origin: null, path: hook.repo }, 'queue', 'override is ignored on manifest repositories');
    await hook.engine.wake();
    assert.equal(hook.current().phase, 'done', hook.current().reason);
    assert.equal(hook.creates.length, 0);
    assert.equal(hook.store.outcome(hook.taskId)!.closeout?.authority, 'hook', 'the manifest hook still owns closeout');
  } finally { await hook.close(); }
});

/** Spec 022 row 7: a closeout already running under agent authority settles under it; later closeouts use the new default. */
test('2d. a default switch while a no-manifest task is mid-closeout settles it as agent', async t => {
  const f = await closeoutFixture(t, { withManifest: false });
  try {
    f.store.putRepository({ origin: null, path: f.repo }, 'agent', 'old default');
    await f.engine.wake();
    assert.equal(f.store.runs(f.taskId)[0]?.role, 'closeout', 'the agent closeout is launched under the old setting');
    // The default switches to Queue while the closeout run is in flight.
    f.store.putRepository({ origin: null, path: f.repo }, null, '');
    await f.reportCloseout(f.head);
    assert.equal(f.current().phase, 'done', f.current().reason);
    assert.equal(f.store.outcome(f.taskId)!.closeout?.authority, 'agent', 'the running closeout settles under the authority it started with');

    // A later closeout in the same repository uses the new default.
    const second = f.store.insert(submissionSchema.parse({
      submissionId: randomUUID(), title: 'Later task', repoPath: f.repo, planningCommit: f.head,
      handoffPath: 'docs/plan.json', originAgentId: 'origin',
    }), 'host', 'pinned handoff text', f.head);
    f.store.update(second.id, {
      phase: 'closing', workspaceId: 'task-ws-2', directory: f.repo, agentId: 'worker-2', runId: 'initial-2', profile: worker,
      resolution: { ...second.resolution, mergedCommit: f.head, syncedCommit: f.head },
    });
    await f.engine.wake();
    const settled = f.store.task(second.id);
    assert.equal(settled.phase, 'done', settled.reason);
    assert.equal(f.store.runs(second.id).length, 0, 'no closeout run is created under the new default');
    assert.equal(f.store.outcome(second.id)!.closeout?.authority, 'queue');
  } finally { await f.close(); }
});

const day = 86400000;
function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-outcomes-'));
  const path = join(dir, 'queue.sqlite');
  let store = new Store(path);
  const input = (id: string) => submissionSchema.parse({
    submissionId: id, title: id, repoPath: '/repo', planningCommit: 'a'.repeat(40),
    handoffPath: 'docs/handoffs/task.md', originAgentId: 'origin',
  });
  const add = (id: string, handoff = 'pinned brief text') => store.insert(input(id), 'host', handoff, 'a'.repeat(40));
  return {
    dir, path, get store() { return store; }, input, add,
    reopen() { store.close(); store = new Store(path); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('11. schema 50 upgrade preserves done and cancelled outcomes and invents nothing for other tasks', () => {
  const f = storeFixture();
  try {
    const done = f.add('done', 'done brief');
    const cancelled = f.add('cancelled', 'cancel brief');
    const live = f.add('live');
    f.store.update(done.id, { phase: 'done', reason: 'Closed', prUrl: 'https://github.com/acme/app/pull/3', prHead: 'c'.repeat(40), resumePrNumber: 3 });
    f.store.update(cancelled.id, { phase: 'cancelled', reason: 'Cancelled: abandoned' });
    const originalDone = f.store.outcome(done.id), originalCancelled = f.store.outcome(cancelled.id);
    f.store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
    f.store.setMeta('schema', 50);
    f.reopen();
    assert.equal(f.store.getMeta('schema'), CURRENT_SCHEMA);
    const doneRow = f.store.outcome(done.id)!;
    const cancelRow = f.store.outcome(cancelled.id)!;
    assert.deepEqual(doneRow, originalDone);
    assert.equal(doneRow.outcome, 'done');
    assert.equal(doneRow.brief.text, 'done brief');
    assert.equal(doneRow.repository.origin, 'acme/app');
    assert.deepEqual(cancelRow, originalCancelled);
    assert.equal(cancelRow.outcome, 'cancelled');
    assert.equal(f.store.outcome(live.id), null);
    assert.equal(f.store.outcome('missing'), null);
  } finally { f.close(); }
});

test('8. outcome rows survive purge and remain readable by task and submission id', () => {
  const f = storeFixture();
  try {
    const done = f.add('done', 'keep this brief');
    f.store.update(done.id, { phase: 'done', reason: 'Closed' });
    const row = f.store.outcome(done.id)!;
    assert.equal(row.backfilled, false);
    f.store.purgeOldTasks(Date.now() + 15 * day);
    assert.throws(() => f.store.task(done.id), /purged/);
    assert.deepEqual(f.store.outcome(done.id), row);
    assert.deepEqual(f.store.outcomeBySubmission(done.submissionId), row);
  } finally { f.close(); }
});

test('9. cancellation, supersession and removal of a finished task each leave one row', async () => {
  const f = storeFixture();
  try {
    const deps: DispositionDeps = {
      hooks: { emit: async () => ({ hold: false, attention: false, records: [] }) },
      observeAgent: async () => ({ stopped: true }),
      archiveAgent: async () => {},
      proveWorkspaceEmpty: async () => ({ empty: true, detail: 'empty' }),
      proveRetainedByReplacement: async () => ({ retained: true, detail: 'retained' }),
      archiveWorkspace: async () => true,
      observeWorkspaceArchived: async () => true,
      settleCancelledPr: async () => 'No PR',
    };
    const cancel = f.add('cancel');
    f.store.update(cancel.id, { phase: 'working', workspaceId: 'ws-cancel', directory: '/missing-cancel', agentId: 'worker-cancel' });
    await requestDisposition(f.store, deps, { taskId: cancel.id, version: f.store.task(cancel.id).version, action: 'cancel', reason: 'Zero-work duplicate' });
    const cancelRow = f.store.outcome(cancel.id)!;
    assert.equal(cancelRow.outcome, 'cancelled');
    assert.equal(cancelRow.mergeCommit, null);
    assert.equal(cancelRow.closeout, null);

    const replacement = f.add('replacement');
    const superseded = f.add('superseded');
    f.store.update(superseded.id, { phase: 'working', workspaceId: 'ws-super', directory: '/missing-super', agentId: 'worker-super' });
    await requestDisposition(f.store, deps, {
      taskId: superseded.id, version: f.store.task(superseded.id).version, action: 'supersede',
      reason: 'Replaced', replacementTaskId: replacement.id, workDisposition: 'preserve',
    });
    const superRow = f.store.outcome(superseded.id)!;
    assert.equal(superRow.outcome, 'superseded');
    assert.equal(superRow.replacementTaskId, replacement.id);
    assert.equal(superRow.mergeCommit, null);

    const finished = f.add('finished');
    f.store.update(finished.id, { phase: 'done', reason: 'Closed without merge' });
    const before = f.store.outcome(finished.id)!;
    f.store.update(finished.id, { removedAt: new Date().toISOString() });
    assert.deepEqual(f.store.outcome(finished.id), before);
    assert.equal(f.store.outcome(finished.id)!.outcome, 'done');
    assert.equal(f.store.outcome(finished.id)!.mergeCommit, null);
  } finally { f.close(); }
});

test('10. crash either side of the terminal transaction never duplicates or rewrites a row', () => {
  const f = storeFixture();
  try {
    const crash = f.add('crash', 'brief-a');
    assert.throws(() => f.store.transaction(() => {
      f.store.update(crash.id, { phase: 'done', reason: 'Closed' });
      throw new Error('crash after write');
    }), /crash after write/);
    assert.equal(f.store.task(crash.id).phase, 'queued');
    assert.equal(f.store.outcome(crash.id), null);

    const ok = f.add('ok', 'brief-b');
    f.store.update(ok.id, { phase: 'done', reason: 'Closed' });
    const first = f.store.outcome(ok.id)!;
    f.store.update(ok.id, { reason: 'later note' });
    assert.deepEqual(f.store.outcome(ok.id), first);
    f.reopen();
    assert.deepEqual(f.store.outcome(ok.id), first);
    f.store.update(ok.id, { reason: 'after restart' });
    assert.deepEqual(f.store.outcome(ok.id), first);
  } finally { f.close(); }
});

test('13. brief content equals the pinned text byte for byte with its digest', () => {
  const f = storeFixture();
  try {
    const text = 'handoff bytes \u{1F4E6} and a trailing space ';
    const task = f.add('brief', text);
    f.store.update(task.id, { phase: 'done', reason: 'Closed' });
    const row = f.store.outcome(task.id)!;
    assert.equal(row.brief.text, text);
    assert.equal(row.brief.digest, `sha256:${digest(text)}`);
    assert.equal(row.brief.mediaType, 'text/markdown');
  } finally { f.close(); }
});

const ledgerScript = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.writeFileSync('docs/ledger.json',JSON.stringify({eventId:event.eventId}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'closeout published',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:'ledger'}));});
`;

type FixtureOptions = { manifest?: unknown; withManifest?: boolean; hooks?: Record<string, { content: string; mode?: number }> };

async function closeoutFixture(t: { after: (fn: () => Promise<void> | void) => void }, options: FixtureOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-outcomes-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await materializeSeed(configuredClone, root);
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(join(repo, 'docs/plan.json'), '{}');
  if (options.withManifest !== false && options.manifest !== undefined) {
    await mkdir(join(repo, '.paseo'), { recursive: true });
    await writeFile(join(repo, '.paseo/queue.json'), JSON.stringify(options.manifest, null, 2));
  }
  for (const [path, spec] of Object.entries(options.hooks ?? {})) {
    const full = join(repo, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, spec.content);
    if (spec.mode) await chmod(full, spec.mode);
  }
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'base');
  await git(repo, 'push', 'origin', 'main');
  const head = await git(repo, 'rev-parse', 'HEAD');
  const dir = await mkdtemp(join(tmpdir(), 'nsq-outcomes-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('lastRetentionAt', Date.now());
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Queue closeout', repoPath: repo, planningCommit: head,
    handoffPath: 'docs/plan.json', originAgentId: 'origin', notifyOriginOnCloseout: true,
  }), 'host', 'pinned handoff text', head);
  const task = store.update(submitted.id, {
    phase: 'closing', workspaceIntent: true, agentIntent: true, workspaceId: 'task-ws', directory: repo,
    agentId: 'worker', runId: 'initial', profile: worker, originWorkspaceId: 'origin-workspace',
    prUrl: 'https://github.com/example/repo/pull/7', prHead: '6'.repeat(40), resumePrNumber: 7,
    resolution: {
      ...submitted.resolution,
      coordinatorWorkspaceId: 'task-ws',
      integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
      review: { eventId: 'review', taskId: submitted.id, runId: 'review-run', status: 'ready_to_merge', summary: 'independent review accepted the exact head', head: '6'.repeat(40), reviewCommentId: 7 },
      reviewerProfile: reviewer, mergedCommit: head, syncedCommit: head, mergeHead: '6'.repeat(40), mergeBase: '7'.repeat(40),
    },
  });
  const states = new Map<string, AgentObservation>();
  const idle = (id: string, workspaceId = 'task-ws') => states.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '' });
  idle('worker'); idle('origin', 'origin-workspace');
  const tokens = new Map<string, string>(), creates: Run[] = [], notices: string[] = [];
  const adapter: Adapter & ResolutionAdapter = {
    profiles: async () => [worker, coordinator], validate: async () => head, verifyWorkspace: async () => 'main',
    createWorkspace: async () => { throw new Error('Closeout must not create workspaces'); }, findWorkspaces: async () => [],
    createAgent: async () => { throw new Error('No worker dispatch expected'); }, findAgents: async () => [],
    observe: async id => { const state = states.get(id); if (!state) throw new Error('Agent was not found'); return state; }, archiveAgent: async () => {},
    verifyPr: async () => ({ head: '6'.repeat(40), url: 'https://github.com/example/repo/pull/7' }),
    createRun: async (t, r, token) => { creates.push(r); tokens.set(r.id, token); const id = `agent-${r.id}`; states.set(id, { id, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' }); return { id, workspaceId: r.workspaceId }; },
    sendRun: async (t, r, token) => { tokens.set(r.id, token); states.set(r.agentId!, { ...states.get(r.agentId!)!, active: true, status: 'running' }); },
    findRunAgents: async () => [], verifyReview: async () => {},
    mergeGate: async () => ({ head: '6'.repeat(40), base: '7'.repeat(40), wait: '' }), merge: async () => {},
    merged: async () => ({ merged: true, commit: head, head: '6'.repeat(40), base: 'main' }), syncMain: async () => head,
    verifyCloseout: async () => undefined, notify: async id => { notices.push(id); },
  };
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker, coordinator];
  return {
    root, repo, head, store, engine, adapter, taskId: task.id, creates, notices,
    current: () => store.task(task.id),
    async reportCloseout(closeoutCommit?: string) {
      const run = store.run(store.task(task.id).resolution.currentRunId!)!;
      idle(run.agentId!, run.workspaceId);
      engine.resolution.complete({ eventId: randomUUID(), taskId: task.id, runId: run.id, status: 'closed', summary: 'legacy closeout accepted', head: run.head, coordinatorGeneration: run.generation, ...(closeoutCommit ? { closeoutCommit } : {}) }, tokens.get(run.id)!);
      await engine.wake();
    },
    close: async () => { await engine.stop(); store.close(); },
  };
}

test('2. v5 closeout queue merges to done with no run, workspace, hook, commit or push', async t => {
  const f = await closeoutFixture(t, { manifest: v5('queue') });
  try {
    const before = await git(f.repo, 'rev-parse', 'HEAD');
    await f.engine.wake();
    const done = f.current();
    assert.equal(done.phase, 'done', done.reason);
    assert.equal(f.creates.length, 0);
    assert.equal(f.store.runs(f.taskId).length, 0);
    assert.equal(f.store.hookEvents(f.taskId).length, 0);
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), before);
    const row = f.store.outcome(f.taskId)!;
    assert.equal(row.outcome, 'done');
    assert.equal(row.closeout?.authority, 'queue');
    assert.equal(row.closeout?.commit, null);
    assert.equal(row.syncedCommit, f.head);
    assert.equal(row.pr?.number, 7);
    assert.equal(row.brief.text, 'pinned handoff text');
  } finally { await f.close(); }
});

test('3. dispatched under v4, closes at a v5 base uses Queue closeout', async t => {
  const f = await closeoutFixture(t, { withManifest: false });
  try {
    const planning = f.head;
    await mkdir(join(f.repo, '.paseo'), { recursive: true });
    await writeFile(join(f.repo, '.paseo/queue.json'), JSON.stringify(v5('queue'), null, 2));
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-m', 'v5 queue');
    await git(f.repo, 'push', 'origin', 'main');
    const v5Head = await git(f.repo, 'rev-parse', 'HEAD');
    f.store.update(f.taskId, { planningBase: planning, planningCommit: planning, resolution: { ...f.current().resolution, mergedCommit: v5Head, syncedCommit: v5Head } });
    await f.engine.wake();
    assert.equal(f.current().phase, 'done', f.current().reason);
    assert.equal(f.creates.length, 0);
    assert.equal(f.store.outcome(f.taskId)!.closeout?.authority, 'queue');
  } finally { await f.close(); }
});

test('4. dispatched under v5, closes at a reverted v4 base uses v4 authority', async t => {
  const f = await closeoutFixture(t, { manifest: v5('queue') });
  try {
    await writeFile(join(f.repo, '.paseo/queue.json'), JSON.stringify({ schema: 'paseo.queue.control.v1', hooks: [] }, null, 2));
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-m', 'revert to v1');
    await git(f.repo, 'push', 'origin', 'main');
    const v1Head = await git(f.repo, 'rev-parse', 'HEAD');
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, mergedCommit: v1Head, syncedCommit: v1Head } });
    await f.engine.wake();
    assert.equal(f.store.runs(f.taskId)[0]?.role, 'closeout');
    assert.equal(f.current().phase, 'closing');
    await f.reportCloseout(v1Head);
    assert.equal(f.current().phase, 'done', f.current().reason);
    assert.equal(f.store.outcome(f.taskId)!.closeout?.authority, 'agent');
  } finally { await f.close(); }
});

test('5b. invalid queue-plus-closeout-hook manifest holds closeout and writes no outcome', async t => {
  const f = await closeoutFixture(t, { manifest: { schema: 'paseo.queue.control.v5', closeout: 'queue', hooks: [v4CloseoutHook()] } });
  try {
    await f.engine.wake();
    assert.equal(f.current().phase, 'closing');
    assert.match(f.current().reason, /task\.closeout|queue/);
    assert.equal(f.creates.length, 0);
    assert.equal(f.store.outcome(f.taskId), null);
  } finally { await f.close(); }
});

test('7. v5 closeout hooks is identical to the same hooks under v4', async t => {
  const f = await closeoutFixture(t, {
    manifest: v5('hooks', [v4CloseoutHook()]),
    hooks: { '.paseo/hooks/ledger': { content: ledgerScript, mode: 0o755 } },
  });
  try {
    await f.engine.wake();
    assert.equal(f.current().phase, 'done', f.current().reason);
    assert.equal(f.creates.length, 0);
    const record = f.store.hookEvents(f.taskId)[0];
    assert.equal(record.state, 'published');
    assert.equal(f.store.outcome(f.taskId)!.closeout?.authority, 'hook');
    assert.equal(f.store.outcome(f.taskId)!.closeout?.commit, record.commit);
  } finally { await f.close(); }
});

test('12. hook and agent closeouts record their authority and published commit', async t => {
  const hook = await closeoutFixture(t, {
    manifest: { schema: 'paseo.queue.control.v1', hooks: [v1Write()] },
    hooks: { '.paseo/hooks/ledger': { content: ledgerScript, mode: 0o755 } },
  });
  try {
    await hook.engine.wake();
    assert.equal(hook.current().phase, 'done', hook.current().reason);
    const hookRow = hook.store.outcome(hook.taskId)!;
    assert.equal(hookRow.closeout?.authority, 'hook');
    assert.equal(hookRow.closeout?.commit, hook.store.hookEvents(hook.taskId)[0].commit);
    assert.equal(hookRow.workers[0]?.profileId, 'worker');
    assert.equal(hookRow.reviewers[0]?.profileId, 'reviewer');
  } finally { await hook.close(); }

  const agent = await closeoutFixture(t, { withManifest: false });
  try {
    agent.store.putRepository({ origin: null, path: agent.repo }, 'agent', 'agent closeout keeps its records');
    await agent.engine.wake();
    assert.equal(agent.store.runs(agent.taskId)[0].role, 'closeout');
    await agent.reportCloseout(agent.head);
    assert.equal(agent.current().phase, 'done', agent.current().reason);
    const row = agent.store.outcome(agent.taskId)!;
    assert.equal(row.closeout?.authority, 'agent');
    assert.equal(row.closeout?.commit, agent.head);
  } finally { await agent.close(); }
});
