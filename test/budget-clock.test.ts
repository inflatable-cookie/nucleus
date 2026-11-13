import { test } from './support/sharded-test';
import assert from 'node:assert/strict';
import { taskBudget } from '../shared/task-budget';
import { summarizeTask, taskDetailView } from '../shared/task-view';
import { TASK_PROGRESSING_REASON } from '../shared/task-detail-summary';
import { runSchema } from '../shared/contracts';
import { ownerTaskNext, collectOwnerVerbFacts } from '../core/verbs/owner-verbs';
import { base, fixture, head, tick } from './support/responsible-lifecycle-fixture';

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
    f.recordRunStart(iso(Date.now() - 4 * 60 * MINUTE));
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
    f.recordRunStart(iso(Date.now() - 4 * 60 * MINUTE));
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
    f.recordRunStart(iso(start));
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
    const budget = taskBudget(f.current(), f.store.runs(f.submitted.id), Date.now(), f.store.eventsAll(f.submitted.id));
    assert.equal(budget.exhausted, null, 'the held hour never reaches the limit');
    assert.ok(Math.abs(budget.wallMs.used - 10 * MINUTE) < MINUTE, `used ${budget.wallMs.used} ms`);
    assert.ok(Math.abs(budget.wallMs.pausedMs - 60 * MINUTE) < MINUTE);
    assert.equal(ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).verbs.find(view => view.verb === 'extend_budget')?.available, false);
    // The intervals are durable telemetry, not only an in-memory discount.
    assert.equal(f.events('budget_clock_paused').length, 1);
    assert.equal(f.events('budget_clock_resumed').length, 1);
    assert.match(taskDetailView(f.current(), {}, f.store.runs(f.submitted.id), f.store.eventsAll(f.submitted.id)).budget!.wallMs.pausedMs.toString(), /^359|^360/);
  } finally { await f.close(); }
});

test('a Nucleus-fault wait and an observation outage do not spend the wall-time budget', async () => {
  const f = fixture({ responsible: true });
  try {
    const start = Date.now() - 100 * MINUTE;
    f.store.update(f.submitted.id, { budgetSince: iso(start) });
    f.recordRunStart(iso(start));
    // A Nucleus-side routing refusal: the task can start no run of its own.
    f.engine.resolution.recordStop(f.current(), 'route_unavailable', 'No runnable profile for the reviewer role');
    f.engine.resolution.settleBudgetClock(f.current());
    const opened = f.current().resolution.budgetClock!;
    assert.equal(opened.reason, 'the task waits on Nucleus: route_unavailable');
    f.store.update(f.current().id, { resolution: { ...f.current().resolution, budgetClock: { ...opened, since: iso(start + 20 * MINUTE) } } });
    f.engine.resolution.waiting(f.current(), 'Worker running', 'lifecycle');
    f.engine.resolution.settleBudgetClock(f.current());
    assert.equal(f.current().resolution.budgetClock!.since, null);

    // A wedged sweep: the sweep records the outage when a quantum overruns its
    // bound, and the pause opens on that first observation — while the lane is
    // still wedged, so the board shows the pause instead of a rising clock. It is
    // dated from the observation, so no outage time depends on when a visit lands.
    const outageAt = iso(Date.now() - 40 * MINUTE);
    f.store.event(f.submitted.id, 'observation_outage', 'Task quantum did not return within 120 s');
    const events = f.store.eventsAll(f.submitted.id);
    f.store.db.prepare('UPDATE events SET at=? WHERE id=?').run(outageAt, events.findLast(event => event.kind === 'observation_outage')!.id);
    const before = f.current().resolution.budgetClock!.pausedMs;
    f.engine.resolution.settleBudgetClock(f.current());
    const open = f.current().resolution.budgetClock!;
    assert.equal(open.reason, 'the sweep could not observe this task (an observation outage)');
    assert.equal(open.since, outageAt, 'the pause is dated from the outage, not from the visit');
    assert.equal(f.events('budget_clock_paused').length, 2, 'the pause is visible in telemetry when it opens');
    assert.equal(f.events('observation_resumed').length, 0, 'a visiting sweep does not claim the lane returned');
    // While the lane is still wedged the budget charges none of the outage, and
    // further sweep visits keep the same interval open.
    f.engine.resolution.settleBudgetClock(f.current());
    assert.equal(f.current().resolution.budgetClock!.since, outageAt, 'a later visit keeps the same pause');
    assert.equal(f.events('budget_clock_paused').length, 2, 'a later visit writes no new pause');
    const whileWedged = taskBudget(f.current(), f.store.runs(f.submitted.id), Date.now(), f.store.eventsAll(f.submitted.id));
    assert.ok(whileWedged.wallMs.used < 30 * MINUTE, `used ${whileWedged.wallMs.used} ms while the lane is wedged`);
    assert.ok(whileWedged.wallMs.pausedMs > 90 * MINUTE, `paused ${whileWedged.wallMs.pausedMs} ms`);
    // The wedged quantum's own finish closes it.
    f.engine.resolution.settleBudgetClock(f.current(), { returned: true });
    assert.ok(f.events('observation_resumed').length > 0, 'the returned lane closes its outage interval');
    assert.equal(f.current().resolution.budgetClock!.since, null);
    const clock = f.current().resolution.budgetClock!;
    assert.ok(Math.abs(clock.pausedMs - 120 * MINUTE) < 2 * MINUTE, `paused ${clock.pausedMs} ms`);
    const budget = taskBudget(f.current(), f.store.runs(f.submitted.id), Date.now(), f.store.eventsAll(f.submitted.id));
    assert.equal(budget.exhausted, null, `used ${budget.wallMs.used} ms of ${budget.wallMs.limit}`);
    assert.ok(budget.wallMs.used < 20 * MINUTE);
    assert.ok(clock.pausedMs > before, 'the outage time is booked, not lost');
  } finally { await f.close(); }
});

