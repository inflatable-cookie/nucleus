import { parseAgentId } from "../../shared/agent-identity";
import { projectSchema, type Project, type ProjectAgent } from "../../shared/contracts";
import { DEFAULT_PLANNER_AGENT_NAME } from "../../shared/schema/project-agents";
import { now, StoreCore } from "./store-core";
import { type StoreProjectRegistry } from "./store-project-registry";

/** The fallback's default address when its preferred one is another thread's: `planner`, `planner-2`, … */
function freeProjectAgentName(agents: readonly ProjectAgent[], base: string): string {
  const taken = new Set(agents.map(agent => agent.name));
  if (!taken.has(base)) return base;
  for (let index = 2; index <= 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`No free default agent name is available beside "${base}"`);
}

/**
 * Named, non-task agents of a project: the registry of addressable threads and the
 * fallback planner's registration. The fallback is the one planner that is also a
 * registered agent; its name follows its thread.
 */
export class StoreProjectAgents {
  constructor(private readonly core: StoreCore, private readonly registry: StoreProjectRegistry) {}

  /**
   * Task 1110: one named, non-task thread. A thread holds at most one name per
   * project, so registering the same thread under a new name renames it and a
   * name given to another thread reassigns it. The dispatch ticket service
   * revokes a superseded participant ticket after this write.
   */
  registerProjectAgent(input: { key: string; name: string; purpose: string; agentId: string; hostId: string; registeredBy: string; note?: string }, at = now()): Project {
    return this.core.transaction(() => {
      const project = this.registry.projectByKey(input.key);
      if (!project) throw new Error(`Unknown project ${input.key}`);
      const fallback = project.planner?.agentId;
      const fallbackEntry = fallback ? (project.agents ?? []).find(agent => agent.agentId === fallback) : undefined;
      // The fallback planner's address belongs to the role: moving it without moving
      // the role would leave the project with an unregistered fallback. The operator
      // reassigns the fallback with project.set-planner, which moves the name with it.
      if (fallbackEntry && fallbackEntry.name === input.name && fallbackEntry.agentId !== input.agentId)
        throw new Error(`"${input.name}" is ${project.name}'s fallback planner address; reassign the fallback with project.set-planner before giving its name to another thread`);
      const { project: updated, kind } = this.upsertProjectAgent(project, input, at);
      this.core.event(`project:${input.key}`, `project_agent_${kind}`, `${input.name} -> ${input.agentId}${input.registeredBy ? ` by ${input.registeredBy}` : ""}${input.note ? `; ${input.note}` : ""}`);
      this.core.advanceRevision();
      return updated;
    });
  }

  /**
   * Task 1110: remove one named agent. The project's fallback planner cannot be
   * removed while it holds that role: name another planner with
   * `project.set-planner` first, so `to: {project}` never dangles.
   */
  unregisterProjectAgent(input: { key: string; name: string; unregisteredBy: string; note?: string }): Project {
    return this.core.transaction(() => {
      const project = this.registry.projectByKey(input.key);
      if (!project) throw new Error(`Unknown project ${input.key}`);
      const entry = (project.agents ?? []).find(agent => agent.name === input.name);
      if (!entry) throw new Error(`Project ${input.key} has no agent named "${input.name}"`);
      if (project.planner?.agentId === entry.agentId)
        throw new Error(`"${input.name}" is ${project.name}'s fallback planner; name another planner with project.set-planner before unregistering it`);
      const updated = projectSchema.parse({ ...project, agents: (project.agents ?? []).filter(agent => agent.name !== input.name) });
      this.registry.persist(updated);
      this.core.event(`project:${input.key}`, "project_agent_unregistered", `${input.name} (was ${entry.agentId}) by ${input.unregisteredBy}${input.note ? `; ${input.note}` : ""}`);
      this.core.advanceRevision();
      return updated;
    });
  }

  /**
   * Task 1110: every fallback planner is a registered agent, including rows
   * written before this registry existed and planners set outside the RPC. This
   * is idempotent and does nothing for a cleared or already-registered planner.
   */
  ensureProjectFallbackAgent(input: { key: string; hostId?: string | null; previousPlannerId?: string | null }, at = now()): Project {
    return this.core.transaction(() => {
      const project = this.registry.projectByKey(input.key);
      if (!project) throw new Error(`Unknown project ${input.key}`);
      if (!project.planner?.agentId) return project;
      const planner = project.planner;
      const current = (project.agents ?? []).find(agent => agent.agentId === planner.agentId);
      if (current) {
        if (planner.name === current.name) return project;
        const repaired = projectSchema.parse({ ...project, planner: { ...planner, name: current.name } });
        this.registry.persist(repaired);
        this.core.advanceRevision();
        return repaired;
      }
      const hostId = parseAgentId(planner.agentId)?.hostId ?? input.hostId ?? null;
      if (!hostId) return project;
      const preferred = planner.name ?? DEFAULT_PLANNER_AGENT_NAME;
      const holder = (project.agents ?? []).find(agent => agent.name === preferred);
      // Reassign the preferred name only when the previous fallback held it (a
      // rotation moves the name). Another thread's address is never dropped: the
      // fallback registers under a free default name instead.
      const name = !holder || (input.previousPlannerId && holder.agentId === input.previousPlannerId)
        ? preferred : freeProjectAgentName(project.agents ?? [], DEFAULT_PLANNER_AGENT_NAME);
      const { project: updated } = this.upsertProjectAgent(project, {
        key: input.key, name, purpose: "Project fallback planner",
        agentId: planner.agentId, hostId, registeredBy: planner.setBy,
      }, at);
      this.core.event(`project:${input.key}`, "project_agent_registered", `fallback planner ${planner.agentId} registered as "${name}"`);
      this.core.advanceRevision();
      return updated;
    });
  }

  /** Inside one write transaction: the registry edit and the planner name that follows it. */
  private upsertProjectAgent(project: Project, input: { key: string; name: string; purpose: string; agentId: string; hostId: string; registeredBy: string }, at: string):
    { project: Project; kind: "registered" | "renamed" | "reassigned" | "updated" } {
    const byName = (project.agents ?? []).find(agent => agent.name === input.name);
    const byThread = (project.agents ?? []).find(agent => agent.agentId === input.agentId);
    let kind: "registered" | "renamed" | "reassigned" | "updated";
    let entry: ProjectAgent;
    if (byName && byName.agentId === input.agentId && byName.hostId === input.hostId) {
      kind = "updated";
      entry = byName.purpose === input.purpose ? byName : { ...byName, purpose: input.purpose };
    } else {
      kind = byName ? "reassigned" : byThread ? "renamed" : "registered";
      entry = { name: input.name, purpose: input.purpose, agentId: input.agentId, hostId: input.hostId, registeredBy: input.registeredBy, registeredAt: at };
    }
    const agents = [...(project.agents ?? []).filter(agent => agent.name !== input.name && agent.agentId !== input.agentId), entry]
      .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt) || a.name.localeCompare(b.name));
    if (agents.length > 100) throw new Error(`Project ${project.key} already has 100 named agents`);
    // The planner's name follows its registered thread, so the fallback marker never names another agent.
    const plannerName = project.planner?.agentId ? agents.find(agent => agent.agentId === project.planner!.agentId)?.name : undefined;
    const planner = project.planner
      ? { agentId: project.planner.agentId, ...(plannerName ? { name: plannerName } : {}), setBy: project.planner.setBy, setAt: project.planner.setAt }
      : project.planner;
    const updated = projectSchema.parse({ ...project, agents, planner });
    this.registry.persist(updated);
    return { project: updated, kind };
  }
}
