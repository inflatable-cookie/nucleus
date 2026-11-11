import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueRuntime } from '../service/runtime-owner';
import { captureHandoff, prepareHandoff } from '../core/planning/handoff';
import { git } from '../core/git/index';
import { operationInputHash } from '../core/store/store';
import { isUnchangedBoard, submitHandoff } from '../shared/contracts';
import type { Adapter } from '../core/host';

const sections = ['What This Thread Was Doing','Why It Matters','Current State','Boundaries','Important Context','Suggested Next Move','Completion Protocol'];
const content = `---
title: Acceptance fixture
kind: northstar-handoff
handoff_mode: worker-pr-loop
worker_mode: implementation
dispatch_authority: orchestrator
status: ready-to-launch
base_required: pushed-main
queue_dispatch: northstar-queue
queue_approval: Operator approved fixture work
queue:
  complexity: medium
---
${sections.map(s => `## ${s}\n\nCommitted instructions.\n`).join('\n')}`;
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }
async function fixture(t: any, offline = false, notify = false, lookup?: (id: string) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'queue-accept-')));
  const repo = join(dir, 'repo'), remote = join(dir, 'origin.git');
  await git(dir, 'init', '--bare', remote); await git(dir, 'clone', remote, repo);
  await git(repo, 'checkout', '-b', 'main'); await git(repo, 'config', 'user.name', 'Queue test'); await git(repo, 'config', 'user.email', 'queue@example.invalid');
  await mkdir(join(repo, 'docs/handoffs'), { recursive: true });
  const path = join(repo, 'docs/handoffs/test.md');
  const text = notify ? content.replace('queue:\n  complexity: medium', 'queue:\n  complexity: medium\n  notifyOriginOnCloseout: true') : content;
  const publish = async (next = text) => { await writeFile(path, next); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'Fixture'); await git(repo, 'push', 'origin', 'main'); };
  await publish();
  let available = !offline, lookups = 0;
  const adapter = {
    client: { isConnected: !offline }, hostId: 'fixture-host',
    socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'helper.mjs'),
    connect: async () => { if (!available) throw Error('Transport not connected'); adapter.client.isConnected = true; },
    close: async () => {}, catalog: async () => ({ providers: [] }),
    originAgent: async (id: string) => { lookups++; await lookup?.(id); return { id, workspaceId: 'origin-ws', archived: false }; },
  } as unknown as Adapter & { client: { isConnected: boolean } };
  const runtime = new QueueRuntime({ dataDir: join(dir, 'data'), adapterFactory: () => adapter, timers: false });
  t.after(async () => { await runtime.drain(); await rm(dir, { recursive: true, force: true }); });
  await runtime.started; await runtime.bootstrap; runtime.store.setMeta('paused', true);
  if (offline) {
    // Model a previously authenticated host which is now disconnected.
    const token = runtime.hostRegistry.connect('fixture-host', runtime.settings.daemonUrl, { adapter: runtime.adapter, admission: runtime.admission });
    runtime.hostRegistry.disconnect('fixture-host', token);
  }
  return { runtime, adapter, dir, repo, remote, path, publish, text,
    input: { hostId: 'fixture-host', handoffPath: path, originAgentId: 'origin', baseBranch: 'main', dryRun: false },
    online: () => { available = true; }, lookups: () => lookups };
}

test('offline handoff accepts once and survives a restart with its committed instruction', { timeout: 15000 }, async t => {
  const f = await fixture(t, true);
  const first = await f.runtime.submitHandoff(f.input);
  assert.ok('operation' in first && first.operation);
  const again = await f.runtime.submitHandoff(f.input);
  assert.ok('operation' in again && again.operation);
  assert.equal(again.operation.id, first.operation.id);
  assert.equal(first.task, null);
  assert.equal(f.runtime.store.tasks().length, 0);
  assert.equal(f.lookups(), 0);
  await f.runtime.engine.quiesce();
  assert.equal(f.runtime.store.operation(first.operation.id)?.state, 'pending');
  const pin = first.submission.instruction;
  await f.publish(f.text.replace('Committed instructions.', 'New committed instructions.'));
  // A fresh runtime reopens the exact accepted payload; it does not capture the changed handoff.
  await f.runtime.drain(); f.online();
  const restarted = new QueueRuntime({ dataDir: join(f.dir, 'data'), adapterFactory: () => f.adapter, timers: false });
  t.after(() => restarted.drain());
  await restarted.started; await restarted.bootstrap;
  const settled = await restarted.engine.awaitOperation(first.operation.id, 5000);
  assert.equal(settled.state, 'succeeded', settled.diagnostic);
  const task = restarted.store.task(settled.result!.taskId!);
  assert.deepEqual(task.instruction, pin);
  assert.equal(restarted.store.tasks().length, 1);
  assert.equal(task.phase, 'queued');
  await restarted.drain();
});

