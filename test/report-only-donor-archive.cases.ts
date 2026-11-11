import type { TestContext } from 'node:test';
import { test } from './support/sharded-test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { holdPatch } from '../core/merge/merge-hold';
import { command, git } from '../core/git/index';
import { terminalArchiveFixture as fixture } from './support/terminal-archive-fixture';

// Report-only donor source archive through owner `complete` and `retry_effect`.
// Kept apart from terminal-archive-retry so each file stays inside the test budget.

const unexpectedCommits = 'Preserving workspace with uncommitted files or unexpected commits';

async function commitDonor(f: Awaited<ReturnType<typeof fixture>>, name: string, push = true) {
  await writeFile(join(f.directory, name), `${name}\n`);
  await git(f.directory, 'add', '-A');
  await git(f.directory, 'commit', '-m', name);
  if (push) await git(f.directory, 'push', 'origin', f.task().branch);
  return git(f.directory, 'rev-parse', 'HEAD');
}

/**
 * A report-only negative result whose donor commits sit beyond the planning
 * base on the published task branch. The owner finishes it through the real
 * `complete` verb; the earlier archive failed on the planning-base head pin.
 */
async function donorFixture(t: TestContext, pin: 'final' | 'stale' | 'absent' = 'final') {
  const f = await fixture(t, { unfinished: true });
  const checkpointHead = f.head;
  const head = await commitDonor(f, 'donor.txt');
  const completion = { eventId: 'worker-blocked-callback', taskId: f.task().id, runId: 'worker-run', status: 'blocked' as const,
    summary: 'Negative result: the donor approach does not hold; source stays on the task branch',
    ...(pin === 'absent' ? {} : { head: pin === 'final' ? head : checkpointHead }) };
  f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(completion.eventId, completion.taskId, completion.runId, 'a'.repeat(64), JSON.stringify({ accepted: true }));
  f.store.update(f.task().id, { runId: completion.runId, completion,
    checkpoints: { ...f.task().checkpoints, records: [{ ordinal: 1, summary: 'Donor checkpoint', head: checkpointHead, at: new Date().toISOString(), runId: completion.runId }] },
    resolution: { ...f.task().resolution, cleanupReason: `Workspace archive for ws failed: ${unexpectedCommits}`,
      workspaceArchiveRetries: [{ workspaceId: 'ws', attempts: 1, error: unexpectedCommits, nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString() }] } });
  f.adapter.findAnyOpenBranchPr = async () => [];
  await f.engine.performTaskControl({ action: 'complete', taskId: f.task().id, version: f.task().version, caller: 'operator',
    reason: 'Negative result accepted; donor source stays on its branch' });
  await f.engine.drainCleanup();
  await writeFile(join(await git(f.directory, 'rev-parse', '--absolute-git-dir'), 'effigy-runtime-scope'), 'b'.repeat(32));
  const remoteHead = async () => (await git(f.primary, 'ls-remote', 'origin', `refs/heads/${f.task().branch}`)).split(/\s+/)[0] ?? '';
  const terminal = () => { const task = f.task(); return { phase: task.phase, prHead: task.prHead, prUrl: task.prUrl, completion: task.completion,
    reportAcceptance: task.reportAcceptance, planningBase: task.planningBase, planningCommit: task.planningCommit,
    mergedCommit: task.resolution.mergedCommit, syncedCommit: task.resolution.syncedCommit, outcome: f.store.outcome(task.id) }; };
  return { ...f, donorHead: head, remoteHead, terminal };
}

for (const pin of ['final', 'stale', 'absent'] as const) test(`owner retry archives report-only donor source at its clean published head without minting product truth: ${pin}`, async t => {
  const f = await donorFixture(t, pin);
  let donorHead = f.donorHead;
  if (pin === 'stale') donorHead = await commitDonor(f, 'later.txt');
  assert.equal(f.task().phase, 'done');
  assert.equal(f.task().reportAcceptance?.kind, 'owner_completed');
  assert.ok(f.next().some(view => view.args?.effect === 'workspace_archive.ws'), 'the planning-base failure is an owner retry');
  const gated: string[] = [];
  const gate = f.engine.hooks.retentionGate.bind(f.engine.hooks);
  f.engine.hooks.retentionGate = async (task, target) => { gated.push(target.head); return gate(task, target); };
  const before = f.terminal();
  const result = await f.retry();
  assert.deepEqual(result.resolution.archivedWorkspaceIds, ['ws']);
  assert.deepEqual(result.resolution.workspaceArchiveRetries, []);
  assert.equal(result.resolution.archiveIntentWorkspaceId, null);
  assert.equal(existsSync(f.directory), false);
  assert.equal(f.remote.archives.length, 1);
  assert.deepEqual(gated, [donorHead], 'retention gates the Git-derived source head, not the planning base');
  assert.deepEqual(f.terminal(), before, 'terminal, report and outcome fields stay unchanged');
  assert.equal(f.task().prHead, null);
  assert.equal(f.task().resolution.mergedCommit, null);
  assert.equal(await f.remoteHead(), donorHead, 'the donor branch stays published');
  assert.equal(f.task().resolution.runtimeRetirements.find(record => record.workspaceId === 'ws')?.state, 'retired');
  const archived = f.store.events(f.task().id).filter(event => event.kind === 'workspace_archived');
  assert.equal(archived.length, 1);
  assert.match(archived[0].detail, new RegExp(`report-only source ${donorHead} preserved on ${f.task().branch}`));
  f.engine.enqueueCleanup(f.task().id);
  await f.engine.drainCleanup();
  assert.equal(f.remote.archives.length, 1, 'later cleanup stays idempotent');
});

