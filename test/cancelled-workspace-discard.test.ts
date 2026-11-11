import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';
import { RuntimeRetirementService } from '../core/runtime/runtime-retirement';
import { Store, now, operationInputHash } from '../core/store/store';
import { holdPatch } from '../core/merge/merge-hold';
import { taskControlOperation } from '../core/verbs/task-control-key';
import { workspaceDiscardKey, type WorkspaceDiscard } from '../core/workspaces/orphan-worktree';
import { runSchema, submissionSchema, taskControlInputSchema } from '../shared/contracts';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';
import { git, preservedFixture } from './support/preserved-retirement-fixture';

/**
 * Papercut c7643943 generalized (Tom's actual "Discard it" ruling, relayed by
 * Supervisor c5403fa7 for a cancelled superseded donor): the done-task route
 * recorded a durable owner content discard, but a cancelled preserved
 * workspace's retirement recorded its authorization and then always proved the
 * workspace empty and published, ignoring `discard`. The same structured
 * `retry_effect workspace_archive.<id>` discard now binds the exact task,
 * workspace and directory before any effect and waives only that retirement's
 * content and publication proofs. Every identity, custody, hold, participant,
 * PR, retention and runtime proof stays; prose is never authority.
 */

const RULING = 'Tom: "Discard it" for the cancelled superseded donor workspace (contents may be lost)';

type ArchiveArgs = Parameters<NonNullable<Adapter['archiveTaskWorkspace']>>;

async function fixture(t: TestContext) {
  // The canonical Queue-owned checkout path: it is what the exact owned-path,
  // canonical-root and orphan proofs read once a discard reaches the adapter.
  const f = await preservedFixture(t, [], true);
  const current = () => f.store.task(f.task.id);
  const record = () => f.store.getMeta<WorkspaceDiscard>(workspaceDiscardKey(f.task.id, f.task.workspaceId!)) ?? null;
  const events = (kind: string) => f.store.eventsAll(f.task.id).filter(event => event.kind === kind);
  const dirty = () => writeFile(join(f.directory, 'src', 'task.rs'), 'never committed\n');
  return { ...f, current, record, events, dirty,
    discard: (overrides: Record<string, unknown> = {}) => f.retry({ reason: RULING, discard: true, ...overrides }) };
}

/** The public durable shape RuntimeOwner.taskControl uses: an accepted operation, then its handler. */
function acceptedControlOperation(f: Awaited<ReturnType<typeof fixture>>, control: ReturnType<typeof taskControlInputSchema.parse>) {
  const { key, payload } = taskControlOperation(control);
  // Queue #912: an accepted task-control operation records its task's host, as Engine.startOperation does.
  const task = f.store.task(control.taskId);
  const acceptance = f.store.acceptOperation({ key, kind: 'task_control', inputHash: operationInputHash(payload),
    taskId: control.taskId, expectedVersion: control.version, payload, hostId: task.hostId, hostSelection: task.hostSelection });
  assert.ok('accepted' in acceptance);
  f.store.putOperation({ ...acceptance.operation, state: 'running', startedAt: now(), attempts: 1 });
  return acceptance.operation.id;
}

async function settleOperation(store: Store, operationId: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const operation = store.operation(operationId);
    if (operation && operation.state !== 'running' && operation.state !== 'pending') return operation;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error(`Operation ${operationId} did not settle`);
}

