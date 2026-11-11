import { REMOVED_TASK_REFUSAL } from './control-refusals';
import { completeStateRefusal } from './control-refusals';
import { isDeepStrictEqual } from "node:util";
import type { Task, TaskControlInput } from "../../shared/contracts";
import { laneListsRepository, normalizeRepositoryOrigin } from "../../shared/lanes";
import { briefDigest } from "../planning/brief";
import type { Engine } from "../engine";
import { settleSupersededFencesInTx } from "../recovery/fence-settlement";
import { observationAdvanceSince, runsUnchangedSince } from "../recovery/observation-advance";
import type { Adapter } from "../host/adapter";
import { now } from "../store/store";

/**
 * The owner's `complete` verb. The same-name `Engine` method delegates here.
 * `store` and `adapter` read the engine per call: tests replace the adapter.
 */
export class TaskCompletion {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }

  /**
   * Spec 050 `complete`: an owner finishes a task that has no PR to merge. Only
   * a terminal task, merge intent, an open PR and a live run refuse it; no brief
   * heading is proof. Liveness is observed, not read from stored flags. One
   * transaction releases the finished runs and settles the superseded episode
   * records with their history kept, then records the terminal done outcome with
   * the owner's reason and optional lane artifact.
   */
  async completeTask(input: TaskControlInput, operationId?: string): Promise<{ task: Task; idempotent: boolean }> {
    const reason = input.reason?.trim();
    if (!reason) throw new Error("Completion requires the owner's reason");
    const artifact = input.artifact;
    const acceptedBy = input.caller ?? "operator";
    const task = this.store.task(input.taskId);
    if (task.phase === "done" && task.reportAcceptance) {
      const prior = task.reportAcceptance;
      if (prior.taskVersion === input.version && task.version >= input.version + 1
          && prior.acceptedBy === acceptedBy && prior.reason === reason
          && isDeepStrictEqual(prior.artifact, artifact)) return { task, idempotent: true };
      throw new Error("Completion already settled for a different version or acceptance; refresh task detail");
    }
    if (task.removedAt) throw new Error(REMOVED_TASK_REFUSAL);
    if (!observationAdvanceSince(task, input.version)) throw new Error("Task changed; refresh before completing");
    const refusal = completeStateRefusal(task, this.store.runs(task.id));
    if (refusal) throw new Error(refusal);
    if (artifact) {
      const delivered = task.completion?.status === "report_ready" ? task.completion.artifact : undefined;
      if (!delivered || !isDeepStrictEqual(delivered, artifact))
        throw new Error("The accepted artifact must be the exact report delivered by this task");
      const lane = this.store.laneByKey(artifact.key);
      const repositoryOrigin = normalizeRepositoryOrigin(task.repository ?? "");
      if (!task.lanes.includes(artifact.key)) throw new Error("The accepted report must be a Nucleus lane document attached to this task");
      if (!lane || !laneListsRepository(lane.repositories, task.repoPath, repositoryOrigin))
        throw new Error("The report lane does not belong to the task repository");
      const exactDoc = this.store.laneDocument(artifact.key, artifact.version);
      if (!exactDoc || exactDoc.key !== artifact.key || exactDoc.version !== artifact.version || exactDoc.digest !== artifact.digest
          || briefDigest(exactDoc.text) !== exactDoc.digest)
        throw new Error("The exact requested Nucleus lane document version and digest are absent or changed");
    }
    for (const completion of [task.completion, ...this.store.runs(task.id).map(run => run.completion)].filter(Boolean)) {
      const receipt = this.store.db.prepare("SELECT task,run FROM receipts WHERE id=?").get(completion!.eventId) as { task?: string; run?: string } | undefined;
      if (receipt?.task !== task.id || receipt.run !== completion!.runId)
        throw new Error("An accepted callback has no immutable task/run receipt");
    }

    const snapshot = () => {
      const current = this.store.task(task.id);
      return {
        task: current,
        runs: this.store.runs(task.id),
        notices: this.store.notices(task.id),
        outcome: this.store.outcome(task.id),
        callbacks: this.store.db.prepare("SELECT id,task,run,hash,response FROM receipts WHERE task=? ORDER BY id").all(task.id),
        credentials: this.store.db.prepare("SELECT run,hash FROM credentials WHERE run=? OR run IN (SELECT id FROM runs WHERE taskId=?) ORDER BY run")
          .all(current.runId ?? "", task.id),
      };
    };
    const initial = snapshot();
    // The awaits below observe each participant twice. A lifecycle observation of
    // the same task or run is not a change: only a substantive write, a run that
    // moved past its observation timestamp, or a new notice, outcome, receipt or
    // credential refuses here (Spec 050 observation admission).
    const ensureCurrent = (where: string) => {
      const current = snapshot();
      const unchanged = observationAdvanceSince(current.task, initial.task.version)
        && runsUnchangedSince(initial.runs, current.runs)
        && isDeepStrictEqual(initial.notices, current.notices)
        && isDeepStrictEqual(initial.outcome, current.outcome)
        && isDeepStrictEqual(initial.callbacks, current.callbacks)
        && isDeepStrictEqual(initial.credentials, current.credentials);
      if (!unchanged) throw new Error(`Task, artifact, run or fence changed during ${where}; refresh before completing`);
    };
    if (initial.outcome) throw new Error("A permanent outcome already exists for this task");

    if (!this.adapter.findAnyOpenBranchPr) throw new Error("Complete open-PR identity lookup is unavailable");
    const openPrs = await this.adapter.findAnyOpenBranchPr(task);
    ensureCurrent("open PR lookup");
    if (openPrs.length) throw new Error(`Task branch has an open forge PR (#${openPrs[0]!.number})`);

    // Every participant is a worker or unreleased run agent. Each must be
    // observed idle, twice, with no turn or permission; anything else is live.
    const participants = new Map<string, string>();
    const addParticipant = (agentId: string | null, workspaceId: string | null) => {
      if (!agentId || !workspaceId) throw new Error("Participant identity or workspace is unknown");
      const existing = participants.get(agentId);
      if (existing && existing !== workspaceId) throw new Error("One participant is recorded against multiple task workspaces");
      participants.set(agentId, workspaceId);
    };
    if (task.agentId && task.workspaceId) addParticipant(task.agentId, task.workspaceId);
    if (task.agentIntent && !task.agentId) throw new Error("A live run is still creating its worker; complete after the creation settles");
    for (const run of initial.runs.filter(item => !item.released || item.active === true)) addParticipant(run.agentId, run.workspaceId);
    let lastObservations = new Map<string, Awaited<ReturnType<Adapter["observe"]>>>();
    const observeIdle = async (label: string) => {
      const observedParticipants = new Map<string, Awaited<ReturnType<Adapter["observe"]>>>();
      for (const [agentId, workspaceId] of participants) {
        const observed = await this.engine.host.observe(agentId);
        ensureCurrent(label);
        if (observed.id !== agentId || observed.workspaceId !== workspaceId || observed.active || observed.permissions
            || !["idle", "error", "closed"].includes(observed.status))
          throw new Error(`Participant ${agentId} is a live run: active, permission-holding or identity-unverified`);
        observedParticipants.set(agentId, observed);
      }
      lastObservations = observedParticipants;
    };
    await observeIdle("first liveness observation");
    await new Promise<void>(resolve => setTimeout(resolve, 250));
    ensureCurrent("repeated liveness observation interval");
    await observeIdle("second liveness observation");
    ensureCurrent("final pre-completion snapshot check");

    const acceptedAt = now();
    const acceptedReason = artifact
      ? `Owner ${acceptedBy} completed ${artifact.key} v${artifact.version} (${artifact.digest}): ${reason}. No PR, code review, QA result or merge was created.`
      : `Owner ${acceptedBy} completed this task: ${reason}. No PR, code review, QA result or merge was created.`;
    const acceptance = { ...(artifact ? { artifact } : {}), acceptedBy, reason, acceptedAt, taskVersion: input.version, kind: "owner_completed" as const };
    const completed = this.store.transaction(() => {
      ensureCurrent("atomic owner completion");
      const current = this.store.task(task.id);
      if (!observationAdvanceSince(current, input.version) || current.phase === "done") throw new Error("Task changed before atomic completion");
      // Finished runs release first: a recovery run's escalation or pending
      // action is recorded by its own release path, then the fences settle.
      for (const run of this.store.runs(task.id).filter(item => !item.released || item.active === true)) {
        const latest = this.store.run(run.id);
        if (!latest || !isDeepStrictEqual(latest, run))
          throw new Error("A run changed before completion");
        const observed = lastObservations.get(run.agentId ?? "");
        if (!observed || observed.id !== run.agentId || observed.workspaceId !== run.workspaceId || observed.active || observed.permissions)
          throw new Error("A run lost its repeated identity-bound inactivity proof");
        if (latest.released) { this.store.putRun({ ...latest, active: false, lastObservedAt: acceptedAt }); continue; }
        if (!latest.completion) this.store.event(task.id, "run_released_by_owner_completion", `${latest.role} ${latest.id}`);
        this.store.deleteCredential(latest.id);
        if (latest.completion) this.engine.releaseVerbFinishedRuns(task.id, [latest], reason);
        else this.store.putRun({ ...latest, status: "finished", released: true, active: false, lastObservedAt: acceptedAt, idleSince: latest.idleSince ?? acceptedAt });
      }
      settleSupersededFencesInTx(this.store, task.id, `complete: ${reason}`, acceptedAt, this.engine.coordinatorActionRunId.getStore());
      const workerObservation = task.agentId ? lastObservations.get(task.agentId) : undefined;
      this.store.event(task.id, "owner_completed", acceptedReason);
      return this.store.update(task.id, { phase: "done", reason: acceptedReason, reportAcceptance: acceptance,
        resolution: { ...this.store.task(task.id).resolution, attention: false, recoveryActive: false },
        agentActive: false, lastAgentStatus: workerObservation?.status ?? current.lastAgentStatus, lastObservedAt: acceptedAt, idleSince: task.idleSince ?? acceptedAt },
        "report_only_completed", `${task.reason}\n${acceptedReason}`);
    });
    this.engine.enqueueTitle(completed.id);
    this.engine.enqueueCleanup(completed.id);
    return { task: completed, idempotent: false };
  }
}
