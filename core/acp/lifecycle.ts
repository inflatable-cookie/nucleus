/**
 * Spec 065 & Spec 068 §2: the task's live activity rendered for an ACP task thread.
 *
 * The agent has no model, so every plan step, tool call, status line and human message
 * comes from here, derived from `taskActivity(facts)` and the task's recorded runs,
 * verdicts and open decisions:
 *
 * - Plan: Queued, Working, Review round N of M, Merge, Close (`pending` / `in_progress` / `completed`).
 * - Tool calls: one `tool_call` per participant run and per automatic repair, with plain
 *   titles and a short detail line from `activity.detail`.
 * - Messages: only what a person reads — a verdict's summary, a question for the operator
 *   with its decision link, and the finish. No raw IDs, SHAs or stop text.
 * - Fallback: one concise status line for clients or attaches without structured updates.
 */
import { createHash } from "node:crypto";
import { REVISION_BUDGET } from "../../shared/incident";
import { isTerminalPhase, taskStateLabel } from "../../shared/task-state";
import type { Decision, Run, Task } from "../../shared/contracts";
import type { TaskActivity } from "../../shared/schema/task-activity";
import type {
  AcpPlanEntry,
  AcpPlanStatus,
  AcpTaskPresentation,
  AcpToolCall,
  AcpToolCallKind,
  AcpToolCallStatus,
} from "../../shared/acp/surface";
import { clipText } from "../../shared/task-detail-summary";
import {
  isReservedRepair,
  readRepairJournal,
  reservationWords,
  type RepairAttemptOutcome,
} from "../recovery/repair-attempts";

/** Default per-cause automatic repair attempt bound (Spec 068 §5). */
const DEFAULT_REPAIR_ATTEMPT_LIMIT = 3;

/** The task's name in text: its durable reference when it has one, else its number or title. */
export function acpTaskName(
  task: Pick<Task, "reference" | "number" | "title" | "id">,
): string {
  if (task.reference) return task.reference;
  if (typeof task.number === "number") return `task ${task.number}`;
  return task.title ? `task “${task.title.slice(0, 80)}”` : `task ${task.id}`;
}

/** Human-facing task name that never exposes a raw internal task ID. */
function acpHumanTaskName(
  task: Pick<Task, "reference" | "number" | "title">,
): string {
  if (task.reference) return task.reference;
  if (typeof task.number === "number") return `task ${task.number}`;
  const title = task.title ? sanitizeHumanText(task.title).slice(0, 80) : "";
  return title ? `“${title}”` : "This task";
}

/**
 * What a session has already shown about this task: the verdict keys and decision
 * versions already emitted as messages, plus legacy line memory for fallback helpers.
 */
export interface AcpLineMemory {
  /** Whether the task reference was already shown on this session. */
  named: boolean;
  /** The PR link already shown on this session, if any. */
  prUrl: string | null;
  /** Verdict keys already emitted as human messages on this session. */
  verdicts?: string[];
  /** Open decision keys (`id:version`) already emitted as human messages on this session. */
  decisions?: string[];
  /** Whether the terminal finish message was already emitted on this session. */
  finished?: boolean;
}

export interface AcpTaskFacts {
  task: Task;
  runs: readonly Run[];
  activity: TaskActivity;
  decisions?: readonly Decision[];
  /**
   * The task's journal. Read only for the facts that name each automatic repair
   * attempt (its launch, `telemetry_recovery`, or a reserved attempt's settlement,
   * `recovery_attempt_settled`), so a later repair never rewrites an earlier attempt's
   * title and every attempt keeps the identity it was reserved under.
   */
  events?: readonly AcpJournalEvent[];
}

/** The one journal shape this rendering reads. */
export interface AcpJournalEvent {
  kind: string;
  detail: string;
}

/** The PR's number in text (`PR #276`), read from its URL; null when the URL has none. */
export function acpPrRef(prUrl: string): string | null {
  const number = /\/pull\/(\d+)/.exec(prUrl)?.[1];
  return number ? `PR #${number}` : null;
}

