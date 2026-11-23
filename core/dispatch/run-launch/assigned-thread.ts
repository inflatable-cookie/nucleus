import type { LaunchThreadContext } from "../launch";
import type { Run, Task } from "../../../shared/contracts";
import { dataHome } from "../../../shared/data-home.mjs";
import { wireLabel } from "../../../shared/wire-labels";
import { active, assignedThreadWaitReason } from "../../recovery/task-reasons";
import {
  mcpBindingPathFromHostRecord,
  observedMcpBindingPath,
  reportBindingReuseDecision,
} from "../../intake/report-binding";
import { unreleasedLaunchFence } from "../../verbs/owner-facts";
import {
  PASS_PROCESS_READ_DEADLINE_MS,
  QUANTUM_READ_DEADLINE_MS,
  boundedRead,
} from "../../scheduling/pass-snapshot";

/** What the launch does with the retained thread it was about to reuse. */
export type AssignedThread =
  /** The retained thread is idle and resumable in its own workspace. */
  | { kind: "reuse"; workspaceId: string }
  /** The thread's report binding belongs to another data home: launch a fresh one. */
  | { kind: "dropped"; workspaceId: string }
  /** The thread already recorded its wait; the launch stops here. */
  | { kind: "handled" };

/**
 * Observe an assigned thread before reusing it: a run still holding it is the
 * launch fence, a report binding outside the current data home is a fresh
 * launch, a busy or terminal thread is a wait with a named cause, and only an
 * idle thread whose own workspace matches may be resumed. Every refusal is a
 * recorded wait or a fault an owner must clear, never a launch that silently
 * starts nothing.
 */
export async function observeAssignedThread(
  ctx: LaunchThreadContext,
  t: Task,
  role: Run["role"],
  agentId: string,
  workspaceId: string,
  threadBusy: (agentId: string) => boolean,
): Promise<AssignedThread> {
  // A run still holding this thread is the launch fence: name it, the rule
  // keeping it and what releases it, so `next` and the owner's verb reply
  // state the same reason instead of a launch that silently starts nothing.
  if (threadBusy(agentId)) {
    ctx.waiting(
      t,
      `Assigned thread is serving another request: ${unreleasedLaunchFence(ctx.store, t, role, agentId) ?? "its current run has not settled"}`,
      "lifecycle",
    );
    return { kind: "handled" };
  }
  const deadlineMs = ctx.quantumReadTimeoutMs ?? QUANTUM_READ_DEADLINE_MS;
  const observed = await boundedRead(
    "assigned thread observation",
    () => ctx.host.observe(agentId),
    deadlineMs,
  );
  if (observed.state === "unknown") {
    ctx.waiting(
      t,
      `Assigned thread ${agentId} observation is unknown (${observed.reason}); waiting for the next host pass`,
      "lifecycle",
    );
    return { kind: "handled" };
  }
  const state = observed.value;
  const recordedPath =
    state.mcpBindingPath ?? mcpBindingPathFromHostRecord(state);
  const bindingKey = wireLabel(state.labels, "mcpBinding");
  const readProcesses = ctx.readPassProcesses
    ? async () => {
        const read = await ctx.readPassProcesses!(t.hostId);
        return read.state === "listed" ? read.processes : null;
      }
    : ctx.adapter.hostProcessListing
      ? async () => {
          const read = await boundedRead(
            "host process listing",
            () => ctx.adapter.hostProcessListing!(),
            PASS_PROCESS_READ_DEADLINE_MS,
          ).catch(() => ({ state: "unknown" as const, reason: "failed" }));
          return read.state === "ok" ? read.value : null;
        }
      : undefined;
  const bindingPath = await observedMcpBindingPath(
    recordedPath,
    bindingKey,
    readProcesses,
  );
  let home: string | undefined;
  try {
    home = dataHome();
  } catch {
    /* unknown home keeps the thread */
  }
  if (
    home &&
    reportBindingReuseDecision({ bindingPath, dataHome: home }) === "fresh"
  ) {
    ctx.store.event(
      t.id,
      "report_binding_relaunch",
      `Retained ${role} ${agentId} report binding ${bindingPath} lives outside the current data home; launching a fresh thread on the same profile`,
    );
    return { kind: "dropped", workspaceId };
  }
  const resumable =
    state.status === "idle" ||
    (state.status === "closed" &&
      (role === "reviewer" || role === "revision")) ||
    (role === "revision" &&
      t.resolution.revisionResumeUnpublished &&
      state.status === "error");
  // A stale pending Nucleus question found at dispatch is resolved, not
  // waited on (papercut ee9fc161): a withdrawn question never stalls
  // dispatch. Anything else pending keeps the ordinary wait below.
  if (
    (active(state) || !resumable) &&
    (state.permissions || state.pendingRequest)
  ) {
    if (await ctx.resolveWithdrawnPending(t, { agentId, state }))
      return { kind: "handled" };
  }
  // No bypass over a pending permission or question here: nothing Queue can
  // observe identifies the pending item as the superseded run's own question,
  // so the resume waits until the thread goes idle. The recorded
  // superseded-run refusal already told the worker to end its turn without asking.
  // A busy thread is a wait; a terminal, non-resumable one is a fault an owner or coordinator must clear.
  if (active(state) || !resumable) {
    ctx.waiting(
      t,
      assignedThreadWaitReason(state),
      active(state) ? "lifecycle" : "operator_needed",
    );
    return { kind: "handled" };
  }
  let resumedWorkspace = workspaceId;
  if (role === "reviewer" || role === "revision") {
    if (state.workspaceId !== t.workspaceId!)
      throw new Error("Retained thread left the worker workspace");
  } else {
    resumedWorkspace = state.workspaceId!;
  }
  // The workspace the run launches on is a launch fence for every role: a
  // retained coordinator naming none, and a reviewer or revision whose task has
  // none either, are faults rather than a launch with no workspace.
  if (!resumedWorkspace)
    throw new Error("Assigned coordinator has no workspace");
  return { kind: "reuse", workspaceId: resumedWorkspace };
}
