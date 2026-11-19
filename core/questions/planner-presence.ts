import { type Project, type Task } from "../../shared/contracts";
import type { Store } from "../store/store";
import { hostKindOf } from "../../shared/host-kind";
import { callerNativeId } from "../../shared/agent-identity";
import type { Resolution } from "../resolution";

export type PlannerPresenceContext = Pick<
  Resolution,
  | "adapter"
  | "host"
  | "identifyOriginHost"
  | "originHostAvailable"
  | "plannerThreadGone"
  | "projectPlannerFor"
  | "taskPlannerFor"
  | "store"
  | "withHost"
>;

export type PlannerThreadRoute =
  | { kind: "routable" | "gone" }
  | { kind: "unroutable"; detail: string };

export function unroutablePlannerDetail(
  agentId: string,
  cause: string,
): string {
  return `Planner unroutable: ${agentId} (${cause}). Re-run project.set-planner.`;
}

/** The latest routing observation belongs to the current assignment only. */
export function projectPlannerRoutingIssue(
  store: Pick<Store, "eventsAll">,
  project: Project,
): string | undefined {
  const latest = store
    .eventsAll(`project:${project.key}`)
    .findLast((event) =>
      [
        "project_planner_unroutable",
        "project_planner_routable",
        "project_planner_set",
        "project_planner_cleared",
      ].includes(event.kind),
    );
  return project.planner && latest?.kind === "project_planner_unroutable"
    ? latest.detail
    : undefined;
}

export class PlannerPresence {
  constructor(readonly context: PlannerPresenceContext) {}
  async plannerThreadGone(agentId: string): Promise<boolean> {
    return (await this.threadRoute(agentId)).kind === "gone";
  }

  async threadRoute(
    agentId: string,
    recordedHostId?: string | null,
  ): Promise<PlannerThreadRoute> {
    const unroutable = (cause: string): PlannerThreadRoute => ({
      kind: "unroutable",
      detail: unroutablePlannerDetail(agentId, cause),
    });
    try {
      const hostId =
        recordedHostId ?? (await this.context.identifyOriginHost(agentId));
      if (
        !hostId ||
        !this.context.withHost(hostId, () =>
          this.context.originHostAvailable(hostId),
        )
      )
        return unroutable(
          "waiting for the planner's proven host to be available",
        );
      const expected = callerNativeId(agentId, hostId);
      if (
        !this.context.withHost(hostId, () => this.context.adapter.originAgent)
      ) {
        const observed = await this.context.withHost(hostId, () =>
          this.context.host.observe(agentId),
        );
        if (observed.id !== expected)
          return unroutable("the host returned a different thread");
        return {
          kind:
            observed.archived || observed.status === "gone" || observed.status === "closed"
              ? "gone"
              : "routable",
        };
      }
      const registered = await this.context.withHost(hostId, () =>
        this.context.host.originAgent(agentId),
      );
      // On T3 the recorded ID can name a thread or an unrelated session. Only a
      // tombstone proves that an identity previously had a thread.
      if (!registered)
        return hostKindOf(hostId) === "t3code"
          ? unroutable("no matching thread on its T3 host")
          : { kind: "gone" };
      if (registered.id !== expected)
        return unroutable("the host returned a different thread");
      return {
        kind: registered.archived || registered.deleted ? "gone" : "routable",
      };
    } catch {
      return unroutable("the host could not verify the thread");
    }
  }

  async observeProjectPlanner(
    project: Project | null,
  ): Promise<{ agentId: string; state: PlannerThreadRoute } | null> {
    const planner = project?.planner;
    if (!project || !planner) return null;
    const { store } = this.context;
    const state = await this.threadRoute(planner.agentId);
    const latest = store.projectByKey(project.key)?.planner;
    if (latest?.agentId !== planner.agentId || latest.setAt !== planner.setAt)
      return null;
    const previousIssue = projectPlannerRoutingIssue(store, project);
    if (state.kind === "unroutable" && previousIssue !== state.detail)
      store.event(
        `project:${project.key}`,
        "project_planner_unroutable",
        state.detail,
      );
    if (state.kind === "routable" && previousIssue)
      store.event(
        `project:${project.key}`,
        "project_planner_routable",
        planner.agentId,
      );
    return { agentId: planner.agentId, state };
  }

  async escalationRecipient(task: Task): Promise<string | null> {
    // Task 1109: the task's own planner hears first; the project planner is the
    // fallback rung, and with neither there is no thread to wait on.
    const own = await this.context.taskPlannerFor(task);
    if (own) return own.agentId;
    const { planner } = await this.context.projectPlannerFor(task);
    return planner;
  }

  notifyStaleQuestionAnswer(
    taskId: string,
    questionId: string,
    who: string,
  ): void {
    const agentId = who.match(
      /^(?:delegated )?(?:planner|decider)\s+(\S+)$/,
    )?.[1];
    if (!agentId) return;
    void (async () => {
      const task = this.context.store.task(taskId);
      const host =
        agentId === task.originAgentId || agentId === task.notificationAgentId
          ? task.originHostId
          : await this.context.identifyOriginHost(agentId);
      if (!host) return;
      await this.context.withHost(host, async () => {
        if (
          !this.context.originHostAvailable(host) ||
          !this.context.adapter.notify
        )
          return;
        await this.context.host.sendMessage(agentId, {
          messageId: `ns-stale-answer-${questionId}`,
          text: `Your answer to Nucleus question ${questionId} arrived after an owner control superseded it. Nucleus recorded it as stale; it has no effect.`,
        });
      });
    })().catch(() => {
      /* the stale answer remains durably recorded */
    });
  }
}
