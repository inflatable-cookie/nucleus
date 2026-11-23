import type { AgentObservation } from "../host/adapter";
import { HostReadRefusalError, isHostOperationTimeout } from "../host";
import { HostTransportFault } from "../host/adapter-routing";
import { isTransportFailure } from "../../shared/transport";
import {
  formatLiveToolIssue,
  liveToolIssueFact,
  noTurnLive,
  type OwnedToolHoldResult,
  type ToolTimelineRead,
} from "../recovery/stall";
import {
  QUANTUM_READ_DEADLINE_MS,
  boundedRead,
  isQuantumDeadlineExceeded,
} from "../scheduling/pass-snapshot";

export type { OwnedToolHoldResult } from "../recovery/stall";

/** A bounded window is liveness evidence only with inactivity and owned-process proof. */
export async function boundedToolHold(
  read: Extract<ToolTimelineRead, { kind: "ok"; coverage: "bounded" }>,
  host: { observe(id: string): Promise<AgentObservation | null> },
  agentId: string,
  workspaceId: string | undefined,
  processProof: (observed: AgentObservation) => Promise<OwnedToolHoldResult>,
  deadlineMs: number = QUANTUM_READ_DEADLINE_MS,
): Promise<OwnedToolHoldResult> {
  // Positive live evidence always holds, even when another signal is unknown.
  // An interrupted call needs no more here: the turn and owned-process proofs
  // below decide it, so a child that survived the interrupt still holds.
  const tool = liveToolIssueFact(read.entries, null, {
    interruptedSettles: true,
  });
  if (tool) {
    const live =
      tool.kind === "live" &&
      ["pending", "running", "waiting"].includes(tool.status);
    return {
      kind: "hold",
      reason: `${live ? "an owned tool is still live" : "owned tool evidence is inconclusive"}: ${formatLiveToolIssue(tool)}`,
    };
  }
  if (read.pendingBackgroundTasks.length)
    return {
      kind: "hold",
      reason: `an owned tool is still live: provider reports outstanding background work: ${read.pendingBackgroundTasks.join(", ")}`,
    };
  let state: AgentObservation | null = null;
  try {
    const observed = await boundedRead(
      "participant observation",
      () => host.observe(agentId),
      deadlineMs,
    );
    if (observed.state === "unknown")
      return { kind: "deferred", reason: observed.reason };
    state = observed.value;
  } catch (error) {
    if (isQuantumDeadlineExceeded(error))
      return { kind: "deferred", reason: error.message };
    if (
      error instanceof HostReadRefusalError ||
      isTransportFailure(error) ||
      isHostOperationTimeout(error) ||
      error instanceof HostTransportFault
    )
      throw error;
    /* Unknown never clears. */
  }
  if (
    !state ||
    state.id !== agentId ||
    !workspaceId ||
    state.workspaceId !== workspaceId
  )
    return {
      kind: "hold",
      reason:
        "owned tool evidence is inconclusive: participant observation or workspace identity is unavailable",
    };
  if (state.active === true || state.activeTurnId || state.permissions === true)
    return {
      kind: "hold",
      reason:
        "an owned tool is still live: participant has an active run or pending runtime request",
    };
  if (!noTurnLive(state))
    return {
      kind: "hold",
      reason:
        "owned tool evidence is inconclusive: participant inactivity is unproven",
    };
  try {
    const proof = await processProof(state);
    if (proof.kind === "clear") return { kind: "clear" };
    if (proof.kind === "deferred") return proof;
    return {
      kind: "hold",
      reason: proof.reason
        ? `owned tool process proof did not clear: ${proof.reason}`
        : "owned tool evidence is inconclusive: owned-process observation returned no verdict",
    };
  } catch (error) {
    if (isQuantumDeadlineExceeded(error))
      return { kind: "deferred", reason: error.message };
    return {
      kind: "hold",
      reason:
        "owned tool evidence is inconclusive: owned-process observation is unavailable",
    };
  }
}
