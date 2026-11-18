/**
 * Spec 066 merge and terminal-cleanup slice (C6): a verified merge proceeds
 * through synchronization, closeout and workspace archive without retry-text or
 * stale-episode dependencies. Fixtures plant the stored reproduction shapes and
 * drive them through the real writers.
 */
import { profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { ResolutionAdapter } from '../core/resolution';
import { runSchema, submissionSchema, taskControlInputSchema, taskNextSchema, type Run, type Task } from '../shared/contracts';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import type { Adapter, AgentObservation } from '../core/host';
import { EXTERNAL_MERGE_CHECK_REASON_PREFIX } from '../core/recovery/task-reasons';
import { Lifecycle } from '../core/closeout/workspace-lifecycle';

const head = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);
const CALLER = 'owner-thread';
const RETRY_TEXT = 'Resolution check retry requested';
const workerProfile = profile('worker', 'test/worker'), reviewerProfile = profile('reviewer', 'test/reviewer');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-066-c6-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('hostId', 'host');
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'C6 merge cleanup', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  store.setMeta('pool', [
    { profileId: workerProfile.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewerProfile.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
  ]);
  store.putRepository({ origin: null, path: '/repo' }, 'queue', 'fixture keeps Queue closeout');
  const observations = new Map<string, AgentObservation>();
  const idle = (id: string, workspaceId = 'workspace') =>
    observations.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '' });
  idle('worker-agent');
  let merges = 0, syncs = 0, archives = 0;
  let observeArchive: () => Promise<boolean> = async () => true;
  const adapter = {
    hostId: 'host',
    isConnected: () => true,
    profiles: async () => [workerProfile, reviewerProfile],
    observe: async (id: string) => observations.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' },
    agentTimelinePage: async () => ({ entries: [], hasOlder: false, hasNewer: false, gap: false, staleCursor: false, reset: false, epoch: 'fixture', projection: 'projected', startCursor: null, endCursor: null }),
    originAgent: async (id: string) => ({ id, workspaceId: 'workspace', archived: true }),
    archiveAgent: async () => {}, notify: async () => {},
    findAgents: async () => [], findRunAgents: async () => [], findWorkspaces: async () => [],
    verifyWorkspace: async () => {},
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/7', head }),
    externalMerge: async () => ({ head, commit: merged }),
    createRun: async () => { throw new Error('no dispatch is expected in these fixtures'); },
    sendRun: async () => {},
    stopAgentTurn: async () => {},
    merge: async () => { merges++; },
    syncMain: async () => { syncs++; return merged; },
    taskWorkspaceArchived: async () => observeArchive(),
    archiveTaskWorkspace: async (_t: Task, _id: string, _d: string, _h: string, allowed: () => boolean) => {
      archives++;
      return allowed();
    },
    preflightWorkspaceStorage: async () => {},
    hostProcessListing: async () => [],
  } as unknown as Adapter & ResolutionAdapter & { hostId: string };
  const engine = new Engine(store, adapter, 0, () => true);
  engine.profiles = [workerProfile, reviewerProfile];
  const task = () => store.task(inserted.id);
  const events = (kind: string) => store.eventsAll(inserted.id).filter(event => event.kind === kind);
  const next = () => taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, task())));
  return {
    dir, store, engine, adapter, observations, idle, taskId: inserted.id, task, events, next,
    counts: () => ({ merges, syncs, archives }),
    setObserveArchive: (fn: () => Promise<boolean>) => { observeArchive = fn; },
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function plantMerged(f: ReturnType<typeof fixture>, overrides: Partial<Task> = {}) {
  const recovery = {
    id: 'episode', key: 'episode', generation: 1, runId: 'recovery-run', agentId: 'coordinator-agent',
    status: 'pending' as const, summary: '', idleSince: null, incidentId: null,
  };
  f.store.update(f.taskId, {
    phase: 'syncing', reason: RETRY_TEXT, planningBase: base, workspaceIntent: true, agentIntent: true,
    workspaceId: 'workspace', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run',
    profile: workerProfile, workerModel: workerProfile.model, prHead: head,
    prUrl: 'https://github.com/example/repo/pull/7',
    completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    resolution: {
      ...f.task().resolution, mergeIntent: true, mergeHead: head, mergedCommit: merged, syncedCommit: null,
      externalMerge: true, integrationTurn: null, currentRunId: 'recovery-run', attention: false, recoveryActive: true,
      recovery, review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-1', status: 'ready_to_merge', summary: 'Approved', head, reviewId: 12 },
    },
    ...overrides,
  });
  f.store.putRun(runSchema.parse({
    id: 'recovery-run', taskId: f.taskId, role: 'recovery', generation: 1, head, base, agentId: 'coordinator-agent',
    workspaceId: 'workspace', profile: null, status: 'finished', createdAt: new Date().toISOString(),
    lastObservedAt: null, active: false, idleSince: null, released: true,
    completion: { taskId: f.taskId, runId: 'recovery-run', eventId: 'recovery-done', status: 'recovered', summary: 'Settled' },
  }) as Run);
  f.idle('coordinator-agent');
  f.idle('worker-agent');
  return f.task();
}

function plantDone(f: ReturnType<typeof fixture>, directory: string, extra: Partial<Task['resolution']> = {}) {
  f.store.update(f.taskId, {
    phase: 'done', reason: 'Nucleus-owned closeout at the synchronized integration commit',
    workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory,
    agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile, prHead: head,
    prUrl: 'https://github.com/example/repo/pull/7',
    completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    resolution: {
      ...f.task().resolution, mergedCommit: merged, syncedCommit: merged, mergeHead: head, externalMerge: true, ...extra,
    },
  });
  return f.task();
}

test('C6: a verified merge stuck on retry-text synchronizes under ordinary sweep', async () => {
  const f = fixture();
  try {
    plantMerged(f);
    assert.equal(await f.engine.resolution.recoverExternalMerge(f.task()), false);
    const settled = f.task();
    assert.equal(settled.phase, 'syncing');
    assert.notEqual(settled.reason, RETRY_TEXT);
    assert.equal(settled.resolution.recoveryActive, false);
    assert.equal(settled.resolution.recovery?.status, 'resolved');
    assert.equal(settled.resolution.currentRunId, null);
    assert.ok(settled.resolution.integrationTurn);
    assert.equal(f.events('recorded_merge_phase_reconciled').length, 1);
    await f.engine.wake();
    const after = f.task();
    assert.ok(['closing', 'done'].includes(after.phase), `${after.phase}: ${after.reason}`);
    assert.equal(after.resolution.syncedCommit, merged);
    assert.equal(after.resolution.mergedCommit, merged);
    assert.equal(f.counts().syncs, 1);
    assert.equal(f.counts().merges, 0);
    assert.equal(f.events('main_synchronized').length, 1);
    if (after.phase === 'closing') await f.engine.wake();
    assert.equal(f.task().phase, 'done');
    assert.equal(f.next().verbs.find(entry => entry.verb === 'retry_effect')?.available ?? false, false);
    const replayed = f.events('recorded_merge_phase_reconciled').length;
    const synced = f.events('main_synchronized').length;
    await f.engine.wake();
    assert.equal(f.events('recorded_merge_phase_reconciled').length, replayed);
    assert.equal(f.events('main_synchronized').length, synced);
    assert.equal(f.counts().syncs, 1);
    assert.equal(f.counts().merges, 0);
  } finally { await f.close(); }
});

test('C6 negative: a live participant keeps the verified merge gated', async () => {
  const f = fixture();
  try {
    plantMerged(f);
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    await f.engine.wake();
    assert.equal(f.task().phase, 'syncing');
    assert.equal(f.task().resolution.mergedCommit, merged);
    assert.equal(f.counts().syncs, 0);
    assert.equal(f.counts().merges, 0);
  } finally { await f.close(); }
});

test('C6 negative: a dirty or unproved checkout keeps the real sync gate', async () => {
  const f = fixture();
  try {
    plantMerged(f);
    f.adapter.syncMain = async () => { throw Error('The bound workspace is dirty'); };
    await f.engine.wake();
    assert.equal(f.task().resolution.mergedCommit, merged);
    assert.equal(f.task().resolution.syncedCommit, null);
    assert.equal(f.counts().merges, 0);
    assert.notEqual(f.task().phase, 'done');
  } finally { await f.close(); }
});

test('a verified merge in needs_attention never restores a pre-attention snapshot', async () => {
  const f = fixture();
  try {
    plantMerged(f, {
      phase: 'needs_attention', reason: RETRY_TEXT,
      resolution: {
        ...f.task().resolution, mergeIntent: true, mergeHead: head, mergedCommit: merged, syncedCommit: null,
        externalMerge: true, attention: false, currentRunId: null, recoveryActive: false, recovery: null,
        externalMergePreAttention: { phase: 'reviewing', reason: 'Ready' },
        review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-1', status: 'ready_to_merge', summary: 'Approved', head, reviewId: 12 },
      },
    });
    const resumed = f.engine.resolution.resumeClearedAttention(f.task());
    assert.ok(resumed);
    assert.notEqual(resumed!.phase, 'reviewing');
    assert.equal(resumed!.resolution.externalMergePreAttention, null);
    assert.ok(['syncing', 'merging', 'closing'].includes(resumed!.phase), resumed!.phase);
    assert.notEqual(resumed!.reason, RETRY_TEXT);
  } finally { await f.close(); }
});

test('a verified merge still parked on an external-merge check stays until the probe', async () => {
  const f = fixture();
  try {
    plantMerged(f, {
      phase: 'needs_attention', reason: `${EXTERNAL_MERGE_CHECK_REASON_PREFIX} fixture head unavailable`,
      resolution: {
        ...f.task().resolution, mergeIntent: true, mergeHead: head, mergedCommit: merged, syncedCommit: null,
        externalMerge: true, attention: false, currentRunId: null, recoveryActive: false, recovery: null,
        externalMergePreAttention: { phase: 'syncing', reason: 'Synchronizing main before closeout' },
        review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-1', status: 'ready_to_merge', summary: 'Approved', head, reviewId: 12 },
      },
    });
    assert.equal(f.engine.resolution.resumeClearedAttention(f.task()), null);
    assert.equal(f.task().phase, 'needs_attention');
    assert.equal(f.task().resolution.externalMergePreAttention, null);
    assert.match(f.task().reason, new RegExp(`^${EXTERNAL_MERGE_CHECK_REASON_PREFIX}`));
    assert.equal(f.events('external_merge_pre_attention_superseded').length, 1);
    assert.equal(f.engine.resolution.resumeClearedAttention(f.task()), null);
    assert.equal(f.events('external_merge_pre_attention_superseded').length, 1);
  } finally { await f.close(); }
});

test('retry_effect settles a gone workspace archive from a recorded retry without a send', async () => {
  const f = fixture();
  try {
    const directory = join(f.dir, 'gone-worktree');
    plantDone(f, directory, {
      workspaceArchiveRetries: [{ workspaceId: 'workspace', attempts: 1, error: 'Transport not connected (status: disposed)', nextAttemptAt: new Date(0).toISOString() }],
    });
    f.setObserveArchive(async () => true);
    const settled = await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'retry_effect', taskId: f.taskId, version: f.task().version,
      effect: 'workspace_archive.workspace', reason: 'Observe the gone workspace', caller: CALLER,
    }));
    assert.deepEqual(settled.resolution.archivedWorkspaceIds, ['workspace']);
    assert.equal(settled.resolution.archiveIntentWorkspaceId, null);
    assert.equal(settled.resolution.workspaceArchiveRetries.length, 0);
    assert.equal(f.counts().archives, 0);
    assert.equal(f.events('workspace_archived').length, 1);
    await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'retry_effect', taskId: f.taskId, version: f.task().version,
      effect: 'workspace_archive.workspace', reason: 'Replay the gone workspace', caller: CALLER,
    }));
    assert.equal(f.events('workspace_archived').length, 1);
    assert.equal(f.counts().archives, 0);
  } finally { await f.close(); }
});

