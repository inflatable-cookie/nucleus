import type {
  AgentMessageRecord,
  DecisionView,
  Run,
  TaskDetail,
  TaskNext,
  TaskNextExplicitCommand,
  UiQueueState,
} from "./contracts";
import { holdsOf } from "./contracts";
import { projectHasRepository } from "./project-scope";
import { hostDisplayLabel } from "./host-outage";
import { decisionAge } from "./pipeline-board";
import { repositoryShortName } from "./repository-label";
import { taskAttention } from "./task-attention";
import {
  budgetBars,
  clipText,
  firstSentence,
  formatSpan,
  taskElapsed,
  waitOwnerLabel,
} from "./task-detail-summary";
import {
  eventDetailSummary,
  eventKindLabel,
  lowValueActivityKinds,
} from "./task-events";
import { phaseStateLabel } from "./task-state";
import {
  isWaitingTaskStop,
  type TaskDecisionFact,
  type TaskStopReason,
} from "./task-stop";
import type { TaskTelemetry } from "./telemetry";
import { formatTelemetryDuration } from "./telemetry";
import {
  capacityWaitCause,
  waitStateLabels,
  type CapacityWaitCause,
} from "./wait-state";

/**
 * Pure derivations for the redesigned task detail (nucleus#1537):
 * Overview "What's happening" plain wording, explicit-command labels,
 * 5-step progress strip, review findings, participant cards, stat tiles,
 * and readable Activity timeline grouping.
 *
 * Every function here is read-only observation over stored task, run, event
 * and `task.next` records. Nothing here grants execution, review or merge authority.
 */

export type DetailTone = "danger" | "warning" | "accent" | "success" | "muted";

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HASH_RE = /\b(?:[0-9a-f]{40}|[0-9a-f]{64})\b/gi;
const RUN_OR_DELIVERY_ID_RE =
  /\b(?:ns-review-[0-9a-f]+|run_[A-Za-z0-9_-]+|wks_[0-9a-f]+|thr_[A-Za-z0-9_-]+|agent_profile_[A-Za-z0-9_-]+)\b/gi;

/** Strip raw UUIDs, full SHAs and internal IDs from Overview prose. */
export function sanitizeOverviewText(text: string): string {
  return text
    .replace(UUID_RE, "")
    .replace(LONG_HASH_RE, "")
    .replace(RUN_OR_DELIVERY_ID_RE, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

export type TaskHappening = {
  /** Short eyebrow label: "Needs you", "In progress · nothing to do", "Waiting · nothing to do", etc. */
  label: string;
  tone: DetailTone;
  /** Plain one-line headline with no raw IDs. */
  headline: string;
  /** Plain explanation with no raw IDs. */
  explanation: string;
  /** Plain "Next:" sentence naming who acts and what Nucleus does on its own. */
  nextLine: string;
};

type StopCopy = {
  label: string;
  tone: DetailTone;
  headline: string;
  explanation: string;
  nextLine: string;
};

function factCopyForOperatorNeeded(
  fact: TaskDecisionFact | null | undefined,
  actorName: string,
): StopCopy | null {
  if (!fact) return null;
  switch (fact.code) {
    case "review_delivery":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "The reviewer’s instructions may not have arrived",
        explanation:
          "Nucleus sent the review assignment, but cannot confirm the reviewer received it. Nucleus will not resend blindly.",
        nextLine:
          "Choose an action below to start the reviewer again, release the stuck run, or message the thread.",
      };
    case "callback_missing":
    case "callback_expired":
    case "callback_attention":
    case "callback_stopped":
      return {
        label: "Needs you",
        tone: "danger",
        headline: `${fact.subject ? `The ${fact.subject}` : "The active participant"} stopped without reporting back`,
        explanation:
          "Its thread went idle without sending a completion report, so Nucleus cannot tell whether the work finished.",
        nextLine:
          "Inspect the thread or choose an action below to continue, restart, or message the participant.",
      };
    case "creation_lookup":
    case "worker_lookup":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "Nucleus couldn’t confirm whether the agent started",
        explanation:
          "The launch request did not return a confirmed thread identity, so Nucleus paused instead of risking duplicate work.",
        nextLine:
          "Choose an action below to replace the uncertain run or release it after checking the host.",
      };
    case "workspace_absent":
    case "workspace_orphan":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "The task’s workspace could not be verified",
        explanation:
          "Nucleus did not find the expected worktree in the host’s workspace inventory.",
        nextLine:
          "Choose an action below to retry workspace setup or start a fresh run.",
      };
    case "host_read_exhausted":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "Nucleus couldn’t read the host’s state",
        explanation:
          "Repeated attempts to inspect the task’s host failed, so Nucleus paused to avoid acting on stale state.",
        nextLine:
          "Check that the host is healthy, then retry or restart the task below.",
      };
    case "coordinator_unavailable":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "No coordinator profile is available for recovery",
        explanation:
          "Nucleus tried to start automatic recovery, but no eligible coordinator profile is enabled and available.",
        nextLine:
          "Enable a coordinator profile in Settings, or choose a direct action below.",
      };
    case "ssh_auth":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "Git authentication failed",
        explanation:
          "The host could not authenticate with the remote repository using SSH.",
        nextLine:
          "Restore SSH credentials on the host, then retry or restart the task below.",
      };
    case "provider_refusal":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "The reviewer hit an unverified provider refusal",
        explanation:
          "The model provider refused the review turn without a verified recoverable cause.",
        nextLine:
          "Route the reviewer to another profile or start a fresh reviewer below.",
      };
    case "check_deadline":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "A required check stayed pending past its deadline",
        explanation:
          "One or more required repository checks did not finish within the expected window.",
        nextLine:
          "Inspect the check on the pull request, then retry or move the task below.",
      };
    case "hook_hold":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "A repository hook is holding this transition",
        explanation:
          "A configured repository hook blocked the task from advancing.",
        nextLine:
          "Review the hook details in the Details tab, then retry or return the task to work.",
      };
    case "pr_head_changed":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "The pull request moved after the worker reported",
        explanation:
          "New commits appeared on the pull request after the completion report, so the reported head no longer matches.",
        nextLine:
          "Choose an action below to review the new head or return the task to the worker.",
      };
    case "pr_identity":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "The pull request is not open or doesn’t match the branch",
        explanation:
          "Nucleus could not verify an open pull request for this task’s branch.",
        nextLine:
          "Check the pull request on GitHub, then choose an action below.",
      };
    case "bb_connect":
    case "pre_send_refused":
      return {
        label: "Needs you",
        tone: "danger",
        headline: `The ${actorName}’s new instructions may not have arrived`,
        explanation:
          "Nucleus could not deliver the instructions to the host, so it paused rather than resending blindly.",
        nextLine:
          "Check the host connection, then choose an action below to start the participant again or release the run.",
      };
    case "origin_error":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "Nucleus couldn’t reach the submitting thread",
        explanation:
          "The origin thread that submitted this task could not be contacted for routing or notifications.",
        nextLine:
          "Check the Details tab for the origin error, or continue the task directly below.",
      };
    case "usage_gate":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "Waiting for your approval under the current usage level",
        explanation:
          "The current usage level requires operator sign-off before dispatching a task of this complexity.",
        nextLine:
          "Approve the linked decision or raise the usage level in Settings.",
      };
    default:
      return null;
  }
}

/** The board fields the happening card and the stat tiles read. */
type CapacityBoard = Partial<Pick<UiQueueState, "tasks" | "projects">>;

const QA_CAPACITY_COPY: StopCopy = {
  label: "Waiting · nothing to do",
  tone: "muted",
  headline: "Waiting for a QA validation slot",
  explanation:
    "The machine-wide validation scheduler is full, so this task is queued for its turn.",
  nextLine:
    "Nucleus runs validation automatically as soon as a QA slot frees up.",
};

const counted = (occupied: number | null, limit: number | null) =>
  occupied !== null && limit !== null
    ? ` (${occupied} of ${limit} in use)`
    : "";

