import { Engine } from '../core/engine';
import type { Adapter } from '../core/host/adapter';
import { hostIndependentControlRefusal } from '../core/host/host-independent-refusals';
import { moveStateRefusal, stopStateRefusal } from '../core/verbs/control-refusals';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { dispositionSchema, runSchema, submissionSchema, taskControlInputSchema, type Task } from '../shared/contracts';
import { completeStateRefusal, routeStateRefusal } from '../core/verbs/control-refusals';
import { liveRun, liveRunForRole, restartResumeChoice, taskNeverDispatched } from '../core/task-decision-rules';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';

function fixture() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'task-decisions-')), 'queue.sqlite'));
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Shared task decisions',
    repoPath: '/fixture-repository', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
  return { store, task };
}

test('never-dispatched includes creation intents and directory evidence in both view and completion admission', () => {
  const { store, task } = fixture();
  try {
    assert.equal(taskNeverDispatched(task, []), true);
    assert.match(completeStateRefusal(task, [])!, /never dispatched/);
    for (const patch of [{ workspaceIntent: true }, { directory: '/fixture-task' }, { agentIntent: true }]) {
      const dispatched = store.update(task.id, { ...patch, phase: 'blocked' });
      assert.equal(taskNeverDispatched(dispatched, []), false);
      assert.equal(completeStateRefusal(dispatched, []), null);
      const view = ownerTaskNext(collectOwnerVerbFacts(store, dispatched)).verbs.find(verb => verb.verb === 'complete');
      assert.equal(view?.available, true);
      store.update(task.id, { workspaceIntent: false, directory: null, agentIntent: false });
    }
  } finally { store.close(); }
});

test('a reported unreleased role run is history for routing and the active participant', () => {
  const { store, task } = fixture();
  try {
    for (const [role, routeRole] of [['reviewer', 'reviewer'], ['recovery', 'coordinator'], ['revision', 'worker']] as const) {
      const run = runSchema.parse({ id: `run-${role}`, taskId: task.id, role, generation: 1, head: 'a'.repeat(40), base: 'b'.repeat(40),
        profile: null, lastObservedAt: null, active: null, idleSince: null,
        agentId: 'agent', workspaceId: 'workspace', status: 'running', createdAt: new Date().toISOString(),
        completion: { eventId: `event-${role}`, taskId: task.id, runId: `run-${role}`, status: 'blocked', summary: 'Reported' }, released: false });
      store.putRun(run);
      const current = store.update(task.id, { phase: 'blocked', resolution: { ...task.resolution, currentRunId: run.id } });
      assert.equal(liveRun(run), false);
      assert.equal(liveRunForRole(current, [run], routeRole), null);
      assert.equal(ownerTaskNext(collectOwnerVerbFacts(store, current)).activeRun, null);
      const pending = { ...run, completion: null };
      assert.equal(liveRunForRole(current, [pending], routeRole)?.run?.id, run.id);
    }
  } finally { store.close(); }
});

test('completion and routing share refusal precedence', () => {
  const { store, task } = fixture();
  try {
    const completed = { ...task, phase: 'done' as const, prUrl: 'https://example.test/pr/1' };
    assert.match(completeStateRefusal(completed, [])!, /unfinished task/);
    assert.match(routeStateRefusal(completed)!, /unfinished, unmerged/);
    const merging = { ...task, resolution: { ...task.resolution, mergeIntent: true }, prUrl: completed.prUrl };
    assert.match(completeStateRefusal(merging, [])!, /merging or merged/);
    assert.match(completeStateRefusal({ ...task, prUrl: completed.prUrl }, [])!, /has a PR/);
  } finally { store.close(); }
});

test('restart uses one resume choice before and after admission', () => {
  const { store, task } = fixture();
  try {
    assert.equal(restartResumeChoice(task, 'blocked_worker'), 'worker');
    assert.equal(restartResumeChoice(task, 'stopped_revision'), 'revision');
    assert.equal(restartResumeChoice(task, 'blocked_with_pr'), 'review');
    assert.equal(restartResumeChoice(task, 'retained_worker'), 'retry');
    const parked = { ...task, prerequisiteWait: { releasedAt: new Date().toISOString() },
      resolution: { ...task.resolution, prePrResumeInstruction: 'Continue' } } as Task;
    assert.equal(restartResumeChoice(parked, 'retained_worker'), 'worker');
  } finally { store.close(); }
});


