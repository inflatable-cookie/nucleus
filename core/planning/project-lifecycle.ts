import type { Project } from "../../shared/contracts";
import { formatAgentId, legacyIdentityObservedOn, parseAgentId } from "../../shared/agent-identity";
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
  observedHostIdOf,
  projectAgentViews,
  unobservedProjectAgentViews,
} from "./project-agents";
import type { Engine } from "../engine";

export type ProjectLifecycleContext = Pick<
  Engine,
  "adapter" | "host" | "store" | "activeHostId"
> &
  Partial<Pick<Engine, "plannerTicketPending" | "resolution">>;

const OWNER_OBSERVATION_TIMEOUT = "Owner liveness check timed out";
const LIVE_INVENTORY_TIMEOUT = "Live thread inventory timed out";
const LIVE_READ_TIMEOUT = "Live Settings read timed out";

/** A Settings live read, bounded so a stalled host ends as unknown rather than a hang. */
const LIVE_READ_MS = 5_000;
function bounded<T>(work: Promise<T>): Promise<T> {
  return observationTimeout(work, LIVE_READ_TIMEOUT, LIVE_READ_MS);
}

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
  /**
   * The planner picker's live threads. Bounded, so a slow or offline host fails
   * the picker with an error instead of holding it open.
   */
  async projectOwnerCandidates() {
    if (!this.context.adapter.listLiveAgents) return [];
    const live = await observationTimeout(
      this.context.host.listLiveAgents(),
      LIVE_INVENTORY_TIMEOUT,
    );
    return live.map((agent) => ({
      id: agent.id,
      title: agent.title,
      workspaceId: agent.workspaceId,
      kind: ownerCandidateKind(agent.labels),
    }));
  }

  /**
   * Settings → Projects. The saved list is answered from the store alone, so a
   * slow or offline host can never hold it. A named `project` also gets its live
   * planner, agent and responsible-thread state. Each host read is bounded and a
   * failed or late one leaves that state unknown; the saved row still returns.
   */
  async projectSettings(input: { project?: string } = {}) {
    const all = this.context.store.projects();
    const projects = input.project
      ? all.filter((project) => project.key === input.project)
      : all;
    if (input.project && !projects.length)
      throw new Error(`Unknown project ${input.project}`);
    const live = input.project ? await this.liveStatus(projects[0]!) : null;
    return buildProjectSettings({
      projects,
      repositories: this.context.store.repositories(),
      overrides: this.context.store.projectDispatchLimitOverrides(),
      defaultSlots:
        this.context.store.getMeta<number>("projectLimit") ??
        DEFAULT_PROJECT_LIMIT,
      liveAgentIds: live?.liveAgentIds ?? new Set(),
      liveKnown: live?.liveKnown ?? false,
      observedHostId: live?.observedHostId,
      plannerTicketPending: this.context.plannerTicketPending?.() ?? new Set(),
      plannerRoutingIssues: new Map(
        projects.map((project) => [
          project.key,
          projectPlannerRoutingIssue(this.context.store, project),
        ]),
      ),
      agents: Object.fromEntries(
        projects.map((project) => [
          project.key,
          live?.agents.get(project.key) ?? unobservedProjectAgentViews(project),
        ]),
      ),
      responsibleThreads: live?.responsibleThreads ?? {},
      latestQaRuns: this.context.store.latestQaRunsFor(
        projectSettingsQaKeys(projects),
      ),
    });
  }

  /**
   * One project's live state, every read bounded. An unreadable inventory is
   * `liveKnown: false`, which the builder reports as unknown planner liveness.
   */
  private async liveStatus(project: Project) {
    const observedHostId =
      this.context.activeHostId ?? observedHostIdOf(this.context.adapter);
    const liveKnown = Boolean(this.context.adapter.listLiveAgents);
    const [inventory, agents, responsible] = await Promise.all([
      liveKnown
        ? bounded(this.context.host.listLiveAgents()).catch(() => null)
        : Promise.resolve(null),
      bounded(
        projectAgentViews({ host: this.context.host, observedHostId }, project),
      ).catch(() => null),
      this.context.resolution
        ? bounded(this.context.resolution.responsibleThread(project)).catch(
            () => null,
          )
        : Promise.resolve(null),
    ]);
    return {
      observedHostId: observedHostId ?? undefined,
      liveKnown: inventory !== null,
      liveAgentIds: new Set(
        (inventory ?? []).flatMap((agent) =>
          observedHostId
            ? [
                formatAgentId(observedHostId, agent.id),
                ...(hostKindOf(observedHostId) === "paseo" ? [agent.id] : []),
              ]
            : [agent.id],
        ),
      ),
      agents: new Map([[project.key, agents]]),
      responsibleThreads: {
        [project.key]: responsible
          ? {
              thread: responsible.thread,
              cacheAgeMs: Math.max(0, Date.now() - responsible.observedAt),
              shortlist: responsible.shortlist,
            }
          : undefined,
      },
    };
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