/**
 * Plain copy for a capacity wait, from the cause the admission check recorded:
 * it names the limit that actually holds the task and never another one.
 */
export function capacityWaitCopy(
  cause: CapacityWaitCause | null,
  projectName: string,
): StopCopy {
  const waiting = { label: "Waiting · nothing to do", tone: "muted" } as const;
  switch (cause?.kind) {
    case "qa":
      return cause.position
        ? {
            ...QA_CAPACITY_COPY,
            explanation: `The machine-wide validation scheduler is full; this task is number ${cause.position} in its queue.`,
          }
        : QA_CAPACITY_COPY;
    case "global":
      return {
        ...waiting,
        headline: "Waiting for a machine-wide task slot",
        explanation: `Every task slot across Nucleus is in use${counted(cause.occupied, cause.limit)}.`,
        nextLine:
          "Nucleus starts it automatically when any task frees a slot. The global limit is in Settings → Limits.",
      };
    case "reservations":
      return {
        ...waiting,
        headline: "Waiting behind earlier queued tasks",
        explanation: `${cause.ahead} earlier queued ${cause.ahead === 1 ? "task has" : "tasks have"} reserved the free machine-wide slots${counted(cause.occupied, cause.limit)}.`,
        nextLine: "Nucleus starts it automatically once its turn comes.",
      };
    case "project":
      return {
        ...waiting,
        headline: `Waiting for a slot in ${projectName}`,
        explanation: `This repository’s task slots are all taken${counted(cause.occupied, cause.limit)}${cause.reserved ? `, ${cause.reserved} by earlier requests` : ""}.`,
        nextLine:
          "Nucleus starts it automatically when a slot frees. You can raise this project’s limit in Settings → Limits.",
      };
    case "papercut":
      // A slot an earlier request has reserved is not in use: name the hold.
      if (cause.reserved > 0)
        return {
          ...waiting,
          headline: "Waiting for a papercut slot",
          explanation: `Papercuts in ${projectName} share their own small pool: ${cause.occupied ?? 0} of ${cause.limit ?? cause.reserved} in use, ${cause.reserved} ${cause.reserved === 1 ? "slot" : "slots"} held for earlier requests.`,
          nextLine:
            "The earlier request has the first claim on the slot. Nucleus starts this papercut when a slot is free for it.",
        };
      return {
        ...waiting,
        headline: "Waiting for a papercut slot",
        explanation: `Papercuts in ${projectName} share their own small pool, and it is full${counted(cause.occupied, cause.limit)}.`,
        nextLine:
          "Nucleus starts it automatically when another papercut finishes. The papercut limit is in Settings → Limits.",
      };
    case "in_flight_ahead":
      return {
        ...waiting,
        headline: "Waiting behind in-flight work",
        explanation: `${cause.ahead} in-flight ${cause.ahead === 1 ? "request ranks" : "requests rank"} ahead of this task for the next slot.`,
        nextLine: "Nucleus starts it automatically once those requests settle.",
      };
    case "in_flight_cap":
      return {
        ...waiting,
        headline: `Waiting for in-flight work in ${projectName} to finish`,
        explanation: `${cause.inFlight} of ${cause.limit} tasks are in flight for this project, its in-flight cap.`,
        nextLine:
          "Nucleus starts work when the project is under its cap. The cap is in Settings → Limits.",
      };
    default:
      return {
        ...waiting,
        headline: "Waiting for a task slot",
        explanation:
          "Every task slot this task can use is taken: its project or papercut pool, the machine-wide limit or earlier reservations.",
        nextLine:
          "Nucleus starts this task automatically when a slot frees. Limits are in Settings → Limits.",
      };
  }
}

/** The short name of what a capacity wait waits on, for the queued stat tile. */
function capacityWaitLabel(cause: CapacityWaitCause | null): string {
  switch (cause?.kind) {
    case "qa":
      return "QA slot";
    case "global":
      return "Machine-wide slot";
    case "reservations":
      return "Earlier queued tasks";
    case "project":
      return "Project slot";
    case "papercut":
      return "Papercut slot";
    case "in_flight_ahead":
      return "In-flight work";
    case "in_flight_cap":
      return "In-flight cap";
    default:
      return "Task slot";
  }
}

/**
 * Plain-wording mapping for every typed `TaskStopReason` in `shared/task-stop.ts`.
 * No raw stop text or raw IDs are copied into the Overview card.
 */