test('an outage that returns before any sweep visit still books the outage time', async () => {
  const f = fixture({ responsible: true });
  try {
    const start = Date.now() - 60 * MINUTE;
    f.store.update(f.submitted.id, { budgetSince: iso(start) });
    f.recordRunStart(iso(start));
    // The quantum overran its bound and returned before the next sweep visit could
    // open the interval: the return path alone has to account for the outage.
    const outageAt = iso(Date.now() - 30 * MINUTE);
    f.store.event(f.submitted.id, 'observation_outage', 'Task quantum did not return within 120 s');
    const events = f.store.eventsAll(f.submitted.id);
    f.store.db.prepare('UPDATE events SET at=? WHERE id=?').run(outageAt, events.findLast(event => event.kind === 'observation_outage')!.id);
    f.engine.resolution.settleBudgetClock(f.current(), { returned: true });
    const clock = f.current().resolution.budgetClock!;
    assert.equal(clock.since, null);
    assert.ok(Math.abs(clock.pausedMs - 30 * MINUTE) < MINUTE, `paused ${clock.pausedMs} ms`);
    assert.equal(clock.pauses, 1);
    assert.equal(f.events('budget_clock_paused').length, 0, 'the interval was never opened before the return');
    assert.equal(f.events('observation_resumed').length, 1, 'the return closes the outage it observed');
    const budget = taskBudget(f.current(), f.store.runs(f.submitted.id), Date.now(), f.store.eventsAll(f.submitted.id));
    assert.ok(Math.abs(budget.wallMs.used - 30 * MINUTE) < MINUTE, `used ${budget.wallMs.used} ms`);
    assert.ok(Math.abs(budget.wallMs.pausedMs - 30 * MINUTE) < MINUTE);
  } finally { await f.close(); }
});

test('a proven pre-send refusal does not spend the budget until an owner resumes the task', async () => {
  const f = fixture({ responsible: true });
  try {
    const start = Date.now() - 90 * MINUTE;
    f.store.update(f.submitted.id, { budgetSince: iso(start) });
    f.recordRunStart(iso(start));
    // The exact durable shape a refused worker creation leaves (see the t3/identity
    // suite): the refusal event, the park in attention and the refused reason.
    f.store.update(f.current().id, { phase: 'needs_attention', agentIntent: false, runId: null,
      reason: 'Worker creation refused before send: no reasoning effort for this model',
      resolution: { ...f.current().resolution, attention: true } }, 'worker_creation_refused_before_send',
    'Worker creation refused before send: no reasoning effort for this model');
    f.engine.resolution.settleBudgetClock(f.current());
    const open = f.current().resolution.budgetClock!;
    assert.equal(open.reason, 'a host-adapter refusal stopped the task before any send');
    assert.ok(open.since, 'the refusal holds the clock');
    // Later sweep visits keep the same interval open rather than reopening it.
    const pausedEvents = f.events('budget_clock_paused').length;
    f.engine.resolution.settleBudgetClock(f.current());
    assert.equal(f.current().resolution.budgetClock!.reason, open.reason);
    assert.equal(f.events('budget_clock_paused').length, pausedEvents, 'a later visit writes no new pause');
    // The task waits on the Nucleus/host fix for 40 minutes without spending its budget.
    f.store.update(f.current().id, { resolution: { ...f.current().resolution,
      budgetClock: { ...open, since: iso(Date.now() - 40 * MINUTE) } } });
    const waiting = taskBudget(f.current(), f.store.runs(f.submitted.id), Date.now(), f.store.eventsAll(f.submitted.id));
    assert.ok(Math.abs(waiting.wallMs.pausedMs - 40 * MINUTE) < MINUTE, `paused ${waiting.wallMs.pausedMs} ms`);
    assert.equal(waiting.exhausted, null, `used ${waiting.wallMs.used} ms of ${waiting.wallMs.limit}`);
    // The owner's resume resolves the attention episode; the clock runs again.
    f.engine.resolution.operatorReturn(f.current(), { attention: false }, { phase: 'queued', reason: 'Waiting for dispatch' },
      'restart', 'The owner resumed the task after the refused creation');
    f.engine.resolution.settleBudgetClock(f.current());
    assert.equal(f.current().resolution.budgetClock!.since, null, 'the resumed task charges its own work again');
    assert.ok(f.current().resolution.budgetClock!.pausedMs >= 40 * MINUTE);
  } finally { await f.close(); }
});