/**
 * Strip raw internal IDs, commit SHAs and stop-reason codes from human-facing messages.
 * Preserves PR numbers (`PR #430`) and task references (`nucleus#1554`).
 */
export function sanitizeHumanText(text: string): string {
  return (
    text
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        "",
      )
      .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi, "")
      // Every host's identifier form, not one host's: `mcp:delegated-work`,
      // `thread:delegated-task:…`, `t3code:one`, `paseo:one`, `wks_…`, `run:…`.
      .replace(
        /\b(?:task|run|agent|thread|session|decision|episode|incident|wks|msg|mcp|t3code|paseo|bb|host|node|work|nucleus-agent)[_:-][A-Za-z0-9_.:-]+\b/gi,
        "",
      )
      .replace(
        /\b(?:run_stalled|operator_needed|responsible_question|awaiting_proof|origin_busy|provider_unavailable|route_unavailable|pr_head_lag|workspace_unavailable|external_unavailable|host_unavailable|paused_stop|needs_operator_input|needs_source_rights|waiting_capacity|waiting_prerequisite|merge_hold)\b/g,
        "",
      )
      .replace(/\(\s*\)/g, "")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

const lowerFirst = (text: string): string =>
  text.length ? text[0]!.toLowerCase() + text.slice(1) : text;

/**
 * Build the 5-step ACP `plan` for a task:
 * Queued, Working, Review round N of M, Merge, Close.
 */
export function acpTaskPlan(
  task: Task,
  runs: readonly Run[],
  activity: TaskActivity,
): AcpPlanEntry[] {
  const round = Math.min(REVISION_BUDGET, task.resolution.revisionRuns + 1);
  const labels = [
    "Queued",
    "Working",
    `Review round ${round} of ${REVISION_BUDGET}`,
    "Merge",
    "Close",
  ];
  const statuses = planStatuses(task, runs, activity);
  return labels.map((content, index) => {
    const status = statuses[index]!;
    return {
      content,
      priority: status === "in_progress" ? "high" : "medium",
      status,
    };
  });
}

function planStatuses(
  task: Task,
  runs: readonly Run[],
  activity: TaskActivity,
): [AcpPlanStatus, AcpPlanStatus, AcpPlanStatus, AcpPlanStatus, AcpPlanStatus] {
  const atIndex = (
    active: number,
  ): [
    AcpPlanStatus,
    AcpPlanStatus,
    AcpPlanStatus,
    AcpPlanStatus,
    AcpPlanStatus,
  ] =>
    [0, 1, 2, 3, 4].map((index) =>
      index < active
        ? "completed"
        : index === active
          ? "in_progress"
          : "pending",
    ) as [
      AcpPlanStatus,
      AcpPlanStatus,
      AcpPlanStatus,
      AcpPlanStatus,
      AcpPlanStatus,
    ];

  switch (task.phase) {
    case "queued":
      return atIndex(0);
    case "dispatching":
    case "working":
    case "changes_requested":
      return atIndex(1);
    case "awaiting_review":
    case "reviewing":
      return atIndex(2);
    case "verifying":
    case "merging":
    case "syncing":
      return atIndex(3);
    case "closing":
      return atIndex(4);
    case "done":
      return ["completed", "completed", "completed", "completed", "completed"];
    case "cancelled": {
      const worked =
        Boolean(task.prUrl) ||
        runs.some((r) => r.role === "revision" && Boolean(r.completion));
      const reviewed = task.resolution.review?.status === "ready_to_merge";
      return [
        "completed",
        worked ? "completed" : "pending",
        reviewed ? "completed" : "pending",
        "pending",
        "pending",
      ];
    }
    case "report_ready":
    case "blocked":
    case "error":
    case "needs_attention": {
      if (task.resolution.review?.status === "ready_to_merge" && task.prUrl) {
        return atIndex(3);
      }
      if (
        task.prUrl &&
        (activity.role === "reviewer" ||
          runs.some((r) => r.role === "reviewer" && !r.released))
      ) {
        return atIndex(2);
      }
      return atIndex(1);
    }
  }
}

