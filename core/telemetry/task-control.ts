import { telemetryFilterSchema, taskControlTelemetrySchema, type TaskControlTelemetry } from "../../shared/telemetry";
import { VERB_OUTCOME_RETENTION_MS, type Store, type VerbOutcome } from "../store/store";

/**
 * Round 4: the applied and refused task-control rate for the telemetry window,
 * capped at the 30-day outcome retention. Owner and coordinator outcomes stay
 * separate (the round-4 exit target is coordinator refusals under 10%). Refusal
 * reasons group by their text with identities and numbers masked.
 */
export function taskControlTelemetry(store: Store, input: unknown, generatedAt = new Date()): TaskControlTelemetry {
  const filters = telemetryFilterSchema.parse(input);
  const windowMs = Math.min(VERB_OUTCOME_RETENTION_MS, filters.window === "all" ? Infinity : { "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[filters.window] * 86_400_000);
  const repoOf = new Map<string, string | null>();
  const repo = (taskId: string) => {
    // A finished task's live row is purged after 4 days but its control outcomes are
    // kept 30, so a purged task resolves through its durable outcome (review #571).
    if (!repoOf.has(taskId)) {
      let path: string | null = null;
      try { path = store.task(taskId).repoPath; } catch { path = store.outcome(taskId)?.repository?.path ?? null; }
      repoOf.set(taskId, path);
    }
    return repoOf.get(taskId) ?? null;
  };
  const outcomes = store.verbOutcomes(new Date(generatedAt.getTime() - windowMs).toISOString())
    .filter(row => !filters.repoPath || repo(row.taskId) === filters.repoPath);
  const rate = (source: VerbOutcome["source"]) => {
    const rows = outcomes.filter(row => row.source === source), refused = rows.filter(row => row.outcome === "refused").length;
    return { applied: rows.length - refused, refused, refusalRate: rows.length ? refused / rows.length : null };
  };
  const actions = new Map<string, TaskControlTelemetry["byAction"][number]>();
  const reasons = new Map<string, TaskControlTelemetry["topRefusals"][number]>();
  for (const row of outcomes) {
    const key = `${row.source}:${row.action}`;
    const entry = actions.get(key) ?? { source: row.source, action: row.action, applied: 0, refused: 0 };
    entry[row.outcome === "applied" ? "applied" : "refused"] += 1;
    actions.set(key, entry);
    if (row.outcome !== "refused") continue;
    const reason = String(row.detail.reason ?? "No reason recorded")
      .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "…").replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi, "…").replace(/\d+/g, "#").slice(0, 200);
    const reasonKey = `${key}:${reason}`;
    const counted = reasons.get(reasonKey) ?? { source: row.source, action: row.action, reason, count: 0 };
    counted.count += 1;
    reasons.set(reasonKey, counted);
  }
  return taskControlTelemetrySchema.parse({
    windowDays: windowMs / 86_400_000, owner: rate("owner"), coordinator: rate("coordinator"),
    byAction: [...actions.values()].sort((a, b) => b.applied + b.refused - a.applied - a.refused || a.action.localeCompare(b.action)).slice(0, 24),
    topRefusals: [...reasons.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 8),
  });
}
