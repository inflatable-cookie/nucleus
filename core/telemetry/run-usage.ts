import type { ProviderUsageReport, RunUsageStreamEvent, RunUsageStream, RunUsageSource } from '../host/types';
export type { ProviderUsageReport, RunUsageStreamEvent, RunUsageStream, RunUsageSource } from '../host/types';
/**
 * Spec 058 slice 1: usage Queue observes on a run's agent stream. Pure reduction only:
 * the tracker feeds events in, the store persists the result, telemetry sums it. Nothing
 * here enforces a budget, pauses, refuses or routes.
 */
import type { Run, RunUsage } from "../../shared/contracts";
import { USAGE_ROLES, type TaskUsage, type UsageRole, type UsageTotals } from "../../shared/telemetry";
import { effectiveTokens } from "../../shared/task-budget";

export { effectiveTokens };

/** What the reducer consumes. `gap` covers a restored or replaced stream whose missed events Queue cannot see. */
export type RunUsageEvent =
  | { type: "turn_started"; turnId?: string }
  | { type: "turn_completed" | "turn_failed" | "turn_canceled"; turnId?: string; usage?: ProviderUsageReport }
  | { type: "usage_updated"; usage: ProviderUsageReport }
  | { type: "gap" };

export const EMPTY_RUN_USAGE: RunUsage = {
  turns: 0, reportedTurns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, wallMs: 0,
  peakContextTokens: null, lastTurnId: null, openTurnId: null, openTurnAt: null, partial: false,
};

const TERMINAL: ReadonlySet<string> = new Set(["turn_completed", "turn_failed", "turn_canceled"]);
const TOKEN_FIELDS = ["inputTokens", "cachedInputTokens", "outputTokens"] as const;

/**
 * Apply one observed event at `at` (Queue's receipt time, ISO). A terminal turn counts
 * once per turn id, so a replayed event never double-counts. A terminal turn with no
 * observed start still counts as a turn but marks wall time partial. A turn that starts
 * while another is open means the earlier terminal event was missed, so it is partial.
 */
export function applyRunUsageEvent(usage: RunUsage, event: RunUsageEvent, at: string): RunUsage {
  if (event.type === "gap") return { ...usage, partial: true };
  if (event.type === "usage_updated") return withPeakContext(usage, event.usage.contextWindowUsedTokens);
  if (event.type === "turn_started") {
    return {
      ...usage,
      partial: usage.partial || usage.openTurnId !== null,
      openTurnId: event.turnId ?? null, openTurnAt: at,
    };
  }
  if (!TERMINAL.has(event.type)) return usage;
  if (event.turnId && event.turnId === usage.lastTurnId) return usage;
  const started = usage.openTurnAt !== null && (!event.turnId || usage.openTurnId === event.turnId);
  const elapsed = started ? Math.max(0, Date.parse(at) - Date.parse(usage.openTurnAt!)) : 0;
  const reported = event.usage ? TOKEN_FIELDS.some(field => typeof event.usage![field] === "number" && Number.isFinite(event.usage![field])) : false;
  const next: RunUsage = {
    ...usage,
    turns: usage.turns + 1,
    reportedTurns: usage.reportedTurns + (reported ? 1 : 0),
    wallMs: usage.wallMs + elapsed,
    partial: usage.partial || !started,
    lastTurnId: event.turnId ?? usage.lastTurnId,
    openTurnId: null, openTurnAt: null,
  };
  if (reported) {
    for (const field of TOKEN_FIELDS) {
      const value = event.usage![field];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) next[field] += value;
    }
  }
  return withPeakContext(next, event.usage?.contextWindowUsedTokens);
}

/** Peak context-window occupancy over the run; a turn's report and a live update both feed it. */
function withPeakContext(usage: RunUsage, used: number | undefined): RunUsage {
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return usage;
  return { ...usage, peakContextTokens: Math.max(usage.peakContextTokens ?? 0, used) };
}

/** Map a run's role to the usage breakdown: revisions are the worker's own turns. */
export function usageRole(role: Run["role"]): UsageRole {
  if (role === "executor" || role === "revision") return "worker";
  if (role === "reviewer") return "reviewer";
  if (role === "recovery") return "recovery";
  return "closeout";
}

function totalsOf(runs: Run[]): UsageTotals {
  const totals: UsageTotals = { turns: 0, reportedTurns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, effectiveTokens: 0, wallMs: 0, peakContextTokens: null };
  for (const run of runs) {
    const usage = run.usage;
    if (!usage) continue;
    totals.turns += usage.turns;
    totals.reportedTurns += usage.reportedTurns;
    totals.inputTokens += usage.inputTokens;
    totals.cachedInputTokens += usage.cachedInputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.wallMs += usage.wallMs;
    if (usage.peakContextTokens !== null) totals.peakContextTokens = Math.max(totals.peakContextTokens ?? 0, usage.peakContextTokens);
  }
  totals.effectiveTokens = effectiveTokens(totals);
  return totals;
}

/**
 * A task's usage over every run it dispatched. Exact means every dispatched run has a
 * usage record and none is partial; none means no run has one. The total is the sum of
 * the measured runs, so a run replaced mid-task adds its own turns, never a copy.
 */
export function taskUsage(runs: Run[]): TaskUsage {
  const dispatched = runs.filter(run => run.agentId || run.usage);
  const measured = dispatched.filter(run => run.usage);
  const evidence = measured.length === 0 ? "none"
    : measured.length === dispatched.length && measured.every(run => !run.usage!.partial) ? "exact" : "partial";
  const byRole = Object.fromEntries(USAGE_ROLES.map(role => [role, totalsOf(measured.filter(run => usageRole(run.role) === role))])) as TaskUsage["byRole"];
  return { evidence, total: totalsOf(measured), byRole };
}
