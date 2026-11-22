import { stopClearedPatch } from "../../shared/task-stop";
import { randomUUID } from "node:crypto";
import type { Task } from "../../shared/contracts";
import { DISPATCH_WAIT_REASON } from "../../shared/task-stop";
import { noticeTaskLine, taskOwner } from "../../shared/contracts";
import { now } from "./store-core";
import type { ReviewEntryFacts } from "./review-entry-eligibility";

/** Only an unconsumed instruction owned by this phase can carry an author wake. */
export function retainedPrerequisiteRevision(task: Task): boolean {
  if (task.phase !== "changes_requested" || !task.prerequisiteWait?.releasedAt)
    return false;
  const state = task.resolution;
  if (state.revisionInstruction?.runId === null) return true;
  return Boolean(
    state.prePrResumeInstruction &&
      task.agentId &&
      task.runId &&
      task.workspaceId &&
      task.profile &&
      !task.prUrl &&
      !task.prHead &&
      !task.resumePrNumber &&
      !task.completion?.prNumber &&
      !task.reviewEntry,
  );
}

/** An open wait parks new work. A released author wait still needs authority. */
export function prerequisiteWaitBlocksPhase(task: Task): boolean {
  return Boolean(
    task.prerequisiteWait &&
      (!task.prerequisiteWait.releasedAt ||
        (task.phase === "changes_requested" &&
          !retainedPrerequisiteRevision(task))),
  );
}

/** The store services the prerequisite bounds call; none of them starts another write funnel. */
export interface PrerequisiteServices extends ReviewEntryFacts {
  transaction<T>(fn: () => T): T;
  task(id: string): Task;
  taskReference(
    id: string,
  ): { title: string; phase: string; removedAt?: string | null } & Record<
    string,
    unknown
  >;
  /** A prerequisite named by UUID or task reference, refused by name when unknown. */
  dependencyTaskId(identity: string): string;
  update(
    id: string,
    change: Partial<Task>,
    kind?: string,
    detail?: string,
    expected?: number,
  ): Task;
  dependencyWait(task: Pick<Task, "dependsOn">): string;
  putNotice(notice: import("../../shared/contracts").Notice): void;
  notices(taskId?: string): import("../../shared/contracts").Notice[];
  /** The never-dispatched review-entry fact, from `review-entry-eligibility.ts`. */
  reviewEntryBeforeFirstRun(task: Task): boolean;
}

/**
 * The dependency boundary and the prerequisite wait: the two controls that change what a
 * task waits on. One owner for their admission rules, so the cycle check, the removed
 * prerequisite refusal and the review-entry exemption cannot drift between them.
 */
