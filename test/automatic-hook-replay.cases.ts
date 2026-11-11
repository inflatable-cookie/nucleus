import { configuredClone, materializeSeed } from './support/git-seed';
import { fakeAdapter } from './support/fakes';
import { test, weighted } from './support/sharded-test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { git, command } from '../core/git/index';
import { RepositoryHooks, blobDigest, isStaleIntegrationBaseRefusal } from '../core/hooks/hooks';
import { hookRecordSchema, type HookRecord } from '../shared/hooks';
import { submissionSchema, runSchema, type Task } from '../shared/contracts';
import { telemetrySnapshot } from '../core/telemetry/telemetry';
import type { Adapter } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';

async function makeRepo(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-replay-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await materializeSeed(configuredClone, root);
  const repo = join(root, 'repo');
  return { root, repo };
}

async function commit(repo: string, message: string, files: Record<string, { content: string; mode?: number }> = {}) {
  for (const [path, spec] of Object.entries(files)) {
    const full = join(repo, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, spec.content);
    if (spec.mode) await chmod(full, spec.mode);
  }
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

async function storeFor(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'nsq-replaystore-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { store: new Store(join(dir, 'queue.sqlite')), path: join(dir, 'queue.sqlite') };
}

function taskFor(store: Store, repo: string, title = 'Replay task'): Task {
  return store.insert(submissionSchema.parse({ submissionId: randomUUID(), title, repoPath: repo, planningCommit: 'a'.repeat(40), handoffPath: 'docs/plan.json', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
}

function integrationManifest(event: 'task.blocked' | 'task.closeout' | 'task.cancelled', allowedPaths: string[]) {
  return JSON.stringify({
    schema: 'paseo.queue.control.v1',
    hooks: [{ id: 'ledger', events: [event], mode: 'integration_write', delivery: 'required', executable: '.paseo/hooks/ledger', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths, commitSubject: { prefix: `queue: ${event}`, maxBytes: 80 } }],
  }, null, 2);
}

/** An integration write that records the delivered base and publishes one declared path. */
function ledgerScript(ledgerPath: string, target: string) {
  return `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify({eventId:event.eventId,attempt:event.attempt,baseCommit:event.repository.baseCommit,root:event.repository.root})+'\\n');
fs.mkdirSync(path.dirname(${JSON.stringify(target)}),{recursive:true});
fs.writeFileSync(${JSON.stringify(target)},JSON.stringify({eventId:event.eventId}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'ledger written',metadata:{},changedPaths:[${JSON.stringify(target)}],commitSubjectSuffix:'ledger'}));});
`;
}

const readJsonl = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

/** One repository, one sibling publisher, one durable store and the Queue hook surface. */
async function replayFixture(t: any, options: { event?: 'task.blocked' | 'task.closeout' | 'task.cancelled'; target?: string; script?: (ledger: string) => string } = {}) {
  const event = options.event ?? 'task.blocked';
  const target = options.target ?? 'docs/replayed.json';
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'ledger.jsonl');
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: integrationManifest(event, [target]) },
    '.paseo/hooks/ledger': { content: (options.script ?? (path => ledgerScript(path, target)))(ledger), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await git(repo, 'push', 'origin', 'main');
  const sibling = join(root, 'sibling');
  await command('git', ['clone', join(root, 'origin.git'), sibling], root);
  await git(sibling, 'config', 'user.name', 'Queue test');
  await git(sibling, 'config', 'user.email', 'queue@example.invalid');
  const { store, path } = await storeFor(t);
  const hooks = new RepositoryHooks(store);
  /** Publish one unrelated commit from the sibling so the canonical checkout falls behind. */
  const advanceRemote = async (label: string) => {
    await git(sibling, 'pull', '--ff-only', 'origin', 'main').catch(() => {});
    const commitSha = await commit(sibling, label, { [`docs/${label}.json`]: { content: '{}' } });
    await git(sibling, 'push', 'origin', 'main');
    return commitSha;
  };
  const syncLocal = () => git(repo, 'pull', '--ff-only', 'origin', 'main');
  const localHead = () => git(repo, 'rev-parse', 'HEAD');
  return { root, repo, sibling, ledger, head, store, path, hooks, advanceRemote, syncLocal, localHead };
}

/** A task whose current resolution run reported a worker-side blocker. */
function blockedTask(store: Store, repo: string, runId = 'run-1') {
  const task = taskFor(store, repo);
  store.putRun(runSchema.parse({
    id: runId, taskId: task.id, role: 'reviewer', generation: 1, head: '6'.repeat(40), base: '7'.repeat(40),
    agentId: 'reviewer', workspaceId: 'task-ws', profile: null, status: 'running',
    createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, released: false,
    completion: { eventId: `${runId}-event`, taskId: task.id, runId, status: 'blocked', summary: 'reviewer blocked on the integration base' },
  }));
  return store.update(task.id, { phase: 'reviewing', workspaceId: 'task-ws', directory: repo, agentId: 'worker', runId: 'initial', resolution: { ...task.resolution, currentRunId: runId } });
}

const emitBlocked = (hooks: RepositoryHooks, store: Store, task: Task) =>
  hooks.emit('task.blocked', store.task(task.id), { event: 'task.blocked', summary: 'reviewer blocked on the integration base' });

weighted(3)('a stale required integration-base occurrence replays automatically with durable lineage', async t => {
  const f = await replayFixture(t);
  try {
    const task = blockedTask(f.store, f.repo);
    const staleBase = await f.advanceRemote('first');
    const first = await emitBlocked(f.hooks, f.store, task);
    assert.equal(first.hold, true, first.records[0].error);
    const old = first.records[0];
    assert.equal(old.state, 'blocked');
    assert.equal(old.baseCommit, f.head);
    assert.match(old.error, /clean synchronized base/);
    assert.equal(old.commit, null);
    assert.equal(old.result, null);
    assert.equal(existsSync(f.ledger), false, 'the stale occurrence never ran the hook');

    await f.syncLocal();
    const replayed = await emitBlocked(f.hooks, f.store, task);
    assert.equal(replayed.hold, false, replayed.records[0].error);
    const fresh = replayed.records[0];
    assert.equal(fresh.state, 'published');
    assert.equal(fresh.baseCommit, staleBase);
    assert.equal(fresh.occurrence, 2, 'exactly one fresh occurrence is minted');
    assert.equal(fresh.attempt, 1);
    assert.notEqual(fresh.eventId, old.eventId, 'the fresh occurrence keeps its own identity');
    assert.ok(fresh.replay, 'the replay lineage is persisted');
    assert.equal(fresh.replay!.ordinal, 1);
    assert.equal(fresh.replay!.fromEventId, old.eventId);
    assert.equal(fresh.replay!.fromOccurrence, 1);
    assert.equal(fresh.replay!.baseCommit, staleBase);

    const records = f.store.hookEvents(task.id);
    assert.equal(records.length, 2, 'the stale occurrence stays immutable audit evidence');
    assert.equal(records[0].state, 'failed');
    assert.match(records[0].summary, /Superseded before publication after the integration base advanced/);
    assert.equal(records[0].eventId, old.eventId);
    assert.equal(records[0].occurrence, 1);
    assert.ok(f.store.eventsAll(task.id).some(event => event.kind === 'hook_automatic_replay_intent'));
    assert.ok(f.store.eventsAll(task.id).some(event => event.kind === 'hook_automatic_replay'));
    assert.ok(f.store.eventsAll(task.id).some(event => event.kind === 'hook_occurrence_superseded'));
    const lines = await readJsonl(f.ledger);
    assert.equal(lines.length, 1, 'the hook executed exactly once, on the fresh occurrence');
    assert.equal(lines[0].baseCommit, staleBase);
    assert.equal(await f.localHead(), fresh.commit, 'the published integration commit is synchronized');
    assert.equal(await git(f.repo, 'rev-parse', 'refs/remotes/origin/main'), fresh.commit);
  } finally { f.store.close(); }
});

weighted(11)('automatic replay is attributed separately from retries and holds', async t => {
  const f = await replayFixture(t);
  try {
    const task = blockedTask(f.store, f.repo);
    await f.advanceRemote('metric');
    await emitBlocked(f.hooks, f.store, task);
    await f.syncLocal();
    await emitBlocked(f.hooks, f.store, task);
    const snapshot = telemetrySnapshot(f.store, { window: 'all', groupBy: 'none' }, new Date());
    assert.equal(snapshot.matchingTasks, 1);
    const telemetry = snapshot.groups[0];
    assert.equal(telemetry.interventions.automaticHookReplays, 1);
    assert.equal(telemetry.interventions.hookRetries, 0, 'an automatic replay is not an operator retry');
    assert.equal(telemetry.interventions.recoveryRuns, 0, 'an automatic replay is not coordinator recovery');
  } finally { f.store.close(); }
});

weighted(2)('a semantic refusal is never replayed as an operational race', async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'semantic.jsonl');
  const refusal = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({eventId:event.eventId})+'\\n');
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'blocked',summary:'roadmap reference missing',metadata:{},changedPaths:[],commitSubjectSuffix:null}));});
`;
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: integrationManifest('task.blocked', ['docs/replayed.json']) },
    '.paseo/hooks/ledger': { content: refusal, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await git(repo, 'push', 'origin', 'main');
  const { store } = await storeFor(t);
  try {
    const task = blockedTask(store, repo);
    const first = await new RepositoryHooks(store).emit('task.blocked', store.task(task.id), { event: 'task.blocked', summary: 'blocks' });
    assert.equal(first.hold, true);
    assert.equal(first.records[0].state, 'blocked');
    assert.equal(first.records[0].result?.outcome, 'blocked', 'a well-formed refusal is durable evidence');
    assert.equal(first.records[0].replayIntent, null);
    // Even after a clean base advance the semantic refusal keeps its hold.
    await commit(repo, 'advance', { 'docs/after.json': { content: '{}' } });
    await git(repo, 'push', 'origin', 'main');
    const replayed = await new RepositoryHooks(store).emit('task.blocked', store.task(task.id), { event: 'task.blocked', summary: 'blocks' });
    assert.equal(replayed.hold, true, 'a semantic refusal is never an automatic replay');
    assert.equal(store.hookEvents(task.id).length, 1);
    assert.equal(store.hookEvents(task.id)[0].eventId, first.records[0].eventId);
    assert.equal((await readJsonl(ledger)).length, 1, 'the hook never re-ran');
    assert.equal(await git(repo, 'rev-parse', 'HEAD'), await git(repo, 'rev-parse', 'refs/remotes/origin/main'));
    assert.equal(head, first.records[0].baseCommit);
  } finally { store.close(); }
});

test('a changed executable refuses the automatic proof and keeps the held occurrence', async t => {
  const f = await replayFixture(t);
  try {
    const task = blockedTask(f.store, f.repo);
    await f.advanceRemote('identity');
    const first = await emitBlocked(f.hooks, f.store, task);
    assert.equal(first.hold, true);
    // Synchronize the canonical base, then change the hook program on top of it.
    await f.syncLocal();
    const before = await f.localHead();
    await commit(f.repo, 'change the hook program', { '.paseo/hooks/ledger': { content: `${ledgerScript(f.ledger, 'docs/replayed.json')}\n`, mode: 0o755 } });
    assert.notEqual(await f.localHead(), before);
    await git(f.repo, 'push', 'origin', 'main');
    const replayed = await emitBlocked(f.hooks, f.store, task);
    assert.equal(replayed.hold, true, 'a changed executable refuses the automatic proof');
    assert.equal(replayed.records[0].eventId, first.records[0].eventId, 'the held occurrence is reused');
    assert.equal(f.store.hookEvents(task.id).length, 1);
    assert.equal(f.store.hookEvents(task.id)[0].replayIntent, null);
    assert.equal(existsSync(f.ledger), false, 'the hook never executes against changed semantics');
  } finally { f.store.close(); }
});

test('a changed instruction or reviewed head refuses the automatic proof', async t => {
  const f = await replayFixture(t);
  try {
    const instruction = { path: 'docs/plan.json', commit: f.head, digest: blobDigest(Buffer.from('{}')), mediaType: 'application/json' };
    const task = blockedTask(f.store, f.repo);
    const pinned = f.store.update(task.id, { instruction });
    await f.advanceRemote('instruction');
    const first = await emitBlocked(f.hooks, f.store, pinned);
    assert.equal(first.hold, true);
    await f.syncLocal();
    const changed = f.store.update(task.id, { instruction: { ...instruction, digest: `sha256:${'b'.repeat(64)}` } });
    const replayed = await emitBlocked(f.hooks, f.store, changed);
    assert.equal(replayed.hold, true, 'a changed submitted instruction refuses the automatic proof');
    assert.equal(f.store.hookEvents(task.id).length, 1);
    assert.equal(existsSync(f.ledger), false);
  } finally { f.store.close(); }
});

weighted(2)('dirty and uncertain state keeps the hold instead of replaying', async t => {
  // A dirty canonical checkout cannot be a clean synchronized base.
  {
    const f = await replayFixture(t);
    try {
      const task = blockedTask(f.store, f.repo);
      await f.advanceRemote('dirty');
      await emitBlocked(f.hooks, f.store, task);
      await f.syncLocal();
      await writeFile(join(f.repo, 'docs/plan.json'), '{"dirty":true}');
      const replayed = await emitBlocked(f.hooks, f.store, task);
      assert.equal(replayed.hold, true, 'dirty state keeps the hold');
      assert.equal(f.store.hookEvents(task.id).length, 1);
      assert.equal(existsSync(f.ledger), false);
    } finally { f.store.close(); }
  }
  // An occurrence that reported uncertainty is not an operational race.
  {
    const f = await replayFixture(t);
    try {
      const task = blockedTask(f.store, f.repo);
      await f.advanceRemote('uncertain');
      const first = await emitBlocked(f.hooks, f.store, task);
      const old = first.records[0];
      f.store.putHookEvent(hookRecordSchema.parse({ ...old, state: 'uncertain', error: 'Isolated checkout creation requires reconciliation', summary: 'Isolated checkout creation requires reconciliation' }));
      await f.syncLocal();
      const replayed = await emitBlocked(f.hooks, f.store, task);
      assert.equal(replayed.hold, true);
      assert.equal(f.store.hookEvents(task.id).length, 1);
      assert.equal(existsSync(f.ledger), false);
    } finally { f.store.close(); }
  }
});

weighted(7)('a worker-blocked integration-base hold replays through the same exact proof', async t => {
  const f = await replayFixture(t);
  try {
    const task = taskFor(f.store, f.repo);
    const blocked = f.store.update(task.id, {
      phase: 'working', workspaceId: 'task-ws', directory: f.repo, agentId: 'worker', runId: 'initial',
      completion: { eventId: 'worker-blocked', taskId: task.id, runId: 'initial', status: 'blocked', summary: 'worker blocked on the integration base' },
    });
    const staleBase = await f.advanceRemote('worker-blocked');
    const first = await emitBlocked(f.hooks, f.store, blocked);
    assert.equal(first.hold, true, first.records[0].error);
    assert.equal(f.hooks.automaticReplayAvailable(f.store.task(task.id)), true, 'the worker blocked result keeps the occurrence applicable');
    await f.syncLocal();
    const replayed = await emitBlocked(f.hooks, f.store, task);
    assert.equal(replayed.hold, false, replayed.records[0].error);
    assert.equal(replayed.records[0].state, 'published');
    assert.equal(replayed.records[0].baseCommit, staleBase);
    assert.equal(replayed.records[0].replay!.ordinal, 1);
    assert.equal((await readJsonl(f.ledger)).length, 1);
  } finally { f.store.close(); }
});

weighted(8)('a refused proof at an unchanged base is not re-proved until the base moves', async t => {
  const f = await replayFixture(t);
  try {
    const task = blockedTask(f.store, f.repo);
    await f.advanceRemote('retry');
    await emitBlocked(f.hooks, f.store, task);
    await f.syncLocal();
    await writeFile(join(f.repo, 'docs/plan.json'), '{"dirty":true}');
    assert.equal(await f.hooks.automaticReplayAttemptDue(f.store.task(task.id)), true);
    await emitBlocked(f.hooks, f.store, task);
    assert.equal(await f.hooks.automaticReplayAttemptDue(f.store.task(task.id)), false, 'the refused base is not re-proved at once');
    assert.equal(f.store.hookEvents(task.id).length, 1);
    // Cleaning a transient state without moving the base keeps the retry bounded.
    await git(f.repo, 'checkout', '--', 'docs/plan.json');
    assert.equal(await f.hooks.automaticReplayAttemptDue(f.store.task(task.id)), false);
    // A repaired base reopens the automatic path immediately.
    await f.advanceRemote('retry-two');
    await f.syncLocal();
    assert.equal(await f.hooks.automaticReplayAttemptDue(f.store.task(task.id)), true);
    const replayed = await emitBlocked(f.hooks, f.store, task);
    assert.equal(replayed.hold, false, replayed.records[0].error);
    assert.equal(replayed.records[0].state, 'published');
    assert.equal(replayed.records[0].replay!.ordinal, 1);
    assert.equal((await readJsonl(f.ledger)).length, 1);
  } finally { f.store.close(); }
});

weighted(12)('a persisted replay intent survives a restart without minting a second occurrence', async t => {
  const f = await replayFixture(t);
  let reopened: Store | undefined;
  try {
    const task = blockedTask(f.store, f.repo);
    const advanced = await f.advanceRemote('restart');
    const first = await emitBlocked(f.hooks, f.store, task);
    assert.equal(first.hold, true);
    const old: HookRecord = first.records[0];
    await f.syncLocal();
    // A crash after the durable intent and before the fresh occurrence: the same
    // intent must resume as the same occurrence and ordinal.
    f.store.putHookEvent(hookRecordSchema.parse({ ...old, replayIntent: { automatic: true, ordinal: 1, baseCommit: advanced, at: new Date().toISOString() } }));
    f.store.event(task.id, 'hook_automatic_replay_intent', `${old.hookId} ${old.event} ${old.eventId}: automatic replay 1/2 at ${advanced}`);
    f.store.close();
    reopened = new Store(f.path);
    const resumed = await new RepositoryHooks(reopened).emit('task.blocked', reopened.task(task.id), { event: 'task.blocked', summary: 'reviewer blocked on the integration base' });
    assert.equal(resumed.hold, false, resumed.records[0].error);
    const records = reopened.hookEvents(task.id);
    assert.equal(records.length, 2, 'restart mints exactly one fresh occurrence');
    assert.equal(records[1].occurrence, 2);
    assert.equal(records[1].replay!.ordinal, 1, 'the persisted intent keeps its ordinal');
    assert.equal((await readJsonl(f.ledger)).length, 1, 'restart executes the hook once');
  } finally { reopened?.close(); if (!reopened) f.store.close(); }
});

weighted(14)('concurrent held occurrences in one repository serialize without duplicate publication', async t => {
  const f = await replayFixture(t);
  try {
    const first = blockedTask(f.store, f.repo, 'run-1');
    const second = blockedTask(f.store, f.repo, 'run-2');
    await f.advanceRemote('concurrent');
    const held = await Promise.all([emitBlocked(f.hooks, f.store, first), emitBlocked(f.hooks, f.store, second)]);
    assert.equal(held[0].hold, true);
    assert.equal(held[1].hold, true);
    await f.syncLocal();
    // One task may observe the other publication inside its proof and resume on
    // the next pass; either way it never mints a duplicate occurrence.
    for (let round = 0; round < 3; round++) {
      for (const task of [first, second]) {
        const latest = f.store.hookEvents(task.id).at(-1)!;
        if (latest.state === 'blocked') await emitBlocked(f.hooks, f.store, task);
      }
    }
    for (const task of [first, second]) {
      const records = f.store.hookEvents(task.id);
      assert.equal(records.length, 2, `${task.id}: one superseded and one fresh occurrence`);
      assert.equal(records.filter(record => record.replay).length, 1, `${task.id}: exactly one automatic replay`);
      assert.equal(records.filter(record => record.state === 'published').length, 1);
    }
    const lines = await readJsonl(f.ledger);
    assert.equal(lines.length, 2, 'each task executed its hook exactly once');
    const remote = (await git(f.repo, 'rev-parse', 'refs/remotes/origin/main')).trim();
    assert.equal((await f.localHead()).trim(), remote, 'the canonical checkout is synchronized');
    for (const record of f.store.hookEvents()) {
      if (!record.commit) continue;
      assert.equal((await git(f.repo, 'merge-base', '--is-ancestor', record.commit, remote)).trim(), '', `commit ${record.commit} is on main`);
    }
  } finally { f.store.close(); }
});

/* ---------------------------------------------------------------------- */
/* Engine-level proofs: the automatic replay resolves a hold before any    */
/* recovery coordinator is created for it.                                 */
/* ---------------------------------------------------------------------- */

const worker = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
const coordinator = { id: 'coordinator', name: 'Coordinator', provider: 'test', model: 'coordinator', notes: '', available: true, problem: '', supportedThinking: [] };

async function engineFixture(t: any, options: { event: 'task.blocked' | 'task.closeout'; coordinatorRecovery?: boolean; blockedSource?: 'run' | 'worker' }) {
  const event = options.event;
  const target = event === 'task.closeout' ? 'docs/ledger.json' : 'docs/replayed.json';
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'engine-ledger.jsonl');
  const older = await commit(repo, 'older', {
    '.paseo/queue.json': { content: integrationManifest(event, [target]) },
    '.paseo/hooks/ledger': { content: ledgerScript(ledger, target), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  const head = await commit(repo, 'base', { 'docs/marker.json': { content: '{}' } });
  await git(repo, 'push', 'origin', 'main');
  const sibling = join(root, 'sibling');
  await command('git', ['clone', join(root, 'origin.git'), sibling], root);
  await git(sibling, 'config', 'user.name', 'Queue test');
  await git(sibling, 'config', 'user.email', 'queue@example.invalid');
  const { store } = await storeFor(t);
  store.setMeta('paused', false);
  store.setMeta('lastRetentionAt', Date.now());
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = taskFor(store, repo, 'Automatic replay');
  const task = store.update(submitted.id, {
    phase: event === 'task.closeout' ? 'closing' : 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'task-ws', directory: repo,
    agentId: 'worker', runId: 'initial', profile: worker,
    prUrl: 'https://github.com/example/repo/pull/7', prHead: '6'.repeat(40), resumePrNumber: 7,
    resolution: {
      ...submitted.resolution, coordinatorWorkspaceId: 'task-ws', integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
      review: { eventId: 'review', taskId: submitted.id, runId: 'review-run', status: 'ready_to_merge', summary: 'independent review accepted the exact head', head: '6'.repeat(40), reviewCommentId: 7 },
      mergedCommit: head, syncedCommit: older, mergeHead: '6'.repeat(40), mergeBase: '7'.repeat(40),
    },
  });
  if (event === 'task.blocked' && options.blockedSource !== 'worker') {
    store.putRun(runSchema.parse({
      id: 'run-1', taskId: task.id, role: 'reviewer', generation: 1, head: '6'.repeat(40), base: '7'.repeat(40),
      agentId: 'reviewer', workspaceId: 'task-ws', profile: null, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, released: false,
      completion: { eventId: 'blocked', taskId: task.id, runId: 'run-1', status: 'blocked', summary: 'reviewer blocked on the integration base' },
    }));
    store.update(task.id, { resolution: { ...store.task(task.id).resolution, currentRunId: 'run-1' } });
  }
  if (event === 'task.blocked' && options.blockedSource === 'worker') {
    store.update(task.id, { phase: 'working', completion: { eventId: 'worker-blocked', taskId: task.id, runId: 'initial', status: 'blocked', summary: 'worker blocked on the integration base' } });
  }
  const states = new Map<string, { id: string; workspaceId: string; status: string; active: boolean; permissions: boolean; error: string }>();
  for (const id of ['worker', 'reviewer', 'coordinator']) states.set(id, { id, workspaceId: 'task-ws', status: 'idle', active: false, permissions: false, error: '' });
  const tokens = new Map<string, string>(), creates: { role: string }[] = [];
  const adapter: Adapter & ResolutionAdapter = fakeAdapter({
    profiles: async () => [worker, coordinator], validate: async () => head, verifyWorkspace: async () => 'main',
    createWorkspace: async () => { throw new Error('No workspace dispatch expected'); },
    createAgent: async () => { throw new Error('No worker dispatch expected'); },
    observe: async (id: string) => { const state = states.get(id); if (!state) throw new Error('Agent was not found'); return state; },
    verifyPr: async () => ({ head: '6'.repeat(40), url: 'https://github.com/example/repo/pull/7' }),
    createRun: async (_t, run, token) => {
      creates.push({ role: run.role }); tokens.set(run.id, token);
      const id = `agent-${run.id}`; states.set(id, { id, workspaceId: run.workspaceId, status: 'running', active: true, permissions: false, error: '' });
      return { id, workspaceId: run.workspaceId };
    },
    sendRun: async (_t, run, token) => { tokens.set(run.id, token); states.set(run.agentId!, { id: run.agentId!, workspaceId: run.workspaceId, status: 'running', active: true, permissions: false, error: '' }); },
    findRunAgents: async () => [], verifyReview: async () => {},
    mergeGate: async () => ({ head: '6'.repeat(40), base: '7'.repeat(40), wait: '' }), merge: async () => {},
    merged: async () => ({ merged: true, commit: head, head: '6'.repeat(40), base: 'main' }), syncMain: async () => head,
    verifyCloseout: async () => undefined, notify: async () => {}, supportsCoordinatorRecovery: options.coordinatorRecovery ?? false,
  });
  const engine = new Engine(store, adapter, 60_000);
  engine.profiles = [worker, coordinator];
  const advanceRemote = async (label: string) => {
    await git(sibling, 'pull', '--ff-only', 'origin', 'main').catch(() => {});
    const sha = await commit(sibling, label, { [`docs/${label}.json`]: { content: '{}' } });
    await git(sibling, 'push', 'origin', 'main');
    return sha;
  };
  return {
    root, repo, ledger, older, head, store, engine, adapter, taskId: task.id, states, creates,
    current: () => store.task(task.id), localHead: () => git(repo, 'rev-parse', 'HEAD'),
    syncLocal: () => git(repo, 'pull', '--ff-only', 'origin', 'main'), advanceRemote,
    close: async () => { await engine.stop(); store.close(); },
  };
}

/**
 * First task quantum, then drop its accepted follow-up. `wake()` waits through
 * follow-ups, so a test that must mutate Git or inspect a hold uses this pause
 * fence instead of the old zero-lane gap. Unpause and `wake()` to continue.
 */
async function pauseAfterFirstQuantum(f: { engine: Engine; store: Store; taskId: string }) {
  await f.engine.wakeTask(f.taskId);
  f.store.setMeta('paused', true);
  await f.engine.quiesce();
}

async function resumeWake(f: { engine: Engine; store: Store }) {
  f.store.setMeta('paused', false);
  await f.engine.wake();
}

weighted(4)('a held closeout base race replays automatically and closes out without a fallback agent', async t => {
  const f = await engineFixture(t, { event: 'task.closeout' });
  try {
    await pauseAfterFirstQuantum(f);
    // A moved base is operational staleness, so the task refreshes itself instead of
    // parking for an operator. A hook's own refusal still parks: see the semantic
    // refusal fixtures below.
    const refreshed = f.current();
    assert.equal(refreshed.phase, 'syncing', `expected an automatic refresh, saw ${refreshed.phase}: ${refreshed.reason}`);
    assert.equal(refreshed.resolution.attention, false, 'a base race is not an operator matter');
    assert.equal(f.creates.length, 0, 'a held closeout authority never launches the fallback agent');
    // Origin moves while the first refresh is fenced. `wake()` then completes
    // through the follow-up: sync the repaired base and publish one replay.
    const repaired = await f.advanceRemote('closeout-repair');
    f.adapter.syncMain = async () => { await f.syncLocal(); return f.localHead(); };
    await resumeWake(f);
    const done = f.current();
    assert.equal(done.phase, 'done', done.reason);
    const records = f.store.hookEvents(f.taskId);
    assert.equal(records.length, 2, 'the stale occurrence is superseded by the published replay at the repaired base');
    assert.equal(records[0].state, 'failed');
    assert.equal(records[0].baseCommit, f.older);
    assert.equal(records[0].result, null);
    assert.equal(records[0].replay, null);
    assert.equal(records[1].state, 'published');
    assert.equal(records[1].replay!.ordinal, 1);
    assert.equal(records[1].baseCommit, repaired);
    assert.equal(done.resolution.syncedCommit, records[1].commit);
    assert.equal(f.creates.length, 0, 'no closeout agent is created');
    assert.equal((await readJsonl(f.ledger)).length, 1, 'the authoritative hook ran exactly once');
    const telemetry = telemetrySnapshot(f.store, { window: 'all', groupBy: 'none' }, new Date()).groups[0];
    assert.equal(telemetry.interventions.automaticHookReplays, 1, 'the repaired-base replay is counted');
    await f.engine.wake();
    assert.equal(f.store.hookEvents(f.taskId).length, 2, 'a later pass does not renew again');
  } finally { await f.close(); }
});

weighted(4)('a closeout base advance refuses changed inputs without replacing the held occurrence', async t => {
  for (const change of ['instruction', 'program', 'manifest'] as const) {
    await t.test(change, async t => {
      const f = await engineFixture(t, { event: 'task.closeout' });
      try {
        await pauseAfterFirstQuantum(f);
        const held = f.store.hookEvents(f.taskId)[0];
        if (change === 'instruction') {
          const task = f.current();
          f.store.update(f.taskId, { instruction: { path: 'docs/plan.json', commit: f.head, digest: blobDigest(Buffer.from('changed')), mediaType: 'application/json' } });
          assert.equal(task.instruction, null);
        } else if (change === 'program') {
          await commit(f.repo, 'change hook program', { '.paseo/hooks/ledger': { content: `${ledgerScript(f.ledger, 'docs/ledger.json')}\n`, mode: 0o755 } });
          await git(f.repo, 'push', 'origin', 'main');
        } else {
          await commit(f.repo, 'change manifest semantics', { '.paseo/queue.json': { content: integrationManifest('task.closeout', ['docs/ledger.json', 'docs/another.json']) } });
          await git(f.repo, 'push', 'origin', 'main');
        }
        if (change === 'instruction') { await f.advanceRemote('instruction-change'); await f.syncLocal(); }
        await resumeWake(f);
        const records = f.store.hookEvents(f.taskId);
        assert.equal(records.length, 1, `${change}: no replacement occurrence`);
        assert.deepEqual(records[0], held, `${change}: held evidence stays unchanged`);
        assert.equal(f.current().phase, 'closing');
        assert.equal(existsSync(f.ledger), false);
      } finally { await f.close(); }
    });
  }
});

weighted(3)('a closeout replay refuses divergence, publication effects and a matching commit', async t => {
  for (const caseName of ['diverged base', 'publication boundary', 'existing event commit'] as const) {
    await t.test(caseName, async t => {
      const f = await engineFixture(t, { event: 'task.closeout' });
      try {
        await pauseAfterFirstQuantum(f);
        const held = f.store.hookEvents(f.taskId)[0];
        if (caseName === 'diverged base') {
          await git(f.repo, 'checkout', '--orphan', 'fixture-divergence');
          await git(f.repo, 'rm', '-rf', '.');
          const divergent = await commit(f.repo, 'unrelated root', { 'docs/diverged.json': { content: '{}' } });
          await git(f.repo, 'checkout', 'main');
          await git(f.repo, 'reset', '--hard', divergent);
        } else if (caseName === 'publication boundary') {
          f.store.putHookEvent(hookRecordSchema.parse({ ...held, commit: f.head }));
        } else {
          await git(f.repo, 'commit', '--allow-empty', '-m', 'event already carried', '-m', `Northstar-Queue-Hook: ${held.eventId}\nNorthstar-Queue-Manifest: ${held.manifest.path}@${held.manifest.digest}`);
          await git(f.repo, 'push', 'origin', 'main');
        }
        const before = f.store.hookEvents(f.taskId)[0];
        await resumeWake(f);
        assert.deepEqual(f.store.hookEvents(f.taskId), [before], `${caseName}: no occurrence mutation`);
        assert.equal(f.current().phase, 'closing');
        assert.equal(existsSync(f.ledger), false);
      } finally { await f.close(); }
    });
  }
});

weighted(9)('a held blocked transition replays before any recovery coordinator is created', async t => {
  const f = await engineFixture(t, { event: 'task.blocked', coordinatorRecovery: true });
  try {
    const repair = await f.advanceRemote('blocked-repair');
    await f.engine.wake();
    const held = f.current();
    assert.equal(held.resolution.attention, true, held.reason);
    assert.equal(f.store.runs(f.taskId).filter(run => run.role === 'recovery').length, 0, 'the automatic window defers coordinator recovery');
    assert.equal(f.creates.length, 0);
    await f.syncLocal();
    await f.engine.wake();
    const records = f.store.hookEvents(f.taskId);
    assert.equal(records.length, 2);
    assert.equal(records[1].state, 'published');
    assert.equal(records[1].baseCommit, repair);
    assert.equal(records[1].replay!.ordinal, 1);
    assert.equal((await readJsonl(f.ledger)).length, 1);
    // The hold itself never spent a coordinator: the replay resolved it first.
    const events = f.store.eventsAll(f.taskId);
    const resolvedAt = events.findIndex(event => event.kind === 'hook_replay_resolved');
    assert.ok(resolvedAt >= 0, 'the resolved hold closes its attention episode');
    assert.equal(events.slice(0, resolvedAt).some(event => event.kind === 'telemetry_recovery'), false, 'no coordinator was engaged for the hook hold');
    const resolved = f.current();
    assert.equal(resolved.phase, 'blocked', resolved.reason);
    assert.equal(resolved.resolution.attention, false);
  } finally { await f.close(); }
});

weighted(5)('a worker-blocked hold replays automatically before a coordinator is engaged', async t => {
  const f = await engineFixture(t, { event: 'task.blocked', blockedSource: 'worker', coordinatorRecovery: true });
  try {
    const repair = await f.advanceRemote('worker-blocked-repair');
    await f.engine.wake();
    const held = f.current();
    assert.equal(held.phase, 'needs_attention', held.reason);
    assert.match(held.reason, /Repository hook/);
    assert.equal(f.store.runs(f.taskId).filter(run => run.role === 'recovery').length, 0, 'the automatic window defers coordinator recovery');
    await f.syncLocal();
    await f.engine.wake();
    const records = f.store.hookEvents(f.taskId);
    assert.equal(records.length, 2);
    assert.equal(records[1].state, 'published');
    assert.equal(records[1].baseCommit, repair);
    assert.equal(records[1].replay!.ordinal, 1);
    assert.equal((await readJsonl(f.ledger)).length, 1);
    const events = f.store.eventsAll(f.taskId);
    const resolvedAt = events.findIndex(event => event.kind === 'hook_replay_resolved');
    assert.ok(resolvedAt >= 0, 'the resolved hold closes its attention episode');
    assert.equal(events.slice(0, resolvedAt).some(event => event.kind === 'telemetry_recovery'), false, 'no coordinator was engaged for the hook hold');
    assert.equal(f.current().phase, 'blocked', f.current().reason);
    assert.equal(f.current().resolution.attention, false);
  } finally { await f.close(); }
});

weighted(19)('two exact replays are allowed and a third movement enters normal bounded recovery', async t => {
  const f = await engineFixture(t, { event: 'task.blocked', coordinatorRecovery: true });
  try {
    const arm = async (runId: string, label: string) => {
      f.store.putRun(runSchema.parse({
        id: runId, taskId: f.taskId, role: 'closeout', generation: 1, head: '6'.repeat(40), base: '7'.repeat(40),
        agentId: 'coordinator', workspaceId: 'task-ws', profile: null, status: 'running', createdAt: new Date().toISOString(),
        lastObservedAt: null, active: false, idleSince: null, released: false,
        completion: { eventId: `${runId}-event`, taskId: f.taskId, runId, status: 'blocked', summary: 'closeout blocked on the integration base' },
      }));
      const task = f.store.task(f.taskId);
      f.store.update(f.taskId, { phase: 'verifying', resolution: { ...task.resolution, currentRunId: runId, attention: false, recovery: null, recoveryActive: false, recoveryAttempts: 0 } });
      await f.advanceRemote(label);
      await f.engine.wake();
      assert.equal(f.store.hookEvents(f.taskId).at(-1)!.state, 'blocked', `${label}: the movement holds`);
      await f.syncLocal();
      await f.engine.wake();
      return f.store.hookEvents(f.taskId).at(-1)!;
    };
    const first = await arm('run-2', 'budget-one');
    assert.equal(first.state, 'published', first.error);
    assert.equal(first.replay!.ordinal, 1);
    const second = await arm('run-3', 'budget-two');
    assert.equal(second.state, 'published', second.error);
    assert.equal(second.replay!.ordinal, 2);
    // The third movement is beyond the automatic budget: the hold stays and the
    // ordinary recovery path takes over.
    f.store.putRun(runSchema.parse({
      id: 'run-4', taskId: f.taskId, role: 'closeout', generation: 1, head: '6'.repeat(40), base: '7'.repeat(40),
      agentId: 'coordinator', workspaceId: 'task-ws', profile: null, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, released: false,
      completion: { eventId: 'run-4-event', taskId: f.taskId, runId: 'run-4', status: 'blocked', summary: 'closeout blocked again' },
    }));
    const third = f.store.task(f.taskId);
    f.store.update(f.taskId, { phase: 'verifying', resolution: { ...third.resolution, currentRunId: 'run-4', attention: false, recovery: null, recoveryActive: false, recoveryAttempts: 0 } });
    await f.advanceRemote('budget-three');
    await f.engine.wake();
    const held = f.store.hookEvents(f.taskId).at(-1)!;
    assert.equal(held.state, 'blocked');
    assert.equal(held.replayIntent, null, 'a third movement records no automatic intent');
    await f.syncLocal();
    await f.engine.wake();
    await f.engine.wake();
    assert.equal(f.store.hookEvents(f.taskId).at(-1)!.state, 'blocked', 'the third movement never replays');
    assert.equal(f.store.hookEvents(f.taskId).filter(record => record.replay).length, 2, 'at most two automatic advances per logical event');
    assert.equal((await readJsonl(f.ledger)).length, 2, 'only the two budgeted replays executed the hook');
    assert.ok(f.store.runs(f.taskId).some(run => run.role === 'recovery'), 'bounded coordinator recovery replaces the exhausted automatic path');
  } finally { await f.close(); }
});


weighted(13)('explicit closeout retry renews a stale base with a retained failure result after repair', async t => {
  const f = await engineFixture(t, { event: 'task.closeout' });
  try {
    await pauseAfterFirstQuantum(f);
    const original = f.store.hookEvents(f.taskId)[0];
    const failure = { schema: 'paseo.queue.hook-result.v1' as const, eventId: original.eventId,
      outcome: 'failed' as const, summary: 'hook metadata exceeds 32 KiB', metadata: {}, changedPaths: [], commitSubjectSuffix: null };
    f.store.putHookEvent({ ...original, result: failure });
    const task = f.current();
    const repaired = f.store.update(task.id, { phase: 'closing', resolution: { ...task.resolution, syncedCommit: f.head, attention: true } });
    assert.equal(f.engine.hooks.heldAutomaticReplay(repaired), null, 'a prior result still disallows automatic replay');
    const plan = join(f.repo, 'docs/plan.json');
    const before = await readFile(plan, 'utf8');
    await writeFile(plan, 'operator work');
    await assert.rejects(() => f.engine.hooks.retry(repaired, original.id), /clean|dirty|synchronized|tracked or untracked changes/i);
    assert.equal(f.store.hookEvents(task.id).length, 1);
    await writeFile(plan, before);
    const outcome = await f.engine.hooks.retry(repaired, original.id);
    assert.equal(outcome.hold, false, JSON.stringify(outcome.records.map(r => r.error)));
    const records = f.store.hookEvents(task.id);
    assert.equal(records.length, 2);
    assert.equal(records[0].state, 'failed');
    assert.deepEqual(records[0].result, failure, 'the old failure remains evidence');
    assert.equal(records[1].baseCommit, f.head);
    assert.equal(records[1].state, 'published');
    assert.equal(records[1].replay, null, 'operator recovery does not replenish automatic retry budget');
    await f.engine.hooks.retry(f.current(), records[1].id);
    assert.equal((await readJsonl(f.ledger)).length, 1, 'a settled retry never republishes');
  } finally { await f.close(); }
});


test('a merged closeout can resynchronize while worker capacity is full', async t => {
  const f = await engineFixture(t, { event: 'task.closeout' });
  try {
    await pauseAfterFirstQuantum(f);
    const task = f.current();
    const held = f.store.update(task.id, { phase: 'closing', workspaceIntent: false,
      reason: 'Repository hook ledger task.closeout holds this transition: stale integration base',
      resolution: { ...task.resolution, attention: true } });
    const other = taskFor(f.store, f.repo, 'Retained worker');
    f.store.update(other.id, { phase: 'working', workspaceIntent: true, workspaceId: 'other-workspace', agentIntent: true, agentId: 'other-worker' });
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1);
    f.store.setMeta('paused', false);
    const result = await f.engine.performTaskControl({ taskId: held.id, version: held.version, action: 'restart', reason: 'Owner re-runs the parked step' });
    assert.equal(result.phase, 'syncing');
    assert.equal(result.resolution.attention, false);
    assert.equal(result.workspaceIntent, false);
    assert.equal(f.creates.length, 0);
  } finally { await f.close(); }
});

test('every stale-base refusal is recognised, not only the clean-synchronized-base prefix', () => {
  // verifyCleanSynchronizedBase refuses on three conditions and only the first carries the
  // "Integration write requires a clean synchronized base:" prefix. A closeout holding on
  // "Integration HEAD moved from the event base" while an active wave moved main under it was
  // therefore neither replayed nor renewed: plain retry_hook and discard retry_hook both returned
  // it to the same hold, and the task sat at closing with nothing that would move it.
  for (const refusal of [
    'Integration write requires a clean synchronized base: local main is behind origin',
    'Integration HEAD moved from the event base',
    'Local integration base differs from origin',
  ]) assert.equal(isStaleIntegrationBaseRefusal(refusal), true, refusal);
  for (const other of [
    'Integration checkout has tracked or untracked changes',
    'Integration checkout is not on the base branch',
    'Checkout Git directory or branch does not match the event identity',
    'Metadata-free checkout is not a proven pre-execution creation failure',
    undefined, null,
  ]) assert.equal(isStaleIntegrationBaseRefusal(other), false, String(other));
});
