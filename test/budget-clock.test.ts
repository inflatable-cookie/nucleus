import { test } from './support/sharded-test';
import assert from 'node:assert/strict';
import { taskBudget } from '../shared/task-budget';
import { taskDetailView } from '../shared/task-view';
import { ownerTaskNext, collectOwnerVerbFacts } from '../core/verbs/owner-verbs';
import { fixture, tick } from './support/responsible-lifecycle-fixture';

/**
 * Spec 058 budgets (nucleus#1153): the T3 trial (swallowtail#225/#226) stopped at
 * `awaiting_review` with `Budget reached` and `suggestedVerbs: []`, raised no
 * question, and spent 90 minutes parked until a person extended both by hand.
 * Most of the 180 minutes had gone on Nucleus defects, not the tasks' work.
 *
 * These are the two promises that broke: a budget stop always asks its question
 * and names `extend_budget`, and time held on a Nucleus-side cause does not
 * spend the budget.
 */

const MINUTE = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const settle = async (ready: () => boolean) => {
  for (let pass = 0; pass < 30 && !ready(); pass++) await tick();
  assert.ok(ready());
};

test('a budget stop at awaiting_review names extend_budget and asks its question', async () => {
  const f = fixture({ responsible: true });
  try {
    // The worker reported and opened the PR hours ago; the wall-time limit is spent.
    f.store.update(f.submitted.id, { budgetSince: iso(Date.now() - 4 * 60 * MINUTE) });
    await f.engine.wake();
    const stopped = f.current();
    assert.equal(stopped.phase, 'awaiting_review');
    assert.equal(stopped.resolution.stop?.reason, 'budget', `no review run starts over budget: ${stopped.reason}`);
    assert.deepEqual(stopped.resolution.stop?.suggestedVerbs, ['extend_budget'],
      'the pause names the verb that answers it');
    // The question is raised on the same pass that records the pause, not only by
    // the sweep's later support step.
    await settle(() => f.asks.length === 1);
    assert.match(f.asks[0]!.question, /reached its budget/);
    assert.ok(f.asks[0]!.options.includes('Extend the budget'), f.asks[0]!.options.join(' | '));
  } finally { await f.close(); }
});

test('a budget question is recorded for every phase, even with the task host offline', async () => {
  const f = fixture({ responsible: true });
  try {
    // The host went offline (or a run carried another host's identity) after the
    // pause was recorded; neither may silence it: the board records questions
    // without the task's host (#1153).
    f.engine.hostAvailable = id => id !== 'host';
    f.store.update(f.submitted.id, { budgetSince: iso(Date.now() - 4 * 60 * MINUTE) });
    f.engine.resolution.recordStop(f.current(), 'budget', 'Budget reached: 180 minutes of wall time since the responsible lifecycle began');
    assert.deepEqual(f.current().resolution.stop?.suggestedVerbs, ['extend_budget']);
    await f.engine.wake();
    assert.equal(f.current().resolution.stop?.reason, 'budget');
    await settle(() => f.store.listDecisions({ status: 'open', task: f.submitted.id }).length === 1);
    const [decision] = f.store.listDecisions({ status: 'open', task: f.submitted.id });
    assert.match(decision!.question, /reached its budget/);
    assert.equal(f.asks.length, 0, 'no native prompt was attempted on an offline host');
    assert.match(f.store.eventsAll(f.submitted.id).find(event => event.kind === 'operator_question_decision')!.detail, /offline/,
      'the board question records why it is there instead of on the thread');
  } finally { await f.close(); }
});

/** Place or release a dispatch hold the way the control path stores it. */
const setDispatchHold = (f: ReturnType<typeof fixture>, reason: string | null, at: string) =>
  f.store.update(f.current().id, reason
    ? { held: true, mergeHold: false, holdOwner: 'operator', holdReason: reason, holdAt: at,
        holds: { dispatch: { owner: 'operator', reason, at, generation: 1, until: null } } } as never
    : { held: false, mergeHold: false, holdOwner: null, holdReason: null, holdAt: null, holds: {} } as never,
  reason ? 'dispatch_held' : 'dispatch_released');