test('a failed archive observation waits, then completes when the host answers', async () => {
  const f = fixture();
  try {
    const directory = join(f.dir, 'transport-worktree');
    plantDone(f, directory, {
      workspaceArchiveRetries: [{ workspaceId: 'workspace', attempts: 1, error: 'Transport not connected (status: disposed)', nextAttemptAt: new Date(0).toISOString() }],
    });
    f.setObserveArchive(async () => { throw Error('Transport not connected (status: disposed)'); });
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'retry_effect', taskId: f.taskId, version: f.task().version,
      effect: 'workspace_archive.workspace', reason: 'Observe the dropped transport', caller: CALLER,
    })), /Waiting to reconcile the uncertain workspace archive for workspace: Transport not connected/);
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
    assert.equal(f.counts().archives, 0);
    f.setObserveArchive(async () => true);
    const settled = await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'retry_effect', taskId: f.taskId, version: f.task().version,
      effect: 'workspace_archive.workspace', reason: 'Host returned', caller: CALLER,
    }));
    assert.deepEqual(settled.resolution.archivedWorkspaceIds, ['workspace']);
    assert.equal(f.counts().archives, 0);
  } finally { await f.close(); }
});

test('an ambiguous catalog observation never archives', async () => {
  const f = fixture();
  try {
    const directory = join(f.dir, 'ambiguous-worktree');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'keep'), 'present');
    plantDone(f, directory, {
      workspaceArchiveRetries: [{ workspaceId: 'workspace', attempts: 1, error: 'Transport not connected (status: disposed)', nextAttemptAt: new Date(0).toISOString() }],
    });
    f.setObserveArchive(async () => { throw Error('Transport not connected (status: disposed)'); });
    const lifecycle = new Lifecycle(f.engine);
    await lifecycle.pass();
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
    assert.match(f.task().resolution.cleanupReason, /Waiting to reconcile the uncertain workspace archive for workspace: Transport not connected/);
    assert.equal(f.counts().archives, 0);
    assert.ok(existsSync(directory));
  } finally { await f.close(); }
});

