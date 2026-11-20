import type { Resolution, ResolutionAdapter } from "../../resolution";
import type { Run } from "../../../shared/contracts";
import type { Task } from "../../../shared/contracts";
import type { Engine } from "../../engine";
import {
  worktreeLinksForBinding,
  worktreeLinksForClearedIntent,
} from "../../workspaces/worktree-links";
import {
  retainNodeModules,
  workspaceCreationRefusal,
} from "../../workspaces/workspace-allocation";
import { startsNoRuns } from "../../closeout/queue-drain";
import { ABSENT_WORKER_REASON } from "../task-reasons";
import { workspaceReplayAllowed } from "./decisions";
import { creationLookup } from "./restarts";
import { staleWorkerIntent } from "./stale-worker";

export type CreationRecoveryContext = Pick<
  Engine,
  | "adapter"
  | "idleGraceMs"
  | "launchAgent"
  | "launchProofOnly"
  | "note"
  | "reconcileAbsentWorker"
  | "recoverProofOnlyDispatch"
  | "stopped"
  | "store"
> & {
  readonly resolution: Pick<
    Resolution,
    "ensureIncident" | "resolveIncident" | "returnToDispatch" | "saveIncident"
  >;
};

/**
 * The engine-side half of absence: recover an unowned workspace creation or an
 * agent-creation intent, replay one proven-empty workspace, and reconcile an
 * absent worker with one replacement. The resolution-side half — the run and
 * worker restarts and the creation replacement — is `AbsentRestarts` in
 * `restarts.ts`; both read the same decisions (`decisions.ts`).
 */