test('a structured owner discard retires a dirty preserved cancelled workspace through the public durable retry', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  let restarted: Engine | undefined, reopened: Store | undefined;
  try {
    await f.dirty();
    // The parent behaviour: the same public retry_effect without a structured
    // discard refuses the dirty contents.
    const refused = await f.retry();
    assert.equal(refused.resolution.workspaceRetirement?.state, 'held');
    assert.match(refused.resolution.workspaceRetirement?.detail ?? '', /dirty/);
    assert.equal(existsSync(f.directory), true);
    assert.equal(f.archive.count, 0);
    assert.equal(f.record(), null, 'a reason and the retirement authorization are not content-loss authority');
    assert.equal(f.events('workspace_discard_authorized').length, 0);
    // Prose naming the ruling, in the reason or as a historical note, stays prose.
    const prose = await f.retry({ reason: RULING, note: RULING });
    assert.equal(prose.resolution.workspaceRetirement?.state, 'held');
    assert.match(prose.resolution.workspaceRetirement?.detail ?? '', /dirty/);
    assert.equal(f.record(), null);
    assert.equal(f.events('workspace_discard_authorized').length, 0);
    assert.deepEqual(prose.disposition, f.cancelled.disposition);

    const heads = git(f.repo, 'ls-remote', '--heads', 'origin');
    const control = taskControlInputSchema.parse({ action: 'retry_effect', taskId: f.task.id, version: f.current().version,
      effect: `workspace_archive.${f.task.workspaceId}`, caller: 'operator (board)', reason: RULING, discard: true });
    const operationId = acceptedControlOperation(f, control);
    const calls: ArchiveArgs[] = [];
    const archive = f.adapter.archiveTaskWorkspace!;
    f.adapter.archiveTaskWorkspace = async (...args: ArchiveArgs) => { calls.push(args); return archive(...args); };
    const archived = await f.engine.performTaskControl(control, operationId);

    assert.equal(archived.resolution.workspaceRetirement?.state, 'archived', archived.resolution.workspaceRetirement?.detail);
    assert.ok(archived.resolution.archivedWorkspaceIds.includes(f.task.workspaceId!));
    assert.equal(existsSync(f.directory), false);
    assert.equal(f.archive.count, 1);
    // The exact recorded decision reached the real retirement preflight and adapter.
    assert.equal(calls.length, 1);
    const bound = f.record();
    assert.deepEqual(calls[0]![12], bound, 'the real adapter receives the exact recorded discard');
    assert.deepEqual({ ...bound, at: undefined }, { workspaceId: f.task.workspaceId, directory: f.directory,
      caller: 'operator (board)', authority: 'operator', note: null, reason: RULING, at: undefined });
    assert.equal(f.events('workspace_discard_authorized').length, 1);
    assert.equal(f.events('workspace_contents_discarded').length, 1);
    assert.match(archived.resolution.workspaceRetirement?.detail ?? '', /unproven contents discarded by operator \(board\) \(operator\)/);
    const intent = f.events('workspace_retirement_intent').at(-1);
    assert.match(intent?.detail ?? '', /unproven contents discarded by operator \(board\)/);
    // Cancellation history and the terminal result are unchanged; no state or credit is minted.
    assert.equal(archived.phase, 'cancelled');
    assert.deepEqual(archived.disposition, f.cancelled.disposition);
    assert.equal(archived.prHead, f.cancelled.prHead);
    assert.equal(archived.resolution.mergedCommit, null);
    assert.equal(archived.reason, f.cancelled.reason);
    assert.equal(git(f.repo, 'ls-remote', '--heads', 'origin'), heads, 'retirement creates or deletes no remote branch');

    // Duplicate delivery of the same accepted control keeps one archive and never replays it.
    const duplicate = await f.engine.performTaskControl(control, operationId);
    assert.deepEqual(duplicate.resolution.archivedWorkspaceIds, archived.resolution.archivedWorkspaceIds);
    assert.equal(f.archive.count, 1);

    // A restart resumes the same accepted operation from its own recorded archive.
    await f.engine.stop();
    reopened = new Store(join(f.root, 'queue.sqlite'));
    restarted = new Engine(reopened, f.adapter, 0, undefined, new RuntimeRetirementService(reopened, f.runtime.invoke));
    restarted.resumeOperations();
    const settled = await settleOperation(reopened, operationId);
    assert.equal(settled.state, 'succeeded', settled.diagnostic);
    assert.equal(f.archive.count, 1, 'no blind replay after restart');
    const after = reopened.task(f.task.id);
    assert.equal(after.resolution.workspaceRetirement?.state, 'archived');
    assert.deepEqual(after.disposition, f.cancelled.disposition);
    assert.deepEqual(reopened.getMeta<WorkspaceDiscard>(workspaceDiscardKey(f.task.id, f.task.workspaceId!)), bound, 'the first record is kept');
  } finally {
    await restarted?.stop();
    reopened?.close();
    await f.close();
  }
});

test('a lost native reply after a discarded retirement settles once from its observation, without replay', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  let restarted: Engine | undefined, reopened: Store | undefined;
  try {
    await f.dirty();
    const archive = f.adapter.archiveTaskWorkspace!;
    f.adapter.archiveTaskWorkspace = async (...args: ArchiveArgs) => {
      await archive(...args);
      // Native delivery, catalog removal and local teardown landed; the reply did not.
      throw Error('Reply lost after the discarded archive landed');
    };
    const unknown = await f.discard();
    assert.equal(unknown.resolution.workspaceRetirement?.state, 'uncertain');
    assert.equal(f.archive.count, 1);
    assert.equal(existsSync(f.directory), false);
    const bound = f.record();
    assert.ok(bound, 'the discard decision is durable before the unknown delivery');

    // Restart observes the same delivery instead of requesting a second archive.
    await f.engine.stop();
    reopened = new Store(join(f.root, 'queue.sqlite'));
    restarted = new Engine(reopened, f.adapter, 0, undefined, new RuntimeRetirementService(reopened, f.runtime.invoke));
    await restarted.scheduleRunBuildOutputs(f.task.id);
    const archived = reopened.task(f.task.id);
    assert.equal(archived.resolution.workspaceRetirement?.state, 'archived', archived.resolution.workspaceRetirement?.detail);
    assert.equal(f.archive.count, 1, 'one archive, observed rather than requested again');
    assert.deepEqual(reopened.getMeta<WorkspaceDiscard>(workspaceDiscardKey(f.task.id, f.task.workspaceId!)), bound, 'the same authorization is kept');
    assert.equal(reopened.eventsAll(f.task.id).filter(event => event.kind === 'workspace_contents_discarded').length, 1);
    assert.deepEqual(archived.disposition, f.cancelled.disposition);
    assert.equal(archived.phase, 'cancelled');
  } finally {
    await restarted?.stop();
    reopened?.close();
    await f.close();
  }
});