test('an accepted submission shows a submitting card on the board until its task exists', { timeout: 15000 }, async t => {
  const f = await fixture(t, true);
  const receipt = await f.runtime.submitHandoff(f.input);
  assert.ok('operation' in receipt && receipt.operation);
  await f.runtime.engine.quiesce();
  assert.equal(f.runtime.store.tasks().length, 0, 'the task does not exist yet');
  const board = f.runtime.uiSnapshot();
  assert.ok(!isUnchangedBoard(board));
  assert.equal(board.pendingSubmissions.length, 1, 'an accepted submission is never invisible');
  const card = board.pendingSubmissions[0];
  assert.equal(card.id, receipt.operation.id);
  assert.equal(card.submissionId, receipt.operation.submissionId);
  assert.equal(card.title, receipt.submission.title);
  assert.equal(card.repoPath, f.repo);
  assert.ok(['pending', 'running'].includes(card.state));
  // The card leaves the board as its task appears.
  await f.runtime.drain();
  f.online();
  const restarted = new QueueRuntime({ dataDir: join(f.dir, 'data'), adapterFactory: () => f.adapter, timers: false });
  t.after(() => restarted.drain());
  await restarted.started; await restarted.bootstrap;
  const settled = await restarted.engine.awaitOperation(receipt.operation.id, 8000);
  assert.equal(settled.state, 'succeeded', settled.diagnostic);
  assert.equal(restarted.store.tasks().length, 1);
  const after = restarted.uiSnapshot();
  assert.ok(!isUnchangedBoard(after));
  assert.deepEqual(after.pendingSubmissions, [], 'the task replaces the submitting card');
});

test('handoff receipt does not await Paseo recipient validation and validates recipients once', { timeout: 15000 }, async t => {
  const entered = gate(), release = gate();
  const f = await fixture(t, false, true, async () => { entered.open(); await release.promise; });
  const start = performance.now();
  const receipt = await f.runtime.submitHandoff(f.input);
  assert.ok('operation' in receipt && receipt.operation);
  assert.ok(performance.now() - start < 2000, 'receipt is independent of the blocked remote lookup');
  try {
    await entered.promise;
    assert.equal(f.runtime.store.tasks().length, 0);
    const duplicate = await f.runtime.submitHandoff(f.input);
    assert.ok('operation' in duplicate && duplicate.operation);
    assert.equal(duplicate.operation.id, receipt.operation.id);
  } finally { release.open(); }
  const settled = await f.runtime.engine.awaitOperation(receipt.operation.id, 5000);
  assert.equal(settled.state, 'succeeded', settled.diagnostic);
  assert.equal(f.lookups(), 1);
});

test('Git outage defers validation under the same receipt, with no origin lookup for quiet submissions', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await rename(f.remote, `${f.remote}.away`);
  const receipt = await f.runtime.submitHandoff(f.input);
  assert.ok('operation' in receipt && receipt.operation);
  await f.runtime.engine.quiesce();
  const waiting = f.runtime.store.operation(receipt.operation.id)!;
  assert.equal(waiting.state, 'pending'); assert.match(waiting.diagnostic, /Git remote/);
  assert.equal(f.runtime.store.tasks().length, 0);
  await rename(`${f.remote}.away`, f.remote);
  f.runtime.engine.resumeSubmissions();
  const settled = await f.runtime.engine.awaitOperation(receipt.operation.id, 5000);
  assert.equal(settled.state, 'succeeded', settled.diagnostic);
  assert.equal(f.lookups(), 0);
});

test('unpushed handoff is accepted durably but never becomes dispatchable', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await writeFile(f.path, f.text.replace('Acceptance fixture', 'Unpushed fixture'));
  await git(f.repo, 'add', '.'); await git(f.repo, 'commit', '-m', 'Not pushed');
  const receipt = await f.runtime.submitHandoff(f.input);
  assert.ok('operation' in receipt && receipt.operation);
  const settled = await f.runtime.engine.awaitOperation(receipt.operation.id, 5000);
  assert.equal(settled.state, 'failed'); assert.match(settled.diagnostic, /Push the integration/);
  assert.equal(f.runtime.store.tasks().length, 0);
});

test('overload stays typed and reconnecting an identical legacy operation keeps its identity', { timeout: 15000 }, async t => {
  const f = await fixture(t, true);
  const prepared = await captureHandoff(f.input);
  const payload = { type: 'submit' as const, submission: { ...prepared.submission, hostId: 'fixture-host' } };
  const old = await f.runtime.operationStart({ key: `submit:${prepared.submission.submissionId}`, kind: 'submit', payload });
  assert.ok('accepted' in old);
  const receipt = await f.runtime.submitHandoff(f.input);
  assert.ok('operation' in receipt && receipt.operation);
  assert.equal(receipt.operation.id, old.operation.id);
  assert.equal(receipt.operation.inputHash, operationInputHash(payload));
  f.runtime.store.setMeta('operationLimit', 1);
  await f.publish(f.text.replace('Acceptance fixture', 'Second fixture'));
  const overloaded = await f.runtime.submitHandoff(f.input);
  assert.ok('backpressured' in overloaded && overloaded.backpressured);
  assert.doesNotThrow(() => submitHandoff.output.parse(overloaded));
  assert.equal(f.runtime.store.operationBacklog(), 1);
});

