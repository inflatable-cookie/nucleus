import { z } from "zod";
import { isSshAuthExhausted } from "./ssh-auth";

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
  // Tom, 2026-11-14 (T3 lane v18, host dropout option 1: wait): the task's host
  // is away. The task keeps its identity, host and threads and waits visibly on
  // that host; moving it stays an explicit owner decision.
  "host_unavailable",
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

/**
 * Spec 069 §3, one owner per field: the task funnel never clears a stop because a
 * write changed `reason` (two writers alternating made a stop oscillate on 22 Nov).
 * A writer whose new reason ends the task's stop says so, with the task as it
 * stands now (read it in the same synchronous step). It clears only when the
 * reason really changes: re-asserting the same reason never clears, so it cannot
 * alternate with the stop's owner recording that same text.
 *
 * `endsStopOnReason` is spread into a resolution literal the write already
 * carries; `stopClearedPatch` is spread into a write that carries none.
 */
export function endsStopOnReason(
  current: { reason: string },
  reason: string,
): { stop?: null } {
  return reason !== current.reason ? { stop: null } : {};
}
export function stopClearedPatch<R extends { stop: unknown }>(
  current: { reason: string; resolution: R },
  reason: string,
): { resolution?: R } {
  return reason !== current.reason
    ? { resolution: { ...current.resolution, stop: null } }
    : {};
}
/**
 * The words a task with no stop or wait reads with. It is prose, not a fault: no
 * writer may turn it into a stop (nucleus#1437). A settled wait leaves it behind.
 */
export const TASK_PROGRESSING_REASON =
  "No stop or wait; the task is progressing.";
/** The explicit unknown a blocked phase names when no recorded cause says why it is blocked. */
export const UNKNOWN_TASK_ATTENTION_REASON = "Task needs attention";
/** Whether a reason is the settled-wait prose, which can never be a stop's cause. */
export const isSettledWaitProse = (text: string | null | undefined): boolean =>
  (text ?? "").trim() === TASK_PROGRESSING_REASON;
export type TaskStopReason = z.infer<typeof taskStopReasonSchema>;

/**
 * Stops that clear on their own when their condition changes. No coordinator is
 * launched for them and no attention notice is sent: a coordinator cannot make
 * capacity free up, a dependency finish, GitHub recover or Queue's own
 * integration turn arrive (lean audit 2026-10-15: 11-16 coordinator runs per
 * task were spent on these).
 */
export const waitingTaskStopReasons = [
  "awaiting_proof",
  "origin_busy",
  "capacity",
  "provider_unavailable",
  "route_unavailable",
  "pr_head_lag",
  "prerequisite",
  "workspace_unavailable",
  "validation",
  "lifecycle",
  "external_unavailable",
  "interactive",
  "responsible_question",
  "escalated",
  "paused_stop",
  "host_unavailable",
] as const satisfies readonly TaskStopReason[];
export const isWaitingTaskStop = (reason: TaskStopReason): boolean =>
  (waitingTaskStopReasons as readonly string[]).includes(reason);

/**
 * Spec 067: mechanical waits that no external fact is guaranteed to clear on its own.
 * Once such a stop stays unresolved past its window (or holds an uncertain creation),
 * Nucleus launches the task's coordinator with the explicit commands available.
 */
export const mechanicalStallStopReasons = [
  "lifecycle",
  "workspace_unavailable",
  "pr_head_lag",
  "validation",
  "external_unavailable",
  "origin_busy",
] as const satisfies readonly TaskStopReason[];
export const isMechanicalStallStop = (reason: TaskStopReason): boolean =>
  (mechanicalStallStopReasons as readonly string[]).includes(reason);
export const isUncertainCreationStop = (
  stop: Pick<TaskStopRecord, "fact"> | null | undefined,
): boolean =>
  stop?.fact?.code === "creation_lookup" ||
  stop?.fact?.code === "worker_lookup";

/**
 * A read-only GitHub or git probe that failed for a reason that clears on its
 * own: a forge 5xx, a truncated response or a fetch racing another fetch. A
 * mutating command (any `gh api -X`/`--method` other than GET, a merge, a push)
 * never matches, because its outcome is unknown rather than absent. The reason
 * must *be* the probe failure: an escalation that quotes one (an uncertain
 * merge past its proof window) stays a real stop.
 */