test('a source change after the recorded discard intent is preserved, never archived through', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  try {
    await f.dirty();
    f.archive.failure = 'worktree.teardown failed before the native request';
    const unknown = await f.discard();
    assert.equal(unknown.resolution.workspaceRetirement?.state, 'uncertain');
    assert.equal(f.archive.count, 1);
    assert.equal(existsSync(f.directory), true);
    // Source the discard never covered: a new commit after the bound intent head.
    await writeFile(join(f.directory, 'src', 'task.rs'), 'committed after the archive intent\n');
    git(f.directory, 'add', 'src/task.rs');
    git(f.directory, 'commit', '-m', 'source after intent');
    const changed = await f.retry();
    assert.equal(changed.resolution.workspaceRetirement?.state, 'held', changed.resolution.workspaceRetirement?.detail);
    assert.match(changed.resolution.workspaceRetirement?.detail ?? '', /head changed since archive intent/);
    assert.equal(existsSync(f.directory), true);
    assert.equal(f.archive.count, 1, 'no native replay while the outcome is unknown');
    assert.deepEqual(changed.resolution.archivedWorkspaceIds, []);
    assert.deepEqual(changed.disposition, f.cancelled.disposition);
  } finally { await f.close(); }
});

test('every fence still holds under a cancelled-workspace discard', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const shapes = ['unauthorized', 'relay-without-note', 'stale-version', 'pause', 'dispatch-hold', 'open-pr', 'shared',
    'retention', 'unreleased-run', 'unknown-observation', 'wrong-directory-record', 'wrong-task-record'] as const;
  for (const shape of shapes) await t.test(shape, async t => {
    const f = await fixture(t);
    try {
      await f.dirty();
      if (shape === 'open-pr') f.adapter.findAnyOpenBranchPr = async () => [{ number: 3, url: 'https://example.invalid/pr/3' }];
      if (shape === 'shared') {
        const other = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Shared donor', repoPath: f.repo,
          planningCommit: f.base, handoffPath: 'other.md', originAgentId: 'origin' }), 'host', 'other', f.base);
        f.store.update(other.id, { phase: 'blocked', workspaceId: f.task.workspaceId });
      }
      if (shape === 'retention') f.engine.hooks.retentionGate = async () => ({ hold: true, attention: true, records: [] });
      if (shape === 'unreleased-run') f.store.putRun(runSchema.parse({ id: 'live-donor-run', taskId: f.task.id, role: 'revision', generation: 1,
        head: f.head, base: f.base, agentId: f.task.agentId, workspaceId: f.task.workspaceId, profile: null,
        status: 'running', createdAt: now(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false }));
      if (shape === 'unknown-observation') f.adapter.observe = async () => { throw Error('Observation unavailable'); };
      if (shape === 'dispatch-hold') f.store.update(f.task.id, holdPatch(f.current(), 'dispatch', 'owner', 'Keep the preserved workspace'));
      if (shape === 'pause') f.store.setMeta('paused', true);
      if (shape === 'wrong-directory-record') f.store.setMeta(workspaceDiscardKey(f.task.id, f.task.workspaceId!), {
        workspaceId: f.task.workspaceId!, directory: join(f.root, 'another-checkout'), caller: 'operator (board)',
        authority: 'operator', note: null, reason: RULING, at: now() } satisfies WorkspaceDiscard);
      // A record kept for another task never authorises this one.
      if (shape === 'wrong-task-record') f.store.setMeta(workspaceDiscardKey(randomUUID(), f.task.workspaceId!), {
        workspaceId: f.task.workspaceId!, directory: f.directory, caller: 'operator (board)',
        authority: 'operator', note: null, reason: RULING, at: now() } satisfies WorkspaceDiscard);

      const attempt = shape === 'unauthorized' ? f.discard({ caller: 'someone-else' })
        : shape === 'relay-without-note' ? f.discard({ caller: 'relay', relayed: true })
        : shape === 'stale-version' ? f.discard({ version: f.current().version - 1 })
        : shape === 'wrong-task-record' ? f.retry() // no structured discard: the other task's record must not waive
        : f.discard();
      if (shape === 'unauthorized') await assert.rejects(attempt, /someone-else has none/);
      else if (shape === 'relay-without-note') await assert.rejects(attempt, /authorization note/);
      else if (shape === 'stale-version') await assert.rejects(attempt, /Task changed/);
      else if (shape === 'wrong-directory-record') await assert.rejects(attempt, /another directory/);
      else await attempt;

      // Nothing was archived or deleted, and the cancellation history is unchanged.
      const result = f.current();
      assert.equal(f.archive.count, 0, shape);
      assert.equal(existsSync(join(f.directory, 'src', 'task.rs')), true, `${shape}: source preserved`);
      assert.deepEqual(result.resolution.archivedWorkspaceIds, [], shape);
      assert.deepEqual(result.disposition, f.cancelled.disposition, shape);
      assert.equal(result.phase, 'cancelled', shape);
      if (['unauthorized', 'relay-without-note', 'stale-version'].includes(shape))
        assert.equal(f.record(), null, `${shape}: no content-loss authority was recorded`);
      if (shape === 'wrong-directory-record') {
        // The contradictory record is refused, not overwritten, and nothing is archived.
        assert.equal(f.record()?.directory, join(f.root, 'another-checkout'));
        assert.equal(result.resolution.workspaceRetirement ?? null, null, 'nothing was written');
      }
      if (shape === 'wrong-task-record') assert.match(result.resolution.workspaceRetirement?.detail ?? '', /dirty/, shape);
      if (shape === 'pause') {
        // Pausing fences the effect while the recorded decision waits.
        assert.equal(result.resolution.workspaceRetirement?.state, 'authorized');
        assert.ok(f.record(), 'the owner decision is durable before any effect');
      }
    } finally { await f.close(); }
  });
});