test('retry_effect settles an intent-state cleanup after the directory is gone', async () => {
  const f = fixture();
  try {
    const directory = join(f.dir, 'cleanup-gone');
    plantDone(f, directory, {
      archivedWorkspaceIds: ['workspace'],
      buildOutputCleanups: [{ workspaceId: 'workspace', directory, state: 'intent', detail: 'Build output cleanup intent recorded', at: new Date().toISOString() }],
    });
    const settled = await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'retry_effect', taskId: f.taskId, version: f.task().version,
      effect: 'build_output_cleanup.workspace', reason: 'Observe the gone cleanup target', caller: CALLER,
    }));
    assert.equal(settled.resolution.buildOutputCleanups[0]?.state, 'complete');
    assert.equal(settled.resolution.buildOutputCleanups[0]?.detail, 'directory absent; nothing to clean up');
  } finally { await f.close(); }
});

test('a still-present workspace with a recorded retry is observed, then archived once the host answers', async () => {
  const f = fixture();
  try {
    const directory = join(f.dir, 'live-worktree');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'keep'), 'present');
    plantDone(f, directory, {
      workspaceArchiveRetries: [{ workspaceId: 'workspace', attempts: 1, error: 'Transport not connected (status: disposed)', nextAttemptAt: new Date(0).toISOString() }],
    });
    f.setObserveArchive(async () => false);
    const lifecycle = new Lifecycle(f.engine);
    await lifecycle.pass();
    assert.ok(f.task().resolution.archivedWorkspaceIds.includes('workspace') || f.counts().archives >= 1,
      `phase=${f.task().phase} archived=${JSON.stringify(f.task().resolution.archivedWorkspaceIds)} reason=${f.task().resolution.cleanupReason}`);
    const archives = f.counts().archives;
    await lifecycle.pass();
    assert.equal(f.counts().archives, archives, 'a repeated pass does not send another archive');
  } finally { await f.close(); }
});
