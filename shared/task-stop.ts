import { z } from "zod";

/** Spec 050 stop reasons: why a task cannot take its next ordinary step. */
export const taskStopReasons = [
  "awaiting_proof",
  "operator_needed",
  "run_stalled",
  "origin_busy",
  "capacity",
  "provider_unavailable",
  "route_unavailable",
  "pr_head_lag",
  "prerequisite",
  "workspace_unavailable",
  "validation",
  "held",
  "lifecycle",
  "external_unavailable",
  // Spec 051: an interactive task's worker is idle in its thread, waiting for the operator.
  "interactive",
  // Spec 058: a responsible task waits on the operator's answer to its one joint
  // worker/reviewer question. The answer clears it; a coordinator cannot.
  "responsible_question",
  // Spec 058 slice 17: a stuck responsible task waits inside the blocker ladder —
  // with the retained reviewer (consult) or with the planner (escalation) — until
  // the consult advice or the delegated answer settles it. The answer clears it.
  "escalated",
  // Spec 058 budgets: a responsible task reached its effective-token or wall-time limit.
  // It starts no new run until the operator extends it, changes its approach or stops it.
  "budget",
  // Queue #650: an operator stopped this task's live thread while Queue was paused
  // (stop active threads). It clears when Queue resumes the thread on unpause.
  "paused_stop",
] as const;
export const taskStopReasonSchema = z.enum(taskStopReasons);
/** Queue's reason for a queued task with nothing in its way but dispatch itself. */
export const DISPATCH_WAIT_REASON = "Waiting for dispatch";
export type TaskStopReason = z.infer<typeof taskStopReasonSchema>;

/**
 * Stops that clear on their own when their condition changes. No coordinator is
 * launched for them and no attention notice is sent: a coordinator cannot make
 * capacity free up, a dependency finish, GitHub recover or Queue's own
 * integration turn arrive (lean audit 2026-10-15: 11-16 coordinator runs per
 * task were spent on these).
 */
export const waitingTaskStopReasons = [
  "awaiting_proof", "origin_busy", "capacity", "provider_unavailable", "route_unavailable", "pr_head_lag",
  "prerequisite", "workspace_unavailable", "validation", "lifecycle", "external_unavailable", "interactive",
  "responsible_question", "escalated", "paused_stop",
] as const satisfies readonly TaskStopReason[];
export const isWaitingTaskStop = (reason: TaskStopReason): boolean => (waitingTaskStopReasons as readonly string[]).includes(reason);

/**
 * A read-only GitHub or git probe that failed for a reason that clears on its
 * own: a forge 5xx, a truncated response or a fetch racing another fetch. A
 * mutating command (any `gh api -X`/`--method` other than GET, a merge, a push)
 * never matches, because its outcome is unknown rather than absent. The reason
 * must *be* the probe failure: an escalation that quotes one (an uncertain
 * merge past its proof window) stays a real stop.
 */
export function isTransientExternalFailure(detail: string): boolean {
  if (/\s(?:-X|--method)\s*(?!GET\b)[A-Z]+\b|\bgh pr merge\b|\bgit push\b/.test(detail)) return false;
  const readOnly = /^(?:External merge check: )?(?:Command failed: (?:gh api|gh pr view|git fetch)\b|Integration checkout changed while fetching)/.test(detail);
  return readOnly && (/\bHTTP 5\d\d\b|\b5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/.test(detail)
    || /unexpected end of JSON input|Integration checkout changed while fetching|ETIMEDOUT|EAI_AGAIN|ECONNRESET/.test(detail));
}

/**
 * Stop verbs name the existing owner verbs an owner can run from the stop. A
 * budget stop names `extend_budget` (nucleus#1153): the pause is answered by an
 * extension, and a stop that listed nothing left the task reading as stranded.
 */
export const taskStopVerbs = ["restart", "route", "move", "proof", "extend_budget", "retry_effect"] as const;
/** Owner verbs that can advance a stop of this reason; a wait clears on its own. */
export const taskStopVerbsFor = (reason: TaskStopReason): TaskStopVerb[] =>
  reason === "operator_needed" ? ["restart", "route", "move"] : reason === "run_stalled" ? ["restart"] : reason === "budget" ? ["extend_budget"] : [];
/**
 * Nucleus#1159: a phase blocked on an uncertain side effect past its bound is
 * attention, not a quiet wait. The detail this prefix opens names the blocking
 * effects, and the owner's one exit is the observation-first `retry_effect`.
 */
export const BLOCKED_EFFECT_ATTENTION_PREFIX = "An uncertain side effect blocks review";
export const taskStopVerbSchema = z.enum(taskStopVerbs);
export type TaskStopVerb = z.infer<typeof taskStopVerbSchema>;

