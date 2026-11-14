import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_RUN_USAGE } from '../core/telemetry/run-usage';
import { budgetClockPaused, budgetPauseDetail, effectiveTokens, nucleusHeldReason, taskBudget, taskBudgetLevel, taskBudgetViewSchema, TASK_BUDGET_DEFAULTS } from '../shared/task-budget';
import type { Run, Task } from '../shared/contracts';

/**
 * Spec 058 budgets: a responsible task pauses once it reaches its effective-token
 * or wall-time limit. These are the pure measurements the launch gate and the
 * board card both read.
 */

const MINUTE = 60_000;
const start = Date.parse('2026-11-01T10:00:00.000Z');
const budgeted = (complexity: Task['complexity'] = 'low', budgetExtensions = 0) =>
  ({ complexity, budgetSince: null, resolution: { budgetExtensions } }) as unknown as Pick<Task, 'complexity' | 'resolution'>;
const run = (createdAt: string, usage?: Partial<NonNullable<Run['usage']>>, agentId: string | null = 'agent'): Run =>
  ({ id: createdAt, agentId, createdAt, role: 'revision', ...(usage ? { usage: { ...EMPTY_RUN_USAGE, turns: 1, reportedTurns: 1, ...usage } } : {}) }) as unknown as Run;

test('effective tokens count uncached input and output in full, and cached input at a tenth', () => {
  assert.equal(effectiveTokens({ inputTokens: 100, cachedInputTokens: 1000, outputTokens: 50 }), 250);
  assert.equal(effectiveTokens({ inputTokens: 0, cachedInputTokens: 5, outputTokens: 0 }), 1, 'rounds to a whole token');
});

test('a size maps to its provisional default, and an unsized responsible task takes medium', () => {
  assert.equal(taskBudgetLevel(undefined), 'medium');
  assert.equal(taskBudgetLevel(null), 'medium');
  assert.equal(taskBudgetLevel('very_low'), 'low');
  assert.equal(taskBudgetLevel('very_high'), 'very_high');
  assert.equal(taskBudget(budgeted('high'), [], start).effectiveTokens.limit, TASK_BUDGET_DEFAULTS.high.effectiveTokens);
  assert.equal(taskBudget(budgeted('low'), [], start).wallMs.limit, 60 * MINUTE);
});

test('affected-test repositories raise only low and medium wall defaults, including extensions', () => {
  const repository = { affectedTests: { command: 'effigy test:affected --run' } };
  assert.equal(taskBudget(budgeted('low'), [], start, [], repository).wallMs.limit, 120 * MINUTE);
  assert.equal(taskBudget(budgeted('medium'), [], start, [], repository).wallMs.limit, 360 * MINUTE);
  assert.equal(taskBudget(budgeted('medium'), [], start).wallMs.limit, 180 * MINUTE);
  assert.equal(taskBudget(budgeted('high'), [], start, [], repository).wallMs.limit, 480 * MINUTE);
  assert.equal(taskBudget(budgeted('medium', 1), [], start, [], repository).wallMs.limit, 720 * MINUTE);
  assert.equal(taskBudget(budgeted('medium'), [], start, [], repository).effectiveTokens.limit, TASK_BUDGET_DEFAULTS.medium.effectiveTokens);
});

test('the effective-token trigger fires at the limit and not one token below it', () => {
  const below = taskBudget(budgeted('low'), [run(new Date(start).toISOString(), { inputTokens: 1_999_999 })], start);
  assert.equal(below.effectiveTokens.used, 1_999_999);
  assert.equal(below.exhausted, null);
  const at = taskBudget(budgeted('low'), [run(new Date(start).toISOString(), { inputTokens: 1_999_000, outputTokens: 1000 })], start);
  assert.equal(at.effectiveTokens.used, 2_000_000);
  assert.equal(at.exhausted, 'effective_tokens');
  assert.equal(at.effectiveTokens.evidence, 'exact');
});

test('the wall-time trigger runs from the first dispatch, so a later run does not restart the clock', () => {
  const first = new Date(start - 61 * MINUTE).toISOString();
  const later = new Date(start - 5 * MINUTE).toISOString();
  const budget = taskBudget(budgeted('low'), [run(later), run(first)], start);
  assert.equal(budget.wallMs.used, 61 * MINUTE);
  assert.equal(budget.exhausted, 'wall_time');
});

