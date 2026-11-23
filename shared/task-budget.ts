import { z } from "zod";
import type { CapabilityLevel, HoldFence, RepositorySettings, Run, Task } from "./contracts";
import type { TaskStopReason } from "./task-stop";

/**
 * Spec 058 budgets: a safety net on each responsible task, not something to tune.
 * Effective tokens and wall time include only runs at or after conversion when
 * the task carries a responsible start. Otherwise they use the first dispatch.
 * Every gate and view measures through this one function (nucleus#1187), and wall
 * time never starts before the lifecycle's first recorded run. The defaults are
 * provisional until a shadow period sets each size near 1.5x the observed 75th
 * percentile.
 */
const MINUTE_MS = 60_000;
export const TASK_BUDGET_DEFAULTS = {
  low: { effectiveTokens: 2_000_000, wallMs: 60 * MINUTE_MS },
  medium: { effectiveTokens: 5_000_000, wallMs: 180 * MINUTE_MS },
  high: { effectiveTokens: 12_000_000, wallMs: 480 * MINUTE_MS },
  very_high: { effectiveTokens: 25_000_000, wallMs: 960 * MINUTE_MS },
} as const;
export type TaskBudgetLevel = keyof typeof TASK_BUDGET_DEFAULTS;

/** Repositories that run affected tests need room for the longer validation pass. */
export function taskBudgetWallDefault(
  level: TaskBudgetLevel,
  repository?: Pick<RepositorySettings, "affectedTests"> | null,
): number {
  if (!repository?.affectedTests) return TASK_BUDGET_DEFAULTS[level].wallMs;
  if (level === "low") return 120 * MINUTE_MS;
  if (level === "medium") return 360 * MINUTE_MS;
  return TASK_BUDGET_DEFAULTS[level].wallMs;
}

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

/**
 * The limits the operator's extensions have granted (nucleus#1214). Stored as the
 * figures themselves rather than a count, because one extension must always clear
 * the stop: the granted limit is measured against the task's own use, not only
 * against the size's default.
 */
export const taskBudgetLimitsSchema = z.object({
  effectiveTokens: z.number().int().positive(),
  wallMs: z.number().positive(),
}).strict();
export type TaskBudgetLimits = z.infer<typeof taskBudgetLimitsSchema>;

/**
 * The limits one extension grants (nucleus#1214): one default increment past the
 * greater of the current limit and the task's own use, so one answer always lets
 * the task continue. Praxis#328 used 1,925 minutes against a 960-minute limit and
 * a per-answer increment (1,440, then 1,920) left the pause standing through
 * three answers.
 */
export function extendedTaskBudgetLimits(
  budget: Pick<TaskBudgetView, "level" | "effectiveTokens" | "wallMs">,
  repository?: Pick<RepositorySettings, "affectedTests"> | null,
): TaskBudgetLimits {
  const tokenIncrement = TASK_BUDGET_DEFAULTS[budget.level].effectiveTokens;
  const wallIncrement = taskBudgetWallDefault(budget.level, repository);
  return taskBudgetLimitsSchema.parse({
    effectiveTokens: Math.max(budget.effectiveTokens.limit + tokenIncrement,
      Math.ceil(budget.effectiveTokens.used) + tokenIncrement),
    wallMs: Math.max(budget.wallMs.limit + wallIncrement, Math.ceil(budget.wallMs.used) + wallIncrement),
  });
}

/**
 * Spec 068 Decision 1 (Tom, 2026-11-22): the first time a task's budget is spent,
 * Nucleus extends it once by one default increment on its own and records
 * `budget_extended` with this source and policy; the next spend raises the ordinary
 * operator budget question. Planners and the operator extended 34 of 35 spent
 * budgets on 15–22 November.
 */
export const AUTOMATIC_BUDGET_EXTENSION_SOURCE = "automatic";
export const AUTOMATIC_BUDGET_EXTENSION_POLICY =
  "Spec 068 Decision 1: a task's first spent budget is extended once by one default increment; the next spend asks the operator";
/** The `budget_extended` detail prefix an automatic extension records. */
export const AUTOMATIC_BUDGET_EXTENSION_DETAIL = `${AUTOMATIC_BUDGET_EXTENSION_SOURCE}: ${AUTOMATIC_BUDGET_EXTENSION_POLICY}`;

