import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_RUN_USAGE } from '../core/telemetry/run-usage';
import { budgetPauseDetail, effectiveTokens, taskBudget, taskBudgetLevel, TASK_BUDGET_DEFAULTS } from '../shared/task-budget';
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
  const budget = taskBudget(budgeted('low'), [before, after], Date.parse('2026-11-01T11:31:00.000Z'), '2026-11-01T10:30:00.000Z');
  assert.equal(budget.effectiveTokens.used, 200);
  assert.equal(budget.wallMs.used, 46 * MINUTE);
});

test('no dispatch yet means no wall time used, and tokens are checked before time', () => {
  assert.deepEqual(taskBudget(budgeted('low'), [], start).wallMs, { used: 0, limit: 60 * MINUTE });
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

test('the pause detail names the limit, so it does not change while the task waits', () => {
  const early = taskBudget(budgeted('low'), [run(new Date(start - 61 * MINUTE).toISOString())], start);
  const later = taskBudget(budgeted('low'), [run(new Date(start - 90 * MINUTE).toISOString())], start + 30 * MINUTE);
  assert.equal(budgetPauseDetail(early), budgetPauseDetail(later));
  assert.equal(budgetPauseDetail(early), 'Budget reached: 60 minutes of wall time since the responsible lifecycle began');
  const tokens = taskBudget(budgeted('low'), [run(new Date(start).toISOString(), { inputTokens: 2_000_000 })], start);
  assert.equal(budgetPauseDetail(tokens), 'Budget reached: 2,000,000 effective tokens');
});
