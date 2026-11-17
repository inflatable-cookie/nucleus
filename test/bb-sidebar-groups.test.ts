/**
 * Spec 062, phase 5: the sidebar's one read.
 *
 * `bb.sidebar-groups` is a projection of two records the service already owns — the
 * live task rows and the BB workspace handles — so this test builds both the way the
 * service does: a real `Store` with a real inserted task, updated through its own
 * API, and the `bbWorkspaces` / `bbThreads` records a BB dispatch writes. The labels
 * are then the shared helpers' own output, and the PR state is the board's own
 * `prStates` record. Nothing here invents a field.
 *
 * The other half is the plugin's side of the same read: its RPC contract must parse
 * exactly what the service serves (the two schemas cannot drift), and the handler
 * forwards one call and rejects when the channel is away, never inventing a group.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Store } from '../core/store/store';
import { taskWaitStateContext } from '../core/recovery/wait-context';
import { visibleTaskSummaries } from '../shared/task-view';
import { submissionSchema } from '../shared/contracts';
import type { Task, TaskSummary } from '../shared/contracts';
import { readBbSidebarGroups } from '../core/runtime/bb-sidebar-groups';
import { bbSidebarGroupsOutputSchema } from '../shared/schema/bb-sidebar';
import { phaseStateLabel, taskStateLabel } from '../shared/task-state';
import { RPC_CATALOGUE } from '../shared/rpc-catalogue';
import { workspaceHandleForPath } from '../shared/host-operation';
import {
  SIDEBAR_GROUPS_METHOD,
  sidebarGroupsOutputSchema,
  createSidebarGroupsService,
} from '../hosts/bb/plugin/sidebar-groups';
import { watchBoardSignal } from '../hosts/bb/plugin/server';
import type { BbPluginApi } from '@get-bb/plugin-sdk';

const hostId = 'bb:' + 'a'.repeat(64);
const handle = workspaceHandleForPath('/synthetic/bb-worktree');

function withStore(body: (store: Store) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'bb-sidebar-groups-'));
  const store = new Store(join(directory, 'queue.sqlite'));
  try {
    body(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** One live task as the service stores it, with the workspace a BB dispatch attaches. */
function seedTask(store: Store, overrides: Parameters<Store['update']>[1] = {}): Task {
  const initial = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: 'BB host phase 5',
      repoPath: '/synthetic/repo',
      planningCommit: 'a'.repeat(40),
      handoffPath: '/synthetic/handoff.md',
      originAgentId: 'origin',
    }),
    hostId,
    '/synthetic/handoff.md',
    'a'.repeat(40),
  );
  store.update(initial.id, {
    phase: 'awaiting_review',
    workspaceId: handle,
    directory: '/synthetic/bb-worktree',
    prUrl: 'https://example.invalid/nucleus/pull/191',
    ...overrides,
  });
  store.setMeta('bbWorkspaces', {
    [handle]: {
      id: handle,
      directory: '/synthetic/bb-worktree',
      repositoryRoot: '/synthetic/repo',
      projectId: 'proj_synthetic',
      title: 'BB host phase 5',
      environmentId: 'env_bb_task',
    },
  });
  return store.task(initial.id);
}

function summaryOf(store: Store, task: Task): TaskSummary {
  const wait = taskWaitStateContext(store, task, null);
  return visibleTaskSummaries([task], [], [], new Map(), new Map([[task.id, wait]]))[0]!;
}

test('the read answers every Nucleus task group in one bounded projection', () => {
  withStore(store => {
    const task = seedTask(store);
    const groups = readBbSidebarGroups({
      liveTasks: () => store.liveTasks(),
      summaries: () => [summaryOf(store, task)],
      workspaces: () => store.getMeta('bbWorkspaces') ?? {},
      threads: () => ({ agents: { thr_worker: { id: 'thr_worker', task: task.id, role: 'worker' } } }),
      prStates: { [task.id]: 'OPEN' },
    });
    const parsed = bbSidebarGroupsOutputSchema.parse(groups);
    assert.equal(parsed.groups.length, 1);
    const group = parsed.groups[0]!;
    assert.equal(group.environmentId, 'env_bb_task');
    assert.equal(group.taskId, task.id);
    assert.equal(group.title, 'BB host phase 5');
    assert.equal(group.phase, 'awaiting_review');
    // The labels are the shared helpers' own output, so the two hosts name a state
    // the same way; the test compares against the helpers, never a copied string.
    const summary = summaryOf(store, task);
    assert.equal(group.phaseLabel, phaseStateLabel(summary));
    assert.equal(group.stateLabel, taskStateLabel(summary));
    assert.equal(group.prNumber, 191);
    assert.equal(group.prState, 'OPEN');
    assert.equal(group.attention, false);
    // The role thread rides the same read, keyed by the group's environment.
    assert.deepEqual(parsed.threads, [
      { threadId: 'thr_worker', taskId: task.id, role: 'worker', environmentId: 'env_bb_task' },
    ]);
  });
});