test('legacy submission retry preserves a handoff operation and its pushed-planning gate', { timeout: 15000 }, async t => {
  const f = await fixture(t, true);
  const first = await f.runtime.submitHandoff(f.input);
  assert.ok('operation' in first && first.operation);
  const again = await f.runtime.engine.startSubmission(first.submission);
  assert.ok('accepted' in again);
  assert.equal(again.operation.id, first.operation.id);
  assert.equal(again.operation.inputHash, first.operation.inputHash);
  assert.equal((f.runtime.store.operationPayload(first.operation.id) as { requirePushedPlanning: boolean }).requirePushedPlanning, true);
});

test('Spec 053: a new submission without complexity is refused at acceptance; an operation Queue already accepted still replays', { timeout: 15000 }, async t => {
  const f = await fixture(t, true);
  // A handoff whose frontmatter names no complexity is refused before any operation exists.
  const bare = f.text.replace('queue:\n  complexity: medium\n', '');
  assert.notEqual(bare, f.text);
  await f.publish(bare);
  await assert.rejects(f.runtime.submitHandoff(f.input), /queue\.complexity is required/);
  assert.equal(f.runtime.store.operations().filter(operation => operation.kind === 'submit').length, 0);
  const prepared = await prepareHandoff({ ...f.input, dryRun: true });
  assert.equal(prepared.submission.complexity, undefined);
  await assert.rejects(f.runtime.submit(prepared.submission), /queue\.complexity is required/);
  await assert.rejects(f.runtime.operationStart({ key: `submit:${prepared.submission.submissionId}`, kind: 'submit', payload: { type: 'submit', submission: prepared.submission } } as never), /queue\.complexity is required/);
  // An operation accepted before the requirement (here straight through the engine) keeps its acceptance on replay.
  const legacySubmission = { ...prepared.submission, hostId: 'fixture-host' };
  const legacy = await f.runtime.engine.startSubmission(legacySubmission);
  assert.ok('operation' in legacy);
  const replay = await f.runtime.operationStart({ key: `submit:${prepared.submission.submissionId}`, kind: 'submit', payload: { type: 'submit', submission: legacySubmission } } as never);
  assert.ok('operation' in replay && replay.operation.id === legacy.operation.id, 'the replay returns the accepted operation');
  // Naming it is enough.
  await f.publish(f.text);
  const named = await f.runtime.submitHandoff(f.input);
  assert.ok('operation' in named && named.operation);
  assert.equal(named.submission.complexity, 'medium');
});

test('submission survives a definite SSH refusal using the same receipt', { timeout: 30000 }, async t => {
  const { chmod } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const f = await fixture(t);
  const prepared = await captureHandoff(f.input);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(f.dir, 'fake-bin'), mode = join(f.dir, 'ssh-mode');
  await mkdir(bin); await writeFile(mode, 'fail');
  await writeFile(join(bin, 'git'), '#!/bin/sh\nif [ "$1" = fetch ] && [ "$(cat "$NUCLEUS_TEST_SSH_MODE")" = fail ]; then echo "Permission denied (publickey)." >&2; exit 128; fi\nexec "$NUCLEUS_TEST_REAL_GIT" "$@"\n');
  await chmod(join(bin, 'git'), 0o700);
  const previous = { path: process.env.PATH, git: process.env.NUCLEUS_TEST_REAL_GIT, mode: process.env.NUCLEUS_TEST_SSH_MODE };
  process.env.PATH = `${bin}:${previous.path}`; process.env.NUCLEUS_TEST_REAL_GIT = realGit; process.env.NUCLEUS_TEST_SSH_MODE = mode;
  try {
    const receipt = await f.runtime.engine.startSubmission(prepared.submission, true);
    assert.ok('accepted' in receipt);
    await f.runtime.engine.quiesce();
    const id = receipt.operation.id, waiting = f.runtime.store.operation(id)!;
    assert.equal(waiting.state, 'pending'); assert.match(waiting.diagnostic, /Retrying at/);
    assert.doesNotMatch(waiting.diagnostic, /inspect.*key/i);
    await writeFile(mode, 'ok');
    const episode = f.runtime.store.getMeta<any>(`gitTransient:${id}`);
    f.runtime.store.setMeta(`gitTransient:${id}`, { ...episode, retryAt: 0 });
    f.runtime.engine.resumeSubmissions();
    const settled = await f.runtime.engine.awaitOperation(id, 5000);
    assert.equal(settled.state, 'succeeded', settled.diagnostic);
    assert.equal(f.runtime.store.tasks().length, 1);
  } finally {
    process.env.PATH = previous.path;
    if (previous.git === undefined) delete process.env.NUCLEUS_TEST_REAL_GIT; else process.env.NUCLEUS_TEST_REAL_GIT = previous.git;
    if (previous.mode === undefined) delete process.env.NUCLEUS_TEST_SSH_MODE; else process.env.NUCLEUS_TEST_SSH_MODE = previous.mode;
  }
});