export function isTransientExternalFailure(detail: string): boolean {
  if (
    /\s(?:-X|--method)\s*(?!GET\b)[A-Z]+\b|\bgh pr merge\b|\bgit push\b/.test(
      detail,
    )
  )
    return false;
  const readOnly =
    /^(?:External merge check: )?(?:Command failed: (?:gh api|gh pr view|git fetch)\b|Integration checkout changed while fetching)/.test(
      detail,
    );
  return (
    readOnly &&
    (/\bHTTP 5\d\d\b|\b5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/.test(
      detail,
    ) ||
      /unexpected end of JSON input|Integration checkout changed while fetching|ETIMEDOUT|EAI_AGAIN|ECONNRESET/.test(
        detail,
      ))
  );
}

/**
 * Stop verbs name the existing owner verbs an owner can run from the stop. A
 * budget stop names `extend_budget` (nucleus#1153): the pause is answered by an
 * extension, and a stop that listed nothing left the task reading as stranded.
 */
export const taskStopVerbs = [
  "restart",
  "route",
  "move",
  "proof",
  "extend_budget",
  "retry_effect",
] as const;
/** Owner verbs that can advance a stop of this reason; a wait clears on its own. */
export const taskStopVerbsFor = (reason: TaskStopReason): TaskStopVerb[] =>
  reason === "operator_needed"
    ? ["restart", "route", "move"]
    : reason === "run_stalled"
      ? ["restart"]
      : reason === "budget"
        ? ["extend_budget"]
        : [];
/**
 * Nucleus#1159: a phase blocked on an uncertain side effect past its bound is
 * attention, not a quiet wait. The detail this prefix opens names the blocking
 * effects, and the owner's one exit is the observation-first `retry_effect`.
 */
export const BLOCKED_EFFECT_ATTENTION_PREFIX =
  "An uncertain side effect blocks review";
export const taskStopVerbSchema = z.enum(taskStopVerbs);
export type TaskStopVerb = z.infer<typeof taskStopVerbSchema>;

export const taskDecisionFactSchema = z
  .object({
    code: z.enum([
      "integration_turn",
      "workspace_absent",
      "workspace_orphan",
      // Spec 068 §4: a phase with no live run, stop or hold that could not be readmitted.
      "orphan_phase",
      "creation_lookup",
      "worker_lookup",
      "callback_missing",
      "callback_expired",
      "callback_attention",
      "callback_stopped",
      "thread_running",
      "creating_worker",
      "profile_unavailable",
      "retained_profile",
      "host_read_exhausted",
      "coordinator_unavailable",
      "ssh_auth",
      "provider_retry",
      "provider_refusal",
      "external_merge_check",
      "external_merge_recovered",
      "check_deadline",
      "review_effect_wait",
      "hook_hold",
      "pr_head_changed",
      "pr_identity",
      "accepted_pr",
      "closeout_base_refresh",
      "deferred_verb",
      "prerequisite",
      "qa_capacity",
      "slot_capacity",
      "dispatch",
      "dispatch_hold",
      "usage_gate",
      "progressing",
      "pre_send_refused",
      "bb_connect",
      "escalation",
      "consult",
      "review_delivery",
      "origin_error",
      // Spec 068 §3: a participant whose agent is provably gone, past the
      // automatic relaunch bound; its subject is the run (or retained worker).
      "participant_gone",
      // Spec 068 §3: the host may still answer the run's own create command, so
      // the creation waits for that answer; nothing replaces it meanwhile.
      "creation_in_flight",
      // Spec 068 batch A: a first dispatch's workspace creation is uncertain and
      // settles by lookup; past its release bound it is a typed stop naming
      // record.clear kind=workspace_intent. Its subject is the task branch.
      "workspace_lookup",
    ]),
    subject: z.string().min(1).max(240).optional(),
    escalationWait: z.object({
      kind: z.enum(["planner", "decision", "time"]),
      target: z.string().min(1).max(240),
    }).strict().optional(),
  })
  .strict();
export type TaskDecisionFact = z.infer<typeof taskDecisionFactSchema>;