/** Durable current stop. A matching observation preserves `since`; clearing it starts no new episode. */
export const taskStopRecordSchema = z.object({
  reason: taskStopReasonSchema,
  detail: z.string().trim().min(1).max(4000),
  since: z.string().datetime({ offset: true }),
  suggestedVerbs: z.array(taskStopVerbSchema).max(taskStopVerbs.length),
}).strict();
export type TaskStopRecord = z.infer<typeof taskStopRecordSchema>;

/** Stable classification for the transient waits the task quantum can observe. */
export function taskStopClassification(detail: string): Pick<TaskStopRecord, "reason" | "suggestedVerbs"> {
  // A hold is its owner's gate: release (or keep_hold) clears it, never a coordinator.
  if (/^(?:Merge|Dispatch) held\b/.test(detail))
    return { reason: "held", suggestedVerbs: [] };
  // Nucleus#1159: the blocked review's one supported exit is the owner's
  // observation-first retry, so it is attention with that verb suggested.
  if (detail.startsWith(BLOCKED_EFFECT_ATTENTION_PREFIX))
    return { reason: "operator_needed", suggestedVerbs: ["retry_effect"] };
  if (isTransientExternalFailure(detail))
    return { reason: "external_unavailable", suggestedVerbs: [] };
  if (/Origin author thread .+ (active|uncertain) turn|origin author.*busy/i.test(detail))
    return { reason: "origin_busy", suggestedVerbs: [] };
  if (/project slot|task slot|capacity|host pressure|waiting behind .*in-flight|admission budget|waiting for dispatch/i.test(detail))
    return { reason: "capacity", suggestedVerbs: [] };
  if (/provider (?:group )?(?:unavailable|exhausted)|subscription group .+ unavailable|quota or balance exhaustion/i.test(detail))
    return { reason: "provider_unavailable", suggestedVerbs: [] };
  if (/coordinator.{0,60}(?:busy|running|active|unavailable)|(?:busy|running|active).{0,60}coordinator|no eligible |no .*profile(?: is)? (?:available|enabled)|profile .* unavailable|configure .*profile/i.test(detail))
    return { reason: "route_unavailable", suggestedVerbs: [] };
  if (/prerequisite/i.test(detail))
    return { reason: "prerequisite", suggestedVerbs: [] };
  if (/workspace (?:is )?(?:unavailable|missing)|workspace creation is uncertain|workspace identity/i.test(detail))
    return { reason: "workspace_unavailable", suggestedVerbs: [] };
  if (/pr (?:head|branch).*(?:lag|behind|not yet)|head lag|waiting for .*pr head/i.test(detail))
    return { reason: "pr_head_lag", suggestedVerbs: [] };
  // A live or unverified worktree QA/validation process is the task's own work
  // still finishing, not absence and not a fault: it waits with no owner verb
  // until the scan observes it settled.
  if (/validation (?:is )?still running in the worktree|worktree validation scan is (?:unverified|incomplete)|validation scan is unverified/i.test(detail))
    return { reason: "validation", suggestedVerbs: [] };
  // Queue's own next step is in progress: its integration turn, required checks
  // settling, a merge outcome probe, or a run it just launched.
  if (/integration turn|required checks? (?:pending|settl|running)|waiting for required checks|merge outcome is uncertain|daemon transport unavailable|host login session is gone|continuing from checkpoint/i.test(detail))
    return { reason: "lifecycle", suggestedVerbs: [] };
  // Spec 058 slice 17: the blocker ladder's own waits. The consult or the
  // delegated answer settles them; a coordinator cannot, so they clear on their own.
  if (/waiting with the (?:retained reviewer|planner|operator)/i.test(detail))
    return { reason: "escalated", suggestedVerbs: [] };
  return { reason: "operator_needed", suggestedVerbs: ["restart", "route", "move"] };
}

/** A stop's suggested verbs follow its typed reason unless the caller names them; never its detail text. */
export function taskStopRecord(
  reason: TaskStopReason, detail: string, prior?: TaskStopRecord | null,
  at = new Date().toISOString(), suggestedVerbs = taskStopVerbsFor(reason),
): TaskStopRecord {
  const normalized = detail.trim().slice(0, 4000) || reason;
  return taskStopRecordSchema.parse({
    reason,
    detail: normalized,
    since: prior?.reason === reason ? prior.since : at,
    suggestedVerbs,
  });
}

/** Spec 050: the stop or wait category `task.next` reports; the board badge reuses the same derivation. */
export const taskStopKindSchema = z.enum(["hold", "incident", "recovery", "attention", "wait", "run"]);

export type TaskStopKind = z.infer<typeof taskStopKindSchema>;