function activeDetailLine(activity: TaskActivity): string | undefined {
  if (activity.state === "active") {
    return activity.detail;
  }
  if (activity.state === "needs_person" && activity.permission) {
    return activity.permission.kind === "question"
      ? "waiting on a question prompt"
      : "waiting on a permission prompt";
  }
  if (activity.state === "nucleus") {
    return `between steps: ${lowerFirst(activity.detail)}`;
  }
  if (activity.state === "needs_person" || activity.state === "unclassified") {
    return sanitizeHumanText(activity.detail) || undefined;
  }
  return undefined;
}

function completedDetailLine(
  run: Pick<Run, "completion" | "status">,
): string | undefined {
  const status = run.completion?.status;
  switch (status) {
    case "ready_for_review":
      return "Ready for review";
    case "ready_to_merge":
      return "Approved";
    case "changes_required":
      return "Changes requested";
    case "closed":
      return "Closed";
    case "verified":
    case "proof_executed":
      return "Verified";
    case "recovered":
      return "Recovered";
    case "blocked":
      return "Blocked";
    case "error":
      return "Failed";
    case "escalate":
      return "Escalated";
    default:
      return run.status === "stopped" ? "Stopped" : undefined;
  }
}

function runToolStatus(
  run: Pick<Run, "status" | "released" | "completion">,
  isLive: boolean,
): AcpToolCallStatus {
  if (
    isLive &&
    !run.released &&
    !run.completion &&
    run.status !== "finished" &&
    run.status !== "stopped" &&
    run.status !== "superseded"
  ) {
    return "in_progress";
  }
  if (
    run.completion?.status === "error" ||
    run.completion?.status === "blocked" ||
    run.completion?.status === "escalate" ||
    (run.status === "stopped" && !run.completion)
  ) {
    return "failed";
  }
  return "completed";
}

const incidentActionLabels: Record<string, (role: string) => string> = {
  replacement: (role) => `starting a fresh ${role}`,
  exact_lookup: (role) => `checking the ${role} thread`,
  callback_reminder: (role) => `reminding the ${role}`,
  stall_continuation: () => "continuing the stalled turn",
};

/** One repair attempt: its own words, and the charged attempt number the bound counts. */
interface RepairAttempt {
  attempt: number;
  cause: string;
  targetRole: string;
  action: string;
  headline?: string;
}

function repairTitle(attempt: RepairAttempt): string {
  // Spec 068 §5 bounds repairs per cause at a fixed limit; the displayed count is the
  // charged attempts alone, so an uncharged outage launch never raises it.
  const ordinal = Math.max(1, attempt.attempt);
  const limit = DEFAULT_REPAIR_ATTEMPT_LIMIT;
  const roleLabel =
    attempt.targetRole && attempt.targetRole !== "unknown"
      ? attempt.targetRole
      : "participant";
  const actionFn = attempt.action
    ? incidentActionLabels[attempt.action]
    : undefined;
  const actionLabel = actionFn ? actionFn(roleLabel) : "";
  const cause =
    clipText(sanitizeHumanText(attempt.cause), 100) ||
    clipText(sanitizeHumanText(attempt.headline ?? ""), 100) ||
    "Recovering the task";

  if (actionLabel && !cause.toLowerCase().includes(actionLabel.toLowerCase())) {
    return `${cause} · ${actionLabel} (${ordinal} of ${limit})`;
  }
  return `${cause} (${ordinal} of ${limit})`;
}