test('a converted task starts token and wall budgets at conversion, ignoring earlier runs', () => {
  const convertedAt = '2026-11-01T10:30:00.000Z';
  const before = run('2026-11-01T10:00:00.000Z', { inputTokens: 2_500_000 });
  const after = run('2026-11-01T10:45:00.000Z', { inputTokens: 200 });
  const budget = taskBudget({ ...budgeted('low'), budgetSince: convertedAt }, [before, after], Date.parse('2026-11-01T11:31:00.000Z'));
  assert.equal(budget.effectiveTokens.used, 200);
  assert.equal(budget.wallMs.used, 46 * MINUTE);
  assert.equal(budget.exhausted, null);
});

test('a legacy converted task uses its responsible_converted event timestamp', () => {
  const before = run('2026-11-01T10:00:00.000Z', { inputTokens: 2_500_000 });
  const after = run('2026-11-01T10:45:00.000Z', { inputTokens: 200 });
  const conversion = [{ at: '2026-11-01T10:30:00.000Z', kind: 'responsible_converted', detail: 'converted' }];
  const budget = taskBudget(budgeted('low'), [before, after], Date.parse('2026-11-01T11:31:00.000Z'), conversion);
  assert.equal(budget.effectiveTokens.used, 200);
  assert.equal(budget.wallMs.used, 46 * MINUTE);
});

test('wall time starts at the lifecycle\'s first recorded run, never at its conversion', () => {
  // oxide#083: a legacy conversion twelve days before the only run, which has no run
  // row — the initial worker's `agent_created` event is its one recorded start.
  const conversion = [{ at: '2026-11-01T20:17:34.000Z', kind: 'responsible_converted', detail: 'converted' }];
  const at = Date.parse('2026-11-13T15:50:13.000Z');
  const runStart = [...conversion, { at: '2026-11-13T15:20:13.000Z', kind: 'agent_created', detail: 'fc221b00' }];
  const budget = taskBudget(budgeted('high'), [], at, runStart);
  assert.equal(budget.wallMs.used, 30 * MINUTE, 'only the recorded run is charged');
  assert.equal(budget.exhausted, null);
  assert.equal(budget.effectiveTokens.used, 0);
  assert.equal(budget.effectiveTokens.evidence, 'none');
  // No recorded run at all: nothing to charge, whatever the conversion time says.
  assert.deepEqual(taskBudget(budgeted('high'), [], at, conversion).wallMs, { used: 0, limit: 480 * MINUTE, pausedMs: 0 });
  assert.equal(taskBudget(budgeted('high'), [], at, conversion).exhausted, null);
  // A run that predates the lifecycle does not start the clock either.
  assert.equal(taskBudget(budgeted('high'), [run('2026-11-01T19:00:00.000Z')], at, conversion).wallMs.used, 0);
});

test('no dispatch yet means no wall time used, and tokens are checked before time', () => {
  assert.deepEqual(taskBudget(budgeted('low'), [], start).wallMs, { used: 0, limit: 60 * MINUTE, pausedMs: 0 });
  const both = taskBudget(budgeted('low'), [run(new Date(start - 90 * MINUTE).toISOString(), { inputTokens: 3_000_000 })], start);
  assert.equal(both.exhausted, 'effective_tokens');
});

test('an unobserved run neither pauses the task nor reads as zero: the token figure is unknown while time still runs', () => {
  const unobserved = taskBudget(budgeted('low'), [run(new Date(start - 10 * MINUTE).toISOString())], start);
  assert.equal(unobserved.effectiveTokens.evidence, 'none');
  assert.equal(unobserved.effectiveTokens.used, 0);
  assert.equal(unobserved.exhausted, null, 'no usage record never pauses on tokens');
  const timed = taskBudget(budgeted('low'), [run(new Date(start - 61 * MINUTE).toISOString())], start);
  assert.equal(timed.exhausted, 'wall_time', 'wall time is known from the dispatch and still pauses');
});

test('partial usage is a lower bound, so reaching the limit on it is a real pause', () => {
  const partial = taskBudget(budgeted('low'), [
    run(new Date(start).toISOString(), { inputTokens: 2_000_000, partial: true }),
    run(new Date(start).toISOString(), undefined),
  ], start);
  assert.equal(partial.effectiveTokens.evidence, 'partial');
  assert.equal(partial.exhausted, 'effective_tokens');
});

test('each extension adds one default increment to both limits', () => {
  const runs = [run(new Date(start - 61 * MINUTE).toISOString(), { inputTokens: 2_000_000 })];
  const extended = taskBudget(budgeted('low', 1), runs, start);
  assert.equal(extended.effectiveTokens.limit, 4_000_000);
  assert.equal(extended.wallMs.limit, 120 * MINUTE);
  assert.equal(extended.exhausted, null);
  assert.equal(taskBudget(budgeted('low', 2), runs, start).effectiveTokens.limit, 6_000_000);
});