const decisionPatterns: ReadonlyArray<[TaskDecisionFact["code"], RegExp]> = [
  ["integration_turn", /^Waiting for repository integration turn/],
  ["workspace_absent", /^Workspace creation is absent from inventory/],
  ["workspace_orphan", / left an orphan .*base-identical and unpublished/],
  [
    "creation_lookup",
    /^(?:Exact (?!worker )\w+ creation lookup is unavailable|The \w+ creation lookup for run |The \w+ creation .+ is still uncertain: a complete lookup)/,
  ],
  [
    "worker_lookup",
    /^(?:Exact worker creation lookup is unavailable|Worker creation lookup is partial)/,
  ],
  ["callback_expired", /^The (\w+) callback reminder expired$/],
  [
    "callback_missing",
    /^The (\w+) thread stopped without a callback; inspect the thread$/,
  ],
  [
    "callback_attention",
    /^The (\w+) (?:thread stopped and its one callback reminder expired|callback reminder expired)/,
  ],
  ["callback_stopped", /^The (\w+) thread stopped/],
  ["callback_missing", /^(worker) stopped without a completion callback/i],
  ["thread_running", /^(\w+) thread running$/],
  ["creating_worker", /^Creating worker$/],
  ["profile_unavailable", /^No eligible/],
  ["retained_profile", /^Retained worker profile is disabled or unavailable/],
  [
    "host_read_exhausted",
    /could not read host state after \d+ attempts|Owner: host-read recovery\./,
  ],
  [
    "coordinator_unavailable",
    /^No coordinator profile is available for recovery/,
  ],
  ["provider_retry", /^Transient provider error/],
  ["provider_refusal", /^Reviewer run (\S+) provider refusal is unverified/],
  ["external_merge_check", /^External merge check:/],
  [
    "external_merge_recovered",
    /^External merge check recovered; resuming task$/,
  ],
  ["check_deadline", /has been pending past its deadline.*job URL:/s],
  ["review_effect_wait", /^(?:Ordinary review|Review-entry) waits for /],
  ["hook_hold", /^Repository hook .+ holds this transition: /s],
  ["pr_head_changed", /^PR head changed after the completion callback$/],
  ["pr_identity", /PR must be open/],
  ["accepted_pr", /^Operator requested accepted-PR workspace reconciliation$/],
  ["closeout_base_refresh", /^Refreshing main before retrying closeout$/],
  [
    "review_delivery",
    /^Reviewer delivery (ns-review-[a-f0-9]{64}) (?:is reserved|is uncertain)/,
  ],
  [
    "deferred_verb",
    /^Owner (\w+) recorded; it is delivered once Nucleus is (?:unpaused|released)$/,
  ],
  ["prerequisite", /^Waiting for prerequisites:/],
  ["qa_capacity", /^Waiting for QA capacity \(position /],
  ["slot_capacity", /^Waiting for a project slot…/],
  ["dispatch", /^Waiting for dispatch$/],
  ["dispatch_hold", /^Dispatch held(?:[ ;]|$)/],
  [
    "usage_gate",
    /^Waiting for the operator: the Low usage level needs permission/,
  ],
  ["progressing", /^No stop or wait; the task is progressing\.$/],
  [
    "bb_connect",
    /^BB host operation was not sent: Service socket connect failed: /,
  ],
  ["pre_send_refused", /refused before send/i],
  [
    "escalation",
    /^(?:Waiting with the (?:planner|operator).*?escalation |Escalation |Blocker escalation )([\w-]+)/,
  ],
  ["consult", /^Waiting with the retained reviewer: consult ([\w-]+)/],
];

/** Decode old text at the persistence boundary and typed upstream diagnostics at their write. */
export function taskDecisionFact(text: string): TaskDecisionFact | null {
  if (isSshAuthExhausted(text)) return { code: "ssh_auth" };
  for (const [code, pattern] of decisionPatterns) {
    const match = pattern.exec(text);
    if (match)
      return {
        code,
        ...(match[1]
          ? {
              subject: (code === "callback_missing"
                ? match[1].toLowerCase()
                : match[1]
              ).slice(0, 240),
            }
          : {}),
      };
  }
  return null;
}

/** Durable current stop. A matching observation preserves `since`; clearing it starts no new episode. */
export const taskStopRecordSchema = z
  .object({
    reason: taskStopReasonSchema,
    detail: z.string().trim().min(1).max(4000),
    since: z.string().datetime({ offset: true }),
    suggestedVerbs: z.array(taskStopVerbSchema).max(taskStopVerbs.length),
    /**
     * The agent a wait is with, when the wait's own writer names one (the ladder's
     * escalation holder). The stop detail repeats it in its sentence for a human;
     * no reader takes the holder from that sentence.
     */
    holderAgentId: z.string().min(1).max(240).optional(),
    fact: taskDecisionFactSchema.nullable().optional(),
    incidentId: z.string().optional(),
  })
  .strict();
export type TaskStopRecord = z.infer<typeof taskStopRecordSchema>;

/**
 * One family of recorded stop detail: the typed reason its own sentence names,
 * and the verbs that advance it. Declared as data, in precedence order, so a new
 * kind of wait is one entry instead of another branch in a chain.
 */
interface StopFamily {
  reason: TaskStopReason;
  suggestedVerbs: readonly TaskStopVerb[];
  matches(detail: string): boolean;
}

const stopFamilies: readonly StopFamily[] = [
  // A hold is its owner's gate: release (or keep_hold) clears it, never a coordinator.
  {
    reason: "held",
    suggestedVerbs: [],
    matches: (detail) => /^(?:Merge|Dispatch) held\b/.test(detail),
  },
  // Nucleus#1159: the blocked review's one supported exit is the owner's observation-first retry.
  {
    reason: "operator_needed",
    suggestedVerbs: ["retry_effect"],
    matches: (detail) => detail.startsWith(BLOCKED_EFFECT_ATTENTION_PREFIX),
  },
  {
    reason: "external_unavailable",
    suggestedVerbs: [],
    matches: isTransientExternalFailure,
  },
  {
    reason: "origin_busy",
    suggestedVerbs: [],
    matches: (detail) =>
      /Origin author thread .+ (active|uncertain) turn|origin author.*busy/i.test(
        detail,
      ),
  },
  {
    reason: "capacity",
    suggestedVerbs: [],
    matches: (detail) =>
      /project slot|task slot|capacity|host pressure|waiting behind .*in-flight|admission budget|waiting for dispatch/i.test(
        detail,
      ),
  },
  {
    reason: "provider_unavailable",
    suggestedVerbs: [],
    matches: (detail) =>
      /provider (?:group )?(?:unavailable|exhausted)|subscription group .+ unavailable|quota or balance exhaustion/i.test(
        detail,
      ),
  },
  {
    reason: "route_unavailable",
    suggestedVerbs: [],
    matches: (detail) =>
      /coordinator.{0,60}(?:busy|running|active|unavailable)|(?:busy|running|active).{0,60}coordinator|no eligible |no .*profile(?: is)? (?:available|enabled)|profile .* unavailable|configure .*profile/i.test(
        detail,
      ),
  },
  {
    reason: "prerequisite",
    suggestedVerbs: [],
    matches: (detail) => /prerequisite/i.test(detail),
  },
  {
    reason: "workspace_unavailable",
    suggestedVerbs: [],
    matches: (detail) =>
      /workspace (?:is )?(?:unavailable|missing)|workspace creation is uncertain|workspace identity/i.test(
        detail,
      ),
  },
  {
    reason: "pr_head_lag",
    suggestedVerbs: [],
    matches: (detail) =>
      /pr (?:head|branch).*(?:lag|behind|not yet)|head lag|waiting for .*pr head/i.test(
        detail,
      ),
  },
  // A live or unverified worktree QA/validation process is the task's own work
  // still finishing, not absence and not a fault: it waits with no owner verb
  // until the scan observes it settled.
  {
    reason: "validation",
    suggestedVerbs: [],
    matches: (detail) =>
      /validation (?:is )?still running in the worktree|worktree validation scan is (?:unverified|incomplete)|validation scan is unverified/i.test(
        detail,
      ),
  },
  // Queue's own next step is in progress: its integration turn, required checks
  // settling, a merge outcome probe, or a run it just launched.
  {
    reason: "lifecycle",
    suggestedVerbs: [],
    matches: (detail) =>
      /integration turn|required checks? (?:pending|settl|running)|waiting for required checks|merge outcome is uncertain|daemon transport unavailable|host login session is gone|continuing from checkpoint/i.test(
        detail,
      ),
  },
  // Spec 058 slice 17: the blocker ladder's own waits. The consult or the
  // delegated answer settles them; a coordinator cannot, so they clear on their own.
  {
    reason: "escalated",
    suggestedVerbs: [],
    matches: (detail) =>
      /waiting with the (?:retained reviewer|planner|operator)/i.test(detail),
  },
  // The one host wait (`shared/host-outage.ts`). Older text paths that restore a
  // reason never invent a different owner for a host that is away.
  {
    reason: "host_unavailable",
    suggestedVerbs: [],
    matches: (detail) =>
      /^Waiting on .{1,120} host .{1,120} since \d{4}-\d{2}-\d{2}T/.test(
        detail,
      ),
  },
];

/**
 * The tail: detail no family names is attention with the ordinary owner verbs,
 * never a quiet wait, so an unrecognised fault stays visible instead of clearing
 * on its own. It is named once here rather than implied by the end of a chain.
 */
export const unclassifiedTaskStop = (): Pick<
  TaskStopRecord,
  "reason" | "suggestedVerbs"
> => ({
  reason: "operator_needed",
  suggestedVerbs: taskStopVerbsFor("operator_needed"),
});

/** Stable classification for the transient waits the task quantum can observe. */
export function taskStopClassification(
  detail: string,
): Pick<TaskStopRecord, "reason" | "suggestedVerbs"> {
  const family = stopFamilies.find((candidate) => candidate.matches(detail));
  return family
    ? { reason: family.reason, suggestedVerbs: [...family.suggestedVerbs] }
    : unclassifiedTaskStop();
}

/**
 * Whether a recorded stop is a wait. Its own typed reason decides; its detail is
 * classified too, for a row whose reason and sentence were written by an older
 * path. One owner answers this so no surface re-reads the sentence itself.
 */
export function recordedStopIsWait(
  record: Pick<TaskStopRecord, "reason">,
): boolean {
  return isWaitingTaskStop(record.reason);
}

/**
 * The agent a recorded stop's detail names as the one the task waits with, for a
 * row written before `holderAgentId` existed. A record that carries the field is
 * never read this way: its own writer recorded the holder, and the sentence stays
 * display text.
 */
export function legacyStopHolderAgentId(
  detail: string | null | undefined,
): string | undefined {
  return (
    detail?.match(
      /Waiting with the planner or task owner\s+([0-9a-f-]{36})\s*:/i,
    )?.[1] ?? undefined
  );
}

/** Whether a recorded stop is a hold; read exactly like `recordedStopIsWait`. */
export function recordedStopIsHeld(
  record: Pick<TaskStopRecord, "reason">,
): boolean {
  return record.reason === "held";
}

/**
 * Dispatch found no eligible profile for the task's next role. The recorded typed stop is the
 * fact every reader uses; the visible reason text is never parsed for it.
 */
export const routeUnavailableStop = (task: {
  resolution: { stop: { reason: string } | null };
}): boolean => task.resolution.stop?.reason === "route_unavailable";

/** A stop's suggested verbs follow its typed reason unless the caller names them; never its detail text. */
export function taskStopRecord(
  reason: TaskStopReason,
  detail: string,
  prior?: TaskStopRecord | null,
  at = new Date().toISOString(),
  suggestedVerbs = taskStopVerbsFor(reason),
  holderAgentId?: string | null,
  fact = taskDecisionFact(detail),
): TaskStopRecord {
  const normalized = detail.trim().slice(0, 4000) || reason;
  // Escalated stops default to the planner seat. Only a writer with the
  // recorded decision or time target can name a different wait.
  if (reason === "escalated" && fact?.code === "escalation" && fact.subject && !fact.escalationWait)
    fact = { ...fact, escalationWait: { kind: "planner", target: holderAgentId || fact.subject } };
  return taskStopRecordSchema.parse({
    reason,
    detail: normalized,
    since: prior?.reason === reason ? prior.since : at,
    suggestedVerbs,
    fact,
    ...(holderAgentId ? { holderAgentId } : {}),
  });
}

/** Spec 050: the stop or wait category `task.next` reports; the board badge reuses the same derivation. */
export const taskStopKindSchema = z.enum([
  "hold",
  "incident",
  "recovery",
  "attention",
  "wait",
  "run",
]);

export type TaskStopKind = z.infer<typeof taskStopKindSchema>;

/**
 * A stop that names this run as its subject: an uncertain-creation wait, or a
 * stalled-turn stop bound to it. Once the run is released the stop describes
 * history, so the release clears it (Spec 068 §5; bovine-accelerator#6863 kept
 * "Uncertain reviewer creation <old run>" after its replacement).
 */
export function stopNamesRun(
  task: {
    resolution: {
      stop: TaskStopRecord | null;
      incident?: { runId?: string | null } | null;
      stalledTurnStop?: { runId: string } | null;
    };
  },
  runId: string,
): boolean {
  const stop = task.resolution.stop;
  if (!stop) return false;
  if (stop.fact?.subject === runId) return true;
  return (
    stop.reason === "run_stalled" &&
    (task.resolution.incident?.runId === runId ||
      task.resolution.stalledTurnStop?.runId === runId)
  );
}

