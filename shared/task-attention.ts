import type { HoldKind, Task } from "./contracts";
import { isTerminalPhase } from "./task-state";
import { blockingHoldKind, isOperatorOwner } from "./holds";

/**
 * The one attention projection (nucleus#1366).
 *
 * The board's Attention column, `task.next` and a host's own row presentation all
 * read this classifier, so no presentation invents its own reading of "a person
 * must act". It derives presentation only: no hold, phase, run or delivery fact is
 * decided here.
 *
 * Four states:
 * - `finished`: the task is done or cancelled.
 * - `attention`: a person must act — the task's own attention flag, an unresolved
 *   origin fault, or a phase that parks work on a person with nothing saying what
 *   it waits for.
 * - `waiting`: nothing Nucleus is running and nobody has to act. An owner hold with
 *   a release condition, a planner's own hold, and an unresolved prerequisite wait
 *   are waits with a named cause, never attention (Tom, 2026-11-19): the owner
 *   already said what the task waits for, so the row must not ask anyone for
 *   anything.
 * - `active`: Nucleus is running a role for the task and no person must act.
 *
 * A planner's own hold waits only while its planner nudge is answered or still
 * pending: once that nudge goes unanswered the hold needs its owner again and the
 * task is attention for that hold generation (nucleus#1419).
 */

export type TaskAttentionState =
  | "finished"
  | "attention"
  | "waiting"
  | "active";

export type TaskAttention =
  | { state: "finished" }
  | { state: "attention"; cause: string }
  | { state: "waiting"; cause: string }
  | { state: "active" };

/** The hold fence's shape this projection reads: its release condition, owner and answer state. */
export interface AttentionFence {
  until?: { kind: "task" | "time" } | null;
  reason?: string;
  /** Who placed the fence, as `holdFencesView` resolves it: the task's owner or the operator. */
  owner?: string;
  /** The planner's nudge for this fence went unanswered, or never reached it (nucleus#1419). */
  unanswered?: "planner" | "delivery" | null;
}

export interface TaskAttentionFacts {
  phase: Task["phase"];
  held: boolean;
  holds?: { dispatch?: AttentionFence; merge?: AttentionFence };
  holdKind?: HoldKind | null;
  /** The task's own recorded attention flag (`resolution.attention`). */
  attention?: boolean;
  /** The repository origin could not be resolved, so the task cannot dispatch. */
  originFault?: boolean;
  /** An unresolved prerequisite wait is the task's current wait. */
  prerequisiteWait?: boolean;
  /** An impossible prerequisite needs an operator to correct the list. */
  prerequisiteOperator?: boolean;
  /** Nucleus has an unreleased run for this task. */
  liveRun?: boolean;
  /** The reference the task waits on, when a title or card names one (`nucleus#1364`). */
  waitingOn?: string | null;
  /** The task's visible reason, the fallback cause text. */
  reason?: string;
}

/** The phases Queue's board parks on a person when nothing else says what the wait is. */
export const ATTENTION_PHASES: ReadonlyArray<Task["phase"]> = [
  "blocked",
  "error",
  "needs_attention",
];

const bounded = (text: string | undefined | null, fallback: string): string => {
  const value = (text ?? "").trim();
  return value ? value.slice(0, 160) : fallback;
};

/** The named cause of a wait, as a card or row states it. */
const waitCause = (facts: TaskAttentionFacts, fallback: string): string =>
  facts.waitingOn
    ? `Waiting on ${facts.waitingOn}`
    : bounded(facts.reason, fallback);

/**
 * The blocking fence with a release condition: the wait this task already named.
 * A hold with no release condition still needs its owner to release it, so it is
 * not a wait the projection can answer on its own.
 */
function releasingHold(facts: TaskAttentionFacts): AttentionFence | null {
  const fence = blockingFence(facts);
  return fence?.until ? fence : null;
}

/** The blocking fence of this task, whatever kind of hold it is. */
function blockingFence(facts: TaskAttentionFacts): AttentionFence | null {
  const dispatch =
    Boolean(facts.holds?.dispatch) || facts.holdKind === "dispatch";
  const merge = Boolean(facts.holds?.merge) || facts.holdKind === "merge";
  const kind = blockingHoldKind(facts.phase, dispatch, merge);
  return kind ? (facts.holds?.[kind] ?? null) : null;
}

/**
 * The planner's own hold, or null. An operator's hold from the board is the
 * operator's to release and keeps its existing attention (nucleus#1419).
 */
function plannerHold(facts: TaskAttentionFacts): AttentionFence | null {
  const fence = blockingFence(facts);
  if (!fence || fence.until) return null;
  return fence.owner && !isOperatorOwner(fence.owner) ? fence : null;
}

export function taskAttention(facts: TaskAttentionFacts): TaskAttention {
  if (isTerminalPhase(facts.phase)) return { state: "finished" };
  const hold = releasingHold(facts);
  // A hold that names its release condition is a wait: the owner already said what
  // it waits for (Tom, 2026-11-19).
  if (hold)
    return {
      state: "waiting",
      cause: waitCause(facts, "Held until its condition"),
    };
  if (facts.prerequisiteWait)
    return {
      state: "waiting",
      cause: waitCause(facts, "Waiting for prerequisite"),
    };
  if (facts.prerequisiteOperator || facts.attention || facts.originFault)
    return {
      state: "attention",
      cause: bounded(facts.reason, "Needs attention"),
    };
  if (facts.liveRun) return { state: "active" };
  // The planner's own hold is a deliberate park, so a quiet row behind it waits
  // rather than asking its owner for anything (nucleus#1419). Once the nudge for
  // that hold generation went unanswered the planner does have to answer it, and
  // the row is shown again; a fresh `hold`/`keep_hold` is a new generation.
  const plannerFence = plannerHold(facts);
  if (plannerFence) {
    if (plannerFence.unanswered === "delivery")
      return {
        state: "attention",
        cause: "The hold nudge was not delivered to the planner",
      };
    if (plannerFence.unanswered)
      return {
        state: "attention",
        cause: "The planner has not answered this hold",
      };
    return { state: "waiting", cause: waitCause(facts, "Held by planner") };
  }
  if (ATTENTION_PHASES.includes(facts.phase))
    return {
      state: "attention",
      cause: bounded(facts.reason, "Needs attention"),
    };
  // A task between roles, queued for capacity or waiting for dispatch runs nothing
  // Nucleus owns here and needs no person: it waits.
  return { state: "waiting", cause: waitCause(facts, "Waiting") };
}