/**
 * One wait occurrence's own call lifetime. The activity derivation names the fact that
 * owns each reading (`occurrence`), so a wait keeps one call while that fact holds and a
 * fresh occurrence — another decision, another stop, a new stop recorded beside a host
 * wait — is a new call. When a reading names no owner, the last concluded run and the
 * phase stand in, so a recurring gap after another run never reuses a completed call.
 */
function waitOccurrenceId(
  task: Task,
  runs: readonly Run[],
  activity: TaskActivity,
): string {
  const owner =
    activity.occurrence ??
    `reading:${task.phase}:${runs.findLast((run) => run.released || run.completion)?.id ?? ""}`;
  return `activity:${activity.state}:${createHash("sha256")
    .update(owner)
    .digest("hex")
    .slice(0, 10)}`;
}

/**
 * Repair launches a pre-send host-read refusal released and refunded: the journal
 * names the run, so its launch is a settled non-charge and stays out of the count.
 */
function refundedRepairRuns(
  events: readonly AcpJournalEvent[] | undefined,
): Set<string> {
  const refunded = new Set<string>();
  for (const event of events ?? []) {
    if (event.kind !== "recovery_transient_read_released") continue;
    const runId = event.detail.trim();
    if (runId) refunded.add(runId);
  }
  return refunded;
}

/**
 * The current wait, shown as its own call whenever no run or repair is in progress.
 * A stall is never hidden behind a plan step: a review gap or a person-owned wait
 * with no live run still appears, in the words `taskActivity` reads.
 */
function waitToolCall(
  task: Task,
  runs: readonly Run[],
  activity: TaskActivity,
  repairInProgress: boolean,
): AcpToolCall | null {
  if (activity.state === "active" || activity.state === "finished") return null;
  // A recovering reading is shown by its repair attempt's own call. With none in
  // progress (an uncertain launch being checked, or an episode whose run already
  // settled), the reading is a wait like any other rather than an invented attempt.
  if (activity.state === "recovering" && repairInProgress) return null;
  const title =
    activity.state === "needs_person"
      ? "Nucleus: waiting for a person"
      : activity.state === "nucleus"
        ? "Nucleus: between steps"
        : activity.state === "recovering"
          ? "Nucleus: recovering"
          : "Nucleus: waiting";
  const detail = activeDetailLine(activity);
  return {
    toolCallId: waitOccurrenceId(task, runs, activity),
    title,
    kind: "think",
    status: "in_progress",
    ...(detail ? { detail } : {}),
  };
}

function participantTitle(
  task: Task,
  run: Pick<Run, "role" | "head">,
  sawPriorReview: boolean,
): { title: string; kind: AcpToolCallKind } {
  const pr = task.prUrl ? acpPrRef(task.prUrl) : null;
  if (run.role === "revision") {
    return {
      title: sawPriorReview
        ? "Worker: addressing review findings"
        : "Worker: implementing the brief",
      kind: "edit",
    };
  }
  if (run.role === "reviewer") {
    const shortHead = (run.head ?? task.prHead)?.slice(0, 7) || null;
    if (pr && shortHead) {
      return {
        title: `Reviewer: reviewing ${pr} at ${shortHead}`,
        kind: "read",
      };
    }
    if (pr) {
      return { title: `Reviewer: reviewing ${pr}`, kind: "read" };
    }
    return { title: "Reviewer: reviewing the changes", kind: "read" };
  }
  if (run.role === "closeout") {
    return { title: "Closeout: finalizing the task", kind: "execute" };
  }
  if (run.role === "executor") {
    return { title: "Executor: running verification", kind: "execute" };
  }
  return { title: "Coordinator: recovering the task", kind: "other" };
}

/** The detail line a reserved attempt that ended before any run was bound settles with. */
const settledReservationDetail: Record<RepairAttemptOutcome, string> = {
  escalated: "Escalated",
  resolved: "Closed",
  waiting: "Deferred to a wait",
  cleared: "Closed",
  superseded: "Replaced by a newer repair",
};

