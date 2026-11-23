import { propagateQuantumDeferral } from "../scheduling/pass-snapshot";
import type { Task } from "../../shared/contracts";
import type { Engine } from "../engine";
import { dispatchBlocked } from "../dispatch/capacity";
import { startsNoRuns } from "../closeout/queue-drain";
import { HostReadRefusalError } from "../host/errors";
import { HostTransportFault } from "../host/adapter-routing";
import {
  CheckoutRefusalError,
  CheckoutUnavailableError,
} from "../workspaces/checkout-volume";
import { workspaceCreationRefusal } from "../workspaces/workspace-allocation";
import { worktreeLinksForClearedIntent } from "../workspaces/worktree-links";
import { bindWorkspaceRegistration } from "../workspaces/workspace-registration";
import { isTransportFailure } from "../../shared/transport";
import type { TaskStopRecord } from "../../shared/task-stop";
import { expiredQuantumDeadlineError } from "../scheduling/pass-snapshot";

/**
 * Spec 068 batch A: an uncertain workspace creation settles by lookup, as an
 * uncertain agent creation does.
 *
 * A task whose dispatch (its first, or a re-dispatch after a host move that left
 * no PR) recorded `workspaceIntent` but never bound a workspace (the service
 * stopped mid-populate, or the create call never answered) is
 * looked up on its host: the host's workspace inventory, the expected worktree
 * directory, the `git worktree list` entry, the task branch (local and remote)
 * and any workspace allocation lease (Barge). Then:
 *
 * - one match binds it, and the worker launches as after an ordinary create;
 * - a complete read proving none of it exists, once this service has no create
 *   in flight for the task and the grace period since the last attempt has
 *   passed, releases the intent so ordinary dispatch creates it again;
 * - Nucleus's own residue (a task branch with no commits past the base, never
 *   pushed and with no worktree) is removed first, then the intent is released;
 *   a branch with commits or a pushed ref is never touched;
 * - a partial or failed read, or a create still running, waits with the reason
 *   named.
 *
 * Releases are bounded per task (`WORKSPACE_RELEASE_ATTEMPTS`, counted since the
 * last explicit release); past the bound the task records a typed stop naming
 * `record.clear kind=workspace_intent`, the explicit command that releases the
 * intent without a proof.
 */

export const WORKSPACE_RELEASE_ATTEMPTS = 3;
export const WORKSPACE_INTENT_RELEASED = "workspace_intent_released";

export type WorkspaceSettlement =
  | "bound"
  | "released"
  | "waiting"
  | "stopped"
  | "skipped";

export type WorkspaceLookupContext = Pick<
  Engine,
  | "store"
  | "adapter"
  | "resolution"
  | "hostHealth"
  | "note"
  | "launchAgent"
  | "stopped"
>;

/** Events that mark a workspace creation attempt; the grace runs from the latest. */
const ATTEMPT_EVENTS = [
  "dispatch_intent",
  "workspace_populate_started",
  "workspace_populate_finished",
  WORKSPACE_INTENT_RELEASED,
  "orphan_workspace_removed",
];

function attemptEvents(
  store: WorkspaceLookupContext["store"],
  taskId: string,
): { kind: string; at: string; detail: string }[] {
  return store.db
    .prepare(
      `SELECT kind, at, detail FROM events WHERE taskId=? AND kind IN (${ATTEMPT_EVENTS.map(() => "?").join(",")}) ORDER BY id`,
    )
    .all(taskId, ...ATTEMPT_EVENTS) as {
    kind: string;
    at: string;
    detail: string;
  }[];
}

const automaticRelease = (detail: string): boolean => {
  try {
    return (JSON.parse(detail) as { automatic?: boolean }).automatic === true;
  } catch {
    return false;
  }
};

/** Automatic releases since the last explicit one: the per-task bound. */
export function automaticWorkspaceReleases(
  store: WorkspaceLookupContext["store"],
  taskId: string,
): number {
  let count = 0;
  for (const event of attemptEvents(store, taskId)) {
    if (event.kind !== WORKSPACE_INTENT_RELEASED) continue;
    count = automaticRelease(event.detail) ? count + 1 : 0;
  }
  return count;
}

/**
 * The fields that release a workspace intent, shared by the automatic release
 * and `record.clear kind=workspace_intent`. A Barge allocation intent is kept:
 * the next populate replays the same request id, so a lease Barge did grant is
 * bound rather than duplicated.
 */
export function workspaceIntentReleasePatch(task: Task): Partial<Task> {
  return { workspaceIntent: false, ...worktreeLinksForClearedIntent(task) };
}

/** The generic wait the quantum recorded before this lookup existed. */
export const LEGACY_WORKSPACE_WAIT =
  "Workspace creation is uncertain; inspect the host and resolve explicitly";