const donorRefusals = ['dirty', 'untracked', 'unpublished', 'unpushed', 'foreign-branch', 'foreign-workspace', 'contradictory-pin',
  'not-from-base', 'base-reset-published', 'base-reset-unpublished', 'moved-during-retention', 'live', 'hold', 'retention'] as const;
for (const shape of donorRefusals) test(`report-only donor archive refuses unproven source, publication, identity and fences: ${shape}`, async t => {
  const f = await donorFixture(t);
  if (shape === 'dirty') await writeFile(join(f.directory, 'donor.txt'), 'edited\n');
  if (shape === 'untracked') await writeFile(join(f.directory, 'keep.txt'), 'local');
  if (shape === 'unpublished') await git(f.primary, 'push', 'origin', '--delete', f.task().branch);
  if (shape === 'unpushed') await commitDonor(f, 'local-only.txt', false);
  if (shape === 'foreign-branch') await git(f.directory, 'checkout', '-b', 'foreign-donor');
  if (shape === 'foreign-workspace') f.remote.descriptor.projectRootPath = join(f.root, 'foreign');
  if (shape === 'contradictory-pin') {
    const sibling = await git(f.directory, 'commit-tree', 'HEAD^{tree}', '-p', f.task().planningBase, '-m', 'rewritten');
    f.store.update(f.task().id, { completion: { ...f.task().completion!, head: sibling } });
  }
  if (shape === 'not-from-base') {
    const orphan = await git(f.directory, 'commit-tree', 'HEAD^{tree}', '-m', 'unrelated history');
    f.store.update(f.task().id, { completion: { ...f.task().completion!, head: undefined }, checkpoints: { ...f.task().checkpoints, records: [] } });
    await git(f.directory, 'reset', '--hard', orphan);
    await git(f.directory, 'push', '--force', 'origin', f.task().branch);
  }
  if (shape.startsWith('base-reset')) {
    // A checkout back at the planning base contradicts the authenticated donor report.
    await git(f.directory, 'reset', '--hard', f.task().planningBase);
    if (shape === 'base-reset-unpublished') await git(f.primary, 'push', 'origin', '--delete', f.task().branch);
  }
  if (shape === 'moved-during-retention') f.engine.hooks.retentionGate = async () => {
    await commitDonor(f, 'moved.txt');
    return { hold: false, attention: false, records: [] };
  };
  if (shape === 'live') f.remote.participant.active = true;
  if (shape === 'hold') f.store.update(f.task().id, holdPatch(f.task(), 'dispatch', 'operator', 'Preserve donor checkout'));
  if (shape === 'retention') f.engine.hooks.retentionGate = async () => { throw Error('consumer retention blocked'); };
  const before = f.terminal();
  const refusal = { 'contradictory-pin': /does not contain authenticated reported head/, 'base-reset-published': /does not contain authenticated reported head/,
    'base-reset-unpublished': /does not contain authenticated reported head/, 'not-from-base': /does not descend from planning base/,
    unpublished: /unpublished commits/, unpushed: /unpublished commits/, 'moved-during-retention': /unexpected commits/,
    dirty: /dirty/, untracked: /dirty/, 'foreign-branch': /wrong branch/ }[shape as string];
  await assert.rejects(f.retry(), refusal ?? /./);
  assert.deepEqual(f.remote.archives, []);
  assert.ok(existsSync(f.directory), 'source stays in the retained checkout');
  assert.equal(f.task().resolution.archiveIntentWorkspaceId, null);
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
  assert.ok(f.next().some(view => view.args?.effect === 'workspace_archive.ws'));
  const { completion: _completion, ...terminal } = f.terminal(), { completion: _before, ...expected } = before;
  assert.deepEqual(terminal, expected);
  if (!shape.endsWith('unpublished')) assert.match(await f.remoteHead(), /^[a-f0-9]{40}$/, 'the donor branch stays published');
});