/**
 * Build the current list of ACP `tool_call` entries from the task's recorded runs and
 * `taskActivity` reading. Stateless and deterministic, so a relaunched agent rebuilds
 * the same tool calls from the service.
 */
export function acpTaskToolCalls(
  task: Task,
  runs: readonly Run[],
  activity: TaskActivity,
  events?: readonly AcpJournalEvent[],
): AcpToolCall[] {
  const calls: AcpToolCall[] = [];
  const currentRunId = task.resolution.currentRunId;
  const liveRun =
    runs.find((r) => r.id === currentRunId && !r.released && !r.completion) ??
    runs.findLast((r) => !r.released && !r.completion) ??
    null;
  const recoveryRunId = task.resolution.recovery?.runId ?? null;
  // Every repair attempt is named by the fact that records it (`repair-attempts.ts`):
  // a bound attempt by its launch, a reserved attempt that ended before binding by its
  // settlement. Each call's terminal status comes only from that attempt's own fact.
  const journal = readRepairJournal(events);
  const episode = task.resolution.recovery;
  const incident =
    task.resolution.incident?.status === "resolved"
      ? null
      : (task.resolution.incident ?? null);
  let sawReview = false;
  // A participant's own call in progress is what a wait must not duplicate. A repair
  // waiting on its coordinator is a separate in-flight attempt, so a person-owned wait
  // beside it still shows.
  let liveParticipant = false;
  let repairInProgress = false;
  // Runs with no launch line at all (recorded before launches were journaled) count
  // among themselves. A launch that names no episode is in the journal, keyed by its
  // run id, with its own words and charge rule.
  let chargedUnlaunched = 0;

  // Legacy/initial worker bound directly on the task row without a matching revision run row.
  const workerOnly =
    Boolean(task.runId && task.agentId) &&
    !runs.some(
      (r) =>
        r.role === "revision" &&
        (r.id === task.runId || r.agentId === task.agentId),
    );
  if (workerOnly && task.runId) {
    const isLive =
      !task.completion && ["dispatching", "working"].includes(task.phase);
    const status: AcpToolCallStatus = isLive
      ? "in_progress"
      : task.completion?.status === "error" ||
          task.completion?.status === "blocked"
        ? "failed"
        : "completed";
    const detail = isLive
      ? activeDetailLine(activity)
      : completedDetailLine({
          completion: task.completion,
          status: "finished",
        });
    if (status === "in_progress") liveParticipant = true;
    calls.push({
      toolCallId: `run:${task.runId}`,
      title: "Worker: implementing the brief",
      kind: "edit",
      status,
      ...(detail ? { detail } : {}),
    });
  }

  for (const run of runs) {
    const isLive = liveRun?.id === run.id;
    const isRecovery =
      run.role === "recovery" ||
      run.role === "verification" ||
      run.id === recoveryRunId;
    if (isRecovery) {
      const record = journal.byRun.get(run.id);
      const ownsEpisode = episode?.runId === run.id ? episode : null;
      let attempt: number;
      if (record) {
        attempt = record.launch!.uncharged
          ? Math.max(1, record.chargedBefore)
          : record.chargedBefore + 1;
      } else {
        chargedUnlaunched += 1;
        attempt = chargedUnlaunched;
      }
      // A bound attempt settles with its own run row: its report, release or
      // supersession. No reading and no other attempt's fact ends it.
      const status = runToolStatus(run, true);
      if (status === "in_progress") repairInProgress = true;
      const title = repairTitle({
        attempt,
        cause:
          record?.cause ||
          (ownsEpisode ? (ownsEpisode.summary ?? "") : "") ||
          run.completion?.headline ||
          "",
        targetRole: record?.targetRole || "",
        action: record?.action || (ownsEpisode ? (incident?.action ?? "") : ""),
        headline: run.completion?.headline,
      });
      const detail =
        status === "in_progress"
          ? activity.state === "recovering"
            ? sanitizeHumanText(activity.detail) || undefined
            : undefined
          : completedDetailLine(run);
      calls.push({
        toolCallId: record?.episodeId
          ? `repair:${record.episodeId}:${record.attempt}`
          : `repair:${run.id}`,
        title,
        kind: "other",
        status,
        ...(detail && detail !== title ? { detail } : {}),
      });
      continue;
    }

    const { title, kind } = participantTitle(task, run, sawReview);
    if (run.role === "reviewer") sawReview = true;
    const status = runToolStatus(run, isLive);
    const detail = isLive
      ? activeDetailLine(activity)
      : completedDetailLine(run);
    if (status === "in_progress") liveParticipant = true;
    calls.push({
      toolCallId: `run:${run.id}`,
      title,
      kind,
      status,
      ...(detail ? { detail } : {}),
    });
  }

  // Reserved attempts that ended before any run was bound: each ends from its own
  // settlement fact, so a later attempt under the same episode never settles an
  // earlier one and an earlier one never hides a later one.
  for (const record of journal.settled) {
    const title = repairTitle({
      attempt: record.chargedBefore + 1,
      cause: record.cause,
      targetRole: record.targetRole,
      action: record.action,
    });
    calls.push({
      toolCallId: `repair:${record.episodeId}:${record.attempt}`,
      title,
      kind: "other",
      status: record.outcome === "escalated" ? "failed" : "completed",
      detail: settledReservationDetail[record.outcome!],
    });
  }

  // The attempt a live episode has reserved before any run is bound to it. It stays
  // shown whatever reading is in front (an operator decision, say), and the
  // coordinator's bind continues the same call because its launch takes this index.
  if (isReservedRepair(episode)) {
    repairInProgress = true;
    const words = reservationWords(task.resolution);
    calls.push({
      toolCallId: `repair:${episode.id}:${journal.attempts(episode.id) + 1}`,
      title: repairTitle({
        attempt: journal.charged(episode.id) + 1,
        ...words,
      }),
      kind: "other",
      status: "in_progress",
      detail:
        activity.state === "recovering"
          ? sanitizeHumanText(activity.detail) || undefined
          : undefined,
    });
  }

  // The wait itself, in Nucleus's or a person's hands, whenever no participant is
  // working. A review gap and a person-owned wait without a live run therefore still
  // show up instead of leaving only a plan step in progress, and an operator decision
  // shows beside a repair that is waiting on its coordinator.
  if (!liveParticipant && !isTerminalPhase(task.phase)) {
    const wait = waitToolCall(task, runs, activity, repairInProgress);
    if (wait) calls.push(wait);
  }

  return calls;
}

