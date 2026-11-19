import { formatAgentId, parseAgentId } from "../../shared/agent-identity";
import { hostKindOf } from "../../shared/host-kind";
import { observationTimeout } from "../recovery/observation-timeout";
import {
  DEFAULT_PROJECT_LIMIT,
  ownerCandidateKind,
  UNRESOLVED_OWNER_SEED,
} from "../../shared/contracts";
import { projectPlannerRoutingIssue } from "../questions/planner-presence";
import {
  buildProjectSettings,
  projectSettingsQaKeys,
} from "./project-settings";
import {
  legacyIdentityObservedOn,
  observedHostIdOf,
  projectAgentViews,
} from "./project-agents";
import type { Engine } from "../engine";

export type ProjectLifecycleContext = Pick<
  Engine,
  "adapter" | "host" | "store" | "activeHostId"
> &
  Partial<Pick<Engine, "plannerTicketPending" | "resolution">>;

const OWNER_OBSERVATION_TIMEOUT = "Owner liveness check timed out";

/**
 * One owner thread's liveness. `live` resolves the thread the project's planner
 * becomes; `missing` is the one answer that may retire the owner record, and
 * only a read on the thread's own host answers it; `unknown` is unreadable
 * evidence and never absence.
 */
type OwnerThreadState =
  | { kind: "live"; agentId: string }
  | { kind: "missing" }
  | { kind: "unknown" };

export class ProjectLifecycle {
  constructor(readonly context: ProjectLifecycleContext) {}
  async projectOwnerCandidates() {
    if (!this.context.adapter.listLiveAgents) return [];
    const live = await this.context.host.listLiveAgents();
    return live.map((agent) => ({
      id: agent.id,
      title: agent.title,
      workspaceId: agent.workspaceId,
      kind: ownerCandidateKind(agent.labels),
    }));
  }

  async projectSettings() {
    const liveKnown = Boolean(this.context.adapter.listLiveAgents);
    const live = liveKnown ? await this.context.host.listLiveAgents() : [];
    const projects = this.context.store.projects();
    const hostId =
      this.context.activeHostId ?? observedHostIdOf(this.context.adapter);
    const agents = Object.fromEntries(
      await Promise.all(
        projects.map(
          async (project) =>
            [
              project.key,
              await projectAgentViews(
                { host: this.context.host, observedHostId: hostId },
                project,
              ),
            ] as const,
        ),
      ),
    );
    return buildProjectSettings({
      projects,
      repositories: this.context.store.repositories(),
      overrides: this.context.store.projectDispatchLimitOverrides(),
      defaultSlots:
        this.context.store.getMeta<number>("projectLimit") ??
        DEFAULT_PROJECT_LIMIT,
      liveAgentIds: new Set(
        live.flatMap((agent) =>
          hostId
            ? [
                formatAgentId(hostId, agent.id),
                ...(hostKindOf(hostId) === "paseo" ? [agent.id] : []),
              ]
            : [agent.id],
        ),
      ),
      liveKnown,
      observedHostId: hostId ?? undefined,
      plannerTicketPending: this.context.plannerTicketPending?.() ?? new Set(),
      plannerRoutingIssues: new Map(
        projects.map((project) => [
          project.key,
          projectPlannerRoutingIssue(this.context.store, project),
        ]),
      ),
      agents,
      responsibleThreads: Object.fromEntries(await Promise.all(projects.map(async project => {
        const result = await this.context.resolution?.responsibleThread(project);
        return [project.key, result ? { thread: result.thread, cacheAgeMs: Math.max(0, Date.now() - result.observedAt) } : undefined];
      }))),
      latestQaRuns: this.context.store.latestQaRunsFor(
        projectSettingsQaKeys(projects),
      ),
    });
  }

  /** Task 1110: a project's named agents with their live state and fallback marker. */
  async projectAgents(projectKey: string) {
    const project = this.context.store.projectByKey(projectKey);
    if (!project) throw new Error(`Unknown project ${projectKey}`);
    return projectAgentViews(
      {
        host: this.context.host,
        observedHostId:
          this.context.activeHostId ?? observedHostIdOf(this.context.adapter),
      },
      project,
    );
  }

  async migrateProjectOwnersToPlanners(): Promise<void> {
    if (this.context.store.getMeta("projectOwnersToPlanners") === "done")
      return;
    let unresolved = 0;
    for (const project of this.context.store.projects()) {
      if (!project.owner || project.planner?.agentId) continue;
      const owner = project.owner.agentId;
      const state = await this.ownerThreadState(owner);
      if (state.kind === "unknown") {
        unresolved++;
        continue;
      }
      if (state.kind === "missing")
        this.context.store.retireProjectOwner(
          project.key,
          "Spec 058 cutover 5: the owner thread is gone or archived, so the record is dropped",
        );
      else
        this.context.store.setProjectPlanner({
          key: project.key,
          agentId: state.agentId,
          setBy: "Queue",
          note: "Spec 058 cutover 5: the live owner thread becomes the planner",
        });
    }
    if (!unresolved)
      this.context.store.setMeta("projectOwnersToPlanners", "done");
  }

  /**
   * Read one owner thread's liveness on the host that can answer for it. The
   * host facade serves a qualified identity on its own host, and an unqualified
   * legacy thread is observable only on a Paseo host; a host that cannot hold
   * the thread, an adapter without the read, and an unreadable answer are all
   * `unknown`, so no wrong-host silence ever retires the record.
   */
  private async ownerThreadState(owner: string): Promise<OwnerThreadState> {
    const observedHostId =
      this.context.activeHostId ?? observedHostIdOf(this.context.adapter);
    try {
      if (!parseAgentId(owner) && !legacyIdentityObservedOn(observedHostId))
        return { kind: "unknown" };
      if (UNRESOLVED_OWNER_SEED.test(owner))
        return await this.seededOwnerThreadState(owner);
      if (!this.context.adapter.originAgent) return { kind: "unknown" };
      const agent = await observationTimeout(
        this.context.host.originAgent(owner),
        OWNER_OBSERVATION_TIMEOUT,
      );
      return agent && !agent.archived
        ? { kind: "live", agentId: owner }
        : { kind: "missing" };
    } catch {
      return { kind: "unknown" };
    }
  }

  /**
   * A seeded owner names a legacy thread by the start of its id. Exactly one
   * live thread resolves it (an exact id wins over a prefix); no match is a
   * proven absence only because the read was made on the thread's own host.
   */
  private async seededOwnerThreadState(
    seed: string,
  ): Promise<OwnerThreadState> {
    if (!this.context.adapter.listLiveAgents) return { kind: "unknown" };
    const live = await observationTimeout(
      this.context.host.listLiveAgents(),
      OWNER_OBSERVATION_TIMEOUT,
    );
    const found = live.filter(
      (agent) => agent.id === seed || agent.id.startsWith(seed),
    );
    if (found.length === 1) return { kind: "live", agentId: found[0].id };
    return found.length ? { kind: "unknown" } : { kind: "missing" };
  }
}