/**
 * Whether a stop is this lookup's own: its lifecycle wait, its typed stop past
 * the bound, or the legacy generic wait. Any other stop belongs to its owner.
 */
export function workspaceLookupStop(
  stop: TaskStopRecord | null | undefined,
): boolean {
  return Boolean(
    stop &&
      (stop.fact?.code === "workspace_lookup" ||
        (stop.reason === "lifecycle" && stop.detail === LEGACY_WORKSPACE_WAIT)),
  );
}

/** The typed stop past the release bound, which a transient read never replaces. */
const boundStop = (stop: TaskStopRecord | null | undefined): boolean =>
  stop?.reason === "operator_needed" && stop.fact?.code === "workspace_lookup";

/** Text for the typed stop past the bound, naming its explicit command. */
export function workspaceReleaseBoundReason(task: Task): string {
  return `Workspace creation for ${task.branch} found nothing to bind after ${WORKSPACE_RELEASE_ATTEMPTS} automatic releases; inspect the host, then use record.clear kind=workspace_intent id=${task.branch} to release it again, or cancel the task`;
}

const routedError = (error: unknown): boolean =>
  error instanceof CheckoutUnavailableError ||
  error instanceof CheckoutRefusalError ||
  error instanceof HostReadRefusalError ||
  error instanceof HostTransportFault ||
  isTransportFailure(error);

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** A lookup wait on the task's own cause; another owner's stop keeps its cause. */
function waitOn(
  ctx: WorkspaceLookupContext,
  task: Task,
  why: string,
): WorkspaceSettlement {
  const current = ctx.store.task(task.id);
  const stop = current.resolution.stop;
  if (
    (stop &&
      stop.reason !== "lifecycle" &&
      stop.fact?.code !== "workspace_lookup") ||
    boundStop(stop)
  )
    return "waiting";
  const reason = `Uncertain workspace creation for ${current.branch}: ${why}; Nucleus looks it up again on the next pass (record.clear kind=workspace_intent id=${current.branch} releases it now)`;
  if (current.reason !== reason || stop?.fact?.code !== "workspace_lookup")
    ctx.resolution.waiting(current, reason, "lifecycle", {
      fact: { code: "workspace_lookup", subject: current.branch },
    });
  return "waiting";
}

/**
 * A dispatch's workspace intent with nothing bound yet and nothing to lose: no
 * worker, run, completion or PR identity. That is a first dispatch, or a
 * re-dispatch after a host move that left no PR; a task with a PR identity
 * keeps its continuation path, since its branch carries work.
 */
export function unboundDispatchWorkspace(task: Task): boolean {
  return (
    task.workspaceIntent &&
    !task.workspaceId &&
    !task.directory &&
    !task.agentIntent &&
    !task.agentId &&
    !task.runId &&
    !task.completion &&
    !task.prUrl &&
    !task.prHead &&
    !task.resumePrNumber &&
    !(task.entrypoint === "proof" && task.proofOnly) &&
    task.entrypoint !== "review" &&
    !["done", "cancelled"].includes(task.phase)
  );
}