/**
 * The attempts charged against one episode's bound, read from the task's journal.
 * `null` counts every charged launch, for a task with no episode to scope to.
 */
function chargedRepairLaunches(
  events: readonly AcpJournalEvent[] | undefined,
  episodeId: string | null,
): number {
  const refunded = refundedRepairRuns(events);
  let charged = 0;
  for (const event of events ?? []) {
    if (event.kind !== "telemetry_recovery") continue;
    try {
      const value = JSON.parse(event.detail) as Record<string, unknown>;
      if (episodeId !== null && value.episodeId !== episodeId) continue;
      if (value.outage === true) continue;
      if (typeof value.runId === "string" && refunded.has(value.runId))
        continue;
      charged += 1;
    } catch {
      if (episodeId === null) charged += 1;
    }
  }
  return charged;
}

/**
 * One concise fallback status line for clients or attaches that do not support
 * structured `plan` / `tool_call` updates. One line per real change: the service
 * sends it only when its reading changed, and the agent never repeats a line.
 */
export function acpStatusLine(
  task: Task,
  activity: TaskActivity,
  events?: readonly AcpJournalEvent[],
): string {
  const pr = task.prUrl ? acpPrRef(task.prUrl) : null;
  if (isTerminalPhase(task.phase)) {
    const label = taskStateLabel(task);
    return pr ? `${label} · ${pr}` : label;
  }
  const episode = task.resolution.recovery;
  const incident =
    task.resolution.incident?.status === "resolved"
      ? null
      : (task.resolution.incident ?? null);
  const detail =
    activity.state === "recovering"
      ? repairTitle({
          attempt: Math.max(
            1,
            chargedRepairLaunches(events, episode?.id ?? null) +
              (episode?.runId ? 0 : 1),
          ),
          cause: incident?.detail || episode?.summary || activity.detail || "",
          targetRole: incident?.role ?? activity.role ?? "",
          action: incident?.action ?? "",
        })
      : activity.state === "needs_person" && activity.permission
        ? activity.permission.kind === "question"
          ? "waiting on a question prompt"
          : "waiting on a permission prompt"
        : activity.state === "nucleus"
          ? `between steps: ${lowerFirst(activity.detail)}`
          : sanitizeHumanText(activity.detail);
  const label = taskStateLabel(task);
  const parts = [label];
  if (pr) parts.push(pr);
  // A reading that already opens with the label (`Reviewing · no live run or wait`)
  // contributes only what the label does not say.
  const rest = detail
    ? detail.toLowerCase().startsWith(label.toLowerCase())
      ? detail.slice(label.length).replace(/^[\s·:—-]+/, "")
      : detail
    : "";
  if (rest) parts.push(rest);
  return parts.join(" · ");
}

