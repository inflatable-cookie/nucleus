import { sameCallerIdentity } from "../../shared/agent-identity";
import type {
  Notice,
  OwnerInventory,
  OwnerInventoryInput,
  ReparentInput,
  ReparentResult,
  Task,
} from "../../shared/contracts";
import {
  episodeBindsCurrentWork,
  isDispositionActive,
  isOperatorOrigin,
  OPERATOR_BOARD_CALLER,
  taskOwner,
  taskPlanner,
} from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { repositoryLabel } from "../../shared/repository-label";
import { recordedStopIsWait } from "../../shared/task-stop";
import type { Resolution } from "../resolution";
import { digest, type Store } from "../store/store";
/** A missing-origin fact can remain visible while a live project thread receives its notices. */
export const missingOriginHasPlanner = (store: Store, task: Task): boolean =>
  task.originError.startsWith("Origin thread is missing") &&
  Boolean(
    store.projectPlannerRecipient(
      store.projectFor(
        task.repoPath,
        normalizeRepositoryOrigin(task.repository ?? ""),
      ),
    ),
  );
/** An open task: neither removed nor finished. Only an open task changes owner. */
const openTask = (task: Task) =>
  !task.removedAt && task.phase !== "done" && task.phase !== "cancelled";

/** The outgoing owner's own completion subscription choice moves to the incoming owner; the incoming owner's own entry wins. */
function movedOverrides(
  overrides: Task["completionSubscriptionOverrides"],
  from: string,
  to: string,
  workspaceId: string,
) {
  const moved = overrides.filter((entry) =>
    sameCallerIdentity(entry.agentId, from),
  );
  if (!moved.length || sameCallerIdentity(from, to)) return overrides;
  const kept = overrides.filter(
    (entry) => !sameCallerIdentity(entry.agentId, from),
  );
  if (kept.some((entry) => sameCallerIdentity(entry.agentId, to)))
    return kept.toSorted((a, b) => a.agentId.localeCompare(b.agentId));
  return [
    ...kept,
    {
      agentId: to,
      workspaceId,
      subscribed: moved.some((entry) => entry.subscribed),
    },
  ].toSorted((a, b) => a.agentId.localeCompare(b.agentId));
}
export class OriginRouting {
  constructor(readonly resolution: Resolution) {}
  get store() {
    return this.resolution.store;
  }
  private unfinished() {
    return this.store.liveTasks();
  }
  private rejectTaskRole(id: string) {
    for (const task of this.unfinished()) {
      const assigned = new Set(
        [
          task.agentId,
          task.coordinatorAgentId,
          task.resolution.reviewerAgentId,
          ...this.store.runs(task.id).map((run) => run.agentId),
        ].filter(Boolean),
      );
      if (
        [...assigned].some((agent) =>
          sameCallerIdentity(agent, id, task.hostId),
        )
      )
        throw Error(
          `${id} is a worker, reviewer or coordinator of task ${task.id}; an owner must be a planning thread`,
        );
    }
  }
  /** The tasks one reparent request names: listed open tasks, or a project's open tasks owned by one thread. */
  private reparentScope(input: ReparentInput): Task[] {
    if ("taskIds" in input) {
      return input.taskIds.map((id) => {
        let task: Task;
        try {
          task = this.store.task(id);
        } catch {
          throw Error(`Unknown task ${id}`);
        }
        if (!openTask(task))
          throw Error(
            `Task ${id} is ${task.removedAt ? "removed" : task.phase}; only an open task changes owner`,
          );
        return task;
      });
    }
    const project = this.store.projectByKey(input.project);
    if (!project) throw Error(`Unknown project ${input.project}`);
    return this.unfinished().filter(
      (task) =>
        sameCallerIdentity(
          taskOwner(task),
          input.fromAgentId,
          task.originHostId,
        ) &&
        this.store.projectFor(
          task.repoPath,
          normalizeRepositoryOrigin(task.repository ?? ""),
        )?.key === project.key,
    );
  }
  /** The operator, current owner, the task's planner, or a registered planner may hand a missing origin to its successor. */
  private assertReparentAuthority(task: Task, caller: string) {
    const project = this.store.projectFor(
      task.repoPath,
      normalizeRepositoryOrigin(task.repository ?? ""),
    );
    const planners = new Set(
      [
        project?.planner?.agentId,
        this.store.queueProject()?.planner?.agentId,
        taskPlanner(task),
      ].filter((id): id is string => Boolean(id && !isOperatorOrigin(id))),
    );
    // The task's own planner shares the owner's proven host; other recorded planners prove none here.
    const plannerHost = (id: string) =>
      sameCallerIdentity(id, taskOwner(task)) ? task.originHostId : undefined;
    if (
      caller === OPERATOR_BOARD_CALLER ||
      sameCallerIdentity(taskOwner(task), caller, task.originHostId) ||
      [...planners].some((id) =>
        sameCallerIdentity(id, caller, plannerHost(id)),
      )
    )
      return;
    throw Error(
      `Changing the owner of task ${task.id} needs the operator at the board or its current owner ${taskOwner(task)} or its planner; ${caller} is neither`,
    );
  }
  /**
   * Spec 040 (Tom, 2026-10-26): one owner field, so a reparent is one write per
   * task. Every owner reader resolves through `taskOwner`: owner-placed holds,
   * attention, prerequisite and completion origin notices follow on their own, and
   * the outgoing owner's own completion subscription choice moves with the task.
   * The only proof is that the new owner is a live planning thread; the old owner
   * may be archived or gone. Reparenting to the current owner changes nothing.
   */
  async reparent(input: ReparentInput): Promise<ReparentResult> {
    const caller = input.caller.trim(),
      reason = input.reason.trim(),
      to = input.toAgentId.trim();
    if (isOperatorOrigin(to))
      throw Error(
        "The operator is not a thread; a task owner must be a live planning thread",
      );
    const scope = this.reparentScope(input);
    for (const task of scope) this.assertReparentAuthority(task, caller);
    const hostId = await this.resolution.identifyOriginHost(to);
    if (!hostId) throw Error("New owner host is unknown or ambiguous");
    const agent = await this.resolution.withHost(hostId, () =>
      this.resolution.host.originAgent(to),
    );
    if (!agent || agent.archived || !agent.workspaceId)
      throw Error(
        `New owner ${to} must be a live, unarchived host thread with a workspace`,
      );
    this.rejectTaskRole(to);
    const workspaceId = agent.workspaceId;
    return this.store.transaction(() => {
      const changed: ReparentResult["changed"] = [],
        unchanged: string[] = [];
      for (const original of scope) {
        const task = this.store.task(original.id);
        if (!openTask(task))
          throw new Error(
            `Task ${task.id} finished during the owner change; nothing was written`,
          );
        this.assertReparentAuthority(task, caller);
        const from = taskOwner(task);
        const updated = this.writeOwner(
          task,
          to,
          workspaceId,
          caller,
          reason,
          hostId,
        );
        if (!updated) {
          unchanged.push(task.id);
          continue;
        }
        changed.push({ taskId: updated.id, version: updated.version, from });
      }
      return { toAgentId: to, workspaceId, changed, unchanged };
    });
  }
  /**
   * nucleus#1447: the unfinished responsibilities one thread still owns, read
   * across every project. It reads the same owner facts `reparent` writes - the
   * same verified caller, the same host-proven thread identity and the same open
   * tasks - and writes nothing, so independent holds stay put and no handover
   * notice is sent. A project-scoped handover remains an explicit reparent; this
   * only says which of the thread's work that reparent would move and what it
   * would leave behind.
   */
  async ownerInventory(input: OwnerInventoryInput): Promise<OwnerInventory> {
    const caller = input.caller.trim(),
      agentId = input.agentId.trim();
    if (isOperatorOrigin(agentId))
      throw Error(
        "The operator is not a thread; it owns no tasks to inventory",
      );
    const hostId = await this.resolution.identifyOriginHost(agentId);
    if (!hostId)
      throw Error(
        `Owner thread ${agentId} is unknown or ambiguous: no registered host proves that identity, so its tasks cannot be inventoried`,
      );
    if (
      caller !== OPERATOR_BOARD_CALLER &&
      !sameCallerIdentity(agentId, caller, hostId)
    )
      throw Error(
        `Inventorying the tasks of ${agentId} needs that thread's own verified identity or the operator at the board; ${caller} is neither`,
      );
    const project =
      input.project === undefined
        ? null
        : this.store.projectByKey(input.project);
    if (input.project !== undefined && !project)
      throw Error(`Unknown project ${input.project}`);
    type Entry = OwnerInventory["outside"][number];
    const entry = (task: Task) => ({
      taskId: task.id,
      number: task.number,
      reference: task.reference,
      title: task.title,
      phase: task.phase,
    });
    const groups = new Map<string, Entry>();
    for (const task of this.unfinished()) {
      if (
        !sameCallerIdentity(taskOwner(task), agentId, task.originHostId, hostId)
      )
        continue;
      // Removed and finished tasks never reach here: `unfinished` is the live set.
      const owned = this.store.projectFor(
        task.repoPath,
        normalizeRepositoryOrigin(task.repository ?? ""),
      );
      const label = repositoryLabel(task);
      const key = owned ? `project:${owned.key}` : `repository:${label}`;
      const group = groups.get(key) ?? {
        project: owned?.key ?? null,
        name: owned?.name ?? label,
        tasks: [],
      };
      group.tasks.push(entry(task));
      groups.set(key, group);
    }
    const ordered = [...groups.values()].sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        (left.project ?? "").localeCompare(right.project ?? ""),
    );
    for (const group of ordered)
      group.tasks.sort(
        (left, right) =>
          (left.number ?? Number.MAX_SAFE_INTEGER) -
            (right.number ?? Number.MAX_SAFE_INTEGER) ||
          left.taskId.localeCompare(right.taskId),
      );
    const selectedKey = project ? `project:${project.key}` : null;
    const selected = selectedKey
      ? (groups.get(selectedKey) ?? {
          project: project!.key,
          name: project!.name,
          tasks: [],
        })
      : null;
    const outside = ordered.filter((group) => group !== selected);
    return {
      agentId,
      hostId,
      selected,
      outside,
      remaining: selected
        ? {
            tasks: outside.reduce(
              (total, group) => total + group.tasks.length,
              0,
            ),
            groups: outside.map((group) => group.name),
          }
        : null,
    };
  }
  /** The one owner write: owner field, its workspace, cleared routing errors, the planner and the outgoing owner's subscription choice. Null when already the owner. */
  private writeOwner(
    task: Task,
    to: string,
    workspaceId: string,
    caller: string,
    reason: string,
    hostId: string,
  ): Task | null {
    const from = taskOwner(task);
    // Task 1109: the task planner is by default its owner, so reparenting moves it as
    // it always moved ownership. A planner a brief named explicitly moves to the new
    // owner too: the reparent is the deliberate act that says who promotes the task.
    const movedPlanner = task.plannerAgentId ? { plannerAgentId: null } : {};
    if (
      sameCallerIdentity(from, to) &&
      sameCallerIdentity(
        task.notificationAgentId,
        to,
        task.originHostId,
        hostId,
      ) &&
      task.originHostId === hostId &&
      task.originWorkspaceId === workspaceId &&
      !task.originError &&
      !task.originLookupError &&
      !task.plannerAgentId
    )
      return null;
    const overrides = movedOverrides(
      task.completionSubscriptionOverrides,
      from,
      to,
      workspaceId,
    );
    return this.store.update(
      task.id,
      {
        notificationAgentId: to,
        originHostId: hostId,
        originWorkspaceId: workspaceId,
        originError: "",
        originLookupError: "",
        // nucleus#1313: a planner change re-nests the presentation — an explicit detach
        // only ever recorded "no planner thread for presentation", so naming a planner
        // clears it and each host follows the new planner's own host.
        ...(task.presentationDetached ? { presentationDetached: null } : {}),
        ...(task.presentationParent ? { presentationParent: null } : {}),
        ...(overrides !== task.completionSubscriptionOverrides
          ? { completionSubscriptionOverrides: overrides }
          : {}),
        ...movedPlanner,
      },
      "owner_changed",
      `${from} → ${to} by ${caller}${task.plannerAgentId ? ` (planner ${task.plannerAgentId} → ${to})` : ""}: ${reason}`.slice(
        0,
        2000,
      ),
    );
  }
  async pass() {
    if (this.resolution.paused()) return;
    type Origin = Awaited<
      ReturnType<NonNullable<typeof this.resolution.adapter.originAgent>>
    >;
    const info = new Map<string, Origin | Error>();
    const observe = async (target: string, hostId: string): Promise<Origin> => {
      const key = JSON.stringify([hostId, target]);
      if (!info.has(key)) {
        try {
          info.set(key, await this.resolution.host.originAgent(target));
        } catch (error) {
          info.set(
            key,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      const result = info.get(key)!;
      if (result instanceof Error) throw result;
      return result;
    };
    const workspaces = this.store.originWorkspaces();
    const route = async (original: Task) => {
      const hostId = original.originHostId;
      if (!hostId) return;
      return this.resolution.withHost(hostId, async () => {
        if (!this.resolution.originHostAvailable(hostId)) return;
        if (!this.resolution.adapter.originAgent) return;
        if (isDispositionActive(original)) return;
        // A finished task that owes its origin nothing has no origin to route. A
        // missing-origin error recorded earlier is no longer true, and left set it
        // would hold archive and retention for good (Consumer-b #680).
        const owesNothing =
          original.phase === "cancelled" ||
          (original.phase === "done" &&
            (!original.completionNotificationCohort?.some(
              (member) => member.originEntry,
            ) ||
              this.store
                .notices(original.id)
                .some(
                  (n) =>
                    n.kind === "completion" &&
                    n.originEntry &&
                    n.status === "delivered",
                )));
        if (owesNothing) {
          if (original.originError || original.originLookupError)
            this.store.update(
              original.id,
              { originError: "", originLookupError: "" },
              "origin_not_owed",
              "Finished task owes its origin no notice; missing-origin state cleared",
            );
          return;
        }
        // The operator is not a thread: there is no origin to look up and no workspace to inherit.
        if (isOperatorOrigin(taskOwner(original))) {
          if (original.originError || original.originLookupError)
            this.store.update(
              original.id,
              { originError: "", originLookupError: "" },
              "origin_not_a_thread",
              "The operator is not a thread; no origin to route",
            );
          return;
        }
        try {
          let t = this.store.task(original.id);
          const target = taskOwner(t);
          const agent = await observe(target, hostId);
          if (this.resolution.paused()) return;
          if (!t.originWorkspaceId) {
            const workspace =
              agent?.workspaceId ??
              (this.resolution.canReuseUnqualifiedOriginWorkspace()
                ? workspaces.get(target)
                : undefined);
            if (workspace) {
              t = this.store.update(t.id, { originWorkspaceId: workspace });
              if (!workspaces.has(target)) workspaces.set(target, workspace);
            }
          }
          if (agent && !agent.archived) {
            if (
              t.originWorkspaceId &&
              agent.workspaceId !== t.originWorkspaceId
            )
              throw Error(
                "Origin thread moved out of its recorded workspace; no automatic reassignment",
              );
            if (t.originError || t.originLookupError)
              this.store.update(t.id, {
                originError: "",
                originLookupError: "",
              });
            return;
          }
          // A missing origin remains visible. A live project thread can receive its notices.
          const reason = t.originWorkspaceId
            ? `Origin thread is missing; reparent the task to its successor in workspace ${t.originWorkspaceId}`
            : "Origin thread is missing and its workspace was not recorded; reparent the task to its successor";
          const planner = this.store.projectPlannerRecipient(
            this.store.projectFor(
              t.repoPath,
              normalizeRepositoryOrigin(t.repository ?? ""),
            ),
          );
          const routedStop = Boolean(
            planner && t.resolution.stop?.detail === reason,
          );
          if (t.originError !== reason || t.originLookupError || routedStop)
            this.store.update(
              t.id,
              {
                originError: reason,
                originLookupError: "",
                ...(routedStop
                  ? { resolution: { ...t.resolution, stop: null } }
                  : {}),
              },
              "origin_missing",
              reason,
            );
        } catch (error) {
          if (this.resolution.paused()) return;
          const reason = String(error instanceof Error ? error.message : error);
          if (this.store.task(original.id).originLookupError !== reason)
            this.store.update(
              original.id,
              { originLookupError: reason },
              "origin_lookup_failed",
              reason,
            );
        }
      });
    };
    for (const task of this.store.originRoutingTasks(true)) {
      if (this.resolution.paused()) return;
      await route(task);
    }
    for (const group of this.store.queuedOriginGroups()) {
      if (this.resolution.paused()) return;
      const hosts = new Map<string, string[]>();
      for (const id of group.ids) {
        const host = this.store.task(id).originHostId;
        if (host) hosts.set(host, [...(hosts.get(host) ?? []), id]);
      }
      for (const [host, ids] of hosts) {
        let unchanged = false;
        await this.resolution.withHost(host, async () => {
          if (!this.resolution.originHostAvailable(host)) return;
          if (!this.resolution.adapter.originAgent) return;
          try {
            const agent = await observe(group.owner, host);
            unchanged = Boolean(
              agent &&
                !agent.archived &&
                group.workspaceId &&
                agent.workspaceId === group.workspaceId,
            );
          } catch {}
        });
        if (unchanged) continue;
        for (const id of ids) {
          if (this.resolution.paused()) return;
          await route(this.store.task(id));
        }
      }
    }
  }
}

// Attention notices deduplicate per episode: an open incident keys its own notice
// (reconciling and escalated are separate), and repeated observations never append
// another. Without one, the episode is the stop whose owner is needed, never the
// wait text alone: a notice a transient wait superseded must not hide the block
// that followed it. A recovery episode that still owns the task keys nothing new,
// because its coordinator, not the owner, is acting on the stop.
const noticeId = (t: Task) => {
  const stop = t.resolution.stop,
    incident = t.resolution.incident;
  const ownerAction =
    Boolean(stop && stop.reason !== "held" && !recordedStopIsWait(stop)) &&
    !episodeBindsCurrentWork(t);
  const episode =
    incident && incident.status !== "resolved"
      ? `${incident.id}:${incident.status === "escalated" ? "escalated" : "reconciling"}`
      : ownerAction
        ? `stop:${stop!.reason}:${stop!.since}`
        : `waiting:${t.phase}:${t.reason}`;
  return digest(`${t.id}:${episode}`);
};
/** Why an origin notice waits when its task has no thread to receive it. */
export const NO_ORIGIN_THREAD_WAIT =
  "No origin thread: waiting for a planner; the operator reads this on the board";
/** Missing and operator origins use the project's live responsible thread. */
export function originUsesProject(task: Task): boolean {
  return (
    task.originError.startsWith("Origin thread is missing") ||
    (isOperatorOrigin(taskOwner(task)) && isOperatorOrigin(task.originAgentId))
  );
}
export function originRecipient(store: Store, task: Task): string | null {
  if (originUsesProject(task))
    return store.projectPlannerRecipient(
      store.projectFor(
        task.repoPath,
        normalizeRepositoryOrigin(task.repository ?? ""),
      ),
    );
  const owner = taskOwner(task);
  return isOperatorOrigin(owner) ? task.originAgentId : owner;
}
const noticeTarget = (
  store: Store,
  task: Task,
  notice: Notice,
): string | null =>
  notice.originEntry
    ? originRecipient(store, task)
    : notice.recipientAgentId || notice.agentId;

export { noticeId, noticeTarget };