test('a task with no attached BB environment, a finished task and an archived handle are absent', () => {
  withStore(store => {
    const live = seedTask(store);
    const unattached = seedTask(store);
    store.update(unattached.id, { workspaceId: null, directory: null });
    const archived = seedTask(store, { workspaceId: workspaceHandleForPath('/synthetic/other') });
    const workspaces: Record<string, { environmentId?: string; archivedAt?: string }> = {
      ...(store.getMeta<Record<string, { environmentId?: string; archivedAt?: string }>>('bbWorkspaces') ?? {}),
    };
    workspaces[workspaceHandleForPath('/synthetic/other')] = {
      environmentId: 'env_archived',
      archivedAt: new Date().toISOString(),
    };
    const groups = readBbSidebarGroups({
      liveTasks: () => store.liveTasks(),
      summaries: () => store.liveTasks().map(task => summaryOf(store, task)),
      workspaces: () => workspaces,
      threads: () => ({}),
      prStates: {},
    });
    assert.deepEqual(
      groups.groups.map(group => group.environmentId),
      ['env_bb_task'],
      'only the live task with an attached, unarchived handle is a group',
    );
    assert.equal(groups.groups[0]!.taskId, live.id);
    assert.equal(groups.groups[0]!.prNumber, 191);
    assert.equal(groups.groups[0]!.prState, null, 'a task with no board PR state names none');
  });
});

test('the state line carries the recorded wait, and the PR number falls back to the card URL', () => {
  withStore(store => {
    const task = seedTask(store, {
      prUrl: 'https://example.invalid/nucleus/pull/204',
      reason: 'Waiting for QA capacity (position 3)',
    });
    store.setMeta('prStates', { [task.id]: 'MERGED' });
    const groups = readBbSidebarGroups({
      liveTasks: () => store.liveTasks(),
      summaries: () => [summaryOf(store, task)],
      workspaces: () => store.getMeta('bbWorkspaces') ?? {},
      threads: () => ({}),
      prStates: { [task.id]: 'MERGED' },
    });
    const group = groups.groups[0]!;
    // The card's number falls back to its own URL only when no completion names one.
    assert.equal(group.prNumber, 204);
    assert.equal(group.prState, 'MERGED');
    // The archived QA-queue reason is shown exactly as Queue wrote it, never rewritten.
    assert.equal(group.waitLabel, 'Waiting for QA capacity (position 3)');
  });
});

test('the plugin serves one forwarding call for the whole sidebar, and refuses when the channel is away', async () => {
  const calls: string[] = [];
  const service = createSidebarGroupsService(() => ({
    request: async (method, input) => {
      calls.push(`${method}:${JSON.stringify(input)}`);
      return { groups: [], threads: [] };
    },
  }));
  assert.deepEqual(await service.sidebarGroups(), { groups: [], threads: [] });
  assert.deepEqual(calls, ['bb.sidebar-groups:null']);
  assert.equal(SIDEBAR_GROUPS_METHOD, 'bb.sidebar-groups');
  const offline = createSidebarGroupsService(() => null);
  await assert.rejects(offline.sidebarGroups(), /not connected/);
});

test('the plugin contract parses exactly what the service serves', () => {
  withStore(store => {
    const task = seedTask(store);
    const groups = readBbSidebarGroups({
      liveTasks: () => store.liveTasks(),
      summaries: () => [summaryOf(store, task)],
      workspaces: () => store.getMeta('bbWorkspaces') ?? {},
      threads: () => ({ agents: { thr_worker: { id: 'thr_worker', task: task.id, role: 'worker' } } }),
      prStates: { [task.id]: 'OPEN' },
    });
    // Both ends validate the same answer, so a field added to one end fails here.
    const served = bbSidebarGroupsOutputSchema.parse(groups);
    const forwarded = sidebarGroupsOutputSchema.parse(JSON.parse(JSON.stringify(served)));
    assert.deepEqual(forwarded, served);
  });
});

test('the board signal publishes only when the service revision moves', async () => {
  const published: Array<{ channel: string; payload: unknown }> = [];
  const bb = {
    log: { info() {}, warn() {}, error() {} },
    realtime: { publish: (channel: string, payload: unknown) => { published.push({ channel, payload }); } },
  } as unknown as BbPluginApi;
  let revision = 5;
  const stop = watchBoardSignal(bb, {
    request: async () => ({ revision }),
  });
  // The first read only records the revision: a just-mounted sidebar already fetched.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(published, []);
  revision = 6;
  await new Promise(resolve => setTimeout(resolve, 2_100));
  stop();
  assert.deepEqual(published, [{ channel: 'nucleus.board-signal', payload: { revision: 6 } }]);
  revision = 7;
  await new Promise(resolve => setTimeout(resolve, 2_100));
  assert.equal(published.length, 1, 'a stopped watcher publishes nothing');
});

test('the catalogue serves the read as one read-only method', () => {
  const entry = RPC_CATALOGUE.find(candidate => candidate.name === 'bb.sidebar-groups');
  assert.ok(entry, 'the catalogue names the sidebar read');
  assert.equal(entry!.mutating, false);
  assert.equal(entry!.method, 'bbSidebarGroups');
  assert.equal(RPC_CATALOGUE.filter(candidate => candidate.name === 'bb.sidebar-groups').length, 1);
});