/** Build the complete structured presentation for one task turn. */
export function acpTaskPresentation(facts: AcpTaskFacts): AcpTaskPresentation {
  return {
    plan: acpTaskPlan(facts.task, facts.runs, facts.activity),
    toolCalls: acpTaskToolCalls(
      facts.task,
      facts.runs,
      facts.activity,
      facts.events,
    ),
    statusLine: acpStatusLine(facts.task, facts.activity, facts.events),
  };
}

/**
 * Derive human-readable messages for what a person reads:
 * 1. A verdict's summary (approved / changes requested)
 * 2. A question for the operator, naming its decision in plain words and pointing at
 *    the Nucleus Inbox, where the operator answers it
 * 3. The finish
 *
 * The message text never contains a raw ID, SHA, custom-scheme address or stop code
 * (planner ruling, 2026-11-23: no ACP client resolves a custom decision scheme, so the
 * words name the decision and the Inbox is where it is answered).
 */
export function acpTaskMessages(
  facts: AcpTaskFacts,
  memory: AcpLineMemory,
): { messages: string[]; nextMemory: AcpLineMemory } {
  const { task, runs, decisions = [] } = facts;
  const messages: string[] = [];
  const verdicts = new Set(memory.verdicts ?? []);
  const shownDecisions = new Set(memory.decisions ?? []);
  let finished = Boolean(memory.finished);
  const pr = task.prUrl ? acpPrRef(task.prUrl) : null;

  // 1. Verdict summary: latest reviewer verdict (from runs or task.resolution.review).
  const reviewerVerdict = runs.findLast(
    (run) =>
      run.role === "reviewer" &&
      (run.completion?.status === "ready_to_merge" ||
        run.completion?.status === "changes_required"),
  );
  const reviewCompletion =
    reviewerVerdict?.completion ??
    (task.resolution.review?.status === "ready_to_merge" ||
    task.resolution.review?.status === "changes_required"
      ? task.resolution.review
      : null);
  if (reviewCompletion) {
    const verdictKey = reviewerVerdict
      ? `${reviewerVerdict.id}:${reviewCompletion.status}`
      : `review:${reviewCompletion.status}:${reviewCompletion.headline ?? ""}`;
    if (!verdicts.has(verdictKey)) {
      verdicts.add(verdictKey);
      const rawSummary =
        reviewCompletion.headline?.trim() ||
        reviewCompletion.summary?.trim() ||
        "";
      const summary = rawSummary
        ? clipText(sanitizeHumanText(rawSummary), 240)
        : "";
      const prefix =
        reviewCompletion.status === "ready_to_merge"
          ? `Review approved${pr ? ` (${pr})` : ""}`
          : `Changes requested${pr ? ` (${pr})` : ""}`;
      messages.push(summary ? `${prefix}: ${summary}` : `${prefix}.`);
    }
  }

  // 2. Open operator questions, each named in plain words and answered in the Inbox.
  for (const decision of decisions) {
    if (decision.status !== "open") continue;
    const key = `${decision.id}:${decision.version}`;
    if (shownDecisions.has(key)) continue;
    shownDecisions.add(key);
    const questionText = clipText(
      sanitizeHumanText(decision.headline || decision.question) ||
        "A decision is needed to continue.",
      240,
    );
    messages.push(
      `Question for you: ${questionText} — answer it in the Nucleus Inbox.`,
    );
  }

  // 3. The finish.
  if (acpTaskFinished(task) && !finished) {
    finished = true;
    messages.push(acpFinishedLine(task));
  }

  return {
    messages,
    nextMemory: {
      named: true,
      prUrl: task.prUrl ?? null,
      verdicts: [...verdicts],
      decisions: [...shownDecisions],
      finished,
    },
  };
}