/** A responsible task with the wall clock partly paused on a Nucleus-side cause. */
const held = (budgetClock: { pausedMs: number; pauses: number; since: string | null; reason: string | null }, budgetExtensions = 0) =>
  ({ complexity: 'low', budgetSince: null, resolution: { budgetExtensions, budgetClock } }) as unknown as Pick<Task, 'complexity' | 'resolution'>;

test('closed paused time is discounted from the wall clock, so a Nucleus fault does not spend the budget', () => {
  const first = new Date(start - 70 * MINUTE).toISOString();
  const clock = { pausedMs: 60 * MINUTE, pauses: 1, since: null, reason: null };
  const budget = taskBudget(held(clock), [run(first)], start);
  assert.equal(budget.wallMs.used, 10 * MINUTE, 'only the task\'s own work is charged');
  assert.equal(budget.wallMs.pausedMs, 60 * MINUTE);
  assert.equal(budget.exhausted, null, 'the held hour never reaches the 60-minute low limit');
  const unpaused = taskBudget(budgeted('low'), [run(first)], start);
  assert.equal(unpaused.exhausted, 'wall_time', 'the same span without a pause is over the limit');
});

test('recorded holds are discounted from the historical wall span without changing task history', () => {
  const heldAt = '2026-10-18T00:00:00.000Z';
  const releasedAt = '2026-11-13T00:00:00.000Z';
  const runAt = heldAt;
  const at = Date.parse('2026-11-13T01:30:00.000Z');
  const events = [
    { at: heldAt, kind: 'hold', detail: 'hold' },
    { at: releasedAt, kind: 'release', detail: 'release' },
  ];
  const budget = taskBudget(budgeted('high'), [run(runAt)], at, events);
  assert.equal(budget.wallMs.used, 90 * MINUTE);
  assert.equal(budget.exhausted, null);
  assert.equal(taskBudget(budgeted('low'), [run(runAt)], Date.parse('2026-11-13T00:40:00.000Z'), events).wallMs.used, 40 * MINUTE);
});

test('dependency and escalation waits are excluded while the live run span still counts', () => {
  const from = '2026-11-01T10:00:00.000Z';
  const to = '2026-11-01T11:00:00.000Z';
  const events = [
    { at: from, kind: 'planner_escalation_wait', detail: 'escalation-id: {"kind":"time","target":"2026-11-01T11:00:00.000Z"}' },
    { at: from, kind: 'planner_escalation_wait', detail: 'decision-id: {"kind":"decision","target":"planner"}' },
    { at: from, kind: 'prerequisite_wait_set', detail: 'dependency-id; waiting' },
    { at: to, kind: 'prerequisite_wait_released', detail: '{"waitId":"dependency-id"}' },
    { at: to, kind: 'planner_escalation_wake_intent', detail: 'decision-id: planner answered' },
  ];
  const budget = taskBudget(budgeted('low'), [run(from)], Date.parse('2026-11-01T11:30:00.000Z'), events);
  assert.equal(budget.wallMs.used, 30 * MINUTE);
  assert.equal(budget.wallMs.pausedMs, 60 * MINUTE);
});

test('an early decision change ends a timed escalation wait at its recorded close', () => {
  const from = '2026-11-01T10:00:00.000Z';
  const closedAt = '2026-11-01T10:20:00.000Z';
  const events = [
    { at: from, kind: 'planner_escalation_wait', detail: 'escalation-id: {"kind":"time","target":"2026-11-01T11:00:00.000Z"}' },
    { at: closedAt, kind: 'planner_escalation_wait_superseded', detail: 'escalation-id: owner resumed task' },
  ];
  const budget = taskBudget(budgeted('low'), [run(from)], Date.parse('2026-11-01T10:30:00.000Z'), events);
  assert.equal(budget.wallMs.used, 10 * MINUTE);
  assert.equal(budget.wallMs.pausedMs, 20 * MINUTE);
});

test('holds before the budget starts do not erase time from the eligible run span', () => {
  const heldAt = '2026-11-01T09:00:00.000Z';
  const releasedAt = '2026-11-01T10:00:00.000Z';
  const firstRun = '2026-11-01T10:00:00.000Z';
  const at = Date.parse('2026-11-01T11:01:00.000Z');
  const events = [
    { at: heldAt, kind: 'hold', detail: 'hold' },
    { at: releasedAt, kind: 'release', detail: 'release' },
  ];
  const budget = taskBudget(budgeted('low'), [run(firstRun)], at, events);
  assert.equal(budget.wallMs.used, 61 * MINUTE);
  assert.equal(budget.wallMs.pausedMs, 0);
  assert.equal(budget.exhausted, 'wall_time');
});