/**
 * oxide#083 (nucleus#1187): the task view reported `0 used` while the dispatcher
 * refused the task at "16982 of 1920 minutes". Its only run was the initial worker,
 * which is stored on the task row and has no run row at all, so the gate measured
 * from a legacy conversion twelve days earlier while the views had nothing to
 * measure from. This is that shape: a legacy `responsible_converted` event, a
 * released legacy hold that left no hold event, the worker's own run start, and the
 * clock pauses a recent Nucleus-side wait wrote.
 */
test('a task whose only run has no run row is charged from its recorded run start, and its gate and views agree', async () => {
  const f = fixture({ responsible: true });
  try {
    // oxide#083 is high (1920 minutes of wall time): the old figure was 16982 of 1920.
    f.store.update(f.submitted.id, { complexity: 'high' });
    f.store.event(f.submitted.id, 'responsible_converted', 'legacy responsible conversion');
    f.store.db.prepare('UPDATE events SET at=? WHERE id=?')
      .run(iso(Date.now() - 12 * 24 * 60 * MINUTE), f.events('responsible_converted').at(-1)!.id);
    // The legacy dispatch hold was released and left no hold event of its own.
    f.store.update(f.submitted.id, { held: false, holdAt: iso(Date.now() - 11 * 24 * 60 * MINUTE),
      holdOwner: 'operator', holdReason: 'waiting on the operator', holds: {} } as never, 'hold_released');
    f.recordRunStart(iso(Date.now() - 30 * MINUTE));
    // A recent Nucleus-side wait: the pause and resume the sweep recorded for it.
    f.engine.resolution.recordStop(f.current(), 'route_unavailable', 'No runnable profile for the reviewer role');
    f.engine.resolution.settleBudgetClock(f.current());
    f.engine.resolution.waiting(f.current(), 'Worker running', 'lifecycle');
    f.engine.resolution.settleBudgetClock(f.current());
    assert.equal(f.events('budget_clock_paused').length, 1);
    assert.equal(f.events('budget_clock_resumed').length, 1);

    const runs = f.store.runs(f.submitted.id), events = f.store.eventsAll(f.submitted.id);
    const gate = taskBudget(f.current(), runs, Date.now(), events);
    const detail = taskDetailView(f.current(), {}, runs, events);
    const board = summarizeTask(f.current(), false, false, {}, runs, undefined, 'host', events);
    assert.equal(gate.exhausted, null, `used ${gate.wallMs.used} ms of ${gate.wallMs.limit}`);
    assert.ok(gate.wallMs.used < 31 * MINUTE, `the twelve held days are not charged: ${gate.wallMs.used} ms`);
    // Each read takes its own `Date.now()`; the figures agree to the millisecond.
    assert.ok(Math.abs(detail.budget!.wallMs.used - gate.wallMs.used) < 1000, `detail ${detail.budget!.wallMs.used} vs gate ${gate.wallMs.used}`);
    assert.equal(detail.budget!.effectiveTokens.used, gate.effectiveTokens.used, 'and its token figure');
    assert.ok(Math.abs(board.budget![3] - gate.wallMs.used) < 1000, `board ${board.budget![3]} vs gate ${gate.wallMs.used}`);
    assert.equal(board.budget![5], gate.exhausted, 'and the same exhaustion');

    // The gate itself: the reviewer the old figure refused starts, and no budget
    // pause or question is raised.
    await f.engine.wake();
    await f.engine.quiesce();
    const running = f.current();
    assert.notEqual(running.resolution.stop?.reason, 'budget', running.reason);
    assert.equal(f.reviewerRuns().length, 1, `a review run starts: ${running.reason}`);
    assert.equal(f.asks.filter(ask => /budget/i.test(ask.question)).length, 0, 'no budget question is raised');
    assert.equal(f.store.listDecisions({ status: 'open', task: f.submitted.id }).length, 0);
    assert.equal(f.events('operator_question').filter(event => event.detail.includes('kind budget')).length, 0);
  } finally { await f.close(); }
});

