import { resultApplied, recordResultApplied } from "../intake/applied-result";
import { digest, latestRunCompletion, now, type Store } from "../store/store";
import {
  isDispositionActive,
  isDispositionComplete,
  taskOwner,
  type Completion,
  type RecoveryActionBinding,
  type Run,
  type Task,
} from "../../shared/contracts";
import type { TaskStopReason } from "../../shared/task-stop";
import type { Resolution } from "../resolution";
import { missingOriginHasPlanner } from "../questions/origin";
import { randomUUID } from "node:crypto";
import { threadRunningReason } from "../intake/thread-waits";
import {
  creationTermination,
  readCreationAttempt,
} from "../store/store-task-funnel";
import { creationLookup } from "./absent-creation/restarts";
import { CREATION_REFUSED_BEFORE_SEND, refusedRunIds } from "./refused-launch";
import {
  taskProgressDigest,
  reportNamesNoAction,
  reportSettlesAsObservation,
} from "./coordinator-report";
import { recoveryApplicationsInFlight } from "./coordinator-settlement";
import {
  liveNoopSummary,
  liveRecoveryWait,
  liveWorkingParticipant,
  observedNoActionSummary,
} from "./live-noop";

/**
 * One recovery episode's durable bookkeeping: the action a coordinator report
 * binds to, the refusal that records a report as not applied, the release of a
 * finished coordinator run, and the escalation the episode ends in. The stages
 * that observe, decide and launch a recovery run (`coordinator-pass`,
 * `coordinator-route`) read and write an episode only through this module.
 */
export type RecoveryContext = Pick<
  Resolution,
  | "adapter"
  | "attention"
  | "automaticHookReplayPending"
  | "ensureIncident"
  | "escalateRefusedCoordinator"
  | "extendCallbackReminder"
  | "graceMs"
  | "host"
  | "hostAvailable"
  | "workerProviderUnavailable"
  | "idle"
  | "lease"
  | "onTaskHost"
  | "openPlannerEscalation"
  | "openReviewContinuationEscalation"
  | "recordStop"
  | "requiredRouteNote"
  | "responsibleBlockerLadder"
  | "resumeTransientProviderThread"
  | "select"
  | "slotAdmissionReason"
  | "startsNoRuns"
  | "stalls"
  | "stopped"
  | "store"
  | "suppressAutomaticRetry"
  | "update"
  | "usageCeilingNote"
  | "validationEvidence"
  | "waiting"
>;

export const needsAttention = (t: Task, store: Store) =>
  Boolean(t.originError && !missingOriginHasPlanner(store, t)) ||
  ["blocked", "error", "needs_attention"].includes(t.phase) ||
  t.resolution.attention ||
  Boolean(t.resolution.roleReplacements && t.reason.startsWith("No eligible"));
export const cause = (t: Task, runs: Run[]) => {
  const c = ["blocked", "error", "needs_attention"].includes(t.phase)
    ? (latestRunCompletion(runs, ["blocked", "error"]) ??
      (t.completion && ["blocked", "error"].includes(t.completion.status)
        ? t.completion
        : null))
    : null;
  return c ? `Worker ${c.status}: ${c.summary}` : t.reason;
};
export const key = (t: Task, runs: Run[]) =>
  t.resolution.stop
    ? digest(`stop:${t.resolution.stop.reason}:${t.resolution.stop.since}`)
    : digest(
        t.originError
          ? `origin:${taskOwner(t)}:${t.originWorkspaceId}:${t.coordinatorGeneration}`
          : `${t.phase}:${cause(t, runs)}:${t.resolution.currentRunId ?? t.runId}:${t.coordinatorGeneration}`,
      );

type RecoveryEpisode = NonNullable<Task["resolution"]["recovery"]>;
const agentlessCreation = (run: Run | null): run is Run =>
  Boolean(
    run &&
      run.role === "recovery" &&
      !run.released &&
      !run.agentId &&
      !run.completion &&
      ["intent", "uncertain"].includes(run.status),
  );