export function stopReasonCopy(
  reason: TaskStopReason,
  context: {
    fact?: TaskDecisionFact | null;
    owner?: string | null;
    projectName?: string;
    hostLabel?: string;
    actorName?: string;
    holdKind?: "dispatch" | "merge" | null;
    holdOwner?: string | null;
    coordinatorActive?: boolean;
    /** The admission's recorded cause for a capacity stop. */
    capacityCause?: CapacityWaitCause | null;
  } = {},
): StopCopy {
  const actor = context.actorName || "worker";
  const proj = context.projectName || "this project";
  const host = context.hostLabel || "the host";
  const owner = context.owner ? waitOwnerLabel(context.owner) : "";

  switch (reason) {
    case "awaiting_proof":
      return {
        label: "Waiting · nothing to do",
        tone: "muted",
        headline: "Waiting for required proof",
        explanation:
          "The reviewer approved the source subject to required proof evidence that has not yet arrived.",
        nextLine:
          "Once the required proof is recorded, Nucleus advances the task automatically.",
      };
    case "operator_needed": {
      const fromFact = factCopyForOperatorNeeded(context.fact, actor);
      if (fromFact) return fromFact;
      return {
        label: "Needs you",
        tone: "danger",
        headline: "This task needs your decision",
        explanation:
          "Nucleus reached a stop that automatic recovery cannot clear on its own.",
        nextLine: context.coordinatorActive
          ? "A coordinator is checking the task. If you’d rather not wait, choose an action below."
          : "Choose an action below, or inspect the raw stop detail in the Details tab.",
      };
    }
    case "run_stalled":
      return {
        label: "Needs you",
        tone: "danger",
        headline: `The ${actor}’s active turn appears stalled`,
        explanation: `The ${actor} thread has been quiet past its activity timeout while still holding the run lease.`,
        nextLine:
          "Choose an action below to stop and restart the turn, or release the stuck run.",
      };
    case "origin_busy":
      return {
        label: "Waiting · nothing to do",
        tone: "muted",
        headline: "Waiting for the submitting thread to finish its turn",
        explanation:
          "The origin thread is currently active, so Nucleus is waiting before delivering its follow-up.",
        nextLine:
          "Nucleus continues automatically once the submitting thread goes idle.",
      };
    case "capacity":
      if (context.fact?.code === "qa_capacity") return QA_CAPACITY_COPY;
      return capacityWaitCopy(context.capacityCause ?? null, proj);
    case "provider_unavailable":
      return {
        label: "Waiting · nothing to do",
        tone: "muted",
        headline: "Waiting for the model provider to recover",
        explanation:
          "The assigned provider group is temporarily unavailable or out of quota.",
        nextLine:
          "Nucleus resumes automatically when the provider returns, or you can route the task to another profile.",
      };
    case "route_unavailable":
      return {
        label: "Waiting · nothing to do",
        tone: "muted",
        headline: "No eligible profile is available right now",
        explanation:
          "No enabled profile currently matches this task’s role, scope and availability rules.",
        nextLine:
          "Nucleus dispatches automatically when an eligible profile returns, or you can adjust profiles in Settings or the ⋯ menu.",
      };
    case "pr_head_lag":
      return {
        label: "Waiting · nothing to do",
        tone: "muted",
        headline: "Waiting for the pull request branch to catch up",
        explanation:
          "The pull request head observed on GitHub does not yet reflect the latest pushed commit.",
        nextLine:
          "Nucleus checks again automatically and continues once GitHub reports the new head.",
      };
    case "prerequisite":
      if (owner === "operator") {
        return {
          label: "Needs you",
          tone: "danger",
          headline: "A prerequisite can no longer finish",
          explanation:
            "One of this task’s prerequisites was cancelled, removed, is missing, or finished with its goal unmet.",
          nextLine:
            "Update the task’s dependencies from the ⋯ menu so it can proceed.",
        };
      }
      return {
        label: "Waiting · nothing to do",
        tone: "muted",
        headline: "Waiting for prerequisite tasks to finish",
        explanation:
          "This task depends on earlier tasks that have not completed yet.",
        nextLine:
          "Nucleus starts it automatically as soon as every prerequisite completes.",
      };
    case "workspace_unavailable":
      return {
        label: "Waiting · nothing to do",
        tone: "muted",
        headline: "Waiting for the task workspace",
        explanation:
          "The task’s git worktree is not ready yet or is still being verified on the host.",
        nextLine:
          "Nucleus continues automatically once the workspace is ready.",
      };
    case "validation":
      return {
        label: "In progress · nothing to do",
        tone: "accent",
        headline: "Project validation is running",
        explanation:
          "Nucleus is waiting for the worktree’s validation checks to finish before advancing.",
        nextLine:
          "Nucleus moves to the next step automatically once validation settles.",
      };
    case "held": {
      const kindLabel = context.holdKind === "merge" ? "Merge" : "Dispatch";
      const holder = context.holdOwner || owner || "the holder";
      return {
        label: "Needs you",
        tone: "warning",
        headline: `${kindLabel} is held by ${holder}`,
        explanation: `A ${kindLabel.toLowerCase()} hold is preventing this task from moving forward automatically.`,
        nextLine:
          "Release or keep the hold from the ⋯ menu once its condition is met.",
      };
    }
    case "lifecycle": {
      if (context.fact?.code === "integration_turn") {
        return {
          label: "Waiting · nothing to do",
          tone: "muted",
          headline: "Waiting for the repository integration turn",
          explanation:
            "Another task in this repository currently holds the single integration turn for verification and merge.",
          nextLine:
            "Nucleus gives this task the integration turn automatically when the current merge finishes.",
        };
      }
      if (context.fact?.code === "closeout_base_refresh") {
        return {
          label: "In progress · nothing to do",
          tone: "accent",
          headline: "Refreshing main before closeout",
          explanation:
            "Nucleus is updating the local integration branch before finishing closeout.",
          nextLine: "Nucleus completes closeout automatically.",
        };
      }
      if (context.fact?.code === "review_effect_wait") {
        return {
          label: "Waiting · nothing to do",
          tone: "muted",
          headline: "Waiting for a pending review effect to settle",
          explanation:
            "An earlier review publication or delivery is still settling before the next review step can run.",
          nextLine:
            "Nucleus resumes review automatically once the pending effect clears.",
        };
      }
      return {
        label: "In progress · nothing to do",
        tone: "accent",
        headline: "Nucleus is completing its next lifecycle step",
        explanation:
          "Checks, merge verification, or a recent launch are still settling.",
        nextLine:
          "Nothing to do — Nucleus advances automatically when this step finishes.",
      };
    }
    case "external_unavailable":
      return {
        label: "Waiting · nothing to do",
        tone: "muted",
        headline: "Waiting for GitHub or git to recover",
        explanation:
          "A read-only GitHub or git check hit a transient network or service error.",
        nextLine: "Nucleus retries automatically on the next tick.",
      };
    case "host_unavailable":
      return {
        label: "Waiting · nothing to do",
        tone: "muted",
        headline: `Waiting for ${host} to reconnect`,
        explanation: `This task is pinned to ${host}, which is currently offline or unreachable.`,
        nextLine:
          "Nucleus resumes the task automatically as soon as the host reconnects.",
      };
    case "interactive":
      return {
        label: "Needs you",
        tone: "warning",
        headline: "Waiting for you in the worker thread",
        explanation:
          "This interactive task’s worker finished its turn and is waiting for your next reply.",
        nextLine:
          "Open the worker thread to reply, or mark the task ready when done.",
      };
    case "responsible_question":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "Waiting for your answer",
        explanation:
          "The worker and reviewer asked a question that needs an operator decision before continuing.",
        nextLine:
          "Answer the question above or in the linked decision to unblock the task.",
      };
    case "escalated":
      if (context.fact?.code === "consult") {
        return {
          label: "Waiting · nothing to do",
          tone: "muted",
          headline: "Waiting on advice from the retained reviewer",
          explanation:
            "The worker consulted the retained reviewer on a blocker.",
          nextLine:
            "Nucleus returns the reviewer’s advice to the worker automatically.",
        };
      }
      return {
        label: "Waiting · nothing to do",
        tone: "muted",
        headline: "Waiting on a ruling from the planner",
        explanation:
          "This task escalated a blocker up the ladder for a planning decision.",
        nextLine:
          "Nucleus resumes the task automatically once the planner answers.",
      };
    case "budget":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "This task reached its budget limit",
        explanation:
          "It hit its effective-token or wall-time allowance, so Nucleus paused further runs.",
        nextLine:
          "Extend the budget from the ⋯ menu, change its approach, or cancel the task.",
      };
    case "paused_stop":
      return {
        label: "Waiting · nothing to do",
        tone: "muted",
        headline: "Paused while Nucleus is stopped",
        explanation:
          "This task’s live thread was stopped while the queue was paused.",
        nextLine:
          "Nucleus resumes it automatically when you unpause the queue.",
      };
  }
}

/**
 * Derive the Overview's "What's happening" card from typed task/next/run state.
 * Plain wording comes from code, never raw stop text or raw IDs.
 */
