import { formatAgentId } from "../../shared/agent-identity";
import { hostKindOf } from "../../shared/host-kind";
import { observationTimeout } from '../recovery/observation-timeout';
import { DEFAULT_PROJECT_LIMIT, ownerCandidateKind } from "../../shared/contracts";
import { buildProjectSettings, projectSettingsQaKeys } from "./project-settings";
import { observedHostIdOf, projectAgentViews } from "./project-agents";
import { UNRESOLVED_SEED } from "../store/store";
import type { Engine } from '../engine';

export type ProjectLifecycleContext = Pick<Engine, 'adapter' | 'host' | 'store' | 'activeHostId'> & Partial<Pick<Engine, 'plannerTicketPending'>>;

export class ProjectLifecycle {
  constructor(readonly context: ProjectLifecycleContext) {}
  async projectOwnerCandidates() {
    if (!this.context.adapter.listLiveAgents) return [];
    const live = await this.context.host.listLiveAgents();
    return live.map(agent => ({
      id: agent.id, title: agent.title, workspaceId: agent.workspaceId,
      kind: ownerCandidateKind(agent.labels),
    }));
  }

  async projectSettings() {
    const liveKnown = Boolean(this.context.adapter.listLiveAgents);
    const live = liveKnown ? await this.context.host.listLiveAgents() : [];
    const projects = this.context.store.projects();
    const hostId = this.context.activeHostId ?? observedHostIdOf(this.context.adapter);
    const agents = Object.fromEntries(await Promise.all(projects.map(async project =>
      [project.key, await projectAgentViews({ host: this.context.host, observedHostId: hostId }, project)] as const)));
    return buildProjectSettings({
      projects,
      repositories: this.context.store.repositories(),
      overrides: this.context.store.projectDispatchLimitOverrides(),
      defaultSlots: this.context.store.getMeta<number>("projectLimit") ?? DEFAULT_PROJECT_LIMIT,
      liveAgentIds: new Set(live.flatMap(agent => hostId
        ? [formatAgentId(hostId, agent.id), ...(hostKindOf(hostId) === 'paseo' ? [agent.id] : [])]
        : [agent.id])),
      liveKnown, observedHostId: hostId ?? undefined,
      plannerTicketPending: this.context.plannerTicketPending?.() ?? new Set(),
      agents,
      latestQaRuns: this.context.store.latestQaRunsFor(projectSettingsQaKeys(projects)),
    });
  }

  /** Task 1110: a project's named agents with their live state and fallback marker. */
  async projectAgents(projectKey: string) {
    const project = this.context.store.projectByKey(projectKey);
    if (!project) throw new Error(`Unknown project ${projectKey}`);
    return projectAgentViews({ host: this.context.host,
      observedHostId: this.context.activeHostId ?? observedHostIdOf(this.context.adapter) }, project);
  }

  async migrateProjectOwnersToPlanners(): Promise<void> {
    if (this.context.store.getMeta("projectOwnersToPlanners") === "done") return;
    let unresolved = 0;
    for (const project of this.context.store.projects()) {
      if (!project.owner || project.planner?.agentId) continue;
      const owner = project.owner.agentId;
      let state: "live" | "missing" | "unknown" | { resolved: string } = "unknown";
      try {
        if (UNRESOLVED_SEED.test(owner)) {
          const found = this.context.adapter.listLiveAgents ? (await observationTimeout(this.context.host.listLiveAgents(), "Owner liveness check timed out")).filter(agent => agent.id.startsWith(owner)) : [];
          state = found.length === 1 ? { resolved: found[0].id } : found.length ? "unknown" : "missing";
        } else {
          const agent = this.context.adapter.originAgent ? await observationTimeout(this.context.host.originAgent(owner), "Owner liveness check timed out") : null;
          state = agent && !agent.archived ? "live" : "missing";
        }
      } catch { state = "unknown"; }
      if (state === "unknown") { unresolved++; continue; }
      if (state === "missing") this.context.store.retireProjectOwner(project.key, "Spec 058 cutover 5: the owner thread is gone or archived, so the record is dropped");
      else {
        const agentId = typeof state === "object" ? state.resolved : owner;
        this.context.store.setProjectPlanner({ key: project.key, agentId, setBy: "Queue",
          note: "Spec 058 cutover 5: the live owner thread becomes the planner" });
      }
    }
    if (!unresolved) this.context.store.setMeta("projectOwnersToPlanners", "done");
  }
}