test('move targets keep handler precedence across view, direct apply and offline admission', async () => {
  const { store, task } = fixture();
  const engine = new Engine(store, {} as Adapter, 0);
  const disposition = dispositionSchema.parse({ kind: 'cancel', status: 'intent', requestedAt: new Date().toISOString(),
    requestedBy: 'operator', reason: 'Cancel', workDisposition: 'archive_if_empty' });
  try {
    for (const state of ['terminal', 'merging', 'disposition', 'terminal-and-disposition', 'merging-and-disposition'] as const) {
      const current = store.update(task.id, { phase: state.startsWith('terminal') ? 'done' : 'working',
        disposition: state.includes('disposition') ? disposition : null,
        resolution: { ...task.resolution, mergeIntent: state.startsWith('merging') } });
      const facts = collectOwnerVerbFacts(store, current);
      for (const to of ['review', 'work', 'merge'] as const) {
        const refusal = moveStateRefusal(current, to)!;
        assert.ok(refusal, `${state}/${to}`);
        const view = ownerTaskNext(facts).verbs.filter(verb => verb.verb === 'move').find(verb => verb.refusal?.startsWith(`move ${to}:`));
        assert.equal(view?.refusal, `move ${to}: ${refusal}. A planner or operator can use force with a reason`);
        const input = taskControlInputSchema.parse({ taskId: task.id, version: current.version, action: 'move', to, reason: 'Move' });
        assert.equal(hostIndependentControlRefusal(engine, input), refusal);
        const apply = to === 'review' ? engine.moveToReview.bind(engine) : to === 'work' ? engine.moveToWork.bind(engine) : engine.moveToMerge.bind(engine);
        await assert.rejects(apply({ taskId: task.id, version: current.version, reason: 'Move' }), error => error instanceof Error && error.message === refusal);
      }
    }
  } finally { await engine.stop(); store.close(); }
});

test('stop refusals agree across view, direct apply and offline admission', async () => {
  const { store, task } = fixture();
  const engine = new Engine(store, {} as Adapter, 0);
  const disposition = dispositionSchema.parse({ kind: 'cancel', status: 'intent', requestedAt: new Date().toISOString(),
    requestedBy: 'operator', reason: 'Cancel', workDisposition: 'archive_if_empty' });
  try {
    for (const phase of ['done', 'cancelled', 'working'] as const) for (const disposed of [false, true]) {
      const current = store.update(task.id, { phase, disposition: disposed ? disposition : null,
        resolution: { ...task.resolution, mergedCommit: phase === 'working' ? 'a'.repeat(40) : null } });
      const refusal = stopStateRefusal(current)!;
      const view = ownerTaskNext(collectOwnerVerbFacts(store, current)).verbs.find(verb => verb.verb === 'stop');
      assert.equal(view?.refusal, refusal);
      const input = taskControlInputSchema.parse({ taskId: task.id, version: current.version, action: 'stop', reason: 'Stop' });
      assert.equal(hostIndependentControlRefusal(engine, input), refusal);
      await assert.rejects(engine.stopTask(input), error => error instanceof Error && error.message === refusal);
      const integrationTask = { ...current, resolution: { ...current.resolution, integrationTurn: { sequence: 1 } } } as Task;
      assert.equal(stopStateRefusal(integrationTask), null, 'stop still releases an integration turn after termination or disposition');
    }
    const unstarted = store.update(task.id, { phase: 'queued', disposition: null, resolution: task.resolution });
    assert.equal(ownerTaskNext(collectOwnerVerbFacts(store, unstarted)).verbs.find(verb => verb.verb === 'stop')?.available, true,
      'the handler can park an unstarted task under a dispatch hold');
  } finally { await engine.stop(); store.close(); }
});