export function taskHappeningView(input: {
  task: TaskDetail;
  next: TaskNext | null;
  runs: readonly Run[];
  state?: CapacityBoard | undefined;
  decisions?: readonly DecisionView[] | undefined;
}): TaskHappening {
  const { task, next, runs, state, decisions } = input;
  const proj = repositoryShortName(task.repoPath);
  const hostLabel = task.resolution.hostWait
    ? hostDisplayLabel(task.resolution.hostWait.hostId)
    : task.hostId
      ? hostDisplayLabel(task.hostId)
      : "the host";
  const activeRun =
    next?.activeRun ?? runs.find((run) => !run.released) ?? null;
  const actorName =
    activeRun?.role === "reviewer"
      ? "reviewer"
      : activeRun?.role === "recovery"
        ? "coordinator"
        : "worker";
  const coordinatorActive = runs.some(
    (run) => run.role === "recovery" && !run.released,
  );
  const fences = holdsOf(task);
  // A queued task waits on its dispatch hold first; after dispatch only the merge hold can block.
  const blockingHold =
    task.phase === "queued" && fences.dispatch
      ? ("dispatch" as const)
      : fences.merge
        ? ("merge" as const)
        : fences.dispatch
          ? ("dispatch" as const)
          : null;
  const holdKind: "dispatch" | "merge" | null = blockingHold;
  const holdOwner = blockingHold
    ? waitOwnerLabel(fences[blockingHold]!.owner)
    : null;

  // 1. Terminal phases
  if (task.phase === "done") {
    return {
      label: "Done",
      tone: "success",
      headline: "This task is complete",
      explanation: task.resolution.mergedCommit
        ? "The pull request merged and closeout finished."
        : "The task finished and closed out.",
      nextLine: "Nothing to do.",
    };
  }
  if (task.phase === "cancelled") {
    const kind =
      task.disposition?.kind === "supersede" ? "superseded" : "cancelled";
    return {
      label: kind === "superseded" ? "Superseded" : "Cancelled",
      tone: "muted",
      headline: `This task was ${kind}`,
      explanation: task.disposition?.reason
        ? sanitizeOverviewText(clipText(task.disposition.reason, 220))
        : `Work stopped because the task was ${kind}.`,
      nextLine:
        "Nothing to do. You can remove it from the queue in the ⋯ menu.",
    };
  }
  if (task.disposition && task.disposition.status !== "complete") {
    return {
      label: "In progress · nothing to do",
      tone: "warning",
      headline:
        task.disposition.kind === "supersede"
          ? "Superseding this task"
          : "Cancelling this task",
      explanation:
        task.disposition.status === "draining"
          ? "The active thread was interrupted and Nucleus is waiting for it to settle."
          : "Nucleus is reconciling the cancellation fence and workspace cleanup.",
      nextLine:
        "Nucleus finishes cancellation automatically, or you can withdraw it from the ⋯ menu while pending.",
    };
  }

  // 2. Recorded WaitState (Spec 043)
  if (task.waitState) {
    const ws = task.waitState;
    if (ws.state === "needs_operator_input") {
      const dec = ws.decisionId
        ? (decisions ?? []).find((d) => d.id === ws.decisionId)
        : undefined;
      const title = dec?.headline ?? dec?.question;
      return {
        label: "Needs you",
        tone: "danger",
        headline: title
          ? sanitizeOverviewText(clipText(title, 140))
          : "Waiting on your decision",
        explanation:
          "This task is paused until its linked operator decision is answered.",
        nextLine:
          "Answer the linked decision to unblock the task; Nucleus resumes automatically.",
      };
    }
    if (ws.state === "needs_source_rights") {
      return {
        label: "Needs you",
        tone: "danger",
        headline: "Needs source rights before continuing",
        explanation:
          "This task cannot access or modify the required source without explicit rights.",
        nextLine: "Grant the required rights or choose an action below.",
      };
    }
    if (ws.state === "merge_hold") {
      return {
        label: "Needs you",
        tone: "warning",
        headline: `Merge is held by ${waitOwnerLabel(ws.owner)}`,
        explanation:
          "This task is ready to merge, but a merge hold is keeping it from merging automatically.",
        nextLine:
          "Release the merge hold from the ⋯ menu when you are ready for Nucleus to merge.",
      };
    }
    if (ws.state === "waiting_prerequisite") {
      const opOwned = ws.owner === "operator";
      return stopReasonCopy("prerequisite", {
        owner: opOwned ? "operator" : ws.owner,
        projectName: proj,
      });
    }
    if (ws.state === "waiting_capacity") {
      // The typed wait names its owner: the machine-wide QA scheduler, or the
      // operator's task-slot limits. Counts come from the board's own projection.
      const cause = capacityWaitCause(task.reason);
      if (
        cause?.kind !== "qa" &&
        (ws.owner !== "operator" || task.reasonFact?.code === "qa_capacity")
      )
        return QA_CAPACITY_COPY;
      return capacityWaitCopy(cause, proj);
    }
  }

  // 3. Recorded typed stop (from `next.stop` or `task.resolution.stop`)
  const stop = next?.stop ?? null;
  const storedStop = task.resolution.stop ?? null;
  const stopReason: TaskStopReason | null =
    stop?.reason ?? storedStop?.reason ?? null;
  const stopFact: TaskDecisionFact | null =
    storedStop?.fact ?? task.reasonFact ?? null;

  if (stopReason) {
    const copy = stopReasonCopy(stopReason, {
      fact: stopFact,
      owner: stop?.owner ?? null,
      projectName: proj,
      hostLabel,
      actorName,
      holdKind,
      holdOwner,
      coordinatorActive,
      capacityCause: capacityWaitCause(task.reason),
    });
    // If the task needs attention even on a waiting stop (e.g. needs_attention phase)
    const isAttn =
      taskAttention({
        phase: task.phase,
        held: task.held,
        holds: task.holds,
        holdKind: task.holdKind,
        attention: task.resolution.attention,
        originFault: Boolean(task.originError || task.originLookupError),
        reason: task.reason,
      }).state === "attention";
    if (isAttn && copy.tone === "muted" && !isWaitingTaskStop(stopReason)) {
      return { ...copy, label: "Needs you", tone: "danger" };
    }
    return copy;
  }

  // 4. Independent host outage
  if (task.resolution.hostWait) {
    return stopReasonCopy("host_unavailable", { hostLabel });
  }

  // 5. Active holds with no stop record
  if (fences.dispatch && task.phase === "queued") {
    return stopReasonCopy("held", {
      holdKind: "dispatch",
      holdOwner: waitOwnerLabel(fences.dispatch.owner),
    });
  }

  // 6. Normal progressing phases (no stop, no wait)
  const roundNum = next
    ? Math.min(next.outcome.revision.runs + 1, next.outcome.revision.budget)
    : 1;
  const profileLabel =
    (activeRun && "profileName" in activeRun
      ? activeRun.profileName
      : activeRun && "profile" in activeRun
        ? activeRun.profile?.name
        : null) ??
    task.profile?.name ??
    null;

  switch (task.phase) {
    case "queued":
      return {
        label: "Waiting · nothing to do",
        tone: "muted",
        headline: `Queued for ${proj}`,
        explanation: "This task is waiting in the queue for dispatch.",
        nextLine: "Nucleus starts it automatically as soon as capacity allows.",
      };
    case "dispatching":
      return {
        label: "In progress · nothing to do",
        tone: "accent",
        headline: "Starting the worker",
        explanation:
          "Nucleus is preparing the workspace and launching the worker thread.",
        nextLine:
          "The worker begins implementing the brief automatically once launched.",
      };
    case "working":
      return {
        label: "In progress · nothing to do",
        tone: "accent",
        headline: profileLabel
          ? `${profileLabel} is working on the task`
          : "The worker is implementing the task",
        explanation:
          "The worker owns this task end to end and will open a pull request when ready.",
        nextLine:
          "When the worker reports ready, Nucleus hands the exact head to an independent reviewer.",
      };
    case "awaiting_review":
    case "report_ready":
      return {
        label: "In progress · nothing to do",
        tone: "accent",
        headline: "Waiting for the reviewer to start",
        explanation:
          "The worker reported ready and Nucleus is dispatching the review run.",
        nextLine:
          "An independent reviewer will check the pull request automatically.",
      };
    case "reviewing":
      return {
        label: "In progress · nothing to do",
        tone: "accent",
        headline: `The reviewer is checking round ${roundNum}`,
        explanation: profileLabel
          ? `${profileLabel} is reviewing the current pull request head.`
          : "An independent reviewer is checking the current pull request head.",
        nextLine:
          "On a pass, Nucleus merges and closes out. On changes, the worker revises.",
      };
    case "changes_requested":
      return {
        label: "In progress · nothing to do",
        tone: "accent",
        headline: "The worker is addressing review feedback",
        explanation:
          "The reviewer requested changes and the worker is revising the pull request.",
        nextLine:
          "Once the worker pushes fixes and reports ready, the retained reviewer checks the new head.",
      };
    case "verifying":
      return {
        label: "In progress · nothing to do",
        tone: "accent",
        headline: "Verifying before merge",
        explanation:
          "The review passed; Nucleus is running pre-merge checks and hooks.",
        nextLine:
          "Once verification passes, Nucleus merges the pull request automatically.",
      };
    case "merging":
      return {
        label: "In progress · nothing to do",
        tone: "accent",
        headline: "Merging the pull request",
        explanation:
          "All gates passed and Nucleus is merging the approved head into the base branch.",
        nextLine:
          "After merge, Nucleus syncs main and closes out the workspace automatically.",
      };
    case "syncing":
    case "closing":
      return {
        label: "In progress · nothing to do",
        tone: "accent",
        headline: "Closing out the task",
        explanation:
          "The pull request merged; Nucleus is syncing main and retiring the task workspace.",
        nextLine: "This task will mark itself done automatically.",
      };
    case "blocked":
    case "error":
    case "needs_attention":
      return {
        label: "Needs you",
        tone: "danger",
        headline: "This task needs your attention",
        explanation:
          "The task stopped and requires an owner decision or recovery action.",
        nextLine:
          "Choose an action below, or inspect the Details tab for the full record.",
      };
  }
}

/**
 * Plain human label for each Spec 067 explicit command returned in `next.explicitCommands`.
 */