export class CreationRecovery {
  constructor(readonly engine: CreationRecoveryContext) {}
  get store() {
    return this.engine.store;
  }
  get adapter() {
    return this.engine.adapter;
  }
  get resolution() {
    return this.engine.resolution;
  }
  async recover(task: Task) {
    if (task.entrypoint === "proof" && task.proofOnly) {
      await this.engine.recoverProofOnlyDispatch(task);
      return;
    }
    if (!task.workspaceId) {
      await this.adapter.preflightWorkspaceStorage?.(task);
      const found = await this.adapter.findWorkspaces(task);
      if (found.length > 1) {
        this.engine.note(
          task.id,
          "Ambiguous workspace identity; no new resource created",
          "workspace_unavailable",
          "needs_attention",
        );
        return;
      }
      if (found.length === 1) {
        this.store.update(
          task.id,
          {
            workspaceId: found[0]!.id,
            directory: found[0]!.directory,
            phase: "dispatching",
            ...worktreeLinksForBinding(this.store.task(task.id), {
              workspaceId: found[0]!.id,
              directory: found[0]!.directory,
            }),
          },
          "workspace_recovered",
          found[0]!.id,
        );
        if (!startsNoRuns(this.store, this.engine.stopped))
          await this.engine.launchAgent(this.store.task(task.id));
        return;
      }
      const classified = await this.adapter.inspectWorkspaceCreation!(task);
      if (classified.kind === "found_done") {
        // Binding a workspace findWorkspaces already returned is settlement.
        // createWorkspace is a start, even when the classifier says found_done.
        if (startsNoRuns(this.store, this.engine.stopped)) return;
        const workspace = await this.adapter.createWorkspace(task);
        this.store.update(
          task.id,
          {
            workspaceId: workspace.id,
            directory: workspace.directory,
            phase: "dispatching",
            ...worktreeLinksForBinding(this.store.task(task.id), {
              workspaceId: workspace.id,
              directory: workspace.directory,
            }),
          },
          "workspace_recovered",
          workspace.id,
        );
        if (!startsNoRuns(this.store, this.engine.stopped))
          await this.engine.launchAgent(this.store.task(task.id));
        return;
      }
      // A single replay is safe only after the complete classifier proves no
      // published or changed work and no worker or recovery owns the intent.
      if (
        workspaceReplayAllowed(
          task,
          classified.kind,
          classified.kind === "partial"
            ? Boolean(this.adapter.removeOrphanWorkspace)
            : false,
          false,
          false,
          workspaceCreationRefusal(classified),
        ) &&
        !this.store.runs(task.id).length &&
        !this.store
          .eventsAll(task.id)
          .some((event) => event.kind === "workspace_creation_auto_replay")
      ) {
        const current = this.store.task(task.id);
        if (
          current.version !== task.version ||
          startsNoRuns(this.store, this.engine.stopped)
        )
          return;
        // Record before removing anything: a crash or uncertain removal cannot
        // authorize another automatic attempt.
        this.store.event(
          task.id,
          "workspace_creation_auto_replay",
          classified.kind,
        );
        if (classified.kind === "partial") {
          await this.adapter.removeOrphanWorkspace!(task, classified.orphan);
          this.store.event(
            task.id,
            "orphan_workspace_removed",
            JSON.stringify(classified.orphan),
          );
        }
        const latest = this.store.task(task.id);
        if (
          latest.version !== current.version ||
          startsNoRuns(this.store, this.engine.stopped)
        )
          return;
        const cleared = worktreeLinksForClearedIntent(latest);
        if (cleared.worktreeLinks) this.store.update(latest.id, cleared);
        this.resolution.returnToDispatch(
          this.store.task(task.id),
          false,
          "Workspace creation proved empty; replaying once",
          "workspace_creation_replayed",
        );
        return;
      }
      this.engine.note(
        task.id,
        workspaceCreationRefusal(classified),
        "operator_needed",
        "needs_attention",
      );
      return;
    } else if (task.agentIntent && !task.agentId) {
      // An armed route is observed by the failover pass.
      if (
        task.failoverReason &&
        staleWorkerIntent(task) &&
        task.resolution.stop?.reason === "lifecycle"
      )
        return;
      // Worker intents live on the task, but the host lookup must still carry
      // the exact run label. A task-only inventory can contain older threads.
      const lookup = this.adapter as typeof this.adapter &
        Partial<Pick<ResolutionAdapter, "findRunAgents">>;
      if (!task.runId || !lookup.findRunAgents) {
        this.engine.note(
          task.id,
          "Exact worker creation lookup is unavailable; the intent remains owned",
          "operator_needed",
          "needs_attention",
        );
        return;
      }
      const identity = {
        id: task.runId,
        taskId: task.id,
        hostId: task.hostId,
        role: "worker",
        workspaceId: task.workspaceId,
      } as unknown as Run;
      const found = await lookup.findRunAgents(identity);
      const decision = creationLookup(found, task.workspaceId);
      if (decision.kind === "bound") {
        const latest = this.store.task(task.id);
        // Another reconciliation may have bound or replaced this intent while
        // lookup was in flight. Its newer state owns the task; do not park it.
        if (
          latest.version !== task.version ||
          !latest.agentIntent ||
          latest.agentId ||
          latest.runId !== task.runId ||
          latest.workspaceId !== task.workspaceId
        )
          return;
        this.resolution.resolveIncident(
          latest,
          task.runId,
          "Exact lookup bound the created worker",
        );
        this.store.update(
          task.id,
          {
            agentId: decision.agentId,
            phase: "working",
            reason: "Recovered worker identity",
          },
          "agent_recovered",
          decision.agentId,
        );
        return;
      }
      const latest = this.store.task(task.id);
      if (
        latest.version !== task.version ||
        !latest.agentIntent ||
        latest.agentId ||
        latest.runId !== task.runId ||
        latest.workspaceId !== task.workspaceId
      )
        return;
      // A match in a different workspace is unknown placement, not absence.
      if (decision.kind === "unknown" && found.length === 1) {
        const partial = found[0] as { hostConfirmed?: boolean };
        const reason =
          partial.hostConfirmed === false
            ? "Worker creation lookup has a local record without host confirmation; the intent remains owned"
            : "Worker creation lookup found an agent outside the retained workspace; no resource was created";
        this.engine.note(
          latest.id,
          reason,
          "operator_needed",
          "needs_attention",
        );
        return;
      }
      await this.engine.reconcileAbsentWorker(latest, found.length);
    }
  }
  /** Reconcile a proof-only provisioning intent and resume only its proof route. */
  async recoverProofOnlyDispatch(task: Task): Promise<void> {
    let workspace =
      task.workspaceId && task.directory
        ? { id: task.workspaceId, directory: task.directory }
        : null;
    if (workspace && task.proofOnly && this.adapter.populateTaskWorktree) {
      const checkout = await this.adapter.populateTaskWorktree(task);
      if (checkout.directory !== workspace.directory)
        throw new Error(
          `The recorded proof-only workspace is ${workspace.directory}, but its checkout is ${checkout.directory}`,
        );
    }
    if (!workspace) {
      // Reconcile the detached checkout before binding a workspace discovered by
      // catalog lookup. Otherwise a reused registration can bypass the proof
      // head check and admit the executor from whatever commit it currently has.
      if (task.proofOnly && this.adapter.populateTaskWorktree)
        await this.adapter.populateTaskWorktree(task);
      const found = await this.adapter.findWorkspaces(task);
      if (found.length > 1) {
        this.engine.note(
          task.id,
          "Ambiguous workspace identity; no new resource created",
          "workspace_unavailable",
          "needs_attention",
        );
        return;
      }
      if (found.length === 1) workspace = found[0]!;
      else {
        const state = this.adapter.inspectWorkspaceCreation
          ? await this.adapter.inspectWorkspaceCreation(task)
          : null;
        if (state && state.kind !== "absent" && state.kind !== "found_done") {
          this.engine.note(
            task.id,
            workspaceCreationRefusal(state),
            "operator_needed",
            "needs_attention",
          );
          return;
        }
        // A transport interruption may have happened before the detached worktree
        // or Paseo registration became visible. Re-enter the same idempotent
        // provisioning steps; createWorkspace will recover a completed registration.
        if (startsNoRuns(this.store, this.engine.stopped)) return;
        if (state?.kind === "absent" && this.adapter.populateTaskWorktree)
          await this.adapter.populateTaskWorktree(task);
        if (!this.adapter.createWorkspace)
          throw new Error("Proof-only workspace provisioning is unavailable");
        workspace = await this.adapter.createWorkspace(this.store.task(task.id));
      }
      const current = this.store.task(task.id);
      this.store.update(
        task.id,
        {
          workspaceId: workspace.id,
          directory: workspace.directory,
          phase: "dispatching",
          ...worktreeLinksForBinding(current, {
            workspaceId: workspace.id,
            directory: workspace.directory,
          }),
        },
        "workspace_recovered",
        workspace.id,
      );
    }
    if (task.proofOnly && workspace)
      retainNodeModules(task.repoPath, workspace.directory);
    if (!startsNoRuns(this.store, this.engine.stopped))
      await this.engine.launchProofOnly(this.store.task(task.id));
  }
  /** An empty inventory does not prove that the original producer has stopped. */
  async reconcileAbsentWorker(t: Task, matches: number) {
    const incident = this.resolution.ensureIncident(
      t,
      null,
      ABSENT_WORKER_REASON,
      "exact_lookup",
    );
    if (Date.now() - Date.parse(incident.createdAt) < this.engine.idleGraceMs)
      return;
    const current = this.store.task(t.id);
    if (!current.agentIntent || current.agentId || current.runId !== t.runId)
      return;
    const replacementSpent = this.store
      .events(t.id)
      .some((event) => event.kind === "absent_worker_retry");
    const reason =
      matches === 0
        ? `Worker creation remains uncertain: no agent was found, but the original create may still deliver${replacementSpent ? "; the automatic replacement allowance was already used" : ""}`
        : `Worker creation lookup is ambiguous (${matches} matching agents); no resource was created`;
    this.engine.note(current.id, reason, "operator_needed", "needs_attention");
  }
}