/** nucleus#1187 acceptance 2: real runs over a limit still stop the task, and both reads agree. */
test('a task with real runs over its wall-time budget is still stopped, and its gate and views agree', async () => {
  const f = fixture({ responsible: true });
  try {
    f.store.update(f.submitted.id, { complexity: 'low' });
    // A real resolution run that started two hours ago; the low wall limit is one hour.
    f.store.putRun(runSchema.parse({ id: 'old-revision', taskId: f.submitted.id, role: 'revision', generation: 1,
      head, base, agentId: 'worker', workspaceId: 'workspace', profile: null, status: 'finished',
      createdAt: iso(Date.now() - 120 * MINUTE), lastObservedAt: null, active: false, idleSince: null,
      completion: null, released: true }));
    const runs = f.store.runs(f.submitted.id), events = f.store.eventsAll(f.submitted.id);
    const gate = taskBudget(f.current(), runs, Date.now(), events);
    const detail = taskDetailView(f.current(), {}, runs, events);
    assert.equal(gate.exhausted, 'wall_time');
    assert.equal(detail.budget!.wallMs.used, gate.wallMs.used);
    assert.equal(detail.budget!.exhausted, 'wall_time');
    await f.engine.wake();
    const stopped = f.current();
    assert.equal(stopped.resolution.stop?.reason, 'budget', stopped.reason);
    assert.match(stopped.reason, /Budget reached: 60 minutes of wall time/);
    assert.equal(f.reviewerRuns().length, 0, 'no run starts over budget');
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, stopped));
    assert.equal(next.stop?.reason, 'budget');
    assert.match(next.reason, /Budget reached/);
    assert.equal(next.verbs.find(view => view.verb === 'extend_budget')?.available, true);
  } finally { await f.close(); }
});

/**
 * nucleus#1187 acceptance 3 (papercut 703b4aa3): the read reports the stop its own
 * figure supports. A pause recorded under the old conversion-based measurement keeps
 * its durable record, but once the same records measure from the worker's run start
 * the pause is not the task's stop and "Budget reached" is not its reason.
 */
test('the reason follows the current stop, so a cleared budget pause does not keep reading "Budget reached"', async () => {
  const f = fixture({ responsible: true });
  try {
    f.store.update(f.submitted.id, { complexity: 'high' });
    f.engine.resolution.recordStop(f.current(), 'budget',
      'Budget reached: 16982 of 1920 minutes of wall time since the responsible lifecycle began');
    f.recordRunStart(iso(Date.now() - 30 * MINUTE));
    const paused = f.current();
    assert.equal(paused.resolution.stop?.reason, 'budget', 'the recorded pause survives as history');
    assert.equal(ownerTaskNext(collectOwnerVerbFacts(f.store, paused)).stop, null, 'the figure it named no longer shows a pause');
    assert.equal(ownerTaskNext(collectOwnerVerbFacts(f.store, paused)).reason, TASK_PROGRESSING_REASON);
    const runs = f.store.runs(f.submitted.id), events = f.store.eventsAll(f.submitted.id);
    const detail = taskDetailView(paused, {}, runs, events);
    assert.equal(detail.resolution.stop, null, 'task detail reads no stop either');
    assert.equal(detail.reason, TASK_PROGRESSING_REASON);
    assert.equal(summarizeTask(paused, false, false, {}, runs, undefined, 'host', events).reason, TASK_PROGRESSING_REASON);

    // A genuine pause keeps its text: the same reason field is the recorded stop.
    f.store.update(f.submitted.id, { complexity: 'low' });
    f.store.putRun(runSchema.parse({ id: 'old-revision', taskId: f.submitted.id, role: 'revision', generation: 1,
      head, base, agentId: 'worker', workspaceId: 'workspace', profile: null, status: 'finished',
      createdAt: iso(Date.now() - 120 * MINUTE), lastObservedAt: null, active: false, idleSince: null,
      completion: null, released: true }));
    const stillPaused = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
    assert.equal(stillPaused.stop?.reason, 'budget');
    assert.match(stillPaused.reason, /Budget reached: 16982 of 1920/);
  } finally { await f.close(); }
});
