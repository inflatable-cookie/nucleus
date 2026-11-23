import type { AgentObservation } from "../host/adapter";
import { HostReadRefusalError, isHostOperationTimeout } from "../host";
import { HostTransportFault } from "../host/adapter-routing";
import { isTransportFailure } from "../../shared/transport";
import {
  formatLiveToolIssue,
  liveToolIssueFact,
  noTurnLive,
  type ToolTimelineRead,
} from "../recovery/stall";
import {
  QUANTUM_READ_DEADLINE_MS,
  boundedRead,
} from "../scheduling/pass-snapshot";

/** A bounded window is liveness evidence only with inactivity and owned-process proof. */
export async function boundedToolHold(
  read: Extract<ToolTimelineRead, { coverage: "bounded" }>,
  host: { observe(id: string): Promise<AgentObservation | null> },
  agentId: string,
  workspaceId: string | undefined,
  processProof: (observed: AgentObservation) => Promise<string | null>,
  deadlineMs: number = QUANTUM_READ_DEADLINE_MS,
): Promise<string | null> {
  // Positive live evidence always holds, even when another signal is unknown.
  const tool = liveToolIssueFact(read.entries);
  if (tool) {
    const live =
      tool.kind === "live" &&
      ["pending", "running", "waiting"].includes(tool.status);
    return `${live ? "an owned tool is still live" : "owned tool evidence is inconclusive"}: ${formatLiveToolIssue(tool)}`;
  }
  if (read.pendingBackgroundTasks.length)
    return `an owned tool is still live: provider reports outstanding background work: ${read.pendingBackgroundTasks.join(", ")}`;
  let state: AgentObservation | null = null;
  try {
    const observed = await boundedRead(
      "participant observation",
      () => host.observe(agentId),
      deadlineMs,
    );
    state = observed.state === "ok" ? observed.value : null;
  } catch (error) {
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
    return "owned tool evidence is inconclusive: participant observation or workspace identity is unavailable";
  if (state.active === true || state.activeTurnId || state.permissions === true)
    return "an owned tool is still live: participant has an active run or pending runtime request";
  if (!noTurnLive(state))
    return "owned tool evidence is inconclusive: participant inactivity is unproven";
  try {
    const issue = await processProof(state);
    if (issue === null) return null;
    return typeof issue === "string" && issue
      ? `owned tool process proof did not clear: ${issue}`
      : "owned tool evidence is inconclusive: owned-process observation returned no verdict";
  } catch {
    return "owned tool evidence is inconclusive: owned-process observation is unavailable";
  }
}