/**
 * Phases whose next step starts a participant run, the step the budget gates. A
 * task verifying, merging or closing out starts no run, so a spent budget there is
 * not its stop; it stops only if that stage needs another run (the launch gate).
 */
export const BUDGET_GATED_PHASES = ["dispatching", "working", "changes_requested", "awaiting_review", "reviewing"] as const;
export const budgetGatesPhase = (phase: string): boolean =>
  (BUDGET_GATED_PHASES as readonly string[]).includes(phase);

/** Whether a spent budget is still the task's first, so Nucleus extends it itself. */
export function automaticBudgetExtensionDue(task: Pick<Task, "resolution">): boolean {
  return (task.resolution.budgetExtensions ?? 0) === 0;
}

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
export const NUCLEUS_HELD_STOP_REASONS = ["external_unavailable", "workspace_unavailable", "route_unavailable", "provider_unavailable", "host_unavailable"] as const satisfies readonly TaskStopReason[];
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
  /** The task's own host wait (nucleus#1198 review): independent of its stop. */
  hostWaitSince?: string | null;
}): string | null {
  if (input.dispatchHeld) return "a dispatch hold blocks every run";
  if (input.observationOutage) return "the sweep could not observe this task (an observation outage)";
  if (input.hostWaitSince) return "the task's host is unavailable";
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
/** One outage of the task's host (`hostOutageIntervals`); `until` is null while it is open. */
export type BudgetHostOutage = { since: string; until: string | null };
type BudgetInterval = { start: number; end: number };

/**
 * The events that record a run's start. A task's initial worker is stored on the
 * task row (`runId`, `agentId`) and never as a run row, so its dispatch intent and
 * its `agent_created` event are the only durable record of when its first run
 * began — the shape a task dispatched once has (nucleus#1187).
 */
export const BUDGET_RUN_START_EVENTS = ["dispatch_intent", "agent_intent", "run_intent", "agent_created"] as const;

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
  // The clock's events place its closed intervals; its folded `pausedMs` is the
  // durable count of that same time. They disagree when the pause is dated from the
  // fault it observed rather than from the pass that noticed it (an observation
  // outage, a dispatch hold), so the fold is authoritative: whatever the events do
  // not account for is booked adjacent to the read, and is never counted twice
  // (nucleus#1187: a folded pause was ignored whenever its events existed, so a held
  // task was charged for its own hold).
  const placed: BudgetInterval[] = [];
  let opened: string | null = null;
  for (const event of events) {
    if (event.kind === "budget_clock_paused") opened ??= event.at;
    else if (event.kind === "budget_clock_resumed" && opened) {
      placed.push({ start: Date.parse(opened), end: Date.parse(event.at) }); opened = null;
    }
  }
  intervals.push(...placed);
  const running = Number.isFinite(Date.parse(clock?.since ?? ""));
  const open = running ? Math.max(0, at - Date.parse(clock!.since!)) : 0;
  // The fold's remainder is booked just before the segment still open, so the two
  // never overlap each other and the clock's own total is what the budget shows.
  const unplaced = Math.max(0, (clock?.pausedMs ?? 0) - unionDuration(placed));
  if (unplaced > 0) intervals.push({ start: at - open - unplaced, end: at - open });
  if (running) intervals.push({ start: Date.parse(clock!.since!), end: at });
  else if (opened) intervals.push({ start: Date.parse(opened), end: at });
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
 * A responsible task's budget at `at` (epoch ms). Every caller passes the same
 * inputs — the task row, its runs, its events, canonical repository settings and
 * its host's outages (Spec 069 §3) —
 * so the dispatch gate, the board, task detail and `task.next` measure one figure
 * (nucleus#1187). The
 * lifecycle start is the task's own `budgetSince`, else its legacy
 * `responsible_converted` event, both read from those events rather than chosen
 * per caller. Each extension adds one default increment and records the granted
 * limits (`resolution.budgetLimits`), which are never below the task's use plus
 * that increment, so one answer always clears the stop (nucleus#1214). A run
 * without a usage record adds no tokens: an
 * unobserved turn never pauses the task, though wall time still runs. Partial
 * usage is a lower bound, so reaching the limit on it is still a real pause. Wall
 * time starts at the lifecycle's first recorded run start and time before it is
 * never charged, whatever the conversion time or `budgetSince`, so a task that
 * has never run reads 0 used. Time the task spent held on a Nucleus-side cause is
 * discounted from wall time and reported as `pausedMs`, so held time never spends
 * the task's budget.
 */
export function taskBudget(task: Pick<Task, "complexity" | "resolution"> & Partial<Pick<Task, "budgetSince" | "holds" | "held" | "mergeHold" | "holdAt" | "holdUntil" | "holdOwner" | "holdReason" | "holdGeneration" | "holdBlocking" | "phase">>, runs: Run[], at: number,
  events: BudgetEvent[] = [], repository?: Pick<RepositorySettings, "affectedTests"> | null,
  hostOutages: readonly BudgetHostOutage[] = []): TaskBudgetView {
  const level = taskBudgetLevel(task.complexity);
  const steps = 1 + (task.resolution.budgetExtensions ?? 0);
  // The recorded extension count sizes the increment per answer; the granted
  // figures win when they are larger, so an extension measured against the task's
  // own use (nucleus#1214) is never undercut by the count it also increments.
  const granted = task.resolution.budgetLimits ?? null;
  const tokenLimit = Math.max(TASK_BUDGET_DEFAULTS[level].effectiveTokens * steps, granted?.effectiveTokens ?? 0);
  const wallLimit = Math.max(taskBudgetWallDefault(level, repository) * steps, granted?.wallMs ?? 0);
  const lifecycleStart = Date.parse(task.budgetSince ?? events.find(event => event.kind === "responsible_converted")?.at ?? "");
  const inLifecycle = (iso: string) => !Number.isFinite(lifecycleStart) || Date.parse(iso) >= lifecycleStart;
  const eligibleRuns = Number.isFinite(lifecycleStart) ? runs.filter(run => inLifecycle(run.createdAt)) : runs;
  const dispatched = eligibleRuns.filter(run => run.agentId || run.usage);
  const measured = dispatched.filter(run => run.usage);
  const evidence = measured.length === 0 ? "none" : measured.length === dispatched.length && measured.every(run => !run.usage!.partial) ? "exact" : "partial";
  const totals = measured.reduce((sum, run) => ({
    inputTokens: sum.inputTokens + run.usage!.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + run.usage!.cachedInputTokens,
    outputTokens: sum.outputTokens + run.usage!.outputTokens,
  }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  const tokensUsed = effectiveTokens(totals);
  // The first recorded run start: an eligible run row, or the dispatch and
  // agent-creation events of a run that has no row. Nothing before it is charged.
  const starts = [...eligibleRuns.map(run => Date.parse(run.createdAt)),
    ...events.filter(event => (BUDGET_RUN_START_EVENTS as readonly string[]).includes(event.kind) && inLifecycle(event.at))
      .map(event => Date.parse(event.at))].filter(Number.isFinite);
  const wallStart = starts.length ? Math.min(...starts) : Number.NaN;
  const wallSpan = Number.isFinite(wallStart) ? Math.max(0, at - wallStart) : 0;
  // A pause is charged only against time inside this task's own wall span, so a
  // clock from an earlier lifecycle can never drive the figure negative.
  // Legacy rows can predate hold events. The current fence carries its original start.
  const fences = task.held ? [task.holds?.dispatch, task.holds?.merge].filter((fence): fence is HoldFence => Boolean(fence)) : [];
  const legacyHoldStart = task.held && !fences.length ? task.holdAt : null;
  const holdIntervals = [...fences.map(fence => ({ start: Date.parse(fence.at), end: at })),
    ...(legacyHoldStart ? [{ start: Date.parse(legacyHoldStart), end: at }] : []),
    // Spec 069 §3: the task's host outages, read from the host's own record, so an
    // outage pauses every task on the host without a write per task.
    ...hostOutages.map(outage => ({ start: Date.parse(outage.since), end: outage.until ? Date.parse(outage.until) : at }))
      .filter(interval => Number.isFinite(interval.start) && Number.isFinite(interval.end))];
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
    ? `Budget reached: ${Math.round(budget.wallMs.limit / MINUTE_MS)} minutes of wall time since the responsible lifecycle began`
    : `Budget reached: ${budget.effectiveTokens.limit.toLocaleString("en-US")} effective tokens`;
}
