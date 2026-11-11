import { parseAgentId } from "../../shared/agent-identity";
import { hostKindOf } from "../../shared/host-kind";
import type { Project, ProjectAgent, ProjectAgentState, ProjectAgentView } from "../../shared/contracts";
import type { Host } from "../../shared/host";
import type { Adapter } from "../host/adapter";

/**
 * Task 1110: a project's named agents, read as one list and resolved by name.
 *
 * A named agent is a non-task thread — a planner, a lead, the coordinator of a
 * cross-section — recorded on the project with the host it lives on. Listing
 * observes each entry's live state; a host that cannot be read, or a thread it
 * cannot describe, is `unknown`, never `gone`. Resolving a name for a send never
 * sends anything: an archived or gone thread fails with that state, so naming an
 * agent can never revive it.
 */
export type ProjectAgentsContext = {
  host: Pick<Host, "originAgent" | "observe">;
  /** The host this process is talking to right now, when it knows. */
  observedHostId: string | null;
};

/** One entry's live state and the host's last activity stamp for it. */
export interface ProjectAgentObservation {
  state: ProjectAgentState;
  lastSeen: string | null;
}

/** A name or fallback that cannot be addressed, with the state that refused it. */
export class ProjectAgentTargetRefusal extends Error {
  constructor(
    readonly projectKey: string,
    readonly agentName: string | null,
    readonly state: ProjectAgentState | "unregistered" | "no-fallback",
    message: string,
  ) {
    super(message);
    this.name = "ProjectAgentTargetRefusal";
  }
}

/**
 * An entry is observed only on the host it was registered from. A bare legacy
 * Paseo id has no encoded host, exactly like the planner liveness read, so any
 * Paseo host may observe it. Every other host mismatch is incomplete, not gone.
 */
export function projectAgentObservedOn(agent: Pick<ProjectAgent, "agentId" | "hostId">, observedHostId: string | null): boolean {
  if (!observedHostId) return false;
  if (agent.hostId === observedHostId) return true;
  if (parseAgentId(agent.agentId)) return false;
  return hostKindOf(agent.hostId) === "paseo" && hostKindOf(observedHostId) === "paseo";
}

/** One entry's live state from its own host. A failed read is `unknown`. */
export async function observeProjectAgent(context: ProjectAgentsContext, agent: ProjectAgent): Promise<ProjectAgentObservation> {
  if (!projectAgentObservedOn(agent, context.observedHostId)) return { state: "unknown", lastSeen: null };
  try {
    const origin = await context.host.originAgent(agent.agentId);
    if (!origin) return { state: "gone", lastSeen: null };
    if (origin.archived) return { state: "archived", lastSeen: null };
    const observation = await context.host.observe(agent.agentId);
    const lastSeen = observation.updatedAt?.trim() || null;
    return { state: observation.active ? "running" : "idle", lastSeen };
  } catch (error) {
    // A proven absence is the one positive answer; every other read failure is unknown.
    if (error instanceof Error && error.message === "Agent was not found") return { state: "gone", lastSeen: null };
    return { state: "unknown", lastSeen: null };
  }
}

/** The project's agents with their live state, in registration order. */
export async function projectAgentViews(context: ProjectAgentsContext, project: Pick<Project, "agents" | "planner">): Promise<ProjectAgentView[]> {
  return Promise.all((project.agents ?? []).map(async agent => {
    const observation = await observeProjectAgent(context, agent);
    return {
      name: agent.name,
      purpose: agent.purpose,
      agentId: agent.agentId,
      hostId: agent.hostId,
      state: observation.state,
      lastSeen: observation.lastSeen,
      fallback: Boolean(project.planner?.agentId && project.planner.agentId === agent.agentId),
    };
  }));
}

export const PROJECT_AGENT_REFUSAL_POINTER = "List the project's agents with project.agents.";

/**
 * Resolve a registered agent for a send. Nothing is sent here.
 *
 * A name is explicit: an archived, gone or unreadable thread fails with that
 * state and a pointer to the list, so naming an agent can never revive it.
 * `name` null is the project's fallback planner — the thread `to: {project}`
 * resolves to — and resolves to the recorded planner without a liveness gate,
 * exactly as delegated questions route to it.
 */
export async function resolveProjectAgent(
  context: ProjectAgentsContext,
  project: Project,
  name: string | null,
): Promise<{ agentId: string; hostId: string; name: string }> {
  if (name === null) {
    const fallback = project.planner?.agentId;
    if (!fallback) throw new ProjectAgentTargetRefusal(project.key, null, "no-fallback",
      `${project.name} has no fallback planner, so to: {project} has no thread to reach. Register one with agent.register and mark it with project.set-planner. ${PROJECT_AGENT_REFUSAL_POINTER}`);
    const entry = (project.agents ?? []).find(agent => agent.agentId === fallback);
    return { agentId: fallback,
      hostId: entry?.hostId ?? parseAgentId(fallback)?.hostId ?? context.observedHostId ?? "",
      name: entry?.name ?? project.planner?.name ?? "" };
  }
  const entry = (project.agents ?? []).find(agent => agent.name === name);
  if (!entry) throw new ProjectAgentTargetRefusal(project.key, name, "unregistered",
    `${project.name} has no agent named "${name}". ${PROJECT_AGENT_REFUSAL_POINTER}`);
  const state = (await observeProjectAgent(context, entry)).state;
  if (state === "archived" || state === "gone" || state === "unknown")
    throw new ProjectAgentTargetRefusal(project.key, name, state, refusalText(project, name, state));
  return { agentId: entry.agentId, hostId: entry.hostId, name: entry.name };
}

function refusalText(project: Project, name: string, state: ProjectAgentState): string {
  const pointer = `Nucleus never sends into that thread. ${PROJECT_AGENT_REFUSAL_POINTER}`;
  if (state === "archived") return `Agent "${name}" on ${project.name} is archived. ${pointer}`;
  if (state === "gone") return `Agent "${name}" on ${project.name} is gone. ${pointer}`;
  return `Agent "${name}" on ${project.name} could not be observed, so its state is unknown. Nothing was sent. ${pointer}`;
}

/** A host-facing adapter may expose the host id it is connected to; absent means unknown. */
export function observedHostIdOf(adapter: Adapter): string | null {
  const id = (adapter as { hostId?: unknown }).hostId;
  return typeof id === "string" && id ? id : null;
}
