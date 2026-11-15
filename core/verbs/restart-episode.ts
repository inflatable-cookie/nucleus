import { TaskChangedRefusal } from "../../shared/task-version";
import { COORDINATOR_LOOP_LIMIT, unproductiveCoordinatorRuns } from '../recovery/recovery-bound';
import { DEFAULT_GLOBAL_LIMIT, type Run, type Task, type TaskControlInput } from "../../shared/contracts";
import { occupiesSlot, recoveryCapacityFor } from "../dispatch/capacity";
import { taskPrNumber } from "../forge/index";
import { runsUnchangedSince } from "../recovery/observation-advance";
import { coordinatorReportMatches } from "../recovery/coordinator-report";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { now } from "../store/store";
import { REMOVED_TASK_REFUSAL } from "./control-refusals";
import type { Engine } from "../engine";
import type { RestartRequest } from "./owner-shared";

/**
 * The resolution half of `restart`: the absent creation of a reviewer, closeout or
 * recovery run, and the coordinator episode. Each settles its own episode, and the
 * admission it re-runs is the same one that admitted the missing run, so a restart
 * never creates a second agent for one recorded run.
 */
export class EpisodeRestarts {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }

  /**
   * Admission is complete before remote displacement; apply rechecks fresh
   * bindings and effects. A deferred admission re-enters later without a second
   * remote cancellation.
   */
  async executeEpisodeRestart(taskId: string, displacement: { runIds: string[]; cancel: () => Promise<void> },
    admit: () => Promise<Task | (() => Task | Promise<Task>)>, runIds: string[] = []): Promise<Task> {
    const before = this.store.task(taskId), runs = this.store.runs(taskId);
    const apply = await admit();
    if (typeof apply !== 'function') return apply; // deferred work re-enters admission later
    const recheck = () => {
      const task = this.store.task(taskId);
      for (const id of [...runIds, ...displacement.runIds]) {
        const run = this.store.run(id);
        const why = run && !run.released ? this.engine.runDurableFence(task, run) : null;
        if (why) throw new DurableFenceRefusal(this.engine.displaceRefusal({ run: run!, why }));
      }
      this.engine.assertUnchangedBeforeCancel(taskId, before.version, runs);
      if (this.engine.coordinatorActionRunId.getStore() && !coordinatorReportMatches(task))
        throw Error('The task moved on since the coordinator was asked');
    };
    recheck();
    await displacement.cancel();
    recheck();
    return apply();
  }

  async restartEpisode(c: RestartRequest): Promise<Task> {
    return c.shape === 'coordinator' ? this.coordinator(c) : this.absentResolution(c);
  }

  /**
   * Spec 050 (#3569): the delegated handlers ignore unreleased recovery runs, so a
   * finished one settles with the restart instead of riding along unreleased. The
   * inventory lookup refuses before anything is written, and the settlement lands
   * inside the action's transaction.
   */
  private async absentResolution(c: RestartRequest): Promise<Task> {
    const { task, input, role, reason, instruction } = c;
    const version = task.version;
    const absent = task.resolution.currentRunId ? this.store.run(task.resolution.currentRunId) : null;
    const finished = await this.engine.collectVerbFinishedRuns(task.id, run => run.id === absent?.id || run.id === this.engine.openEpisodeRunId(task.id));
    if (finished.fenced.length) throw new DurableFenceRefusal(this.engine.verbRunFenceRefusal(finished.fenced[0]!));
    // The episode's own run settles with the restart unless it is the absent
    // run this shape is binding again. It is cancelled only after the
    // inventory lookups below have had their say.
    const displacement = task.resolution.recovery?.runId && task.resolution.recovery.runId !== absent?.id
      ? await this.engine.planEpisodeDisplacement(task.id, version, `restart ${role}`) : { runIds: [] as string[], cancel: async () => {} };
    const settleFences = { detail: `restart ${role}: ${reason}`, runIds: finished.settleable.map(item => item.id), displacedRunIds: displacement.runIds };
    return this.engine.control(() => this.executeEpisodeRestart(task.id, displacement,
      () => this.engine.prepareAbsentResolution({ taskId: task.id, version, settleFences }, { input, instruction }),
      finished.settleable.map(run => run.id)), `task:${task.id}`);
  }

  /**
   * The coordinator episode. Only the owner's deliberate restart re-arms the
   * bounded recovery loop: an authenticated coordinator report goes through the
   * same shared plan but never buys its own recovery allowance.
   */
  private async coordinator(c: RestartRequest): Promise<Task> {
    const { task, input, reason } = c;
    const version = task.version;
    const absentRecovery = this.resolution.recovery.absentRun(task);
    if (absentRecovery) {
      if (!this.resolution.adapter.findRunAgents) throw Error('Run identity lookup is unavailable');
      const found = await this.resolution.adapter.findRunAgents(absentRecovery);
      if (found.length) throw Error('Recovery run creation is no longer proven absent; inspect the matching agent before retrying');
      return this.engine.control(() => this.store.transaction(() => {
        const current = this.store.task(task.id);
        this.engine.requireOwnerControlCurrent(current, version, 'Task changed during absent recovery-run verification');
        if (this.resolution.recovery.absentRun(current)?.id !== absentRecovery.id)
          throw new TaskChangedRefusal('Task changed during absent recovery-run verification', version, current.version);
        const others = this.store.runs(task.id).filter(run => !run.released && run.id !== absentRecovery.id);
        if (others.length) throw Error('Resolve the other retained runs before restarting coordinator recovery');
        this.adapter.purgeReportingFiles?.(task.id, [absentRecovery.id]);
        const released = this.resolution.recovery.releaseAbsent(current, absentRecovery.id, 'Exact task/run label lookup found no recovery agent');
        return this.resolution.operatorReturn(released, { recoveryActive: false, recovery: null, recoveryAttempts: 0 },
          {}, 'coordinator_rearmed', `Owner restarted coordinator recovery: ${reason}`);
      }), `task:${task.id}`);
    }
    const episodeRunId = task.resolution.recovery?.runId;
    // The ordinary fence stands: the episode's own run is this restart's
    // subject, and every other unreleased run — including the task's current
    // worker or reviewer — must settle by observation or fence the restart.
    // A retained run with an unresolved delivery is exactly what
    // `resolution.retry` refuses, and that refusal is never reclassified as
    // a successful re-arm (review 5673847000).
    const finished = await this.engine.collectVerbFinishedRuns(task.id, run => run.id === episodeRunId);
    if (finished.fenced.length) throw new DurableFenceRefusal(this.engine.verbRunFenceRefusal(finished.fenced[0]!));
    // Only the owner's deliberate coordinator restart re-arms the bounded
    // recovery loop. An authenticated coordinator report goes through this
    // same shared plan, but it must never buy its own recovery allowance.
    const ownerRearm = !this.engine.coordinatorActionRunId.getStore();
    const exhaustedBound = () => {
      const current = this.store.task(task.id);
      return current.resolution.recovery?.status === "escalated"
        && unproductiveCoordinatorRuns(this.store, current.id) >= COORDINATOR_LOOP_LIMIT;
    };
    return this.engine.control(() => this.store.transaction(() => {
      this.engine.requireOwnerControlCurrent(this.store.task(task.id), version, "Task changed; refresh before restarting");
      this.engine.settleVerbFences(task.id, {
        detail: `restart coordinator: ${reason}`, runIds: finished.settleable.map(item => item.id), preserveEpisode: true,
      });
      const rearm = () => {
        // Tom, 2026-10-27: an exhausted-bound episode the loop itself stopped
        // closes with its history kept, so the ordinary pass opens a fresh one
        // under the owner's deliberate re-arm.
        const current = this.store.task(task.id), recovery = current.resolution.recovery;
        return this.store.update(current.id, {
          resolution: { ...current.resolution, recoveryActive: false,
            ...(recovery && recovery.status !== "resolved"
              ? { recovery: { ...recovery, status: "resolved" as const, summary: `Owner re-armed coordinator recovery: ${reason}; original: ${recovery.summary}`.slice(0, 4000) } }
              : {}) },
        }, "coordinator_rearmed", reason);
      };
      try {
        return this.resolution.retry(this.store.task(task.id), false, undefined, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The proven case only: an owner restarting an episode the three-launch
        // bound stopped. Every other refusal — a retained run, a durable
        // effect, an ordinary no-action state, a coordinator's own report —
        // keeps its ownership and evidence and rolls the settlement back.
        if (!ownerRearm || message !== "No resolution action needs retry" || !exhaustedBound()) throw error;
        const applied = rearm();
        // The re-arm's durable identity belongs to the successful transition,
        // not to the best-effort owner_control audit line: one ordinary event
        // in this transaction, structured and length-bounded, is what the
        // recovery bound reads (review 5673077554).
        this.store.event(task.id, "coordinator_rearm", JSON.stringify({ verb: "restart", role: "coordinator",
          caller: input.caller ?? null, at: now(), reason: reason.slice(0, 2000) }));
        return applied;
      }
    }), `task:${task.id}`);
  }

  async prepareAbsentResolution(input: { taskId: string; version: number; settleFences?: { detail: string; runIds: string[]; displacedRunIds?: string[] } }, restart?: { input: TaskControlInput; instruction: string }): Promise<Task | (() => Task | Promise<Task>)> {
    const task = this.store.task(input.taskId), runs = this.store.runs(task.id);
    const check = () => {
      const current = this.store.task(task.id);
      if (current.removedAt) throw Error(REMOVED_TASK_REFUSAL);
      this.engine.rejectFenced(current, 'absent resolution recovery');
      this.engine.requireOwnerControlCurrent(current, input.version, 'Task changed during absent resolution-run verification');
      if (!runsUnchangedSince(runs, this.store.runs(task.id))) throw new TaskChangedRefusal('Task changed during absent resolution-run verification', input.version, current.version);
      return current;
    };
    check();
    const settling = input.settleFences ? [...input.settleFences.runIds, ...(input.settleFences.displacedRunIds ?? [])] : [];
    const admitLocal = () => {
      const current = check();
      if (!occupiesSlot(current, this.store.runs(task.id))) {
        const capacity = recoveryCapacityFor(current, this.store.activeCapacityTasks(), this.store.getMeta<number>('globalLimit') ?? DEFAULT_GLOBAL_LIMIT, this.store.projectDispatchLimitFor(current), this.store.papercutDispatchPolicy());
        if (capacity) throw Error(capacity);
      }
      const run = this.resolution.absentResolutionRun(current);
      if (!run) throw Error('Absent resolution-run recovery requires an uncertain reviewer, coordinator or escalated recovery creation with no agent');
      if (this.resolution.recovery.busy(current) && !settling.includes(current.resolution.recovery?.runId ?? '')) throw Error('Wait for coordinator recovery to finish before replacing the absent run');
      return this.resolution.admitAbsentResolution(current, run.id, settling);
    };
    const run = admitLocal();
    if (this.adapter.workspaceAvailable && !await this.adapter.workspaceAvailable(task.workspaceId!)) throw Error('Absent resolution-run recovery requires the retained task workspace');
    if (!this.resolution.adapter.findRunAgents) throw Error('Run identity lookup is unavailable');
    const found = await this.resolution.adapter.findRunAgents(run);
    if (restart && !found.length) {
      const latest = this.store.task(task.id), wait = this.engine.dispatchWaitsFor(latest);
      // A newly placed hold defers intent, never carries this inventory read
      // forward as authority. Replay derives the subject and admits it afresh.
      if (wait) return this.engine.deferOwnerVerb(latest, restart.input, wait, { runId: run.id });
    }
    if (!restart && found.length) throw Error('Resolution run creation is no longer proven absent; inspect the matching agent before retrying');
    if (found.length > 1) throw Error(`Run creation lookup is ambiguous (${found.length} matching agents); no restart`);
    if (found.length === 1 && found[0]!.workspaceId !== run.workspaceId)
      throw Error(`Run creation lookup found agent ${found[0]!.id} outside the retained workspace ${run.workspaceId}; inspect it before restarting so no second agent is created for the same run`);
    if (run.role === 'closeout') {
      if (!this.adapter.verifyCleanQueueWorktree) throw Error('Workspace verification is unavailable');
      await this.adapter.verifyCleanQueueWorktree(task);
    } else {
      const pr = await this.adapter.verifyPr(task, taskPrNumber(task));
      if (pr.url !== task.prUrl || pr.head !== task.prHead || pr.head !== run.head) throw Error('PR head changed; inspect it before replacing the absent run');
    }
    admitLocal();
    if (restart && !found.length) {
      const wait = this.engine.dispatchWaitsFor(check());
      if (wait) return this.engine.deferOwnerVerb(check(), restart.input, wait, { runId: run.id });
      await this.resolution.admitUncertainRunRestart(check(), run.id, settling);
      admitLocal();
    }
    return async () => {
      const current = check();
      admitLocal();
      if (restart && found.length) {
        return this.store.transaction(() => {
          if (input.settleFences) this.engine.settleVerbFences(task.id, input.settleFences);
          const latest = this.store.run(run.id)!, settledTask = this.store.task(task.id), agentId = found[0]!.id;
          this.store.putRun({ ...latest, agentId, status: 'running' });
          const patch: Partial<Task> = {};
          if (latest.role === 'reviewer') patch.resolution = { ...settledTask.resolution, reviewerAgentId: agentId, reviewerProfile: latest.profile, attention: false };
          if (['recovery', 'closeout'].includes(latest.role) && settledTask.coordinatorGeneration === latest.generation && !settledTask.coordinatorAgentId) patch.coordinatorAgentId = agentId;
          this.store.event(task.id, 'absent_creation_bound', `Exact lookup bound ${latest.role} run ${latest.id} to agent ${agentId} on restart`);
          return this.store.update(task.id, patch, 'restart_creation_bound');
        });
      }
      if (restart) {
        const wait = this.engine.dispatchWaitsFor(current);
        if (wait) return this.engine.deferOwnerVerb(current, restart.input, wait, { runId: run.id });
        return this.resolution.restartUncertainRun(current, run.id, restart.instruction, input.settleFences);
      }
      throw Error('Restart authorization is required');
    };
  }
}