/** Settle one task whose workspace creation is uncertain. */
export async function settleWorkspaceCreation(
  ctx: WorkspaceLookupContext,
  task: Task,
): Promise<WorkspaceSettlement> {
  const { store, adapter } = ctx;
  if (!unboundDispatchWorkspace(task) || dispatchBlocked(task))
    return "skipped";
  // This service's own first dispatch owns a create still in flight.
  if (ctx.hostHealth.launchInFlight(task.id)) return "skipped";
  const paused = startsNoRuns(store, ctx.stopped);
  // Captured before the reads: only an attempt that had already ended counts.
  const attempts = attemptEvents(store, task.id);
  const lastAt = Date.parse(attempts.at(-1)?.at ?? task.createdAt);
  const graceEndsAt = lastAt + ctx.resolution.graceMs;
  const graceOver = Date.now() >= graceEndsAt;

  await adapter.preflightWorkspaceStorage?.(task);
  let found: { id: string; directory: string }[];
  try {
    found = await adapter.findWorkspaces(task);
  } catch (error) {
    propagateQuantumDeferral(error);
    if (routedError(error)) throw error;
    return paused
      ? "skipped"
      : waitOn(
          ctx,
          task,
          `the host workspace inventory could not be read (${message(error)})`,
        );
  }
  if (found.length > 1) {
    ctx.note(
      task.id,
      "Ambiguous workspace identity; no new resource created",
      "workspace_unavailable",
      "needs_attention",
    );
    return "waiting";
  }
  if (found.length === 1) {
    bindWorkspaceRegistration(
      store,
      task.id,
      found[0]!,
      "workspace_recovered",
      { phase: "dispatching" },
    );
    if (!paused) await ctx.launchAgent(store.task(task.id));
    return "bound";
  }
  if (!adapter.inspectWorkspaceCreation)
    return paused
      ? "skipped"
      : waitOn(ctx, task, "this host cannot inspect its worktrees");
  let state: Awaited<
    ReturnType<NonNullable<typeof adapter.inspectWorkspaceCreation>>
  >;
  try {
    // A branch absent locally is also looked up on its push remote.
    state = await adapter.inspectWorkspaceCreation(task, {
      remoteWhenAbsent: true,
    });
  } catch (error) {
    propagateQuantumDeferral(error);
    if (routedError(error)) throw error;
    return paused
      ? "skipped"
      : waitOn(
          ctx,
          task,
          `the worktree inspection could not complete (${message(error)})`,
        );
  }
  if (state.kind === "found_done" || state.kind === "registered_incomplete") {
    if (paused) return "skipped";
    const populated =
      state.kind === "registered_incomplete"
        ? await adapter.populateTaskWorktree?.(task)
        : undefined;
    if (startsNoRuns(store, ctx.stopped)) return "skipped";
    const workspace = await adapter.createWorkspace(task, {
      freshlyPopulated: populated?.populated,
    });
    bindWorkspaceRegistration(
      store,
      task.id,
      workspace,
      "workspace_recovered",
      { phase: "dispatching" },
    );
    await ctx.launchAgent(store.task(task.id));
    return "bound";
  }
  if (paused) return "skipped";
  if (state.kind === "still_running")
    return waitOn(ctx, task, `its create is still running (${state.evidence})`);
  if (state.kind === "unknown")
    return waitOn(ctx, task, `the host read was partial (${state.evidence})`);
  if (
    state.kind === "conflicting" ||
    state.kind === "proof_head_mismatch" ||
    (state.kind === "partial" && state.orphan.provenance !== "branch_only")
  ) {
    // Work that may be someone's, or a populate leftover with a directory: a
    // person decides, through the verb the refusal names.
    const refusal = workspaceCreationRefusal(state);
    if (store.task(task.id).reason !== refusal)
      ctx.note(task.id, refusal, "operator_needed", "needs_attention");
    return "waiting";
  }
  // Absent, or Nucleus's own empty unpublished branch with no worktree.
  if (!graceOver)
    return waitOn(
      ctx,
      task,
      `nothing found yet; its grace period ends at ${new Date(graceEndsAt).toISOString()}`,
    );
  const current = store.task(task.id);
  const stop = current.resolution.stop;
  if (
    stop &&
    stop.reason !== "lifecycle" &&
    stop.fact?.code !== "workspace_lookup"
  )
    return "waiting";
  if (
    automaticWorkspaceReleases(store, task.id) >= WORKSPACE_RELEASE_ATTEMPTS
  ) {
    const reason = workspaceReleaseBoundReason(current);
    if (current.reason !== reason)
      ctx.resolution.waiting(current, reason, "operator_needed", {
        fact: { code: "workspace_lookup", subject: current.branch },
      });
    return "stopped";
  }
  let removed: string | null = null;
  if (state.kind === "partial") {
    if (!adapter.removeOrphanWorkspace)
      return waitOn(
        ctx,
        task,
        `its empty branch ${state.orphan.branch} cannot be removed on this host`,
      );
    // An abandoned quantum (its deadline passed) never removes anything.
    const expired = expiredQuantumDeadlineError("empty branch removal");
    if (expired) throw expired;
    try {
      // Re-inspects first and deletes the ref only at the head it proved.
      await adapter.removeOrphanWorkspace(current, state.orphan);
    } catch (error) {
      propagateQuantumDeferral(error);
      if (routedError(error)) throw error;
      return waitOn(
        ctx,
        task,
        `its empty branch could not be removed (${message(error)})`,
      );
    }
    removed = state.orphan.head;
    store.event(
      task.id,
      "orphan_workspace_removed",
      JSON.stringify({ ...state.orphan, automatic: true }),
    );
  }
  const latest = store.task(task.id);
  if (latest.workspaceId || !latest.workspaceIntent) return "skipped";
  store.transaction(() => {
    const fresh = store.task(task.id);
    store.update(
      fresh.id,
      workspaceIntentReleasePatch(fresh),
      WORKSPACE_INTENT_RELEASED,
      JSON.stringify({
        automatic: true,
        branch: fresh.branch,
        found: removed ? "empty_branch" : "nothing",
        ...(removed ? { removedHead: removed } : {}),
      }),
    );
    ctx.resolution.returnToDispatch(
      store.task(fresh.id),
      false,
      removed
        ? `Uncertain workspace creation left only an empty branch at ${removed.slice(0, 12)}; removed it and requeued`
        : "Uncertain workspace creation found nothing on the host; requeued",
      "workspace_intent_requeued",
    );
  });
  return "released";
}