export class StorePrerequisites {
  constructor(private readonly services: PrerequisiteServices) {}
  updateDependencies(
    task: Task,
    dependsOn: string[],
    actor = "operator control",
  ): Task {
    const beforeDispatch =
      task.phase === "queued" &&
      !task.workspaceIntent &&
      !task.agentIntent &&
      !task.workspaceId &&
      !task.agentId &&
      !task.completion &&
      !task.resolution.currentRunId;
    if (!beforeDispatch && !this.services.reviewEntryBeforeFirstRun(task))
      throw new Error("Dependencies can only change before dispatch begins");
    // The stored list names each prerequisite by UUID, whichever accepted form the caller used.
    const resolved: string[] = [];
    for (const named of dependsOn) {
      const id = this.services.dependencyTaskId(named);
      if (id === task.id) throw new Error("A task cannot depend on itself");
      let dependency: ReturnType<PrerequisiteServices["taskReference"]>;
      try {
        dependency = this.services.taskReference(id);
      } catch {
        throw new Error(
          `Prerequisite task does not exist: ${named}. Submit prerequisites first.`,
        );
      }
      if (dependency.removedAt && dependency.phase !== "done")
        throw new Error(
          `Prerequisite was removed before completion: ${dependency.title} (${named})`,
        );
      resolved.push(id);
      const pending = [id],
        visited = new Set<string>();
      while (pending.length) {
        const candidate = pending.pop()!;
        if (candidate === task.id)
          throw new Error(
            `Dependency change would create a cycle through ${id}`,
          );
        if (visited.has(candidate)) continue;
        visited.add(candidate);
        try {
          pending.push(...this.services.task(candidate).dependsOn);
        } catch {
          /* Purged completed history cannot point back to this live task. */
        }
      }
    }
    const normalized = resolved.sort();
    if (JSON.stringify(normalized) === JSON.stringify(task.dependsOn))
      return task;
    const reason =
      this.services.dependencyWait({ dependsOn: normalized }) ||
      DISPATCH_WAIT_REASON;
    return this.services.update(
      task.id,
      {
        dependsOn: normalized,
        reason,
        ...stopClearedPatch(this.services.task(task.id), reason),
      },
      "dependencies_changed",
      `${task.dependsOn.join(", ") || "none"} → ${normalized.join(", ") || "none"}; requested by ${actor}`,
      task.version,
    );
  }
  setPrerequisiteWait(
    task: Task,
    waitsFor: string[],
    reason: string,
    expectedVersion = task.version,
  ): Task {
    if (task.version !== expectedVersion)
      throw new Error(
        "Task changed; refresh before setting a prerequisite wait",
      );
    if (
      [
        "queued",
        "dispatching",
        "merging",
        "syncing",
        "closing",
        "done",
        "cancelled",
      ].includes(task.phase)
    )
      throw new Error(
        "Prerequisite waits require a dispatched, unmerged task before merge intent",
      );
    if (task.resolution.mergeIntent || task.resolution.mergedCommit)
      throw new Error(
        "Prerequisite waits cannot be changed after merge intent or merge",
      );
    const dispatched = Boolean(
      task.agentId ||
        task.runId ||
        task.completion ||
        task.prUrl ||
        task.prHead ||
        task.resumePrNumber ||
        task.resolution.currentRunId,
    );
    if (!dispatched)
      throw new Error("Prerequisite waits require a dispatched task");
    const normalized = [...waitsFor].sort();
    for (const id of normalized) {
      if (id === task.id) throw new Error("A task cannot wait for itself");
      let prerequisite: ReturnType<PrerequisiteServices["taskReference"]>;
      try {
        prerequisite = this.services.taskReference(id);
      } catch {
        throw new Error(`Prerequisite task does not exist: ${id}`);
      }
      if (prerequisite.removedAt && prerequisite.phase !== "done")
        throw new Error(
          `Prerequisite was removed before completion: ${prerequisite.title} (${id})`,
        );
    }
    if (!normalized.length) {
      if (!task.prerequisiteWait) return task;
      return this.services.update(
        task.id,
        { prerequisiteWait: null },
        "prerequisite_wait_cleared",
        `${task.prerequisiteWait.waitsFor.join(", ")}; requested by ${reason}`,
        expectedVersion,
      );
    }
    if (
      !task.prerequisiteWait?.releasedAt &&
      task.prerequisiteWait?.reason === reason &&
      JSON.stringify(task.prerequisiteWait.waitsFor) ===
        JSON.stringify(normalized)
    )
      return task;
    const wait = {
      id: randomUUID(),
      waitsFor: normalized,
      reason: reason.trim(),
      releasedAt: null,
    };
    return this.services.update(
      task.id,
      { prerequisiteWait: wait },
      "prerequisite_wait_set",
      `${normalized.join(", ")}; ${reason.trim()}`,
      expectedVersion,
    );
  }
  /** Release one retained prerequisite wait and create its owner notice atomically. */
  reconcilePrerequisiteWait(taskId: string): "none" | "waiting" | "released" {
    return this.services.transaction(() => {
      const task = this.services.task(taskId),
        wait = task.prerequisiteWait;
      if (!wait || wait.releasedAt) return "none";
      if (this.services.dependencyWait({ dependsOn: wait.waitsFor }))
        return "waiting";
      const id = `prerequisite-wait:${wait.id}`;
      if (!this.services.notices(task.id).some((notice) => notice.id === id)) {
        const owner = taskOwner(task);
        this.services.putNotice({
          id,
          taskId: task.id,
          agentId: owner,
          recipientAgentId: owner,
          workspaceId: task.originWorkspaceId,
          sources: [],
          originEntry: true,
          kind: "prerequisite",
          status: "pending",
          error: "",
          text: `Nucleus prerequisite wait cleared\n${noticeTaskLine(task)}\nReason: ${wait.reason}\nPrerequisites complete: ${wait.waitsFor.join(", ")}\nThe task is back in normal handling. A revision needs its own authorization.`,
        });
      }
      // The release is the producer's clear: its prerequisite stop goes with it.
      const stop =
        task.resolution.stop?.reason === "prerequisite"
          ? { resolution: { ...task.resolution, stop: null } }
          : {};
      // The retained row stays in the operational index across a restart.
      // The next phase (or its owner) consumes its continuation separately.
      this.services.update(
        task.id,
        { prerequisiteWait: { ...wait, releasedAt: now() }, ...stop },
        "prerequisite_wait_released",
        JSON.stringify({
          waitId: wait.id,
          waitsFor: wait.waitsFor,
          reason: wait.reason,
        }),
        task.version,
      );
      return "released";
    });
  }
}