/**
 * Signature of everything the ACP thread shows: plan, tool calls, status line, and
 * human-facing message keys. Unchanged writes (version bumps, polls) keep the same
 * signature and emit nothing.
 */
export function acpPresentationSignature(
  presentation: AcpTaskPresentation,
  facts: AcpTaskFacts,
): string {
  const verdictIds = facts.runs
    .filter(
      (r) =>
        r.role === "reviewer" &&
        (r.completion?.status === "ready_to_merge" ||
          r.completion?.status === "changes_required"),
    )
    .map((r) => `${r.id}:${r.completion!.status}`);
  if (!verdictIds.length && facts.task.resolution.review) {
    verdictIds.push(
      `review:${facts.task.resolution.review.status}:${facts.task.resolution.review.headline ?? ""}`,
    );
  }
  const decisionIds = (facts.decisions ?? [])
    .filter((d) => d.status === "open")
    .map((d) => `${d.id}:${d.version}`);
  return JSON.stringify({
    plan: presentation.plan,
    toolCalls: presentation.toolCalls,
    statusLine: presentation.statusLine,
    verdicts: verdictIds,
    decisions: decisionIds,
    finished: acpTaskFinished(facts.task),
  });
}

/**
 * Legacy single-line milestone helper, retained for direct unit tests and text formatting.
 */
export function acpLifecycleLine(
  task: Task,
  memory: AcpLineMemory = { named: false, prUrl: null },
): string {
  const label = taskStateLabel(task);
  const head = memory.named ? label : `${acpTaskName(task)} · ${label}`;
  if (!task.prUrl) return head;
  const pr = memory.prUrl === task.prUrl ? acpPrRef(task.prUrl) : task.prUrl;
  return pr ? `${head} · ${pr}` : head;
}

/**
 * Legacy signature helper: label and PR link only.
 */
export function acpLifecycleSignature(task: Task): string {
  return [taskStateLabel(task), task.prUrl ?? ""].join("\u0000");
}

/** Whether the task has finished, which releases the session's turn. */
export const acpTaskFinished = (task: Pick<Task, "phase">): boolean =>
  isTerminalPhase(task.phase);

/** The human-facing message a session shows when its task finishes (no raw IDs or SHAs). */
export function acpFinishedLine(task: Task): string {
  const name = acpHumanTaskName(task);
  const pr = task.prUrl ? acpPrRef(task.prUrl) : null;
  if (task.phase === "cancelled") {
    const verb =
      task.disposition?.kind === "supersede"
        ? "was superseded"
        : "was cancelled";
    return `${name} ${verb}.`;
  }
  return pr ? `${name} is done · ${pr}.` : `${name} is done.`;
}