export function explicitCommandLabel(cmd: TaskNextExplicitCommand): string {
  const args = cmd.args ?? {};
  switch (cmd.action) {
    case "run.start": {
      const role = typeof args.role === "string" ? args.role : "worker";
      const agent = typeof args.agent === "string" ? args.agent : "retained";
      if (role === "worker") {
        return agent === "fresh"
          ? "Start a fresh worker"
          : "Start the worker again";
      }
      if (role === "reviewer") {
        return agent === "fresh"
          ? "Start a fresh reviewer"
          : "Continue the reviewer";
      }
      return "Start the coordinator";
    }
    case "run.release":
      return "Release the stuck run";
    case "record.clear": {
      const kind = typeof args.kind === "string" ? args.kind : "";
      if (kind === "stop") return "Clear the stop record";
      if (kind === "wait") return "Clear the wait";
      if (kind === "hold") return "Clear the hold";
      if (kind === "host_wait") return "Clear the host wait";
      if (kind === "escalation") return "Clear the escalation";
      if (kind === "incident") return "Clear the incident";
      if (kind === "effect") return "Clear the stuck effect";
      return "Clear the stuck record";
    }
    case "phase.set": {
      const to = typeof args.to === "string" ? args.to : "";
      return to ? `Set phase to ${to.replaceAll("_", " ")}` : "Change phase";
    }
    case "message.send": {
      const role = typeof args.role === "string" ? args.role : "worker";
      return `Message the ${role}`;
    }
    case "turn.take":
      return "Take the integration turn";
    case "turn.release":
      return "Release the integration turn";
    case "merge.now":
      return "Merge the PR now";
    case "closeout.now":
      return "Start closeout now";
  }
}

export type ProgressStep = {
  key: "queued" | "working" | "review" | "merge" | "close";
  label: string;
  sub: string;
  state: "done" | "current" | "todo";
  tone: DetailTone;
};

/**
 * 5-step progress strip shown for every task (Tom: "Keep for all"):
 * Queued → Working → Review → Merge → Close.
 */
export function taskProgressSteps(input: {
  task: TaskDetail;
  next: TaskNext | null;
  runs: readonly Run[];
  telemetry?: TaskTelemetry | null;
  now?: number;
}): ProgressStep[] {
  const { task, next, runs, telemetry, now = Date.now() } = input;
  const isAttn =
    taskAttention({
      phase: task.phase,
      held: task.held,
      holds: task.holds,
      holdKind: task.holdKind,
      attention: task.resolution.attention,
      originFault: Boolean(task.originError || task.originLookupError),
      reason: task.reason,
    }).state === "attention";

  const hasReview = Boolean(
    next?.outcome.accepted ||
      next?.outcome.reported ||
      next?.outcome.reader ||
      (next?.outcome.revision.runs ?? 0) > 0 ||
      runs.some((r) => r.role === "reviewer"),
  );
  const roundBudget = next?.outcome.revision.budget ?? 6;
  const roundNum = next
    ? Math.min(next.outcome.revision.runs + 1, roundBudget)
    : Math.max(1, runs.filter((r) => r.role === "reviewer").length);

  // Determine active step index (0..4, or 5 if all done)
  let currentIndex = 0;
  switch (task.phase) {
    case "queued":
    case "dispatching":
      currentIndex = 0;
      break;
    case "working":
      currentIndex = 1;
      break;
    case "awaiting_review":
    case "report_ready":
    case "reviewing":
    case "changes_requested":
      currentIndex = 2;
      break;
    case "verifying":
    case "merging":
      currentIndex = 3;
      break;
    case "syncing":
    case "closing":
      currentIndex = 4;
      break;
    case "done":
      currentIndex = 5;
      break;
    case "blocked":
    case "error":
    case "needs_attention":
      if (task.resolution.mergedCommit) currentIndex = 4;
      else if (task.resolution.mergeIntent) currentIndex = 3;
      else if (hasReview || task.prUrl) currentIndex = 2;
      else if (task.agentId || runs.length > 0) currentIndex = 1;
      else currentIndex = 0;
      break;
    case "cancelled":
      if (task.resolution.mergedCommit) currentIndex = 4;
      else if (hasReview || task.prUrl) currentIndex = 2;
      else if (task.agentId || runs.length > 0) currentIndex = 1;
      else currentIndex = 0;
      break;
  }

  const currentTone: DetailTone =
    task.phase === "cancelled"
      ? "muted"
      : isAttn
        ? "danger"
        : task.phase === "queued"
          ? "accent"
          : task.phase === "changes_requested"
            ? "warning"
            : "accent";

  // Subtitles for each step
  const createdMs = Date.parse(task.createdAt);
  const queuedSub =
    currentIndex === 0
      ? Number.isFinite(createdMs)
        ? `Waiting ${formatSpan(Math.max(0, now - createdMs))}`
        : "Waiting"
      : Number.isFinite(createdMs)
        ? new Date(createdMs).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "Done";

  const activeStageMs =
    telemetry?.stages
      .filter((s) => s.stage === "worker_active")
      .reduce((sum, s) => sum + s.elapsedMs, 0) ?? 0;
  const elapsedMs = taskElapsed(runs, now);
  const workingSub =
    currentIndex < 1
      ? ""
      : activeStageMs > 0
        ? formatTelemetryDuration(activeStageMs)
        : currentIndex === 1 && elapsedMs !== null
          ? formatSpan(elapsedMs)
          : currentIndex > 1
            ? "Done"
            : "";

  const reviewSub = task.skipPRReview
    ? "Skipped"
    : currentIndex < 2
      ? ""
      : task.phase === "changes_requested"
        ? `Round ${roundNum} · changes`
        : hasReview
          ? `Round ${roundNum} of ${roundBudget}`
          : currentIndex === 2
            ? "Pending"
            : "Approved";

  const mergeSub =
    currentIndex < 3
      ? ""
      : task.resolution.mergedCommit
        ? "Merged"
        : task.phase === "verifying"
          ? "Verifying"
          : task.phase === "merging"
            ? "Merging"
            : holdsOf(task).merge
              ? "Held"
              : "";

  const closeSub =
    task.phase === "done"
      ? "Done"
      : task.phase === "cancelled"
        ? "Cancelled"
        : currentIndex === 4
          ? "Closing"
          : "";

  const defs: Array<{ key: ProgressStep["key"]; label: string; sub: string }> =
    [
      { key: "queued", label: "Queued", sub: queuedSub },
      { key: "working", label: "Working", sub: workingSub },
      { key: "review", label: "Review", sub: reviewSub },
      { key: "merge", label: "Merge", sub: mergeSub },
      { key: "close", label: "Close", sub: closeSub },
    ];

  return defs.map((def, idx) => {
    if (task.phase === "done") {
      return { ...def, state: "done", tone: "success" };
    }
    if (idx < currentIndex) {
      return { ...def, state: "done", tone: "success" };
    }
    if (idx === currentIndex) {
      return { ...def, state: "current", tone: currentTone };
    }
    return { ...def, state: "todo", tone: "muted" };
  });
}

/**
 * A finding's label: the severity the reviewer wrote (P1-P3), a structured
 * verdict's own value (Fail, Gap for insufficient, Pass, N/A), OK for an approval
 * summary, or Note for a summary with no recorded severity. Nothing is inferred.
 */
export type ReviewFindingSeverity =
  | "P1"
  | "P2"
  | "P3"
  | "OK"
  | "Fail"
  | "Gap"
  | "Pass"
  | "N/A"
  | "Note";

export type ReviewFindingItem = {
  id: string;
  severity: ReviewFindingSeverity;
  text: string;
  status: string;
};

export type TaskReviewFindings = {
  roundLabel: string;
  /** The selected report's own summary, always shown above its findings. */
  summary: string;
  items: ReviewFindingItem[];
};

/** Which review report the section shows: one task, run and completion event. */
type ReviewEvidence = {
  /** reported: a pending verdict Nucleus has not applied; accepted: the applied verdict; recorded: a run's completion read without `next`. */
  kind: "reported" | "accepted" | "recorded";
  superseded: boolean;
  runId: string | null;
  eventId: string | null;
  head: string | null;
  status: string;
  summary: string | null;
};

