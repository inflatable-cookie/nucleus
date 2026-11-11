import type { Task, TaskHolds, HoldFence, HoldKind } from "./contracts";

/** Fields `holdsOf` reads, including the legacy single-hold projection. */
export type HoldFields = Pick<Task, "held" | "phase" | "mergeHold" | "holdOwner" | "holdReason" | "holdAt" | "holdGeneration" | "holdUntil" | "holdBlocking" | "originAgentId"> & { holds?: TaskHolds; notificationAgentId?: string | null };

/**
 * The independent fences on a task. Stored `holds` win while the task is held;
 * otherwise the legacy `held`/`mergeHold` projection is rebuilt so older rows
 * and tests that only set those fields keep their meaning.
 */
export function holdsOf(task: HoldFields): TaskHolds {
  if (!task.held) return {};
  if (task.holds?.dispatch || task.holds?.merge) {
    return {
      ...(task.holds.dispatch ? { dispatch: task.holds.dispatch } : {}),
      ...(task.holds.merge ? { merge: task.holds.merge } : {}),
    };
  }
  const fence: HoldFence = {
    owner: task.holdOwner ?? TASK_OWNER_HOLD,
    reason: task.holdReason ?? "not recorded",
    at: task.holdAt ?? "",
    generation: task.holdGeneration || 1,
    until: task.holdUntil ?? null,
    ...(task.holdBlocking ? { blocking: task.holdBlocking } : {}),
  };
  return task.mergeHold === true || task.phase !== "queued" ? { merge: fence } : { dispatch: fence };
}

/** Project the two fences onto the Spec 040 legacy fields. Merge is primary when both exist. */
export function syncHoldProjection(holds: TaskHolds): Pick<Task, "holds" | "held" | "mergeHold" | "holdOwner" | "holdReason" | "holdAt" | "holdGeneration" | "holdBlocking" | "holdUntil"> {
  const next: TaskHolds = {
    ...(holds.dispatch ? { dispatch: holds.dispatch } : {}),
    ...(holds.merge ? { merge: holds.merge } : {}),
  };
  const primary = next.merge ?? next.dispatch;
  return {
    holds: next,
    held: Boolean(primary),
    mergeHold: Boolean(next.merge),
    holdOwner: primary?.owner ?? null,
    holdReason: primary?.reason ?? null,
    holdAt: primary?.at ?? null,
    holdGeneration: primary?.generation ?? 0,
    holdBlocking: next.merge?.blocking ?? null,
    holdUntil: primary?.until ?? null,
  };
}

export function mergeHeld(task: HoldFields): boolean {
  return Boolean(holdsOf(task).merge);
}

/**
 * A hold of either kind fences the merge path (Queue #531): a stop is a stop
 * whatever fence it placed, so an owner-stopped task past review never records
 * merge intent. The merge hold keeps its own visible meaning; this only says
 * that nothing held merges.
 */
export function mergeFenced(task: HoldFields): boolean {
  const holds = holdsOf(task);
  return Boolean(holds.merge || holds.dispatch);
}

export function defaultHoldKind(task: Pick<Task, "phase">): HoldKind {
  return task.phase === "queued" ? "dispatch" : "merge";
}

/** The operator identity the board sends on `queue.task`; the direct operator authority for owner-class controls. */
export const OPERATOR_BOARD_CALLER = "operator (board)";

/** The operator's own identities: never a Paseo thread, so never an origin to route or a workspace to inherit (consumer #687). */
export const OPERATOR_IDENTITIES: ReadonlySet<string> = new Set(["operator", OPERATOR_BOARD_CALLER]);

export const isOperatorOrigin = (id: string | null | undefined): boolean => Boolean(id) && OPERATOR_IDENTITIES.has(id!.trim());

/**
 * Spec 058 cutover 5: origin slug of this repository. The Queue planner is the
 * planner of the project that holds this origin, whatever that project's key is.
 * The slug is the repository's real name on the forge; it never renames here.
 */
export const QUEUE_REPOSITORY_ORIGIN = "inflatable-cookie/paseo-northstar-queue";

export const NUCLEUS_REPOSITORY_ORIGIN = "inflatable-cookie/nucleus";

