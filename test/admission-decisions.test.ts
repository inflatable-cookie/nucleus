import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submissionSchema, taskSchema } from '../shared/contracts';
import { capacityLimitFor, capacityReason, decideSlotAdmission, type CapacityLimit } from '../core/dispatch/capacity';
import { dispatchGate } from '../core/dispatch/dispatch-decisions';
import { taskStopRecord } from '../shared/task-stop';

const base = 'a'.repeat(40);
const submission = submissionSchema.parse({ submissionId: 's', title: 'T', repoPath: '/r', planningCommit: base, handoffPath: 'h.md', originAgentId: 'o' });
const task = taskSchema.parse({ ...submission, id: 't', hostId: 'h', createdAt: 'now', updatedAt: 'now', version: 1, phase: 'queued', reason: '', held: false, handoffText: '', planningBase: base, workspaceId: null, directory: null, branch: 'ns-t', agentId: null, runId: null, profile: null, workspaceIntent: false, agentIntent: false, lastAgentStatus: null, idleSince: null, completion: null, agentActive: null, lastObservedAt: null, prUrl: null, prHead: null, coordinatorGeneration: 1 });

test('dispatch gate returns the first stop', () => {
  const cases = [
    [{ task }, ''],
    [{ transientWaiting: true, task }, 'transient'],
    [{ selectionAvailable: false }, 'route'],
    [{ task: { ...task, phase: 'working' as const }, stopped: true }, 'task'],
    [{ task, paused: true, catalogKnown: false }, 'paused'],
    [{ task, dispatchHeld: true }, 'dispatch held'],
    [{ catalogKnown: false, dependencyWait: 'wait' }, 'catalog'],
    [{ dependencyWait: 'wait', capacity: 'full' }, 'dependency'],
    [{ capacity: 'full' }, 'capacity'],
  ] as const;
  for (const [facts, expected] of cases) assert.equal(dispatchGate(facts), expected);
});

test('slot admission names occupancy and earlier reservations', () => {
  const earlier = { ...task, id: 'earlier', number: 1 };
  const running = { ...earlier, agentActive: true };
  const review = { ...earlier, phase: 'awaiting_review' as const };
  const policy = { limit: 1, projectKeyFor: (candidate: typeof task) => candidate.repoPath };
  const cases: { tasks: (typeof task)[]; global: number; project: number; capacity: CapacityLimit | null; requests: (typeof task)[]; waiters: (typeof task)[]; expected: string }[] = [
    { tasks: [task], global: 2, project: 2, capacity: null, requests: [task], waiters: [], expected: '' },
    { tasks: [task, running], global: 1, project: 2, capacity: 'global', requests: [], waiters: [], expected: 'Waiting for a project slot… Global concurrent task-slot limit reached (1/1 occupied: #001)' },
    { tasks: [task, running, review], global: 1, project: 2, capacity: 'global', requests: [], waiters: [review], expected: 'Waiting for a project slot… Global concurrent task-slot limit reached (1/1 occupied: #001; 1 waiting without a slot: #001)' },
    { tasks: [task, review], global: 1, project: 2, capacity: null, requests: [review, task], waiters: [], expected: 'Waiting for a project slot… waiting behind 1 in-flight: #001' },
    { tasks: [task, earlier], global: 1, project: 2, capacity: null, requests: [earlier, task], waiters: [], expected: 'Waiting for a project slot… Waiting behind 1 earlier queued reservations (0/1 global slots occupied)' },
    { tasks: [task, earlier], global: 2, project: 1, capacity: null, requests: [earlier, task], waiters: [], expected: 'Waiting for a project slot… Project concurrent task-slot limit reached (0/1 occupied, 1 reserved by earlier requests)' },
  ];
  for (const c of cases) assert.equal(decideSlotAdmission(task, c.tasks, c.global, () => c.project, policy, c.capacity, c.requests, c.waiters), c.expected);
});

test('capacity names the limit that refuses the request, not a message prefix', () => {
  const running = { ...task, agentActive: true };
  assert.equal(capacityLimitFor(task, [task], 2, 2), null, 'an idle lifecycle holds no slot');
  assert.equal(capacityLimitFor(task, [task, running], 1, 2), 'global');
  assert.equal(capacityLimitFor(task, [task, running], 2, 1), 'project');
  const papercut = { ...task, papercutTask: true };
  const policy = { limit: 1, projectKeyFor: (candidate: typeof task) => candidate.repoPath };
  assert.equal(capacityLimitFor(papercut, [papercut, { ...papercut, agentActive: true }], 9, 9, policy), 'papercut', 'a papercut request is capped by its own project pool');
  assert.deepEqual(
    (['global', 'project', 'papercut'] as const).map(capacityReason),
    ['Global concurrent task-slot limit reached', 'Project concurrent task-slot limit reached', 'Project papercut task-slot limit reached'],
  );
});

test('slot request decisions preserve eligibility gates', async () => {
  const { slotRequestDecision } = await import('../core/dispatch/capacity');
  const phases = ['awaiting_review', 'changes_requested'];
  // A route wait is the recorded typed stop, exactly what dispatch writes.
  const routeStop = taskStopRecord('route_unavailable', 'no eligible worker');
  const routeWaiter = { ...task, reason: routeStop.detail, resolution: { ...task.resolution, stop: routeStop } };
  const cases = [
    [task, {}, 'read'],
    [task, { dependencyWait: '' }, true],
    [task, { dependencyWait: 'wait' }, false],
    [routeWaiter, {}, 'read'],
    [routeWaiter, { routingRetryAllowed: false }, false],
    [{ ...task, agentActive: true }, {}, false],
    [{ ...task, phase: 'needs_attention' as const }, {}, false],
  ] as const;
  for (const [candidate, facts, expected] of cases) assert.equal(slotRequestDecision(candidate, phases, false, facts), expected);
});