const VERDICT_LABEL: Record<string, ReviewFindingSeverity> = {
  fail: "Fail",
  insufficient: "Gap",
  pass: "Pass",
  not_applicable: "N/A",
};

/**
 * The review report the Overview shows, as written (planner ruling after review
 * round 3): its own summary, written findings with their recorded severities and
 * its structured verdicts. Nothing is carried across reports and no individual
 * finding is marked fixed. The report is the pending reported verdict, else the
 * applied one, else (without `next`) the newest reviewer completion; its text is
 * read only from the run completion with the same task, run and completion event,
 * and the outcome's own summary stands in while the two reads catch up.
 * Returns null when no review has occurred yet.
 */
export function taskReviewFindings(
  task: TaskDetail,
  next: TaskNext | null,
  runs: readonly Run[],
): TaskReviewFindings | null {
  const reviewerRuns = runs
    .filter((r) => r.role === "reviewer" && r.completion)
    .sort(
      (a, b) =>
        Date.parse(a.lastObservedAt ?? a.createdAt) -
        Date.parse(b.lastObservedAt ?? b.createdAt),
    );
  const reported = next?.outcome.reported ?? null;
  const accepted = next?.outcome.accepted ?? null;
  const newestRun = reviewerRuns[reviewerRuns.length - 1] ?? null;
  const stored = task.resolution.review ?? null;
  const evidence: ReviewEvidence | null = reported
    ? { kind: "reported", superseded: false, ...pickEvidence(reported) }
    : accepted
      ? {
          kind: "accepted",
          superseded: accepted.superseded,
          ...pickEvidence(accepted),
        }
      : newestRun?.completion
        ? {
            kind: "recorded",
            superseded: false,
            runId: newestRun.id,
            eventId: newestRun.completion.eventId,
            head: newestRun.head ?? newestRun.completion.head ?? null,
            status: newestRun.completion.status,
            summary: newestRun.completion.summary ?? null,
          }
        : stored
          ? {
              kind: "recorded",
              superseded: false,
              runId: stored.runId ?? null,
              eventId: stored.eventId ?? null,
              head: stored.head ?? null,
              status: stored.status,
              summary: stored.summary ?? null,
            }
          : null;
  if (!evidence) return null;

  // Same task, run and completion event: a retained reviewer can file a second
  // report on the same run, and `queue.detail` and `task.next` poll separately.
  const sameReport = (
    completion:
      | {
          taskId?: string;
          runId?: string;
          eventId?: string;
        }
      | null
      | undefined,
  ) =>
    Boolean(
      completion &&
        evidence.runId &&
        evidence.eventId &&
        completion.runId === evidence.runId &&
        completion.eventId === evidence.eventId &&
        (!completion.taskId || completion.taskId === task.id),
    );
  const run = reviewerRuns.find(
    (item) => item.taskId === task.id && sameReport(item.completion),
  );
  const completion = run?.completion ?? (sameReport(stored) ? stored : null);

  const currentHead = task.prHead ?? next?.prHead ?? null;
  const short = (head: string | null) => (head ? head.slice(0, 7) : "");
  // "Current head" is decided only by comparing this report's own head with the
  // PR head: never by poll order, verdict kind or supersession.
  const notes: string[] = [];
  if (!evidence.head) notes.push("Head not recorded");
  else if (!currentHead) notes.push(`Reviewed ${short(evidence.head)}`);
  else if (evidence.head !== currentHead)
    notes.push(`Not the current head (reviewed ${short(evidence.head)})`);
  else notes.push(`At ${short(evidence.head)}`);
  if (evidence.superseded) notes.push("Superseded");
  if (evidence.kind === "reported") notes.push("Reported, not yet applied");
  const reportNote = notes.join(" · ");

  const approved = evidence.status === "ready_to_merge";
  const statusWord = approved
    ? "approved"
    : evidence.status === "changes_required"
      ? "changes requested"
      : evidence.status.replaceAll("_", " ");
  const kindWord =
    evidence.kind === "reported"
      ? " · reported, not yet applied"
      : evidence.superseded
        ? " · superseded"
        : "";
  const roundIndex = run ? reviewerRuns.indexOf(run) + 1 : reviewerRuns.length;
  const roundLabel = `Round ${Math.max(1, roundIndex)} · ${statusWord}${kindWord}`;

  const items: ReviewFindingItem[] = [];
  // Written findings, with the severity the reviewer recorded ("- [P1] ..." or "P2: ...").
  const rawText = completion
    ? completion.reviewText?.trim() || completion.summary?.trim() || ""
    : "";
  const sevPattern =
    /^(?:[-*•]\s*)?(?:\*\*)?\[?(P[123])\]?(?:\*\*)?[:\s-]+(.+)$/i;
  rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, index) => {
      const match = sevPattern.exec(line);
      if (!match) return;
      items.push({
        id: `finding-${index}`,
        severity: match[1]!.toUpperCase() as "P1" | "P2" | "P3",
        text: clipText(match[2]!.trim(), 240),
        status: reportNote,
      });
    });
  // Structured verdicts, each with its own value and evidence.
  for (const verdict of completion?.verdicts ?? []) {
    items.push({
      id: verdict.id,
      severity: VERDICT_LABEL[verdict.verdict] ?? "Note",
      text: clipText(`${verdict.subject}: ${verdict.evidence}`, 240),
      status: reportNote,
    });
  }

  // The selected report's own summary: the joined completion's when the reads
  // agree, the outcome's own while they catch up.
  const summary = clipText(
    (completion?.summary?.trim() || evidence.summary?.trim() || "").replace(
      /\s+/g,
      " ",
    ),
    320,
  );
  if (items.length === 0) {
    items.push({
      id: "summary-finding",
      severity: approved ? "OK" : "Note",
      text: statusWord.charAt(0).toUpperCase() + statusWord.slice(1),
      status: approved ? `Approved · ${reportNote}` : reportNote,
    });
  }

  return { roundLabel, summary, items };
}

function pickEvidence(source: {
  runId: string;
  eventId: string;
  head: string | null;
  status: string;
  summary: string | null;
}): Omit<ReviewEvidence, "kind" | "superseded"> {
  return {
    runId: source.runId,
    eventId: source.eventId,
    head: source.head,
    status: source.status,
    summary: source.summary,
  };
}

export type ParticipantCard = {
  role: "Worker" | "Reviewer" | "Coordinator";
  name: string;
  model: string;
  status: string;
  tone: DetailTone;
};

/**
 * "Who's on it": Worker, Reviewer and Coordinator cards with profile name,
 * model and status dot with words.
 */