test('a dispatch hold does not spend the wall-time budget', async () => {
  const f = fixture({ responsible: true });
  try {
    const start = Date.now() - 70 * MINUTE;
    f.store.update(f.submitted.id, { budgetSince: iso(start) });
    setDispatchHold(f, 'waiting on the Nucleus fix for the wedged sweep', iso(start + 10 * MINUTE));
    // The pass that observes the hold opens the pause interval...
    f.engine.resolution.settleBudgetClock(f.current());
    const opened = f.current().resolution.budgetClock!;
    assert.ok(opened.since, 'the interval is open while the task is held');
    // ...and it is dated from the hold, not from the pass that noticed it.
    f.store.update(f.current().id, { resolution: { ...f.current().resolution, budgetClock: { ...opened, since: iso(start + 10 * MINUTE) } } });
    setDispatchHold(f, null, iso(Date.now()));
    // Releasing the hold closes the interval: 60 of the 70 elapsed minutes were
    // Nucleus's, so the task has 10 minutes of its own work on the clock.
    f.engine.resolution.settleBudgetClock(f.current());
    const clock = f.current().resolution.budgetClock!;
    assert.equal(clock.since, null, 'the clock runs again once the task can make progress');
    assert.equal(clock.pauses, 1);
    assert.ok(Math.abs(clock.pausedMs - 60 * MINUTE) < MINUTE, `paused ${clock.pausedMs} ms`);
    const budget = taskBudget(f.current(), f.store.runs(f.submitted.id), Date.now());
    assert.equal(budget.exhausted, null, 'the held hour never reaches the limit');
    assert.ok(Math.abs(budget.wallMs.used - 10 * MINUTE) < MINUTE, `used ${budget.wallMs.used} ms`);
    assert.ok(Math.abs(budget.wallMs.pausedMs - 60 * MINUTE) < MINUTE);
    assert.equal(ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).verbs.find(view => view.verb === 'extend_budget')?.available, false);
    // The intervals are durable telemetry, not only an in-memory discount.
    assert.equal(f.events('budget_clock_paused').length, 1);
    assert.equal(f.events('budget_clock_resumed').length, 1);
    assert.match(taskDetailView(f.current(), {}, f.store.runs(f.submitted.id)).budget!.wallMs.pausedMs.toString(), /^359|^360/);
  } finally { await f.close(); }
});

test('a Nucleus-fault wait and an observation outage do not spend the wall-time budget', async () => {
  const f = fixture({ responsible: true });
  try {
    const start = Date.now() - 100 * MINUTE;
    f.store.update(f.submitted.id, { budgetSince: iso(start) });
    // A Nucleus-side routing refusal: the task can start no run of its own.
    f.engine.resolution.recordStop(f.current(), 'route_unavailable', 'No runnable profile for the reviewer role');
    f.engine.resolution.settleBudgetClock(f.current());
    const opened = f.current().resolution.budgetClock!;
    assert.equal(opened.reason, 'the task waits on Nucleus: route_unavailable');
    f.store.update(f.current().id, { resolution: { ...f.current().resolution, budgetClock: { ...opened, since: iso(start + 20 * MINUTE) } } });
    f.engine.resolution.waiting(f.current(), 'Worker running', 'lifecycle');
    f.engine.resolution.settleBudgetClock(f.current());
    assert.equal(f.current().resolution.budgetClock!.since, null);

    // A wedged sweep: the outage is recorded when the quantum overruns its bound
    // and closes when the lane returns — the sweep visits the task meanwhile but
    // only the returned quantum may call it resumed.
    const outageAt = iso(Date.now() - 20 * MINUTE);
    f.store.event(f.submitted.id, 'observation_outage', 'Task quantum did not return within 120 s');
    const events = f.store.eventsAll(f.submitted.id);
    f.store.db.prepare('UPDATE events SET at=? WHERE id=?').run(outageAt, events.findLast(event => event.kind === 'observation_outage')!.id);
    const before = f.current().resolution.budgetClock!.pausedMs;
    f.engine.resolution.settleBudgetClock(f.current());
    assert.equal(f.events('observation_resumed').length, 0, 'a visiting sweep does not claim the lane returned');
    assert.ok(Math.abs(f.current().resolution.budgetClock!.pausedMs - before) < MINUTE, 'the outage interval stays open');
    f.engine.resolution.settleBudgetClock(f.current(), { returned: true });
    assert.ok(f.events('observation_resumed').length > 0, 'the returned lane closes its outage interval');
    const clock = f.current().resolution.budgetClock!;
    assert.ok(Math.abs(clock.pausedMs - 100 * MINUTE) < 2 * MINUTE, `paused ${clock.pausedMs} ms`);
    const budget = taskBudget(f.current(), f.store.runs(f.submitted.id), Date.now());
    assert.equal(budget.exhausted, null, `used ${budget.wallMs.used} ms of ${budget.wallMs.limit}`);
    assert.ok(budget.wallMs.used < 20 * MINUTE);
  } finally { await f.close(); }
});