test('an open interval counts until it closes, and never overcharges an earlier lifecycle', () => {
  const first = new Date(start - 90 * MINUTE).toISOString();
  const open = { pausedMs: 20 * MINUTE, pauses: 1, since: new Date(start - 30 * MINUTE).toISOString(), reason: 'the task waits on Nucleus: route_unavailable' };
  assert.equal(budgetClockPaused(open, start), 50 * MINUTE, 'closed intervals plus the one still open');
  const budget = taskBudget(held(open), [run(first)], start);
  assert.equal(budget.wallMs.used, 40 * MINUTE);
  assert.equal(budget.wallMs.pausedMs, 50 * MINUTE);
  // A clock left over from a longer earlier lifecycle is clamped to this span.
  const stale = taskBudget(held({ pausedMs: 10 * 60 * MINUTE, pauses: 4, since: null, reason: null }), [run(new Date(start - 5 * MINUTE).toISOString())], start);
  assert.equal(stale.wallMs.used, 0);
  assert.equal(stale.wallMs.pausedMs, 5 * MINUTE);
  // The wire view keeps reading when a stored row carries no clock at all.
  assert.equal(taskBudgetViewSchema.parse({ level: 'low', effectiveTokens: { used: 0, limit: 1, evidence: 'none' },
    wallMs: { used: 0, limit: 60 * MINUTE }, exhausted: null }).wallMs.pausedMs, 0);
});

test('only a Nucleus-side hold stops the clock; the task\'s own waits keep charging', () => {
  assert.match(nucleusHeldReason({ stopReason: 'route_unavailable', dispatchHeld: false })!, /waits on Nucleus: route_unavailable/);
  assert.match(nucleusHeldReason({ stopReason: 'external_unavailable', dispatchHeld: false })!, /external_unavailable/);
  assert.match(nucleusHeldReason({ stopReason: null, dispatchHeld: true })!, /dispatch hold blocks every run/);
  assert.match(nucleusHeldReason({ stopReason: 'operator_needed', dispatchHeld: false, incidentCause: 'workspace_state' })!, /host fault: workspace_state/);
  assert.match(nucleusHeldReason({ stopReason: 'operator_needed', dispatchHeld: false, incidentCause: 'uncertain_delivery' })!, /host fault: uncertain_delivery/);
  assert.match(nucleusHeldReason({ stopReason: 'operator_needed', dispatchHeld: false, presendRefusal: true })!, /refusal stopped the task before any send/);
  assert.match(nucleusHeldReason({ stopReason: null, dispatchHeld: false, observationOutage: true })!, /could not observe this task/);
  assert.equal(nucleusHeldReason({ stopReason: 'operator_needed', dispatchHeld: false, incidentCause: 'hook_failure' }), null,
    'a hook the change broke is the task\'s own work');
  assert.equal(nucleusHeldReason({ stopReason: 'operator_needed', dispatchHeld: false, incidentCause: 'worker_blocked' }), null);
  assert.equal(nucleusHeldReason({ stopReason: null, dispatchHeld: false, presendRefusal: false, observationOutage: false }), null);
  assert.equal(nucleusHeldReason({ stopReason: 'budget', dispatchHeld: false }), null, 'a budget pause is already spent');
  assert.equal(nucleusHeldReason({ stopReason: 'validation', dispatchHeld: false }), null, 'a worktree validation is the task\'s own work');
  assert.equal(nucleusHeldReason({ stopReason: 'capacity', dispatchHeld: false }), null, 'queueing for a slot is not a fault');
  assert.equal(nucleusHeldReason({ stopReason: null, dispatchHeld: false }), null);
});

test('the pause detail names the limit, so it does not change while the task waits', () => {
  const early = taskBudget(budgeted('low'), [run(new Date(start - 61 * MINUTE).toISOString())], start);
  const later = taskBudget(budgeted('low'), [run(new Date(start - 90 * MINUTE).toISOString())], start + 30 * MINUTE);
  assert.equal(budgetPauseDetail(early), budgetPauseDetail(later));
  assert.equal(budgetPauseDetail(early), 'Budget reached: 60 minutes of wall time since the responsible lifecycle began');
  const tokens = taskBudget(budgeted('low'), [run(new Date(start).toISOString(), { inputTokens: 2_000_000 })], start);
  assert.equal(budgetPauseDetail(tokens), 'Budget reached: 2,000,000 effective tokens');
});