export function taskParticipants(
  task: TaskDetail,
  next: TaskNext | null,
  runs: readonly Run[],
): ParticipantCard[] {
  const latestByRole = (rolesList: readonly Run["role"][]) =>
    runs
      .filter((r) => rolesList.includes(r.role))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ??
    null;

  // Worker
  const revisionRun = latestByRole(["revision"]);
  const workerProfile = revisionRun?.profile ?? task.profile;
  const workerLive =
    (revisionRun && !revisionRun.released) ||
    (Boolean(task.agentId) &&
      ["dispatching", "working", "changes_requested"].includes(task.phase));
  const workerStatus = (() => {
    if (task.phase === "queued" && !task.agentId)
      return { text: "Not started", tone: "muted" as DetailTone };
    if (task.resolution.stalledTurnStop && workerLive)
      return { text: "Turn stalled", tone: "danger" as DetailTone };
    if (
      revisionRun?.status === "uncertain" ||
      (task.agentIntent && !task.agentId)
    )
      return { text: "Delivery unconfirmed", tone: "danger" as DetailTone };
    if (workerLive) return { text: "Working", tone: "accent" as DetailTone };
    if (task.completion || revisionRun?.completion) {
      const st = (revisionRun?.completion ?? task.completion)!.status;
      if (st === "ready_for_review" || st === "report_ready")
        return { text: "Reported ready", tone: "success" as DetailTone };
      if (st === "blocked" || st === "error")
        return { text: `Reported ${st}`, tone: "danger" as DetailTone };
      return { text: st.replaceAll("_", " "), tone: "muted" as DetailTone };
    }
    return {
      text: task.agentId ? "Idle" : "Not started",
      tone: "muted" as DetailTone,
    };
  })();

  const workerCard: ParticipantCard = {
    role: "Worker",
    name: workerProfile?.name ?? "Automatic",
    model: workerProfile?.model
      ? workerProfile.model
      : task.complexity
        ? `Starts at ${task.complexity.replaceAll("_", " ")} tier`
        : "Automatic selection",
    status: workerStatus.text,
    tone: workerStatus.tone,
  };

  // Reviewer
  const reviewerRun = latestByRole(["reviewer"]);
  const reviewerProfile = reviewerRun?.profile ?? null;
  const reviewerLive = Boolean(reviewerRun && !reviewerRun.released);
  const reviewerStatus = (() => {
    if (task.skipPRReview)
      return { text: "Skipped", tone: "muted" as DetailTone };
    if (!reviewerRun)
      return { text: "Not started", tone: "muted" as DetailTone };
    if (reviewerRun.status === "uncertain")
      return { text: "Delivery unconfirmed", tone: "danger" as DetailTone };
    if (reviewerLive)
      return { text: "Reviewing", tone: "accent" as DetailTone };
    if (reviewerRun.completion?.status === "ready_to_merge")
      return { text: "Approved", tone: "success" as DetailTone };
    if (reviewerRun.completion?.status === "changes_required")
      return { text: "Waiting for revision", tone: "warning" as DetailTone };
    if (reviewerRun.completion)
      return {
        text: reviewerRun.completion.status.replaceAll("_", " "),
        tone: "muted" as DetailTone,
      };
    return { text: "Idle", tone: "muted" as DetailTone };
  })();

  const reviewerCard: ParticipantCard = {
    role: "Reviewer",
    name: reviewerProfile?.name ?? (task.skipPRReview ? "None" : "Automatic"),
    model:
      reviewerProfile?.model ??
      (task.skipPRReview ? "PR review skipped" : "Independent model"),
    status: reviewerStatus.text,
    tone: reviewerStatus.tone,
  };

  // Coordinator
  const coordRun = latestByRole(["recovery"]);
  const coordProfile = coordRun?.profile ?? null;
  const coordLive = Boolean(coordRun && !coordRun.released);
  const coordStatus = (() => {
    if (!coordRun) return { text: "—", tone: "muted" as DetailTone };
    if (coordLive)
      return { text: "Checking the task", tone: "accent" as DetailTone };
    if (coordRun.completion?.status === "recovered")
      return { text: "Recovered", tone: "success" as DetailTone };
    if (coordRun.completion)
      return {
        text: coordRun.completion.status.replaceAll("_", " "),
        tone: "muted" as DetailTone,
      };
    return { text: "Finished", tone: "muted" as DetailTone };
  })();

  const coordCard: ParticipantCard = {
    role: "Coordinator",
    name: coordProfile?.name ?? "None",
    model:
      coordProfile?.model ??
      (next?.attention ? "On standby" : "Only if it stalls"),
    status: coordStatus.text,
    tone: coordStatus.tone,
  };

  return [workerCard, reviewerCard, coordCard];
}

export type StatTile = {
  label: string;
  value: string;
  barRatio?: number;
  barWarning?: boolean;
};

/**
 * "Time and budget": 4 stat tiles (elapsed, active or queued time, review rounds
 * or queue position, and budget with a bar).
 */
export function taskStatTiles(input: {
  task: TaskDetail;
  next: TaskNext | null;
  runs: readonly Run[];
  telemetry?: TaskTelemetry | null;
  state?: CapacityBoard | undefined;
  now?: number;
}): StatTile[] {
  const { task, next, runs, telemetry, state, now = Date.now() } = input;
  const createdMs = Date.parse(task.createdAt);
  const queuedMs = Number.isFinite(createdMs)
    ? Math.max(0, now - createdMs)
    : 0;
  const elapsedMs = taskElapsed(runs, now);

  // Budget tile
  const bars = budgetBars(task.budget);
  const timeBar = bars.find((b) => b.key === "time");
  const tokenBar = bars.find((b) => b.key === "tokens");
  const primaryBar =
    task.budget?.exhausted === "effective_tokens"
      ? tokenBar
      : (timeBar ?? tokenBar);
  const budgetTile: StatTile = primaryBar
    ? {
        label: "Budget",
        value: primaryBar.text.split(" · ")[0] ?? primaryBar.text,
        barRatio: primaryBar.ratio,
        barWarning: primaryBar.ratio >= 0.8 || Boolean(task.budget?.exhausted),
      }
    : {
        label: "Budget",
        value: runs.length === 0 ? "Not started" : "Unlimited",
        barRatio: 0,
      };

  // Queued (not yet dispatched)
  if (task.phase === "queued" && runs.length === 0) {
    // What holds it comes from the admission check; a position shows only when
    // the admission supplies one (earlier reservations, the QA queue).
    const cause = capacityWaitCause(task.reason);
    const position =
      cause?.kind === "reservations"
        ? { label: "Ahead in queue", value: String(cause.ahead) }
        : cause?.kind === "qa" && cause.position
          ? { label: "QA position", value: String(cause.position) }
          : null;
    return [
      { label: "Queued for", value: formatSpan(queuedMs) },
      {
        label: "Waiting on",
        value: cause ? capacityWaitLabel(cause) : "Dispatch",
      },
      ...(position ? [position] : []),
      budgetTile,
    ];
  }

  // Dispatched / active / finished
  const activeMs =
    telemetry?.stages
      .filter((s) => s.stage.endsWith("_active"))
      .reduce((sum, s) => sum + s.elapsedMs, 0) ?? 0;
  const waitingMs =
    telemetry?.stages
      .filter((s) => s.stage.endsWith("_wait") || s.stage === "capacity_wait")
      .reduce((sum, s) => sum + s.elapsedMs, 0) ?? 0;

  const hasReview = Boolean(
    next &&
      (next.outcome.revision.runs > 0 ||
        next.outcome.accepted ||
        next.outcome.reader),
  );
  const thirdTile: StatTile = hasReview
    ? {
        label: "Review rounds",
        value: `${Math.min(next!.outcome.revision.runs + 1, next!.outcome.revision.budget)} of ${next!.outcome.revision.budget}`,
      }
    : {
        label: "Waiting",
        value: waitingMs > 0 ? formatTelemetryDuration(waitingMs) : "0s",
      };

  return [
    {
      label: "Elapsed",
      value: elapsedMs !== null ? formatSpan(elapsedMs) : formatSpan(queuedMs),
    },
    {
      label: "Active",
      value: activeMs > 0 ? formatTelemetryDuration(activeMs) : "—",
    },
    thirdTile,
    budgetTile,
  ];
}

/**
 * Bookkeeping event kinds hidden behind "Show raw events (N)" in the Activity tab.
 * Includes the existing low-value kinds plus usage unavailable, prompt size,
 * creation attempt reserved/settled, cleanup deferral and observation outages.
 */
const BOOKKEEPING_EVENT_KINDS: ReadonlySet<string> = new Set([
  ...lowValueActivityKinds,
  "run_usage_unavailable",
  "usage_unavailable",
  "prompt_size",
  "creation_attempt_reserved",
  "creation_attempt_settled",
  "cleanup_deferred",
  "cleanup_deferral",
  "observation_outage",
  "host_observation_outage",
  "phase_latency",
  "initial_pr_lookup_empty",
  "pr_lookup_empty",
  "participant_tool_reap_empty",
  "participant_tool_reap_skipped",
  "load_guard_skipped",
  "check_policy_observation",
  "callback_reminder_skipped",
  "callback_reminder_extended",
]);

export function isBookkeepingEventKind(kind: string): boolean {
  if (BOOKKEEPING_EVENT_KINDS.has(kind)) return true;
  if (kind.endsWith("_duration")) return true;
  if (
    kind.includes("usage_unavailable") ||
    kind.includes("prompt_size") ||
    kind.includes("attempt_reserved") ||
    kind.includes("attempt_settled") ||
    kind.includes("cleanup_defer") ||
    kind.includes("observation_outage")
  ) {
    return true;
  }
  return false;
}