for (const shape of ['present', 'absent-retained', 'pre-head-intent'] as const) test(`uncertain report-only donor archive observes delivery before replay or local teardown: ${shape}`, async t => {
  const f = await donorFixture(t);
  f.updateResolution({ archiveIntentWorkspaceId: 'ws', archiveIntentHead: shape === 'pre-head-intent' ? null : f.donorHead, workspaceArchiveRetries: [] });
  assert.ok(f.next().some(view => view.args?.effect === 'workspace_archive.ws'));
  f.remote.catalogued = shape !== 'absent-retained';
  if (shape === 'pre-head-intent') {
    // An intent recorded before its head was bound kept the planning base; it is never rederived.
    await assert.rejects(f.retry(), /unexpected commits/);
    assert.ok(existsSync(f.directory));
    assert.deepEqual(f.remote.archives, []);
    assert.equal(f.task().resolution.archiveIntentWorkspaceId, 'ws');
    return;
  }
  await f.retry();
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws']);
  assert.equal(existsSync(f.directory), false);
  assert.equal(f.remote.archives.length, shape === 'present' ? 1 : 0, 'an absent catalog never replays the native archive');
  assert.equal(await f.remoteHead(), f.donorHead);
});

test('a lost donor archive reply keeps the intent head and preserves a newly published source', async t => {
  const f = await donorFixture(t);
  const ref = f.api.workspaces.ref;
  f.api.workspaces.ref = () => ({ ...ref(), archive: async requestId => {
    f.remote.archives.push(requestId);
    f.remote.catalogued = false;
    throw Error('delivery response lost');
  } });
  await assert.rejects(f.retry(), /delivery response lost/);
  assert.equal(f.task().resolution.archiveIntentWorkspaceId, 'ws');
  assert.equal(f.task().resolution.archiveIntentHead, f.donorHead, 'intent binds the derived source head');
  const moved = await commitDonor(f, 'after-intent.txt');
  await assert.rejects(f.retry(), /unexpected commits/);
  assert.ok(existsSync(f.directory), 'a head published after intent is preserved, not torn down');
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
  assert.equal(f.task().resolution.archiveIntentHead, f.donorHead);
  assert.equal(await f.remoteHead(), moved);
  await git(f.directory, 'reset', '--hard', f.donorHead);
  await f.retry();
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws']);
  assert.equal(f.task().resolution.archiveIntentHead, null);
  assert.equal(f.remote.archives.length, 1, 'local teardown finishes without a native replay');
  assert.equal(await f.remoteHead(), moved, 'the remote donor branch is untouched');
});

for (const shape of ['canonical', 'switched-during-retention'] as const) test(`report-only donor archive binds its recorded repository origin: ${shape}`, async t => {
  const f = await donorFixture(t);
  // Hosted-shaped disposable bare repositories inside the fixture root; the
  // task records the hosted identity a real submission would.
  const canonical = join(f.root, 'github.com', 'acme', 'donor.git'), foreign = join(f.root, 'github.com', 'other', 'donor.git');
  await mkdir(join(f.root, 'github.com'), { recursive: true });
  await command('git', ['clone', '--bare', '--quiet', join(f.root, 'origin.git'), canonical], f.root);
  await command('git', ['clone', '--bare', '--quiet', join(f.root, 'origin.git'), foreign], f.root);
  await git(f.primary, 'remote', 'set-url', 'origin', canonical);
  f.store.update(f.task().id, { repository: 'acme/donor' });
  if (shape === 'switched-during-retention') f.engine.hooks.retentionGate = async () => {
    await git(f.primary, 'remote', 'set-url', 'origin', foreign);
    await command('git', ['--git-dir', canonical, 'update-ref', '-d', `refs/heads/${f.task().branch}`], f.root);
    return { hold: false, attention: false, records: [] };
  };
  if (shape === 'canonical') {
    await f.retry();
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws']);
    assert.equal(existsSync(f.directory), false);
    assert.equal((await git(f.primary, 'ls-remote', 'origin', `refs/heads/${f.task().branch}`)).split(/\s+/)[0], f.donorHead);
    return;
  }
  await assert.rejects(f.retry(), /origin does not match the recorded task identity/);
  assert.ok(existsSync(f.directory), 'a switched origin preserves the checkout');
  assert.deepEqual(f.remote.archives, []);
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
  assert.equal(f.task().resolution.archiveIntentWorkspaceId, null);
});

test('report-only donor teardown rechecks origin after the final catalog refresh', async t => {
  const f = await donorFixture(t);
  const foreign = join(f.root, 'foreign.git');
  await command('git', ['clone', '--bare', '--quiet', join(f.root, 'origin.git'), foreign], f.root);
  // The second refresh after native archive is the last catalog read before
  // local teardown; switch origin there and drop the donor branch.
  let refreshesAfterArchive = 0;
  const ref = f.api.workspaces.ref;
  f.api.workspaces.ref = () => {
    const base = ref();
    return { ...base, refresh: async () => {
      if (f.remote.archives.length && ++refreshesAfterArchive === 2) {
        await git(f.primary, 'remote', 'set-url', 'origin', foreign);
        await command('git', ['--git-dir', join(f.root, 'origin.git'), 'update-ref', '-d', `refs/heads/${f.task().branch}`], f.root);
      }
      return base.refresh();
    } };
  };
  await assert.rejects(f.retry(), /repository origin changed before teardown/);
  assert.ok(existsSync(f.directory), 'the checkout survives a late origin switch');
  assert.equal(f.remote.archives.length, 1);
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
  assert.equal(f.task().resolution.archiveIntentWorkspaceId, 'ws', 'native delivery stays an uncertain intent');
});