test('a paused cancelled-workspace discard applies the same durable decision once unpaused', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  try {
    await f.dirty();
    f.store.setMeta('paused', true);
    const waiting = await f.discard();
    assert.equal(waiting.resolution.workspaceRetirement?.state, 'authorized');
    assert.equal(f.archive.count, 0);
    const bound = f.record();
    assert.ok(bound);
    f.store.setMeta('paused', false);
    // A later plain retry applies the already-recorded decision; it records no second one.
    const archived = await f.retry();
    assert.equal(archived.resolution.workspaceRetirement?.state, 'archived', archived.resolution.workspaceRetirement?.detail);
    assert.equal(f.archive.count, 1);
    assert.equal(existsSync(f.directory), false);
    assert.equal(f.events('workspace_discard_authorized').length, 1);
    assert.deepEqual(f.record(), bound);
    assert.deepEqual(archived.disposition, f.cancelled.disposition);
  } finally { await f.close(); }
});

test('an ordinary cancelled retirement still proves clean published source', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  try {
    // Uncommitted contents refuse without a discard, and no structured record appears.
    await writeFile(join(f.directory, 'untracked.txt'), 'never committed\n');
    const dirty = await f.retry();
    assert.equal(dirty.resolution.workspaceRetirement?.state, 'held');
    assert.match(dirty.resolution.workspaceRetirement?.detail ?? '', /dirty/);
    assert.equal(f.archive.count, 0);
    assert.equal(f.record(), null);
    // A local unpublished commit is refused by the publication proof too.
    git(f.directory, 'add', 'untracked.txt');
    git(f.directory, 'commit', '-m', 'local only');
    const unpublished = await f.retry();
    assert.equal(unpublished.resolution.workspaceRetirement?.state, 'held');
    assert.match(unpublished.resolution.workspaceRetirement?.detail ?? '', /not on origin queue branch|no origin ref contains HEAD/);
    assert.equal(f.archive.count, 0);
    assert.equal(existsSync(f.directory), true);
    // Clean and published, the same ordinary path archives as before.
    git(f.directory, 'push', 'origin', f.task.branch);
    const clean = await f.retry();
    assert.equal(clean.resolution.workspaceRetirement?.state, 'archived', clean.resolution.workspaceRetirement?.detail);
    assert.equal(f.archive.count, 1);
    assert.equal(existsSync(f.directory), false);
    assert.equal(f.record(), null, 'an ordinary retirement records no content discard');
    assert.equal(f.events('workspace_contents_discarded').length, 0);
    assert.deepEqual(clean.disposition, f.cancelled.disposition);
  } finally { await f.close(); }
});