/** Plain lines for events whose detail is only an identifier. */
const IDENTITY_EVENT_SUMMARY: Record<string, string> = {
  agent_created: "A new agent thread started for this task.",
  review_result_applied: "Nucleus applied the reviewer’s verdict.",
  review_reapplied: "Nucleus reapplied the reviewer’s verdict.",
};

/** Host thread and agent identities: `thread:delegated-task:…`, `mcp:…`, `t3code:…`, `ns-agent-…`, `ns-run-…`. */
const HOST_IDENTITY_PATTERN =
  /\b(?:thread|mcp|t3code)(?::[\w.@/-]+)+|\bns-(?:agent|run)-[\w-]+/gi;

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SHA_PATTERN = /\b([0-9a-f]{7})[0-9a-f]{33}\b/gi;
const phaseWords = (phase: unknown) =>
  typeof phase === "string" ? phase.replaceAll("_", " ") : "";

/**
 * The timeline's plain line for one event. Structured payloads become a short
 * sentence (an owner control names its verb, caller, phase change and reason);
 * raw identifiers drop out and commit SHAs shorten. The full record stays under
 * "Show raw events".
 */
export function readableEventDetail(detail: string, kind = ""): string {
  const text = detail.trim();
  // A detail that is only an identifier (an agent or thread ID, a run ID, a host
  // thread path) says nothing to a reader: summarize the event by its kind.
  const identityOnly =
    Boolean(text) &&
    (stripHostIdentities(text) === "" ||
      (!/\s/.test(text) &&
        /\d/.test(text) &&
        /[:-]/.test(text) &&
        text.length >= 8));
  if (identityOnly) return IDENTITY_EVENT_SUMMARY[kind] ?? "";
  if (text.startsWith("{") || text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: a person's note such as "[QA] waiting for the receipt", kept as
      // written apart from any host identity.
      return stripHostIdentities(text);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return "";
    const record = parsed as Record<string, unknown>;
    if (typeof record.verb === "string") {
      const parts = [
        `${record.verb.replaceAll("_", " ")}${typeof record.caller === "string" && record.caller ? ` by ${record.caller}` : ""}`,
      ];
      const before = phaseWords(record.phaseBefore);
      const after = phaseWords(record.phaseAfter);
      if (before && after && before !== after)
        parts.push(`${before} → ${after}`);
      if (typeof record.reason === "string" && record.reason.trim())
        parts.push(stripIdentifiers(record.reason));
      return parts.filter(Boolean).join(" · ");
    }
    for (const field of ["summary", "reason", "detail", "message"]) {
      const value = record[field];
      if (typeof value === "string" && value.trim())
        return stripIdentifiers(value);
    }
    return "";
  }
  return stripIdentifiers(text) || (IDENTITY_EVENT_SUMMARY[kind] ?? "");
}

function stripHostIdentities(text: string): string {
  return text
    .replace(HOST_IDENTITY_PATTERN, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripIdentifiers(text: string): string {
  return stripHostIdentities(text)
    .replace(UUID_PATTERN, "")
    .replace(SHA_PATTERN, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s·:;,-]+|[\s·:;,-]+$/g, "")
    .trim();
}

export type ActivityTimelineItem = {
  id: string;
  kind: string;
  source: "event" | "message";
  title: string;
  detail: string;
  at: string;
  tone: DetailTone;
  count: number;
};

function eventTone(kind: string): DetailTone {
  if (
    kind.includes("failed") ||
    kind.includes("error") ||
    kind.includes("lost") ||
    kind.includes("uncertain") ||
    kind.includes("unreviewed") ||
    kind.includes("attention") ||
    kind.includes("missed")
  ) {
    return "danger";
  }
  if (
    kind.includes("changes") ||
    kind.includes("hold") ||
    kind.includes("escalation") ||
    kind.includes("question") ||
    kind.includes("ask") ||
    kind.includes("reminder") ||
    kind.includes("blocked")
  ) {
    return "warning";
  }
  if (
    kind.includes("merged") ||
    kind.includes("completed") ||
    kind.includes("approved") ||
    kind.includes("passed") ||
    kind.includes("admitted") ||
    kind.includes("answered") ||
    kind.includes("resolved") ||
    kind.includes("recovered") ||
    kind.includes("done")
  ) {
    return "success";
  }
  if (
    kind.includes("started") ||
    kind.includes("dispatched") ||
    kind.includes("review") ||
    kind.includes("coordinator") ||
    kind.includes("owner_") ||
    kind.includes("operator_")
  ) {
    return "accent";
  }
  return "muted";
}

/**
 * Build the readable Activity timeline:
 * - Filters out bookkeeping events (those stay under "Show raw events (N)")
 * - Folds messages and escalation/question events into one chronological stream
 * - Groups consecutive repeated events of the same kind with a repeat count
 * Sorted newest first.
 */
export function buildActivityTimeline(input: {
  events: ReadonlyArray<{
    id: number;
    at: string;
    kind: string;
    detail: string;
  }>;
  messages: ReadonlyArray<AgentMessageRecord>;
  taskId: string;
}): { items: ActivityTimelineItem[]; rawCount: number } {
  const rawCount = input.events.length;
  const entries: Array<ActivityTimelineItem & { ts: number }> = [];

  for (const ev of input.events) {
    if (isBookkeepingEventKind(ev.kind)) continue;
    const ts = Date.parse(ev.at);
    entries.push({
      id: `ev:${ev.id}`,
      kind: ev.kind,
      source: "event",
      title: eventKindLabel(ev.kind),
      detail: eventDetailSummary(readableEventDetail(ev.detail, ev.kind)),
      at: ev.at,
      tone: eventTone(ev.kind),
      count: 1,
      ts: Number.isFinite(ts) ? ts : 0,
    });
  }

  for (const msg of input.messages) {
    const sent = msg.fromTaskId === input.taskId;
    const counterpart = sent
      ? (msg.toReference ?? msg.toRole)
      : (msg.fromReference ?? msg.fromRole);
    const status =
      msg.status === "delivered"
        ? "Delivered"
        : msg.status === "expired"
          ? "Expired · not delivered before the recipient finished"
          : msg.status === "uncertain"
            ? "Delivery unknown"
            : "Queued · waiting for the recipient’s next turn";
    const delivery =
      msg.status !== "delivered" && msg.error
        ? `${status} · last note: ${msg.error}`
        : status;
    const ts = Date.parse(msg.createdAt);
    entries.push({
      id: `msg:${msg.id}`,
      kind: sent ? "message_sent" : "message_received",
      source: "message",
      title: sent
        ? `Message sent to ${counterpart}`
        : `Message from ${counterpart}`,
      // A message is bounded by the send limit; the timeline shows all of it.
      detail: `${delivery} · ${msg.text.trim()}`,
      at: msg.createdAt,
      tone:
        msg.status === "expired"
          ? "danger"
          : msg.status === "delivered"
            ? "accent"
            : "warning",
      count: 1,
      ts: Number.isFinite(ts) ? ts : 0,
    });
  }

  // Sort newest first
  entries.sort((a, b) => b.ts - a.ts);

  // Group consecutive repeated events of the same kind (messages stay individual)
  const grouped: ActivityTimelineItem[] = [];
  for (const entry of entries) {
    const prev = grouped[grouped.length - 1];
    if (
      prev &&
      entry.source === "event" &&
      prev.source === "event" &&
      prev.kind === entry.kind
    ) {
      prev.count += 1;
    } else {
      const { ts: _ts, ...item } = entry;
      grouped.push(item);
    }
  }

  return { items: grouped, rawCount };
}

/** Format a timeline timestamp concisely (time today, or short date + time). */
export function formatActivityTime(at: string, now = Date.now()): string {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const n = new Date(now);
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return decisionAge(at, now);
}
