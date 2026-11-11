import { z } from "zod";
import type { CapabilityLevel, Run, Task } from "./contracts";

/**
 * Spec 058 budgets: a safety net on each responsible task, not something to tune.
 * Effective tokens and wall time include only runs at or after conversion when
 * the task carries a responsible start. Otherwise they use the first dispatch.
 * The defaults are provisional until a shadow period sets
 * each size near 1.5x the observed 75th percentile.
 */
const MINUTE_MS = 60_000;
export const TASK_BUDGET_DEFAULTS = {
  low: { effectiveTokens: 2_000_000, wallMs: 60 * MINUTE_MS },
  medium: { effectiveTokens: 5_000_000, wallMs: 180 * MINUTE_MS },
  high: { effectiveTokens: 12_000_000, wallMs: 480 * MINUTE_MS },
  very_high: { effectiveTokens: 25_000_000, wallMs: 960 * MINUTE_MS },
} as const;
export type TaskBudgetLevel = keyof typeof TASK_BUDGET_DEFAULTS;

/** very_low takes the low default; a responsible task with no size takes medium. */
export function taskBudgetLevel(complexity: CapabilityLevel | null | undefined): TaskBudgetLevel {
  if (!complexity) return "medium";
  return complexity === "very_low" ? "low" : complexity;
}

/** Spec 058 effective tokens: uncached input + output + 10% of cached input, rounded to a whole token. */
export function effectiveTokens(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): number {
  return Math.round(usage.inputTokens + usage.outputTokens + usage.cachedInputTokens * 0.1);
}

export const taskBudgetViewSchema = z.object({
  level: z.enum(["low", "medium", "high", "very_high"]),
  effectiveTokens: z.object({
    used: z.number().int().min(0), limit: z.number().int().positive(),
    /** `none`: no run reported usage, so the token figure is unknown rather than zero. */
    evidence: z.enum(["exact", "partial", "none"]),
  }).strict(),
  wallMs: z.object({ used: z.number().min(0), limit: z.number().positive() }).strict(),
  /** The limit reached, if any. Tokens are checked first. */
  exhausted: z.enum(["effective_tokens", "wall_time"]).nullable(),
}).strict();
export type TaskBudgetView = z.infer<typeof taskBudgetViewSchema>;

/** Compact board wire form: token used/limit/evidence, wall used/limit, exhausted. */
export const taskBudgetBoardViewSchema = z.tuple([
  z.number().int().min(0), z.number().int().positive(), z.enum(["exact", "partial", "none"]),
  z.number().min(0), z.number().positive(), z.enum(["effective_tokens", "wall_time"]).nullable(),
]);
export type TaskBudgetBoardView = z.infer<typeof taskBudgetBoardViewSchema>;
export const taskBudgetBoardView = (budget: TaskBudgetView): TaskBudgetBoardView => [
  budget.effectiveTokens.used, budget.effectiveTokens.limit, budget.effectiveTokens.evidence,
  budget.wallMs.used, budget.wallMs.limit, budget.exhausted,
];

/**
 * A responsible task's budget at `at` (epoch ms). A legacy conversion timestamp
 * is supplied by callers that can read the event store. Each extension adds one default
 * increment, so the limits grow by the size's default per answer. A run without a
 * usage record adds no tokens: an unobserved turn never pauses the task, though
 * wall time still runs. Partial usage is a lower bound, so reaching the limit on it
 * is still a real pause.
 */
export function taskBudget(task: Pick<Task, "complexity" | "resolution"> & Partial<Pick<Task, "budgetSince">>, runs: Run[], at: number,
  legacyBudgetSince?: string | null): TaskBudgetView {
  const level = taskBudgetLevel(task.complexity);
  const steps = 1 + (task.resolution.budgetExtensions ?? 0);
  const tokenLimit = TASK_BUDGET_DEFAULTS[level].effectiveTokens * steps;
  const wallLimit = TASK_BUDGET_DEFAULTS[level].wallMs * steps;
  const since = Date.parse(task.budgetSince ?? legacyBudgetSince ?? "");
  const eligibleRuns = Number.isFinite(since) ? runs.filter(run => Date.parse(run.createdAt) >= since) : runs;
  const dispatched = eligibleRuns.filter(run => run.agentId || run.usage);
  const measured = dispatched.filter(run => run.usage);
  const evidence = measured.length === 0 ? "none" : measured.length === dispatched.length && measured.every(run => !run.usage!.partial) ? "exact" : "partial";
  const totals = measured.reduce((sum, run) => ({
    inputTokens: sum.inputTokens + run.usage!.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + run.usage!.cachedInputTokens,
    outputTokens: sum.outputTokens + run.usage!.outputTokens,
  }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  const tokensUsed = effectiveTokens(totals);
  const starts = eligibleRuns.map(run => Date.parse(run.createdAt)).filter(Number.isFinite);
  const firstStart = starts.length ? Math.min(...starts) : Number.NaN;
  const wallStart = Number.isFinite(since) ? Math.max(since, Number.isFinite(firstStart) ? firstStart : since) : firstStart;
  const wallUsed = Number.isFinite(wallStart) ? Math.max(0, at - wallStart) : 0;
  const exhausted = tokensUsed >= tokenLimit ? "effective_tokens" : wallUsed >= wallLimit ? "wall_time" : null;
  return {
    level,
    effectiveTokens: { used: tokensUsed, limit: tokenLimit, evidence },
    wallMs: { used: wallUsed, limit: wallLimit },
    exhausted,
  };
}

/**
 * The stop detail a budget pause records. It names the limit, not the running
 * total: the detail is written once per pause, so it must not change while the
 * task waits on the operator.
 */
export function budgetPauseDetail(budget: TaskBudgetView): string {
  return budget.exhausted === "wall_time"
    ? `Budget reached: ${budget.wallMs.limit / MINUTE_MS} minutes of wall time since the responsible lifecycle began`
    : `Budget reached: ${budget.effectiveTokens.limit.toLocaleString("en-US")} effective tokens`;
}