/**
 * The task's one owner (Tom, 2026-10-26): the thread its attention, completion,
 * hold-release and planning notices reach. `notificationAgentId` is the owner
 * field; the creator (`originAgentId`) is history and answers only for a row
 * written before the owner field was backfilled. Reparenting writes only this.
 */
export function taskOwner(task: { notificationAgentId?: string | null; originAgentId: string }): string {
  return task.notificationAgentId || task.originAgentId;
}

/**
 * A hold fence owned by "whoever owns the task now". A hold the owner places is
 * stored with this marker rather than its thread id, so changing the owner moves
 * the hold's release prompts with it and leaves no stale identity behind.
 */
export const TASK_OWNER_HOLD = "task-owner";

/** The thread a hold fence answers to: the task owner for an owner-placed hold, else the recorded owner. */
export function holdOwnerOf(task: { notificationAgentId?: string | null; originAgentId: string }, owner: string | null | undefined): string {
  return !owner || owner === TASK_OWNER_HOLD ? taskOwner(task) : owner;
}

/** The owner value a new hold fence stores: the marker when the placing thread owns the task. */
export function storedHoldOwner(task: { notificationAgentId?: string | null; originAgentId: string }, owner: string): string {
  return owner !== TASK_OWNER_HOLD && !isOperatorOrigin(owner) && owner === taskOwner(task) ? TASK_OWNER_HOLD : owner;
}


/** Compact board view of each present fence; omitted entirely when neither is set. */
export function holdFencesView(task: HoldFields): { dispatch?: { owner: string; reason: string; since: string }; merge?: { owner: string; reason: string; since: string } } | undefined {
  const holds = holdsOf(task);
  if (!holds.dispatch && !holds.merge) return undefined;
  const view = (fence: HoldFence) => ({ owner: holdOwnerOf(task, fence.owner), reason: fence.reason.slice(0, 600), since: fence.at });
  return {
    ...(holds.dispatch ? { dispatch: view(holds.dispatch) } : {}),
    ...(holds.merge ? { merge: view(holds.merge) } : {}),
  };
}


/** A visible hold blocks dispatch only while a dispatch fence is present. */
export function taskHoldKind(task: HoldFields): HoldKind | null {
  const holds = holdsOf(task);
  if (holds.merge) return "merge";
  if (holds.dispatch) return "dispatch";
  return null;
}

/** Phases a dispatch fence blocks: the task has not started. */
export const DISPATCH_BLOCKED_PHASES: readonly Task["phase"][] = ["queued", "dispatching"];

/** Phases a merge fence blocks: the task is ready to merge. */
export const MERGE_BLOCKED_PHASES: readonly Task["phase"][] = ["verifying", "merging"];

/** Shared client/server derivation; parked tasks wait on their live fence, dispatch first. */
export function blockingHoldKind(phase: Task['phase'], dispatch: boolean, merge: boolean): HoldKind | null {
  const parked = phase === 'blocked' || phase === 'needs_attention';
  if (dispatch && (parked || DISPATCH_BLOCKED_PHASES.includes(phase))) return 'dispatch';
  if (merge && (parked || MERGE_BLOCKED_PHASES.includes(phase))) return 'merge';
  return null;
}

/**
 * The fence that is the task's wait right now, or null. When both fences block,
 * the dispatch fence is the wait; the merge fence stays on the task beside it.
 */
export function blockingHoldFence(task: HoldFields): { kind: HoldKind; fence: HoldFence } | null {
  const holds = holdsOf(task);
  const kind = blockingHoldKind(task.phase, Boolean(holds.dispatch), Boolean(holds.merge));
  return kind ? { kind, fence: holds[kind]! } : null;
}

/** Spec 040: a merge hold that is still the last blocker at the reviewed head and has waited past the escalation time. */
export function holdEscalated(task: Pick<Task, "held" | "phase" | "prHead" | "holdOwner" | "holdBlocking" | "holdGeneration"> & Partial<HoldFields>): boolean {
  const merge = holdsOf(task as HoldFields).merge;
  const b = merge?.blocking ?? task.holdBlocking;
  const generation = merge?.generation ?? task.holdGeneration;
  const owner = merge?.owner ?? task.holdOwner;
  return Boolean(merge) && Boolean(b?.escalatedAt) && b!.head === task.prHead && b!.generation === generation && (task.phase === "verifying" || task.phase === "merging") && !isOperatorOrigin(owner);
}
