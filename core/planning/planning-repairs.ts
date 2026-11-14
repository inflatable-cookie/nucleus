import type { Task } from "../../shared/contracts";
import type { Engine } from "../engine";
import { git, proveRebindableDispatchBase } from "../git/index";
import { workspaceCreationRefusal } from "../workspaces/workspace-allocation";
import { worktreeLinksForBinding, worktreeLinksForClearedIntent } from "../workspaces/worktree-links";

/** Verification and re-admission of tasks before worker dispatch. */
export class PlanningRepairs {
  constructor(private readonly engine: Engine) {}
  private get store() { return this.engine.store; }
  private get adapter() { return this.engine.adapter; }
  private get resolution() { return this.engine.resolution; }
  /**
   * Re-record a task's dispatch base to the worktree head when nothing was ever pinned to the old one.
   *
   * `planningBase` is recorded when the handoff is submitted and the worker worktree must sit exactly
   * on it. If main advances between that record and the workspace creation - a coordinator's own
   * handoff push is enough - the worktree lands on the newer head and dispatch refuses forever, while
   * restart's validation replay refuses because a workspace is visible. There is no worker agent, run, branch or
   * PR to preserve in that state, so the repair is to re-record the base, gated on the proofs in
   * proveRebindableDispatchBase: clean worktree on the queue-owned branch, head descending from the
   * recorded base, and the submitted handoff present at that head.
   */
  async rerecordPlanningBase(input: { taskId: string; version: number }): Promise<Task> {
    const current = this.store.task(input.taskId);
    if (current.removedAt) throw new Error("Task was removed from the queue");
    if (current.version !== input.version) throw new Error("Task changed; refresh before retrying");
    // A recovery run is not a worker: it exists precisely because an uncertain creation had to be
    // diagnosed, and it proves the absence of a worker agent and worker run. Gating on any run at all
    // refused the state the control was built for.
    if (current.agentIntent || current.agentId)
      throw new Error("A worker agent already exists; a dispatch base is only re-recorded before any worker exists");
    const taskRuns = this.store.runs(current.id);
    if (taskRuns.some(run => run.role !== "recovery"))
      throw new Error("A worker run already exists; a dispatch base is only re-recorded before any worker exists");
    if (taskRuns.some(run => !run.released))
      throw new Error("A run is still in flight; a dispatch base is only re-recorded once the task is settled");
    if (current.prUrl || current.prHead || current.resumePrNumber)
      throw new Error("A PR identity already exists; resolve the dispatch instead of re-recording its base");
    if (!current.workspaceIntent || !current.workspaceId || !current.directory)
      throw new Error("Re-recording a dispatch base requires the recorded workspace");
    if (this.engine.stopped || this.store.getMeta("paused")) throw new Error("A dispatch base cannot be re-recorded while the queue is paused");
    const newBase = await git(current.directory, "rev-parse", "HEAD");
    await proveRebindableDispatchBase(current, current.directory, newBase);
    return this.store.transaction(() => {
      const latest = this.store.task(current.id);
      if (latest.version !== current.version || latest.planningBase !== current.planningBase || latest.agentIntent || latest.agentId ||
        latest.workspaceId !== current.workspaceId || latest.prUrl || latest.prHead)
        throw new Error("Task changed during dispatch base re-record; retry");
      return this.store.update(latest.id, {
        phase: "queued", planningBase: newBase,
        reason: `Dispatch base re-recorded to ${newBase}; dispatching from the current integration head`,
      }, "planning_base_rerecorded", `${current.planningBase} → ${newBase}`);
    });
  }

