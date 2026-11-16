import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { projectSchema, submissionSchema, visibleTaskSummaries, type Task } from '../shared/contracts';
import { taskStopRecord } from '../shared/task-stop';

/**
 * The board projection reads typed facts for the two things it used to decode
 * from detail text (nucleus#1252): the prerequisite a wait names, and the agent a
 * blocker escalation waits with. A record written before those fields existed
 * keeps the projection it had, so these are those boundaries on both shapes.
 */
const head = 'a'.repeat(40), at = '2026-10-27T00:00:00.000Z';
const repo = { origin: 'owner/app', path: '/app' };
const project = projectSchema.parse({ key: 'app', name: 'App', repositories: [repo], primary: repo });

function seed(store: Store, id: string, patch: Partial<Task>) {
  const inserted = store.insert(submissionSchema.parse({
    submissionId: id, title: id, repoPath: '/app', planningCommit: head, handoffPath: `${id}.md`, originAgentId: '0b355fd4',
  }), 'host', 'handoff', head);
  return store.update(inserted.id, { notificationAgentId: '56e9c969', originError: '', originLookupError: '', ...patch });
}

test('the board names the prerequisite a generated dependency wait refers to', () => {
  const store = new Store(':memory:');
  try {
    const prerequisite = seed(store, 'prerequisite', { phase: 'queued', number: 248, reference: 'project-c#248' });
    const reason = `Waiting for prerequisites: A merged prerequisite (${prerequisite.id}): cancelled`;
    const waiting = seed(store, 'waiting', { phase: 'queued', dependsOn: [prerequisite.id], reason });
    const context = new Map([[waiting.id, { dependencyWait: reason }]]);
    const card = visibleTaskSummaries([store.task(prerequisite.id), store.task(waiting.id)], [project], [], new Map(), context)
      .find(task => task.id === waiting.id)!;
    assert.equal(card.waitingOn, 'project-c#248');
  } finally { store.close(); }
});

test('an escalation names the holder its record typed, and a record from before the field keeps its owner', () => {
  const store = new Store(':memory:');
  try {
    const holder = '7a3c4bc4-e0db-48bb-9071-4ae6f3a09222';
    const plannerProject = projectSchema.parse({ ...project, planner: { agentId: holder, setBy: 'operator', setAt: at } });
    const detail = `Waiting with the planner or task owner ${holder}: blocker escalation ${'f'.repeat(64)} is open`;
    const task = seed(store, 'escalated', { phase: 'blocked' });
    const withStop = (stop: ReturnType<typeof taskStopRecord>) => store.update(task.id, {
      resolution: { ...store.task(task.id).resolution, stop },
    });

    // A record from before the field: the stop owner's legacy decode keeps the name.
    withStop(taskStopRecord('escalated', detail, null, at));
    const [legacy] = visibleTaskSummaries([store.task(task.id)], [plannerProject]);
    assert.equal(legacy.stopRecord?.holderAgentId, undefined);
    assert.equal(legacy.stopDisplayOwner, 'App planner');

    // A record the ladder writes now: the typed field is the fact.
    withStop(taskStopRecord('escalated', detail, null, at, [], holder));
    const [typed] = visibleTaskSummaries([store.task(task.id)], [plannerProject]);
    assert.equal(typed.stopRecord?.holderAgentId, holder);
    assert.equal(typed.stopDisplayOwner, 'App planner');

    // The field decides, even when the sentence still names another thread: a
    // requester that is not the project planner reads as "a planner thread".
    const other = '0b355fd4-1111-4222-8333-944455556666';
    withStop(taskStopRecord('escalated', detail, null, at, [], other));
    const [mismatch] = visibleTaskSummaries([store.task(task.id)], [plannerProject]);
    assert.equal(mismatch.stopRecord?.holderAgentId, other);
    assert.equal(mismatch.stopDisplayOwner, 'a planner thread');
  } finally { store.close(); }
});