/** The termination witness must already exist when the exact lookup starts. */
export async function observeRecoveryCreation(
  resolution: RecoveryContext,
  task: Task,
  run: Run,
) {
  if (
    !run.hostId ||
    run.hostId !== task.hostId ||
    !run.workspaceId ||
    !resolution.hostAvailable(task, run)
  )
    throw Error(
      "The recovery creation lookup needs its recorded host and workspace online",
    );
  const proof = creationTermination(resolution.store, run, resolution.graceMs);
  const found = await resolution.onTaskHost(run, () => {
    if (!resolution.adapter.findRunAgents)
      throw Error("Run identity lookup is unavailable");
    return resolution.adapter.findRunAgents(run);
  });
  return { task, run, lookup: creationLookup(found, run.workspaceId), proof };
}
type RecoveryCreationObservation = Awaited<
  ReturnType<typeof observeRecoveryCreation>
>;

/** A report that was authenticated and accepted, and could not be applied. */
export const ACCEPTED_RECOVERY_NOT_APPLIED_PREFIX =
  "Accepted recovery report was not applied: ";

export class CoordinatorEpisode {
  constructor(readonly resolution: RecoveryContext) {}
  get store() {
    return this.resolution.store;
  }
  busy(t: Task) {
    const id = t.resolution.recovery?.runId;
    return Boolean(id && !this.store.run(id)?.released);
  }
  wait(t: Task, reason: string, stop: TaskStopReason) {
    this.resolution.waiting(t, reason, stop);
    const current = this.store.task(t.id),
      recovery = current.resolution.recovery;
    // A transient route/admission wait is a stop on the task, not an empty
    // recovery episode. Leave no episode behind until a coordinator run exists.
    if (recovery?.status === "pending" && !recovery.runId && !recovery.action)
      this.resolution.update(
        current,
        { recovery: null, recoveryActive: false },
        {},
        "recovery_waiting",
      );
  }
  bindingFrom(
    run: Run,
    incident: RecoveryEpisode,
  ): RecoveryActionBinding | null {
    if (incident.action) return incident.action;
    const completion = run.completion;
    if (!completion || run.role !== "recovery") return null;
    if (
      completion.status !== "recovered" &&
      completion.status !== "escalate" &&
      completion.status !== "blocked" &&
      completion.status !== "error"
    )
      return null;
    return {
      eventId: completion.eventId,
      runId: run.id,
      reportStatus: completion.status,
      recoveryAction: completion.recoveryAction ?? null,
      coordinatorAction: completion.coordinatorAction ?? null,
      summary: completion.summary,
      status: "pending",
    };
  }
  completionFromBinding(
    t: Task,
    run: Run,
    action: RecoveryActionBinding,
  ): Completion {
    return (
      run.completion ?? {
        eventId: action.eventId,
        taskId: t.id,
        runId: action.runId,
        status: action.reportStatus,
        summary: action.summary,
        coordinatorAction: action.coordinatorAction ?? undefined,
        coordinatorGeneration: run.generation,
      }
    );
  }
  acceptedActionIdentity(action: RecoveryActionBinding) {
    return `accepted ${action.reportStatus}${action.coordinatorAction ? ` + ${action.coordinatorAction.verb}` : ""} report ${action.eventId} on recovery run ${action.runId}`;
  }
  refuseAcceptedAction(
    t: Task,
    run: Run,
    action: RecoveryActionBinding,
    reason: string,
    escalate: boolean,
  ): void {
    if (!this.store.db.isTransaction)
      return this.store.transaction(() =>
        this.refuseAcceptedAction(t, run, action, reason, escalate),
      );
    if (resultApplied(this.store, t.id, run.id)) return;
    const current = this.store.task(t.id);
    const latest = this.store.run(run.id);
    if (!latest) return;
    // Round 4 telemetry: a report refused here is a coordinator refusal too, keyed
    // to its report so the engine's own settlement never counts it twice.
    try {
      this.store.recordVerbOutcome(
        t.id,
        action.coordinatorAction?.verb ?? "retired_recovery_action",
        "refused",
        "coordinator",
        { coordinatorRun: run.id, reason: reason.slice(0, 600) },
        `coordinator:${action.eventId}`,
      );
    } catch {
      /* the refusal stands even if its record could not be written */
    }
    const completion = this.completionFromBinding(current, latest, action);
    this.store.putRun({
      ...latest,
      completion,
      released: true,
      status: "finished",
    });
    this.resolution.update(current, { recoveryActive: false });
    const summary = `${ACCEPTED_RECOVERY_NOT_APPLIED_PREFIX}${reason} (${this.acceptedActionIdentity(action)})`;
    const refused = { ...action, status: "refused" as const, reason };
    if (escalate) {
      this.save(this.store.task(t.id), { action: refused });
      this.escalate(this.store.task(t.id), summary);
    } else {
      const settled = this.store.task(t.id),
        recovery = settled.resolution.recovery,
        incident = settled.resolution.incident;
      const resolvedIncident =
        action.reportStatus === "recovered" &&
        recovery?.incidentId &&
        incident?.id === recovery.incidentId &&
        incident.status === "reconciling"
          ? {
              ...incident,
              status: "resolved" as const,
              detail: `Recovery reported the trigger settled: ${action.summary}; ${reason}`,
              updatedAt: now(),
            }
          : incident;
      this.resolution.update(settled, {
        recovery: {
          ...recovery!,
          status: "resolved",
          summary,
          action: refused,
        },
        incident: resolvedIncident,
      });
    }
    recordResultApplied(this.store, t.id, run.id);
  }
  /**
   * A recovered report with no owner verb: the coordinator found the task live.
   * Settle the episode as a no-op, restore the ordinary live wait, and do not
   * climb the planner ladder. Papercut a721bbcc.
   */
  settleLiveNoOp(t: Task, run: Run, action: RecoveryActionBinding): void {
    if (!this.store.db.isTransaction)
      return this.store.transaction(() => this.settleLiveNoOp(t, run, action));
    if (resultApplied(this.store, t.id, run.id)) return;
    const current = this.store.task(t.id);
    const latest = this.store.run(run.id);
    if (
      !latest ||
      latest.released ||
      current.resolution.recovery?.runId !== latest.id
    )
      return;
    const others = this.store
      .runs(current.id)
      .filter((item) => item.id !== latest.id);
    const live = liveWorkingParticipant(current, others);
    // A recovered-without-action report is a live no-op only while Nucleus
    // observes an occupant. Otherwise the caller keeps the old refusal.
    const wait = liveRecoveryWait(current, {
      prerequisite: this.store.dependencyWait(current),
      slot: this.resolution.slotAdmissionReason(current),
    });
    if (!live && !wait) return;
    const completion = this.completionFromBinding(current, latest, action);
    this.store.putRun({
      ...latest,
      completion,
      released: true,
      status: "finished",
    });
    const summary = live
      ? liveNoopSummary(live)
      : `live: task is waiting; ${wait!.reason}`;
    const recovery = current.resolution.recovery;
    const incident = current.resolution.incident;
    const ownsIncident = Boolean(
      incident &&
        incident.status !== "resolved" &&
        (incident.role === "recovery" ||
          recovery?.incidentId === incident.id ||
          (recovery?.runId != null && incident.runId === recovery.runId)),
    );
    const phase =
      live && ["blocked", "error", "needs_attention"].includes(current.phase)
        ? live.role === "reviewer"
          ? "reviewing"
          : live.role === "revision"
            ? "changes_requested"
            : "working"
        : undefined;
    this.resolution.update(
      current,
      {
        recoveryActive: false,
        attention: false,
        stop: null,
        ...(recovery
          ? {
              recovery: {
                ...recovery,
                status: "resolved" as const,
                summary,
                action: { ...action, status: "applied" as const },
              },
            }
          : {}),
        ...(ownsIncident
          ? {
              incident: {
                ...incident!,
                status: "resolved" as const,
                detail: summary,
                updatedAt: now(),
              },
            }
          : {}),
      },
      { ...(phase ? { phase } : {}) },
      "recovery_live_noop",
      `recovery: task live, nothing to do; ${summary}`,
    );
    this.resolution.waiting(
      this.store.task(t.id),
      wait?.reason ?? threadRunningReason(live!.role),
      wait?.stop ?? "lifecycle",
    );
    recordResultApplied(this.store, t.id, latest.id);
  }
  /**
   * A report that named no owner verb settles the episode as observed: there is
   * nothing to apply, so nothing is refused and no attention notice is raised. The
   * report's own words are kept as the episode's summary and the run releases with
   * its completion. The stop it answered stays exactly as recorded, so a later pass
   * over the same unchanged facts reads this resolved episode instead of opening
   * another one (nucleus#1388).
   */
  settleObservedNoAction(
    t: Task,
    run: Run,
    action: RecoveryActionBinding,
  ): void {
    if (!this.store.db.isTransaction)
      return this.store.transaction(() =>
        this.settleObservedNoAction(t, run, action),
      );
    if (resultApplied(this.store, t.id, run.id)) return;
    const current = this.store.task(t.id);
    const latest = this.store.run(run.id);
    if (
      !latest ||
      latest.released ||
      current.resolution.recovery?.runId !== latest.id
    )
      return;
    const completion = this.completionFromBinding(current, latest, action);
    this.store.putRun({
      ...latest,
      completion,
      released: true,
      status: "finished",
    });
    const recovery = current.resolution.recovery;
    const incident = current.resolution.incident;
    const summary = observedNoActionSummary(action);
    // Only a recovered observation says its trigger is gone. A blocked, errored or
    // escalated one names a fault the episode keeps as it is.
    const settledIncident =
      action.reportStatus === "recovered" &&
      recovery?.incidentId &&
      incident?.id === recovery.incidentId &&
      incident.status === "reconciling"
        ? {
            ...incident,
            status: "resolved" as const,
            detail: `Recovery reported the trigger settled: ${action.summary}`,
            updatedAt: now(),
          }
        : incident;
    this.resolution.update(
      current,
      {
        recoveryActive: false,
        ...(recovery
          ? {
              recovery: {
                ...recovery,
                status: "resolved" as const,
                summary,
                action: { ...action, status: "applied" as const },
              },
            }
          : {}),
        incident: settledIncident,
      },
      {},
      "recovery_observed_no_action",
      summary,
    );
    recordResultApplied(this.store, t.id, latest.id);
  }
  /**
   * Resolution changes that close a recovery episode whose run no longer holds it:
   * the episode resolves with `detail`, a pending accepted action is recorded as not
   * applied, the incident it owns settles with it, and the stop that described the
   * episode clears. `episodeOwned` says a run this pass released owned the episode,
   * so the changes apply even after the release already cleared `recoveryActive`.
   * A record the release resolved keeps its own summary. Null when no episode is
   * active and none is owned. The caller folds the changes into its own update and
   * owns the transaction.
   */
  settledEpisodeChanges(
    t: Task,
    detail: string,
    episodeOwned = false,
  ): Partial<Task["resolution"]> | null {
    const current = this.store.task(t.id);
    if (!current.resolution.recoveryActive && !episodeOwned) return null;
    const episode = current.resolution.recovery ?? null,
      incident = current.resolution.incident;
    const action =
      episode?.action?.status === "pending" ? episode.action : null;
    const summary = action
      ? `${ACCEPTED_RECOVERY_NOT_APPLIED_PREFIX}${detail} (${this.acceptedActionIdentity(action)})`
      : detail;
    const ownsIncident = Boolean(
      incident &&
        incident.status !== "resolved" &&
        (incident.role === "recovery" ||
          episode?.incidentId === incident.id ||
          (episode?.runId != null && incident.runId === episode.runId)),
    );
    const closeEpisode = Boolean(episode && episode.status !== "resolved");
    return {
      recoveryActive: false,
      stop: null,
      ...(closeEpisode
        ? {
            recovery: {
              ...episode!,
              status: "resolved" as const,
              summary,
              ...(action
                ? {
                    action: {
                      ...action,
                      status: "refused" as const,
                      reason: detail,
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(ownsIncident
        ? {
            incident: {
              ...incident!,
              status: "resolved" as const,
              detail,
              updatedAt: now(),
            },
          }
        : {}),
    };
  }
  /**
   * Release one finished recovery run and settle its episode bookkeeping — the
   * release path shared by the reconciliation quantum (`Engine.settleFinishedRuns`)
   * and by owner verbs that settle a finished run before their run fence (Spec
   * 050: no verb is refused by a stale record). A pending accepted action is
   * recorded as not applied, audibly, and its stale retry is never executed; an
   * escalated report records its escalation; the callback and history are kept.
   * Only this run is released. Caller owns the transaction.
   */
  settleFinishedRun(t: Task, run: Run, notAppliedReason: string) {
    const latest = this.store.run(run.id);
    if (!latest || latest.released || !latest.completion) return;
    const current = this.store.task(t.id);
    const incident = current.resolution.recovery;
    // The owner verb is settling its own reporting coordinator. Its outcome is
    // recorded by the applying call after the verb returns, not as a refusal.
    const applicationKey = JSON.stringify([
      t.id,
      latest.id,
      latest.completion.eventId,
    ]);
    if (recoveryApplicationsInFlight.has(applicationKey)) {
      this.store.putRun({ ...latest, released: true, status: "finished" });
      this.store.event(
        t.id,
        "run_released_from_recorded_completion",
        `recovery ${latest.id}`,
      );
      return;
    }
    if (
      this.store
        .eventsAll(t.id)
        .some(
          (event) =>
            event.kind === "run_result_applying" &&
            event.detail === applicationKey,
        ) &&
      !resultApplied(this.store, t.id, latest.id)
    ) {
      this.resolution.attention(
        current,
        `Coordinator result ${latest.id} has an uncertain owner-verb outcome; inspect next and settle the existing action before retrying`,
      );
      return;
    }
    this.store.event(
      t.id,
      "run_released_from_recorded_completion",
      `recovery ${latest.id}`,
    );
    if (latest.completion.status === "escalate") {
      // The escalation is the applied outcome, not a stale action: record it like
      // the reconciliation release path does so the episode does not read running
      // and launch another coordinator for the same issue.
      this.store.putRun({ ...latest, released: true, status: "finished" });
      let after = current;
      if (after.resolution.recoveryActive)
        after = this.resolution.update(after, { recoveryActive: false });
      if (
        after.resolution.recovery?.runId === latest.id &&
        after.resolution.recovery?.status !== "escalated"
      )
        this.escalate(after, latest.completion.summary);
      recordResultApplied(this.store, t.id, latest.id);
      return;
    }
    const action =
      incident && incident.runId === latest.id
        ? this.bindingFrom(latest, incident)
        : null;
    if (action && action.status === "pending") {
      // A report that named no owner verb, or a `cannot`, has nothing to apply: it
      // releases as the observation it is. Only a report that named a verb this
      // release superseded is recorded as not applied (nucleus#1388).
      if (reportSettlesAsObservation(action)) {
        this.settleObservedNoAction(current, latest, action);
        return;
      }
      // refuseAcceptedAction records the release with the episode closed and the
      // accepted action marked not applied; the stale retry is never executed.
      this.refuseAcceptedAction(
        current,
        latest,
        action,
        notAppliedReason,
        false,
      );
      return;
    }
    this.store.putRun({ ...latest, released: true, status: "finished" });
    if (current.resolution.recoveryActive)
      this.resolution.update(current, { recoveryActive: false });
    recordResultApplied(this.store, t.id, latest.id);
  }
  /**
   * Closeout release bookkeeping: the task is merging past this recovery, so a
   * pending accepted action is recorded as not applied, audibly, and its stale
   * retry is never executed; the episode closes with the run. An already-decided
   * or escalation-outcome release stays with the caller's plain release. False
   * when the caller should release the run itself. Caller owns the transaction.
   */
  releaseWithNotAppliedAction(
    t: Task,
    run: Run,
    reason: string,
    appliedCoordinatorRunId?: string,
  ): boolean {
    const latest = this.store.run(run.id);
    const current = this.store.task(t.id);
    const incident = current.resolution.recovery;
    if (
      !latest ||
      latest.released ||
      !latest.completion ||
      latest.completion.status === "escalate"
    )
      return false;
    const action =
      incident && incident.runId === latest.id
        ? this.bindingFrom(latest, incident)
        : null;
    if (!action || action.status !== "pending") return false;
    if (action.coordinatorAction && latest.id === appliedCoordinatorRunId) {
      this.store.putRun({ ...latest, released: true, status: "finished" });
      this.resolution.update(
        current,
        {
          recovery: {
            ...incident!,
            status: "resolved",
            summary: reason,
            action: { ...action, status: "applied" },
          },
          recoveryActive: false,
          stop: null,
        },
        {},
        "coordinator_action_applied",
        action.eventId,
      );
      this.store.event(
        t.id,
        "run_released_from_recorded_completion",
        `recovery ${latest.id}`,
      );
      recordResultApplied(this.store, t.id, latest.id);
      return true;
    }
    this.refuseAcceptedAction(current, latest, action, reason, false);
    recordResultApplied(this.store, t.id, latest.id);
    this.store.event(
      t.id,
      "run_released_from_recorded_completion",
      `recovery ${latest.id}`,
    );
    return true;
  }
  /**
   * Spec 050, papercut e692bde2: a recovery that was authenticated and accepted
   * settles its bookkeeping regardless of review-dispatch authorization. While
   * review authorization holds, `pass` and `route` must not touch the task —
   * except this settlement: a recovery run whose completion is durably recorded,
   * whose exact coordinator identity still matches and whose workspace is
   * observed idle with no active turn and no pending permission releases, a
   * pending old action is marked not applied, and the stale retry is never
   * executed. Everything else stays fenced until authorization returns. True
   * when the run settled.
   */
  async settleAuthorizationFencedRun(t: Task): Promise<boolean> {
    // A paused queue defers its results: settling here could release a run the
    // pause is holding (the reconciliation quantum settles finished runs only
    // after its own pause check, for the same reason). The next pass after the
    // unpause settles it.
    if (this.resolution.startsNoRuns()) return false;
    const incident = t.resolution.recovery;
    const run = incident?.runId ? this.store.run(incident.runId) : null;
    if (!incident || !run || run.released || !run.completion) return false;
    if (
      run.role !== "recovery" ||
      !run.agentId ||
      run.generation !== t.coordinatorGeneration ||
      t.coordinatorAgentId !== run.agentId ||
      incident.generation !== run.generation ||
      incident.agentId !== run.agentId
    )
      return false;
    let state;
    try {
      state = await this.resolution.onTaskHost(run, () =>
        this.resolution.host.observe(run.agentId!),
      );
    } catch {
      return false;
    }
    // The pause can land during the observation: re-check before writing, and
    // again inside the write transaction.
    if (this.resolution.startsNoRuns()) return false;
    if (
      !state ||
      state.id !== run.agentId ||
      state.workspaceId !== run.workspaceId ||
      state.active ||
      state.permissions ||
      !["idle", "error", "closed"].includes(state.status)
    )
      return false;
    let settled = false;
    this.store.transaction(() => {
      if (this.resolution.startsNoRuns()) return;
      const latest = this.store.run(run.id);
      const current = this.store.task(t.id);
      const recovery = current.resolution.recovery;
      // The idle observation belongs to this exact binding. An owner control can
      // replace it while observe awaits, even if the episode keeps its run ID.
      if (
        !latest ||
        latest.released ||
        !latest.completion ||
        latest.role !== run.role ||
        latest.agentId !== run.agentId ||
        latest.workspaceId !== run.workspaceId ||
        latest.generation !== run.generation ||
        latest.completion.eventId !== run.completion!.eventId ||
        current.coordinatorGeneration !== run.generation ||
        current.coordinatorAgentId !== run.agentId ||
        current.resolution.coordinatorWorkspaceId !==
          t.resolution.coordinatorWorkspaceId ||
        !recovery ||
        recovery.id !== incident.id ||
        recovery.key !== incident.key ||
        recovery.runId !== run.id ||
        recovery.generation !== run.generation ||
        recovery.agentId !== run.agentId
      )
        return;
      this.settleFinishedRun(
        current,
        latest,
        "review authorization still holds; the accepted action was not applied",
      );
      settled = true;
    });
    return settled;
  }
  /**
   * The episode's own creation the host refused before send: it never crossed
   * the send boundary, so its run settled released with no agent and no
   * completion (nucleus#1364). Nothing is left for the exact-creation lookup to
   * find, and the owner `restart` re-arms over the refusal instead of being
   * refused by an intent that cannot exist.
   */
  refusedRun(t: Task) {
    const episode = t.resolution.recovery,
      run = episode?.runId ? this.store.run(episode.runId) : null;
    if (
      episode?.status !== "escalated" ||
      !run ||
      run.role !== "recovery" ||
      !run.released ||
      run.agentId ||
      run.completion
    )
      return null;
    return refusedRunIds(this.store.eventsAll(t.id)).has(run.id) ? run : null;
  }
  /**
   * A coordinator creation the host refused before send settles that occurrence
   * at once (nucleus#1364): nothing crossed the send boundary, so the run, its
   * credential and the episode's agent binding are released here, the refusal is
   * recorded against the run, and the episode keeps its record naming it. The
   * escalation stays for the owner, and an owner `restart` then re-arms recovery
   * over it instead of being refused by an intent that cannot exist. Automatic
   * recovery asks for another eligible profile; the refused one stays out until
   * that restart re-arms it (`refused-launch.ts`).
   */
  releaseRefusedCreation(t: Task, run: Run, reason: string): Task | null {
    return this.store.transaction(() => {
      const current = this.store.task(t.id),
        latest = this.store.run(run.id),
        episode = current.resolution.recovery;
      if (!latest || latest.released || latest.agentId || latest.completion)
        return null;
      if (!episode || episode.runId !== latest.id) return null;
      this.store.deleteCredential(latest.id);
      this.store.putRun({
        ...latest,
        status: "superseded",
        released: true,
        active: false,
      });
      this.store.event(
        current.id,
        CREATION_REFUSED_BEFORE_SEND,
        JSON.stringify({ runId: latest.id, reason: reason.slice(0, 1000) }),
      );
      return this.resolution.update(
        this.store.task(current.id),
        { recovery: { ...episode, runId: latest.id, agentId: null } },
        {},
        "recovery_creation_refused_before_send",
        reason,
      );
    });
  }
  /** The coordinator restart subject while its escalated creation still owns the run. */
  absentRun(t: Task) {
    const incident = t.resolution.recovery,
      run = incident?.runId ? this.store.run(incident.runId) : null;
    return incident?.status === "escalated" && agentlessCreation(run)
      ? run
      : null;
  }
  /**
   * Agentless creations no live episode names whose recorded attempt has
   * terminated (nucleus#1370). Resuming ordinary recovery from an answered
   * escalation, an operator return or a superseded episode drops the episode
   * record without settling the creation it recorded, so the run outlives its
   * binding. Its attempt is still on the task's own journal, which is why the
   * sweep can still prove it terminated; only those shapes cost a host lookup.
   */
  orphanedCreations(t: Task): Run[] {
    const bound = t.resolution.recovery?.runId ?? null;
    return this.store
      .runs(t.id)
      .filter(
        (run) =>
          run.id !== bound &&
          agentlessCreation(run) &&
          Boolean(
            creationTermination(this.store, run, this.resolution.graceMs),
          ),
      );
  }
  /**
   * Release an agentless creation no episode names once its recorded attempt has
   * terminated and its exact lookup is empty. Only the credential and the run
   * settle; an incident that names this run resolves with it, and the live
   * episode (if another one has since bound the run) keeps `releaseAbsent`.
   */
  releaseOrphaned(observed: RecoveryCreationObservation): Task | null {
    if (!this.store.db.isTransaction)
      return this.store.transaction(() => this.releaseOrphaned(observed));
    if (observed.lookup.kind !== "absent" || !observed.proof) return null;
    const { task, run } = observed,
      current = this.store.task(task.id),
      latest = this.store.run(run.id);
    if (
      !agentlessCreation(latest) ||
      latest.taskId !== current.id ||
      latest.hostId !== run.hostId ||
      latest.workspaceId !== run.workspaceId ||
      latest.generation !== run.generation ||
      latest.createdAt !== run.createdAt ||
      current.resolution.recovery?.runId === latest.id ||
      readCreationAttempt(this.store, latest)?.attemptId !==
        observed.proof.attemptId ||
      current.removedAt ||
      isDispositionActive(current) ||
      isDispositionComplete(current) ||
      ["done", "cancelled"].includes(current.phase) ||
      this.resolution.stopped() ||
      !this.resolution.hostAvailable(current, latest)
    )
      return null;
    const at = now(),
      summary =
        "Exact lookup found no recovery agent after its creation producer stopped",
      incident = current.resolution.incident;
    this.store.deleteCredential(latest.id);
    this.store.putRun({
      ...latest,
      status: "superseded",
      released: true,
      active: false,
      absentProvenAt: at,
    });
    return this.resolution.update(
      current,
      {
        // The episode that recorded this creation is gone; a task left active
        // with no episode would keep reading as a live recovery.
        ...(current.resolution.recovery ? {} : { recoveryActive: false }),
        ...(incident?.runId === latest.id && incident.status !== "resolved"
          ? {
              incident: {
                ...incident,
                status: "resolved" as const,
                detail: summary,
                updatedAt: at,
              },
            }
          : {}),
      },
      {},
      "absent_recovery_released",
      JSON.stringify({ runId: latest.id, ...observed.proof }),
    );
  }
  /** Recheck the occurrence that was observed before binding or releasing it. */
  currentCreation({ task, run }: RecoveryCreationObservation) {
    const current = this.store.task(task.id),
      latest = this.store.run(run.id),
      episode = current.resolution.recovery,
      prior = task.resolution.recovery;
    if (
      !agentlessCreation(latest) ||
      latest.taskId !== current.id ||
      latest.hostId !== run.hostId ||
      latest.workspaceId !== run.workspaceId ||
      latest.generation !== run.generation ||
      latest.createdAt !== run.createdAt ||
      current.coordinatorGeneration !== run.generation ||
      !episode ||
      !prior ||
      episode.id !== prior.id ||
      episode.key !== prior.key ||
      episode.runId !== run.id ||
      episode.generation !== run.generation ||
      episode.agentId ||
      episode.action ||
      episode.status === "resolved" ||
      episode.generation !== prior.generation ||
      (current.lastSubstantiveVersion ?? current.version) !==
        (task.lastSubstantiveVersion ?? task.version) ||
      current.removedAt ||
      isDispositionActive(current) ||
      isDispositionComplete(current) ||
      ["done", "cancelled"].includes(current.phase) ||
      this.resolution.stopped() ||
      !this.resolution.hostAvailable(current, latest)
    )
      return null;
    return { current, run: latest, episode };
  }
  /** The run, credential and episode release together. The underlying stop keeps its own owner. */
  releaseAbsent(observed: RecoveryCreationObservation): Task | null {
    if (!this.store.db.isTransaction)
      return this.store.transaction(() => this.releaseAbsent(observed));
    if (observed.lookup.kind !== "absent" || !observed.proof) return null;
    const binding = this.currentCreation(observed);
    if (!binding) return null;
    const { current, run, episode } = binding;
    if (
      readCreationAttempt(this.store, run)?.attemptId !==
      observed.proof.attemptId
    )
      return null;
    const at = now(),
      summary =
        "Exact lookup found no recovery agent after its creation producer stopped";
    const incident = current.resolution.incident;
    this.store.deleteCredential(run.id);
    this.store.putRun({
      ...run,
      status: "superseded",
      released: true,
      active: false,
      absentProvenAt: at,
    });
    return this.resolution.update(
      current,
      {
        recoveryActive: false,
        recovery: {
          ...episode,
          status: "resolved",
          runId: null,
          agentId: null,
          summary,
        },
        ...(incident?.runId === run.id && incident.status !== "resolved"
          ? {
              incident: {
                ...incident,
                status: "resolved" as const,
                detail: summary,
                updatedAt: at,
              },
            }
          : {}),
      },
      {},
      "absent_recovery_released",
      JSON.stringify({ runId: run.id, ...observed.proof }),
    );
  }
  save(t: Task, patch: Partial<RecoveryEpisode>) {
    const current = this.store.task(t.id);
    // An operator control can clear the recovery while a pass awaits; never rebuild a partial one.
    if (!current.resolution.recovery) return current;
    return this.resolution.update(
      current,
      { recovery: { ...current.resolution.recovery, ...patch } },
      {},
      "recovery",
    );
  }
  escalate(t: Task, summary: string) {
    const current = this.store.task(t.id);
    const recovery = current.resolution.recovery;
    if (
      recovery?.status === "escalated" &&
      recovery.summary === summary &&
      current.resolution.incident?.status === "escalated"
    )
      return summary;
    // Escalation attaches to the fault already being observed; a fresh incident is derived only when none exists.
    const existing =
      current.resolution.incident?.status === "resolved"
        ? null
        : current.resolution.incident;
    const incident =
      existing ?? this.resolution.ensureIncident(current, null, summary);
    // One escalation event per incident: repeated observations update the row, they do not append.
    const alreadyEscalated =
      recovery?.status === "escalated" && recovery.incidentId === incident.id;
    const base = recovery ?? {
      id: randomUUID(),
      key: key(current, this.store.runs(current.id)),
      generation: current.coordinatorGeneration,
      runId: null,
      agentId: null,
      status: "pending" as const,
      summary: "",
      idleSince: null,
      incidentId: null,
      progress: taskProgressDigest(current),
    };
    this.resolution.update(
      current,
      {
        recovery: {
          ...base,
          status: "escalated",
          summary,
          incidentId: incident.id,
        },
        incident: {
          ...incident,
          status: "escalated",
          detail: summary,
          updatedAt: now(),
        },
      },
      {},
    );
    if (!alreadyEscalated)
      this.store.event(t.id, "recovery_escalated", summary);
    return summary;
  }
}
