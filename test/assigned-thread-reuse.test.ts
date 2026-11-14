import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskSchema, type Task } from '../shared/contracts';
import type { LaunchThreadContext } from '../core/dispatch/launch';
import { observeAssignedThread } from '../core/dispatch/run-launch/assigned-thread';

const base = 'a'.repeat(40), head = 'b'.repeat(40);
const state = (workspaceId: string | null) => ({ id: 'agent', workspaceId, status: 'idle' as const, active: false, permissions: false, error: '' });

function task(overrides: Partial<Task> = {}): Task {
  return taskSchema.parse({
    submissionId: 's', title: 'T', repoPath: '/repo', planningCommit: base, handoffPath: 'h.md', originAgentId: 'o',
    id: 'task-1', hostId: 'host', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1, phase: 'queued', reason: '', held: false, handoffText: '', planningBase: base,
    workspaceId: 'ws', directory: '/worktree', branch: 'ns-task-1', agentId: null, runId: null, profile: null,
    workspaceIntent: false, agentIntent: false, lastAgentStatus: null, idleSince: null, completion: null,
    agentActive: null, lastObservedAt: null, prUrl: null, prHead: head, coordinatorGeneration: 1,
    ...overrides,
  });
}

function context(observed: { id: string; workspaceId: string | null; status: string; active: boolean; permissions: boolean; error: string }, events: string[] = []): LaunchThreadContext {
  return {
    host: { observe: async () => observed as never },
    adapter: {},
    store: {
      event: (_id: string, kind: string) => { events.push(kind); },
      runs: () => [],
      pool: () => [],
    },
    resolveWithdrawnPending: async () => false,
    waiting: (target: Task, reason: string) => { events.push(`wait: ${reason}`); target.reason = reason; },
  } as unknown as LaunchThreadContext;
}

/** A launch has already computed its workspace by now; a `null` here is the runtime fault the guard catches. */
const reuse = async (observed: ReturnType<typeof state>, candidate: Task, role: 'reviewer' | 'revision' | 'closeout', workspaceId: string | null) =>
  observeAssignedThread(context(observed), candidate, role, 'agent', workspaceId as string, () => false);

test('a retained thread without a workspace is a fault for every role', async () => {
  await assert.rejects(
    () => reuse(state(null), task({ workspaceId: null, directory: null }), 'reviewer', null),
    /Assigned coordinator has no workspace/,
    'a reviewer whose task names no workspace and whose thread observed none is a fault, not a launch',
  );
  await assert.rejects(
    () => reuse(state(null), task({ workspaceId: null, directory: null }), 'revision', null),
    /Assigned coordinator has no workspace/,
  );
  await assert.rejects(
    () => reuse(state(null), task(), 'closeout', null),
    /Assigned coordinator has no workspace/,
    'a retained coordinator that observed no workspace is a fault',
  );
});

test('a leaked thread and a coordinator workspace resolve from the observation', async () => {
  await assert.rejects(
    () => reuse(state('other-workspace'), task(), 'reviewer', 'ws'),
    /Retained thread left the worker workspace/,
  );
  assert.deepEqual(await reuse(state('coordinator-workspace'), task(), 'closeout', 'ws'),
    { kind: 'reuse', workspaceId: 'coordinator-workspace' }, 'the coordinator resumes in the workspace it observed');
  assert.deepEqual(await reuse(state('ws'), task(), 'revision', 'ws'),
    { kind: 'reuse', workspaceId: 'ws' }, 'the revision resumes in the task workspace');
});

test('a busy thread records its wait instead of reusing the binding', async () => {
  const candidate = task();
  const result = await observeAssignedThread(context(state('ws')), candidate, 'reviewer', 'agent', 'ws', () => true);
  assert.deepEqual(result, { kind: 'handled' });
  assert.match(candidate.reason, /Assigned thread is serving another request/);
});