  async retryValidation(input: { taskId: string; version: number; rebindWorkspaceId?: string; removeOrphanWorkspace?: boolean; settleFences?: { detail: string; runIds: string[]; displacedRunIds?: string[] } }): Promise<Task> {
    const current = this.store.task(input.taskId);
    if (current.removedAt) throw new Error("Task was removed from the queue");
    if (current.version !== input.version) throw new Error("Task changed; refresh before retrying");
    this.engine.rejectFenced(current, "validation retry");
    if (!["queued", "needs_attention", "blocked", "error"].includes(current.phase) || current.entrypoint === "review")
      throw new Error("Validation retry requires an initial pre-dispatch task");
    if (current.agentIntent || current.agentId) throw new Error("A worker creation is already in flight; uncertain creation cannot be replayed");
    // The same settled rule the restart shape uses (nucleus#1147): only an unreleased
    // run owns the task. A released run, historical or not, is a previous owner move's
    // history, and the retained workspace is verified before any new worker starts.
    if (current.completion || current.prUrl || current.prHead || current.resumePrNumber || current.resolution.mergeIntent ||
        current.resolution.currentRunId || current.resolution.recoveryActive || this.store.runs(current.id).some(run => !run.released))
      throw new Error("Validation retry requires settled pre-dispatch state with no worker or PR");
    // Round 4: re-admission is state; the scheduler waits for unpause to dispatch.
    if (this.engine.stopped) throw new Error("Validation cannot be retried while Nucleus is stopping");
    let retained = false;
    let rebound: { id: string; directory: string } | null = null;
    let bound: { id: string; directory: string } | null = null;
    let displaced: { id: string; directory: string; branch: string } | null = null;
    const targetOwnedElsewhere = (id: string, directory: string) => this.store.tasks().some(other => other.id !== current.id &&
      (other.workspaceId === id || other.directory === directory || other.resolution.coordinatorWorkspaceId === id ||
       other.resolution.closeoutWorkspaceId === id)) || this.store.workspaceUsedByOtherTaskRun(current.id, id);
    if (input.rebindWorkspaceId && (!current.workspaceIntent || !current.workspaceId || !current.directory))
      throw new Error("Workspace rebind requires a recorded workspace to preserve");
    if (current.workspaceIntent) {
      const found = await this.adapter.findWorkspaces(current);
      if (found.length) {
        const targetId = input.rebindWorkspaceId ?? current.workspaceId;
        const matches = found.filter(workspace => workspace.id === targetId);
        if (!current.workspaceId || !current.directory || matches.length !== 1 || !matches[0].directory ||
            (targetId === current.workspaceId && matches[0].directory !== current.directory))
          throw new Error("Visible workspace does not uniquely match the task's recorded workspace and directory");
        if (input.rebindWorkspaceId && input.rebindWorkspaceId !== current.workspaceId) {
          const old = found.filter(workspace => workspace.id === current.workspaceId);
          if (old.length !== 1 || old[0].directory !== current.directory || matches[0].directory === current.directory)
            throw new Error("Displaced workspace identity must remain visible at its recorded directory");
          if (targetOwnedElsewhere(targetId!, matches[0].directory))
            throw new Error("Rebind target is referenced by another task");
          displaced = { id: current.workspaceId, directory: current.directory,
            branch: await git(current.directory, "branch", "--show-current") };
          rebound = matches[0];
        }
        await this.adapter.verifyWorkspace(current, matches[0].directory);
        retained = true;
      } else if (current.workspaceId || current.directory) {
        throw new Error("The recorded workspace is not visible; reconcile its identity before retrying");
      } else if (this.adapter.inspectWorkspaceCreation) {
        const classified = await this.adapter.inspectWorkspaceCreation(current);
        if (classified.kind === "found_done") {
          bound = await this.adapter.createWorkspace(current);
          await this.adapter.verifyWorkspace(current, bound.directory);
          retained = true;
        } else if (classified.kind === "partial") {
          const orphan = classified.orphan;
          if (!input.removeOrphanWorkspace || !this.adapter.removeOrphanWorkspace)
            throw new Error(workspaceCreationRefusal(classified));
          await this.adapter.removeOrphanWorkspace(current, orphan);
          this.store.event(current.id, "orphan_workspace_removed", JSON.stringify(orphan));
        } else if (classified.kind !== "absent") {
          throw new Error(workspaceCreationRefusal(classified));
        }
      }
    } else if (current.workspaceId || current.directory) {
      throw new Error("Recorded workspace has no creation intent; reconcile its identity before retrying");
    }
    return this.store.transaction(() => {
      const latest = this.store.task(current.id);
      if (latest.version !== current.version || this.engine.stopped) throw new Error("Task changed during validation verification; retry");
      // Spec 050 (#3569): the settling restart supersedes its admission fences
      // atomically with the re-admission; a refusal inside rolls both back.
      if (input.settleFences) this.engine.settleVerbFences(current.id, input.settleFences);
      if (rebound && displaced) {
        if (targetOwnedElsewhere(rebound.id, rebound.directory)) throw new Error("Rebind target acquired another task owner during verification");
        this.store.setMeta(`displacedDispatchWorkspace:${current.id}:${displaced.id}`, displaced);
        this.store.update(current.id, { workspaceId: rebound.id, directory: rebound.directory },
          "dispatch_workspace_rebound", JSON.stringify({ from: displaced, to: rebound }));
      } else if (bound) {
        this.store.update(current.id, { workspaceId: bound.id, directory: bound.directory, ...worktreeLinksForBinding(this.store.task(current.id), { workspaceId: bound.id, directory: bound.directory }) }, "workspace_created", bound.id);
      }
      const reason = retained ? "Retained workspace verified; validation retry requested" : current.workspaceIntent
        ? "Uncertain workspace creation is provably absent; replaying the same create" : "Validation retry requested";
      // Clearing a recorded intent carries only the eligibility it recorded (no backfill).
      if (!retained) { const cleared = worktreeLinksForClearedIntent(this.store.task(current.id)); if (cleared.worktreeLinks) this.store.update(current.id, cleared); }
      return this.resolution.returnToDispatch(this.store.task(current.id), retained, reason);
    });
  }

}
