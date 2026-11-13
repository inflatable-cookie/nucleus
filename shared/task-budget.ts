import { z } from "zod";
import type { CapabilityLevel, HoldFence, Run, Task } from "./contracts";
import type { TaskStopReason } from "./task-stop";

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
  /** `pausedMs` is time already discounted because the task was held or waiting. */
  wallMs: z.object({ used: z.number().min(0), limit: z.number().positive(), pausedMs: z.number().min(0).default(0) }).strict(),
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
 * Stops that mean Nucleus or its host is what the task waits on, not the task's
 * own work: a host-adapter refusal before a send, a Paseo workspace that is not
 * there, routing with no runnable profile, or a provider/subscription outage.
 * A task held on one of these makes no progress of its own, so its wall clock
 * stops (nucleus#1153).
 */
export const NUCLEUS_HELD_STOP_REASONS = ["external_unavailable", "workspace_unavailable", "route_unavailable", "provider_unavailable"] as const satisfies readonly TaskStopReason[];
export type NucleusHeldStopReason = (typeof NUCLEUS_HELD_STOP_REASONS)[number];

/**
 * Incidents that are the host adapter's or a workspace's own fault — a workspace
 * that is not there or not clean, or a delivery whose outcome is unknown. The task
 * can send nothing until one settles.
 */
export const NUCLEUS_HELD_INCIDENT_CAUSES = ["workspace_state", "uncertain_delivery"] as const;

/**
 * The durable event a host adapter (or the launcher acting on its typed refusal)
 * writes when a proven pre-send refusal stopped a run: nothing was sent, so the
 * task is blocked on the adapter, not on its own work. The interval stays open
 * while the task still carries that attention and closes when an owner resumes it
 * (the `attention_episode_resolved` a resuming control writes).
 */
export const NUCLEUS_HELD_REFUSAL_EVENTS = [
  "worker_creation_refused_before_send",
  "creation_refused_before_send",
  "ordinary_review_refused_before_send",
  "review_prompt_refused_before_send",
] as const;

/**
 * Why the task's wall clock is stopped right now, or null while it runs: a
 * dispatch hold (which blocks every run the task could start), an observation
 * outage on its lane, a proven pre-send refusal, an unresolved host/workspace
 * incident, or a Nucleus-fault wait. A merge hold is not one: the task can still
 * progress its own work.
 */
export function nucleusHeldReason(input: {
  stopReason: TaskStopReason | null | undefined;
  dispatchHeld: boolean;
  incidentCause?: string | null;
  presendRefusal?: boolean;
  observationOutage?: boolean;
}): string | null {
  if (input.dispatchHeld) return "a dispatch hold blocks every run";
  if (input.observationOutage) return "the sweep could not observe this task (an observation outage)";
  if (input.presendRefusal) return "a host-adapter refusal stopped the task before any send";
  const cause = input.incidentCause;
  if (cause && (NUCLEUS_HELD_INCIDENT_CAUSES as readonly string[]).includes(cause)) return `the task waits on a host fault: ${cause}`;
  const reason = input.stopReason;
  return reason && (NUCLEUS_HELD_STOP_REASONS as readonly string[]).includes(reason) ? `the task waits on Nucleus: ${reason}` : null;
}

/**
 * Durable wall-clock pause accounting (nucleus#1153). `pausedMs` is closed
 * paused time, `since` an interval still open, and `pauses` how many intervals
 * closed. It is folded into the budget so the wall figure and the board both
 * read the time the task could actually work.
 */
export const budgetClockSchema = z.object({
  pausedMs: z.number().min(0), pauses: z.number().int().min(0),
  since: z.string().datetime({ offset: true }).nullable(),
  /** Why the open interval is paused; null while the clock runs. */
  reason: z.string().max(200).nullable(),
}).strict();
export type BudgetClock = z.infer<typeof budgetClockSchema>;

export type BudgetEvent = { at: string; kind: string; detail: string };
type BudgetInterval = { start: number; end: number };

function recordedWaitIntervals(events: BudgetEvent[], at: number): BudgetInterval[] {
  const intervals: BudgetInterval[] = [];
  const add = (start: string | undefined, end: string | undefined) => {
    const from = Date.parse(start ?? ""), to = Math.min(at, end ? Date.parse(end) : at);
    if (Number.isFinite(from) && to > from) intervals.push({ start: from, end: to });
  };
  let dispatchHold: string | null = null, mergeHold: string | null = null, prerequisiteWait: string | null = null;
  const escalations = new Map<string, { at: string; target?: string }>();
  const questions = new Map<string, { at: string }>();
  for (const event of events) {
    if (event.kind === "hold") dispatchHold ??= event.at;
    else if (event.kind === "merge_hold") mergeHold ??= event.at;
    else if (event.kind === "release") {
      if (dispatchHold) add(dispatchHold, event.at);
      dispatchHold = null;
    } else if (event.kind === "merge_release") {
      if (mergeHold) add(mergeHold, event.at);
      mergeHold = null;
    } else if (event.kind === "hold_auto_released") {
      if (event.detail.startsWith("dispatch;") && dispatchHold) { add(dispatchHold, event.at); dispatchHold = null; }
      if (event.detail.startsWith("merge;") && mergeHold) { add(mergeHold, event.at); mergeHold = null; }
    } else if (event.kind === "prerequisite_wait_set") {
      prerequisiteWait ??= event.at;
    } else if (event.kind === "prerequisite_wait_released" || event.kind === "prerequisite_wait_resumed") {
      if (prerequisiteWait) add(prerequisiteWait, event.at);
      prerequisiteWait = null;
    } else if (event.kind === "planner_escalation_wait") {
      const id = event.detail.split(":", 1)[0]!;
      let wait: { kind?: string; target?: string } = {};
      try { wait = JSON.parse(event.detail.slice(id.length + 2)); } catch { /* Historical malformed event is not a proven wait interval. */ }
      escalations.set(id, { at: event.at, ...(wait.kind === "time" && wait.target ? { target: wait.target } : {}) });
    } else if (["planner_escalation_wake_intent", "planner_escalation_wait_superseded", "planner_escalation_refused"].includes(event.kind)) {
      const id = event.detail.split(":", 1)[0]!;
      const wait = escalations.get(id);
      if (wait) {
        const targetAt = Date.parse(wait.target ?? "");
        const closedAt = Number.isFinite(targetAt) && targetAt < Date.parse(event.at) ? wait.target : event.at;
        add(wait.at, closedAt);
      }
      escalations.delete(id);
    } else if (event.kind === "operator_question" || event.kind === "responsible_question") {
      const id = event.detail.split(":", 1)[0]!;
      if (event.kind === "operator_question" && /kind budget\b/.test(event.detail)) continue;
      questions.set(`${event.kind}:${id}`, { at: event.at });
    } else if (["operator_question_answered", "operator_question_superseded", "responsible_question_answered", "responsible_question_superseded"].includes(event.kind)) {
      const id = event.detail.split(":", 1)[0]!;
      const kind = event.kind.startsWith("operator_question") ? "operator_question" : "responsible_question";
      const question = questions.get(`${kind}:${id}`);
      if (question) add(question.at, event.at);
      questions.delete(`${kind}:${id}`);
    }
  }
  add(dispatchHold ?? undefined, undefined);
  add(mergeHold ?? undefined, undefined);
  add(prerequisiteWait ?? undefined, undefined);
  for (const wait of escalations.values()) add(wait.at, wait.target);
  for (const question of questions.values()) add(question.at, undefined);
  return intervals;
}

function unionDuration(intervals: BudgetInterval[]): number {
  const sorted = intervals.filter(interval => interval.end > interval.start).sort((a, b) => a.start - b.start);
  let total = 0, start = Number.NaN, end = Number.NaN;
  for (const interval of sorted) {
    if (!Number.isFinite(start)) { start = interval.start; end = interval.end; }
    else if (interval.start <= end) end = Math.max(end, interval.end);
    else { total += end - start; start = interval.start; end = interval.end; }
  }
  return Number.isFinite(start) ? total + end - start : total;
}

/** Paused time from stored interval events plus the Nucleus-owned clock's live segment. */
export function recordedBudgetPaused(events: BudgetEvent[], task: Pick<Task, "resolution">, at: number,
  budgetStart = Number.NEGATIVE_INFINITY, additionalIntervals: BudgetInterval[] = []): number {
  const intervals = recordedWaitIntervals(events, at);
  const clock = task.resolution.budgetClock;
  const eventClock = events.filter(event => event.kind === "budget_clock_paused" || event.kind === "budget_clock_resumed");
  if (eventClock.length) {
    if (clock?.since) intervals.push({ start: Date.parse(clock.since), end: at });
    let opened: string | null = null;
    for (const event of eventClock) {
      if (event.kind === "budget_clock_paused") opened ??= event.at;
      else if (opened) { intervals.push({ start: Date.parse(opened), end: Date.parse(event.at) }); opened = null; }
    }
    if (opened && !clock?.since) intervals.push({ start: Date.parse(opened), end: at });
  } else {
    // Older rows may have a folded clock without its audit events. Its closed
    // total has no exact placement, so keep it adjacent to the open segment.
    const open = clock?.since ? Math.max(0, at - Date.parse(clock.since)) : 0;
    const total = (clock?.pausedMs ?? 0) + open;
    if (total > 0) intervals.push({ start: at - total, end: at });
  }
  intervals.push(...additionalIntervals);
  return unionDuration(intervals.map(interval => ({
    start: Math.max(interval.start, budgetStart), end: Math.min(interval.end, at),
  })));
}

/** Paused time at `at`: closed intervals plus the one still open. */
export function budgetClockPaused(clock: BudgetClock | null | undefined, at: number): number {
  if (!clock) return 0;
  const started = clock.since ? Date.parse(clock.since) : Number.NaN;
  const open = Number.isFinite(started) ? Math.max(0, at - started) : 0;
  return clock.pausedMs + open;
}

/**
 * A responsible task's budget at `at` (epoch ms). A legacy conversion timestamp
 * is supplied by callers that can read the event store. Each extension adds one default
 * increment, so the limits grow by the size's default per answer. A run without a
 * usage record adds no tokens: an unobserved turn never pauses the task, though
 * wall time still runs. Partial usage is a lower bound, so reaching the limit on it
 * is still a real pause. Time the task spent held on a Nucleus-side cause is
 * discounted from wall time and reported as `pausedMs`, so held time never spends
 * the task's budget.
 */
export function taskBudget(task: Pick<Task, "complexity" | "resolution"> & Partial<Pick<Task, "budgetSince" | "holds" | "held" | "mergeHold" | "holdAt" | "holdUntil" | "holdOwner" | "holdReason" | "holdGeneration" | "holdBlocking" | "phase">>, runs: Run[], at: number,
  legacyBudgetSince?: string | null, events: BudgetEvent[] = []): TaskBudgetView {
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
  const wallSpan = Number.isFinite(wallStart) ? Math.max(0, at - wallStart) : 0;
  // A pause is charged only against time inside this task's own wall span, so a
  // clock from an earlier lifecycle can never drive the figure negative.
  // Legacy rows can predate hold events. The current fence carries its original start.
  const fences = task.held ? [task.holds?.dispatch, task.holds?.merge].filter((fence): fence is HoldFence => Boolean(fence)) : [];
  const legacyHoldStart = task.held && !fences.length ? task.holdAt : null;
  const holdIntervals = [...fences.map(fence => ({ start: Date.parse(fence.at), end: at })),
    ...(legacyHoldStart ? [{ start: Date.parse(legacyHoldStart), end: at }] : [])];
  const paused = Math.min(wallSpan, Number.isFinite(wallStart)
    ? recordedBudgetPaused(events, task, at, wallStart, holdIntervals) : 0);
  const wallUsed = wallSpan - paused;
  const exhausted = tokensUsed >= tokenLimit ? "effective_tokens" : wallUsed >= wallLimit ? "wall_time" : null;
  return {
    level,
    effectiveTokens: { used: tokensUsed, limit: tokenLimit, evidence },
    wallMs: { used: wallUsed, limit: wallLimit, pausedMs: paused },
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
