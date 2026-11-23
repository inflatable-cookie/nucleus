import { missingReportBindingCompletion } from "../intake/reporting-failure";
import { digest, now } from "../store/store";
import type { Run, Task } from "../../shared/contracts";
import {
  isDispositionActive,
  isDispositionComplete,
} from "../../shared/contracts";
import { isWaitingTaskStop } from "../../shared/task-stop";
import { reviewFenceHoldsCoordinators } from "../review/review-continuation";
import { dispatchBlocked } from "../dispatch/capacity";
import { escalationSummary } from "./task-reasons";
import {
  ACCEPTED_RECOVERY_NOT_APPLIED_PREFIX,
  cause,
  needsAttention,
  observeRecoveryCreation,
  type CoordinatorEpisode,
  type RecoveryContext,
} from "./coordinator-episode";
import { plannerEscalations, type LadderEvent } from "../questions/ladder";
import { closeEscalationFollowups } from "../questions/ladder/continuation";
import { releaseRunFromRecordedCompletion } from "./fence-settlement";
import { resultApplied } from "../intake/applied-result";
import { matchingInactiveParticipant } from "../intake/run-settlement";
import { releaseCoordinatorBinding } from "../verbs/explicit-resolution";
import { coordinatorClaim } from "./coordinator-settlement";
import type { AgentObservation } from "../host/adapter";
import {
  completedTurnCanRelease,
  timestampCompletion,
  type CompletionObservation,
} from "./completed-run-observation";
import { runActivityObservation } from "../telemetry/task-activity-observation";
import {
  coordinatorReportMatches,
  recoveryContinuationMatches,
  reportNamesNoAction,
  retiredNarrowAction,
  retiredNarrowRefusal,
} from "./coordinator-report";
import {
  liveRecoveryWait,
  liveWorkingParticipant,
  observeRecoveryParticipants,
} from "./live-noop";
import {
  DEAD_PARTICIPANT_ATTEMPTS,
  deadParticipantDetail,
  threadGoneError,
} from "./dead-participant";
import { hostFaultHost, reportHostCallFailure } from "../host/adapter-routing";
import { isTransportFailure } from "../../shared/transport";
import { waitAgeMs } from "../scheduling/host-outage";
import {
  COORDINATOR_OBSERVATION_DEFERRED_EVENT,
  coordinatorObservationDeferral,
  type CoordinatorObservationDeferral,
} from "../../shared/task-activity";

/**
 * How long a recovery episode may sit pending with no run before it escalates.
 *
 * Papercut 0489ea25: nucleus#1166's stalled turn recorded `recovery_pending` and
 * then nothing for 2h14m, because the stalled worker still held the workspace
 * lease and no launch, wait or escalation followed. A pending episode that
 * starts no run inside this bound reaches the task's planner ladder instead.
 */
export const RECOVERY_PENDING_BOUND_MS = 3 * 60_000;
/** The pending episode's escalation, naming the stop and the verb that exits it. */
export const recoveryPendingEscalation = (t: Task): string => {
  const stop = t.resolution.stop;
  const verbs = stop?.suggestedVerbs?.length
    ? stop.suggestedVerbs.join(", ")
    : "next";
  const detail = (stop?.detail ?? t.reason).slice(0, 1200);
  return `Recovery was requested for this task but started no run within ${Math.round(RECOVERY_PENDING_BOUND_MS / 60_000)} minutes: ${stop ? `stop ${stop.reason} — ${detail}` : detail}. Nothing else followed, so Nucleus asks the planner ladder which owner action continues it. The exit is ${verbs}; next lists every verb with its refusal.`;
};
/**
 * How long a coordinator may go unobserved on host faults or transport failures,
 * while its host reads as up, before the observation escalates. Outages and the
 * service's own downtime are not counted.
 */
export const COORDINATOR_UNOBSERVED_BOUND_MS = 5 * 60_000;
/** The recovery coordinator stopped without a result: its thread holds the answer, and nothing repeats its prompt. */
export const RECOVERY_STOPPED_WITHOUT_RESULT =
  "The recovery coordinator stopped without a result. Inspect its thread; the plugin has not repeated its prompt.";

export type CoordinatorPassContext = {
  readonly resolution: RecoveryContext;
  readonly episode: CoordinatorEpisode;
  /** Tests shorten the pending-episode bound without waiting minutes. */
  readonly pendingBoundMs: () => number;
};

/**
 * The recovery pass: one sweep over the tasks that hold a coordinator run. It
 * observes that exact run, settles it when it finished, supersedes it when the
 * generation changed, retains an unproved creation, hands a responsible
 * task's report to its planner ladder, and escalates a pending episode that
 * starts no run inside its bound. It decides nothing about which tasks need a
 * coordinator: that is `CoordinatorRoute`.
 */
export class CoordinatorPass {
  constructor(private readonly context: CoordinatorPassContext) {}
  get resolution() {
    return this.context.resolution;
  }
  get episode() {
    return this.context.episode;
  }
  get store() {
    return this.context.resolution.store;
  }
  /** The engine's handler that applies one accepted coordinator report as an owner verb. */
  coordinatorActionHandler:
    | ((
        task: Task,
        run: Run,
        action: import("../../shared/contracts").RecoveryActionBinding,
      ) => Promise<void>)
    | null = null;
  /**
   * Release the episode's coordinator run on proof that its agent is dead.
   * Each head allows `DEAD_PARTICIPANT_ATTEMPTS` such releases, as batch A
   * allows every other role; past that the task records a typed stop naming its
   * explicit command, and the dead run stays bound so no coordinator cycles.
   */
  private async releaseGoneCoordinator(
    t: Task,
    run: Run,
  ): Promise<"released" | "bounded" | "none"> {
    const prove = this.resolution.participantGoneProof;
    if (!prove || !run.agentId) return "none";
    const proof = await prove(t, run);
    if (
      !proof ||
      this.resolution.stopped() ||
      this.resolution.startsNoRuns() ||
      !recoveryContinuationMatches({
        task: [t, this.store.task(t.id)],
        run: [run, this.store.run(run.id)],
      })
    )
      return "none";
    if (
      this.episode.goneReleasesAtHead(t, proof.head) >= DEAD_PARTICIPANT_ATTEMPTS
    ) {
      const latest = this.store.task(t.id);
      const reason = `${deadParticipantDetail(proof)}. Nucleus already replaced this coordinator ${DEAD_PARTICIPANT_ATTEMPTS} times at this head; use run.start coordinator fresh replacing=${run.id} or run.release run=${run.id}`;
      if (latest.reason !== reason)
        this.resolution.waiting(latest, reason, "operator_needed", {
          fact: { code: "participant_gone", subject: run.id },
        });
      return "bounded";
    }
    return this.episode.releaseGone(t, run, proof) ? "released" : "none";
  }
  /**
   * Wait for the coordinator's host to answer, inside a bound. The wait is
   * recorded (`coordinator_observation_deferred`), and the activity reading
   * shows it as Nucleus's move. While the host itself reads as down its outage
   * owns the wait; once the host is up and the coordinator has gone unobserved
   * for `COORDINATOR_UNOBSERVED_BOUND_MS` (outages and downtime excluded), the
   * observation stops waiting and escalates. Returns whether it waits.
   */
  private deferCoordinatorObservation(t: Task, run: Run, error: unknown): boolean {
    const since = run.lastObservedAt ?? run.createdAt;
    if (
      this.resolution.hostAvailable(t, run) &&
      waitAgeMs(this.store, t.hostId, since) >= COORDINATOR_UNOBSERVED_BOUND_MS
    )
      return false;
    if (
      !coordinatorObservationDeferral(this.store.eventsAll(t.id), run)
    ) {
      const detail: CoordinatorObservationDeferral = {
        runId: run.id,
        since,
        until: new Date(Date.parse(since) + COORDINATOR_UNOBSERVED_BOUND_MS).toISOString(),
        cause: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      };
      this.store.event(t.id, COORDINATOR_OBSERVATION_DEFERRED_EVENT, JSON.stringify(detail));
    }
    return true;
  }

  private staleBindingReason(task: Task, run: Run): string | null {
    if (run.role !== "recovery" || run.mergeRetirement) return null;
    const episode = task.resolution.recovery;
    const settled =
      "The completed coordinator run no longer owns an applicable action.";
    if (episode?.runId !== run.id)
      return !run.released && run.completion ? settled : null;
    const action = episode.action;
    if (run.generation !== task.coordinatorGeneration)
      return !run.released ||
        episode.status !== "resolved" ||
        action?.status === "pending"
        ? "coordinator generation changed after the accepted report"
        : null;
    if (
      !run.completion ||
      action?.runId !== run.id ||
      action.eventId !== run.completion.eventId
    )
      return null;
    if (!run.released && action.status === "refused") return settled;
    if (
      action.status === "pending" &&
      action.coordinatorAction &&
      !["none", "cannot"].includes(action.coordinatorAction.verb) &&
      episode.progress &&
      !coordinatorReportMatches(task)
    )
      return "The task moved on since the coordinator was asked (its results, head, phase, run or routes changed)";
    return null;
  }

  /** Staleness retires the action only after the coordinator's turn settles. */
  private async settleStaleBindings(
    task: Task,
    stale: Run[],
  ): Promise<Task | null> {
    let current = task;
    for (const candidate of stale) {
      const run = this.store.run(candidate.id);
      if (!run) continue;
      const reason = this.staleBindingReason(current, run);
      if (!reason) continue;
      const episode = current.resolution.recovery;
      const bound = episode?.runId === run.id;
      const action = bound ? this.episode.bindingFrom(run, episode) : null;
      const reportId = run.completion?.eventId ?? action?.eventId;
      if (!run.released) {
        if (!run.agentId) continue;
        const agentId = run.agentId;
        const observed = await this.resolution
          .onTaskHost(run, () => this.resolution.host.observe(agentId))
          .catch(() => null);
        if (
          this.resolution.startsNoRuns() ||
          !recoveryContinuationMatches({
            task: [current, this.store.task(current.id)],
            run: [run, this.store.run(run.id)],
          })
        )
          return null;
        if (!observed || !matchingInactiveParticipant(run, observed)) continue;
      }
      const claim =
        reportId && !resultApplied(this.store, current.id, run.id)
          ? coordinatorClaim(this.store, current.id, run.id, reportId)
          : "unclaimed";
      if (claim === "unknown" || claim === "in_flight") continue;
      if (bound && (claim === "applied" || claim === "refused")) {
        // The recorded owner-verb outcome still owns the report, even at an older head.
        if (
          action?.runId === run.id &&
          action.eventId === reportId &&
          this.coordinatorActionHandler
        ) {
          await this.coordinatorActionHandler(current, run, action);
          current = this.store.task(current.id);
        }
        continue;
      }
      current = this.store.transaction(() => {
        const patch = releaseCoordinatorBinding(
          this.store,
          current,
          run,
          reason,
        );
        return this.store.update(
          current.id,
          patch,
          "coordinator_binding_released",
          run.id,
        );
      });
    }
    // A stale bound run still waiting on proof or an outcome must stay out of
    // the ordinary report path, which has its own release and refusal rules.
    const boundRunId = current.resolution.recovery?.runId;
    const boundRun = boundRunId ? this.store.run(boundRunId) : null;
    return boundRun && this.staleBindingReason(current, boundRun) ? null : current;
  }

  async pass(taskId?: string) {
    if (
      !this.resolution.adapter.supportsCoordinatorRecovery ||
      this.resolution.stopped()
    )
      return;
    for (const initial of this.store
      .maintenanceTasks(true)
      .filter((task) => !taskId || task.id === taskId)) {
      let t = this.store.task(initial.id),
        incident = t.resolution.recovery;
      const runs = this.store.runs(t.id);
      if (
        (t.entrypoint !== "proof" || !t.proofOnly) &&
        !this.resolution.startsNoRuns() &&
        !isDispositionActive(t) &&
        !isDispositionComplete(t) &&
        !["done", "cancelled"].includes(t.phase)
      ) {
        const stale = runs.filter((run) => this.staleBindingReason(t, run));
        if (stale.length) {
          const settled = await this.settleStaleBindings(t, stale);
          if (!settled) continue;
          t = settled;
          incident = t.resolution.recovery;
        }
      }
      // The retired report is already history. Release its execution custody
      // only after the ordinary merge lease positively observes participants and
      // effects quiet, and only if neither task nor run changed during that read.
      for (const retired of runs.filter(
        (run) => run.mergeRetirement && run.completion && !run.released,
      )) {
        if (!(await this.resolution.executionLease(t, undefined, false, true)))
          continue;
        this.store.transaction(() => {
          const current = this.store.task(t.id),
            latest = this.store.run(retired.id);
          if (
            latest &&
            recoveryContinuationMatches({
              task: [t, current],
              run: [retired, latest],
            })
          )
            releaseRunFromRecordedCompletion(this.store, current.id, latest);
        });
      }
      if (t.entrypoint === "proof" && t.proofOnly) {
        // A stale worker-recovery episode must not own a proof-only task. Stop and
        // supersede its exact coordinator run, then let the task quantum resume the
        // proof route from its already-provisioned detached checkout.
        if (incident?.runId) {
          const run = this.store.run(incident.runId);
          if (run && !run.released && run.role === "recovery" && run.agentId) {
            const host = this.resolution.host;
            if (this.resolution.adapter.stopAgentTurn)
              await host.stopAgentTurn(run.agentId);
            const state = await host.observe(run.agentId);
            if (
              state.active ||
              state.permissions ||
              !["idle", "error", "closed"].includes(state.status)
            )
              continue;
            const latest = this.store.task(t.id),
              latestRun = this.store.run(run.id),
              latestRecovery = latest.resolution.recovery;
            if (
              !latestRun ||
              latestRun.released ||
              !recoveryContinuationMatches({
                task: [t, latest],
                run: [run, latestRun],
              }) ||
              latestRecovery?.runId !== run.id
            )
              continue;
            this.store.transaction(() => {
              const current = this.store.task(t.id),
                bound = this.store.run(run.id)!;
              this.store.putRun({
                ...bound,
                released: true,
                status: "superseded",
              });
              this.resolution.update(
                current,
                {
                  recoveryActive: false,
                  recovery: {
                    ...current.resolution.recovery!,
                    status: "resolved",
                    summary:
                      "Proof-only task resumed its executor route; worker recovery was superseded",
                  },
                  incident: current.resolution.incident
                    ? {
                        ...current.resolution.incident,
                        status: "resolved",
                        detail: "Proof-only task resumed its executor route",
                        updatedAt: now(),
                      }
                    : null,
                  stop: null,
                },
                {
                  coordinatorAgentId: "",
                  coordinatorGeneration: current.coordinatorGeneration + 1,
                  phase: "dispatching",
                  reason:
                    "Proof-only task resumed after worker recovery was superseded",
                },
                "proof_only_recovery_superseded",
                run.id,
              );
            });
          }
        }
        continue;
      }
      // A creation whose episode was replaced (an answered escalation resumed
      // ordinary recovery, an operator return, a superseded episode) is still a
      // recorded attempt on the task's own journal, so it is released by the
      // same producer-termination rule instead of holding every owner verb
      // forever (nucleus#1370). Only a terminated attempt is looked up; an
      // unsettled producer, a non-empty lookup or an offline host keeps it owned.
      if (
        !this.resolution.startsNoRuns() &&
        !isDispositionActive(t) &&
        !isDispositionComplete(t) &&
        !["done", "cancelled"].includes(t.phase) &&
        !dispatchBlocked(t) &&
        !reviewFenceHoldsCoordinators(t, this.store)
      ) {
        let released = false;
        for (const creation of this.episode.orphanedCreations(t)) {
          let observed: Awaited<ReturnType<typeof observeRecoveryCreation>>;
          try {
            observed = await observeRecoveryCreation(
              this.resolution,
              t,
              creation,
            );
          } catch {
            // An unreadable lookup proves nothing: the creation stays owned.
            continue;
          }
          if (this.resolution.stopped() || this.resolution.startsNoRuns())
            return;
          // A dispatch hold, a review fence or a disposition that landed while
          // the host was read owns the task now, exactly as it does for the
          // episode-bound creation below: this release waits for a later pass.
          t = this.store.task(t.id);
          if (
            dispatchBlocked(t) ||
            reviewFenceHoldsCoordinators(t, this.store) ||
            isDispositionActive(t) ||
            isDispositionComplete(t) ||
            ["done", "cancelled"].includes(t.phase)
          )
            continue;
          if (this.episode.releaseOrphaned(observed)) released = true;
        }
        // A release is a task write: re-read before the episode path compares
        // its own observation against this task's version.
        if (released) {
          t = this.store.task(t.id);
          incident = t.resolution.recovery;
        }
      }
      // Before anyone acts on a stall episode, re-observe the exact participant.
      // A resumed turn or owned tool settles the obsolete episode and its question.
      const fault = t.resolution.incident;
      if (
        incident &&
        ["pending", "escalated"].includes(incident.status) &&
        !incident.runId &&
        !incident.action &&
        fault?.cause === "stalled_turn" &&
        ["reconciling", "escalated"].includes(fault.status) &&
        fault.runId &&
        incident.incidentId === fault.id &&
        !t.resolution.stalledTurnStop
      ) {
        const run =
          fault.role === "worker" && t.runId === fault.runId
            ? null
            : this.store.run(fault.runId);
        const agentId =
          run?.agentId ??
          (fault.role === "worker" && t.runId === fault.runId
            ? t.agentId
            : null);
        const workspaceId = run?.workspaceId ?? t.workspaceId;
        const assigned = run
          ? run.taskId === t.id &&
            ((run.role === "revision" && fault.role === "worker") ||
              (run.role === "reviewer" && fault.role === "reviewer")) &&
            !run.released &&
            !run.completion &&
            t.resolution.currentRunId === run.id
          : fault.role === "worker" && !t.completion && t.runId === fault.runId;
        if (agentId && assigned) {
          try {
            const state = await this.resolution.onTaskHost(run ?? t, () =>
              this.resolution.host.observe(agentId),
            );
            if (
              state.id === agentId &&
              state.workspaceId === workspaceId &&
              (await this.resolution.stalls.hasActivity(t, run, state))
            ) {
              const current = this.store.task(t.id),
                recovery = current.resolution.recovery;
              const causeId = digest(`recovery-pending:${t.id}:${incident.id}`);
              const escalations = plannerEscalations(
                this.store.eventsAll(t.id) as LadderEvent[],
              ).filter((e) => e.cause === causeId);
              const latestRun = run ? this.store.run(run.id) : null;
              if (
                !escalations.some((e) => e.answered) &&
                recoveryContinuationMatches({ task: [t, current] }) &&
                recovery?.id === incident.id &&
                ["pending", "escalated"].includes(recovery.status) &&
                !recovery.runId &&
                !recovery.action &&
                current.resolution.incident?.id === fault.id &&
                ["reconciling", "escalated"].includes(
                  current.resolution.incident.status,
                ) &&
                !current.resolution.stalledTurnStop &&
                (run
                  ? current.resolution.currentRunId === run.id &&
                    latestRun &&
                    !latestRun.released &&
                    !latestRun.completion &&
                    latestRun.agentId === agentId &&
                    latestRun.workspaceId === workspaceId
                  : current.runId === fault.runId &&
                    current.agentId === agentId &&
                    current.workspaceId === workspaceId &&
                    !current.completion)
              ) {
                this.store.transaction(() => {
                  for (const escalation of escalations) {
                    this.store.event(
                      t.id,
                      "planner_escalation_resolved",
                      `${escalation.id}: stall ended before action`,
                    );
                    closeEscalationFollowups(this.store, t.id, escalation.id);
                  }
                  this.resolution.update(
                    current,
                    {
                      attention: false,
                      recoveryActive: false,
                      stop: null,
                      recovery: {
                        ...recovery,
                        status: "resolved",
                        summary: "Stall ended before recovery acted",
                      },
                      incident: {
                        ...current.resolution.incident!,
                        status: "resolved",
                        detail: "Stall ended before recovery acted",
                        updatedAt: now(),
                      },
                    },
                    {
                      phase:
                        run?.role === "reviewer"
                          ? "reviewing"
                          : run?.role === "revision"
                            ? "changes_requested"
                            : "working",
                      reason: "Run active again",
                    },
                    "stall_ended",
                    fault.runId!,
                  );
                });
                continue;
              }
            }
          } catch {
            /* An unavailable observation cannot settle the episode. */
          }
        }
      }
      if (!incident?.runId) {
        // Papercut 0489ea25: a pending episode with no run is invisible unless it
        // reaches someone. The pending event is its clock; a legitimate capacity,
        // dispatch or route wait clears the episode (`wait`) instead of leaving it.
        // Paused, dispatch-held and accepted-action episodes are not silent: their
        // own wait or owner owns them and moves no escalation here.
        const pendingSince =
          incident?.status === "pending" && !incident.action
            ? (this.store
                .eventsAll(t.id)
                .findLast((event) => event.kind === "recovery_pending")?.at ??
              null)
            : null;
        // A planner's recorded task, time or decision wait owns the next action.
        // It is not an empty recovery episode waiting for a coordinator launch.
        const ownerWaitActive = Boolean(
          t.resolution.stop && isWaitingTaskStop(t.resolution.stop.reason),
        );
        if (
          incident &&
          pendingSince &&
          !this.resolution.startsNoRuns() &&
          !dispatchBlocked(t) &&
          !ownerWaitActive &&
          Date.now() - Date.parse(pendingSince) >= this.context.pendingBoundMs()
        ) {
          // Check the exact owner again before timing out a pending recovery.
          // A cached running flag alone also describes stalled turns.
          const owner = t.resolution.currentRunId
            ? this.store.run(t.resolution.currentRunId)
            : null;
          const candidate =
            owner?.taskId === t.id &&
            (owner.role === "reviewer" || owner.role === "revision") &&
            !owner.released &&
            !owner.completion
              ? owner
              : null;
          const initialWorker = !t.resolution.currentRunId && !t.completion;
          const agentId =
            candidate?.agentId ?? (initialWorker ? t.agentId : null);
          if (agentId && !t.resolution.stalledTurnStop) {
            try {
              const state = await this.resolution.onTaskHost(
                candidate ?? t,
                () => this.resolution.host.observe(agentId),
              );
              if (
                state.id === agentId &&
                state.workspaceId === (candidate ?? t).workspaceId &&
                !["gone", "closed", "error"].includes(state.status) &&
                (await this.resolution.stalls.hasActivity(t, candidate, state))
              )
                continue;
            } catch {
              /* A failed read does not prove progress. */
            }
            // A report or owner action may have landed while the host was queried.
            if (
              this.resolution.stopped() ||
              this.resolution.startsNoRuns() ||
              !recoveryContinuationMatches({
                task: [t, this.store.task(t.id)],
                ...(candidate
                  ? { run: [candidate, this.store.run(candidate.id)] }
                  : {}),
              })
            )
              continue;
          }
          const summary = recoveryPendingEscalation(t);
          this.episode.escalate(t, summary);
          this.resolution.openPlannerEscalation(this.store.task(t.id), {
            cause: digest(`recovery-pending:${t.id}:${incident.id}`),
            runId: null,
            question: summary,
            payload: {
              cause: "recovery-pending",
              taskId: t.id,
              runId: null,
              question: summary,
            },
            suggestedVerbs: t.resolution.stop?.suggestedVerbs,
          });
          continue;
        }
        continue;
      }
      let run = this.store.run(incident.runId);
      if (
        isDispositionActive(t) ||
        isDispositionComplete(t) ||
        (dispatchBlocked(t) && !run?.completion)
      )
        continue;
      // Queue #691: a finished task's coordinator gets no further authority. Its silence never escalates
      // the done task, and its report is evidence (Resolution.complete); terminal cleanup releases the run.
      if (["done", "cancelled"].includes(t.phase)) continue;
      if (reviewFenceHoldsCoordinators(t, this.store)) {
        // A finished accepted recovery still settles its bookkeeping while review
        // authorization holds (Spec 050: no verb is refused by a stale record);
        // nothing else about the task moves until authorization returns.
        await this.episode.settleAuthorizationFencedRun(t);
        continue;
      }
      if (
        !run ||
        run.taskId !== t.id ||
        run.role !== "recovery" ||
        (run.released &&
          (!run.completion ||
            resultApplied(this.store, t.id, run.id) ||
            this.episode.bindingFrom(run, incident)?.status !== "pending"))
      )
        continue;
      const episodeId = incident.id;
      const episodeRunId = incident.runId;
      try {
        if (run.generation !== t.coordinatorGeneration) continue;
        if (!run.agentId && !run.released) {
          if (this.resolution.startsNoRuns()) continue;
          const observed = await observeRecoveryCreation(
            this.resolution,
            t,
            run,
          );
          if (this.resolution.stopped() || this.resolution.startsNoRuns())
            return;
          const current = this.store.task(t.id);
          if (
            !recoveryContinuationMatches({
              task: [observed.task, current],
              run: [observed.run, this.store.run(observed.run.id)],
            })
          )
            continue;
          t = current;
          if (dispatchBlocked(t) || reviewFenceHoldsCoordinators(t, this.store))
            continue;
          const creation = observed.lookup;
          if (creation.kind === "absent" && observed.proof) {
            this.episode.releaseAbsent(observed);
            continue;
          }
          const bound = this.store.transaction(() => {
            const binding = this.episode.currentCreation(observed);
            if (!binding) return null;
            const { current, run: latest } = binding;
            if (creation.kind !== "bound") {
              this.episode.escalate(
                current,
                "Coordinator recovery creation is uncertain; no duplicate was launched. Inspect the queue run before retrying.",
              );
              return null;
            }
            const enrolled = {
              ...latest,
              agentId: creation.agentId,
              status: "running" as const,
            };
            this.store.putRun(enrolled);
            this.episode.save(current, { agentId: creation.agentId });
            if (current.coordinatorAgentId !== creation.agentId)
              this.store.update(
                current.id,
                { coordinatorAgentId: creation.agentId },
                "coordinator_assigned",
                creation.agentId,
              );
            return enrolled;
          });
          if (!bound) continue;
          run = bound;
          t = this.store.task(t.id);
        }
        let state: AgentObservation | null = null;
        if (!run.released) {
          const at = now();
          const agentId = run.agentId!;
          let observation: CompletionObservation;
          try {
            observation = {
              kind: "observed",
              state: await this.resolution.onTaskHost(t, () =>
                this.resolution.host.observe(agentId),
              ),
            };
          } catch (error) {
            observation = { kind: "unobservable", error };
          }
          if (this.resolution.stopped()) return;
          const current = this.store.task(t.id);
          if (
            !recoveryContinuationMatches({
              task: [t, current],
              run: [run, this.store.run(run.id)],
            })
          )
            continue;
          t = current;
          if (
            t.resolution.recovery?.id !== episodeId ||
            t.resolution.recovery.runId !== run.id ||
            t.coordinatorGeneration !== run.generation ||
            isDispositionActive(t) ||
            isDispositionComplete(t)
          )
            continue;
          state = observation.kind === "observed" ? observation.state : null;
          if (state && (state.id !== agentId || state.workspaceId !== run.workspaceId))
            throw Error("Recovery coordinator workspace changed");
          const idle = state !== null &&
            !state.active && !state.activeTurnId && !state.permissions &&
            ["idle", "error", "closed"].includes(state.status);
          const reported = timestampCompletion(this.store, run, at);
          const ready = completedTurnCanRelease(reported, observation, at, this.resolution.graceMs);
          const changed = state !== null || reported !== run;
          run = state ? {
            ...reported,
            active: !idle,
            lastObservedAt: at,
            idleSince: idle ? (run.idleSince ?? at) : null,
            participantActivity: runActivityObservation(run, state, at),
          } : reported;
          if (changed) this.store.putRun(run);
          if (this.resolution.startsNoRuns()) continue;
          if (reviewFenceHoldsCoordinators(t, this.store)) {
            await this.episode.settleAuthorizationFencedRun(t);
            continue;
          }
          if (ready) {
            this.store.transaction(() =>
              releaseRunFromRecordedCompletion(this.store, t.id, run!),
            );
            run = this.store.run(run.id)!;
          } else if (!state) {
            if (run.completionReceivedAt) continue;
            if (observation.kind === "unobservable") {
              const error = observation.error;
              // Spec 068 §3: a coordinator whose agent is provably gone is a
              // dead participant like any other, in the same order as the
              // participant observation pass. A host answer that the thread is
              // gone is only a reason to look; the proof (its process gone, or
              // its thread absent or removed on an exact read) is the authority.
              // Without that proof it keeps the escalation below: an archived
              // thread proves nothing and is not a host fault to wait out.
              if (threadGoneError(error)) {
                if ((await this.releaseGoneCoordinator(t, run)) !== "none")
                  continue;
                throw error;
              }
              // Any other failed host call or a transport failure: its host's
              // health takes the sample, and the observation waits for the next
              // pass inside a bound, as a recorded wait.
              const failedHost = hostFaultHost(error);
              if (failedHost || isTransportFailure(error)) {
                if (failedHost)
                  reportHostCallFailure(this.resolution.adapter, failedHost, error);
                if (this.deferCoordinatorObservation(t, run, error)) continue;
                throw error;
              }
              // A read the host could not answer still gets the proof; anything
              // short of it keeps the ordinary handling below.
              if (
                !threadGoneError(error) &&
                (await this.releaseGoneCoordinator(t, run)) !== "none"
              )
                continue;
              throw error;
            }
          } else if (
            (!run.completion &&
              (await this.resolution.resumeTransientProviderThread(t, run, state))) ||
            !idle
          )
            continue;
        }
        if (
          this.resolution.startsNoRuns() ||
          dispatchBlocked(this.store.task(t.id))
        )
          continue;
        const observedTask = this.store.task(t.id);
        if (
          !recoveryContinuationMatches({
            task: [t, observedTask],
            run: [run, this.store.run(run.id)],
          })
        )
          continue;
        t = observedTask;
        incident = t.resolution.recovery;
        if (incident?.id !== episodeId || incident.runId !== episodeRunId)
          continue;
        run = this.store.run(run.id)!;
        if (
          run.status === "running" &&
          state &&
          !run.completion &&
          !incident.action &&
          Date.now() - Date.parse(run.idleSince!) >= this.resolution.graceMs
        ) {
          const failure = missingReportBindingCompletion(
            this.resolution.adapter.helperPath,
            {
              taskId: t.id,
              runId: run.id,
              head: run.head,
              coordinatorGeneration: run.generation,
            },
            state,
          );
          if (failure) {
            this.store.transaction(() => {
              run = { ...this.store.run(run!.id)!, completion: failure };
              this.store.putRun(run);
              this.store.event(t.id, "report_failed", failure.summary);
            });
          }
        }
        const pending =
          incident.action?.status === "pending" ? incident.action : null;
        if (
          incident.action?.status === "applied" ||
          incident.action?.status === "refused"
        ) {
          if (!run.released)
            this.store.putRun({ ...run, released: true, status: "finished" });
          continue;
        }
        if (!run.completion && !pending) {
          if (
            Date.now() - Date.parse(run.idleSince!) >=
            this.resolution.graceMs
          ) {
            this.store.putRun({ ...run, released: true, status: "finished" });
            this.resolution.update(t, { recoveryActive: false });
            this.episode.escalate(t, RECOVERY_STOPPED_WITHOUT_RESULT);
          }
          continue;
        }
        const finishedRun = run;
        const accepted = this.episode.bindingFrom(run, incident);
        const reported = accepted
          ? this.episode.completionFromBinding(t, finishedRun, accepted)
          : null;
        if (
          accepted &&
          ((accepted.reportStatus === "recovered" &&
            reportNamesNoAction(accepted)) ||
            (["blocked", "error"].includes(accepted.reportStatus) &&
              reported?.providerUnavailable !== true))
        ) {
          await observeRecoveryParticipants(this.resolution, t);
          const current = this.store.task(t.id);
          if (
            !recoveryContinuationMatches({
              task: [t, current],
              run: [finishedRun, this.store.run(finishedRun.id)],
            })
          )
            continue;
          t = current;
        }
        // Nucleus's own observation, not the coordinator's claim: a live no-op
        // settles only while an unreleased non-recovery run still holds the lane.
        const live = liveWorkingParticipant(
          this.store.task(t.id),
          this.store.runs(t.id).filter((item) => item.id !== finishedRun.id),
        );
        const liveWait = liveRecoveryWait(t, {
          prerequisite: this.store.dependencyWait(t),
          slot: this.resolution.slotAdmissionReason(t),
        });
        // A live no-op starts no work: do not wait for the working participant's
        // lease. That participant staying active is the reason the report exists.
        if (
          (live || liveWait) &&
          accepted?.status === "pending" &&
          accepted.reportStatus === "recovered" &&
          reportNamesNoAction(accepted)
        ) {
          this.store.transaction(() =>
            this.episode.settleLiveNoOp(
              this.store.task(t.id),
              finishedRun,
              accepted,
            ),
          );
          continue;
        }
        if (
          (live || liveWait) &&
          accepted &&
          reported &&
          ["blocked", "error"].includes(accepted.reportStatus) &&
          reported.providerUnavailable !== true
        ) {
          this.store.transaction(() =>
            this.episode.settleLiveNoOp(
              this.store.task(t.id),
              finishedRun,
              accepted,
            ),
          );
          continue;
        }
        if (!(await this.resolution.lease(t)) || this.resolution.startsNoRuns())
          continue;
        const current = this.store.task(t.id);
        if (
          !recoveryContinuationMatches({
            task: [t, current],
            run: [finishedRun, this.store.run(finishedRun.id)],
          })
        )
          continue;
        t = current;
        if (
          t.responsible &&
          accepted &&
          reported &&
          ["blocked", "error"].includes(accepted.reportStatus) &&
          reported.providerUnavailable !== true
        ) {
          this.store.transaction(() =>
            this.episode.settleFinishedRun(
              this.store.task(t.id),
              finishedRun,
              `Recovery reported ${accepted.reportStatus}: ${accepted.summary}; handing it to the responsible-task planner ladder`,
            ),
          );
          // The ladder's question is the report's own words, so a `cannot`'s
          // reason joins them when the summary does not already carry it
          // (planner ruling db7b10d9).
          const reason =
            accepted.coordinatorAction?.verb === "cannot"
              ? accepted.coordinatorAction.reason
              : null;
          const handoff =
            reason && !reported.summary.includes(reason)
              ? { ...reported, summary: `${reported.summary}; ${reason}` }
              : reported;
          await this.resolution.responsibleBlockerLadder(
            this.store.task(t.id),
            { source: "recovery", runId: finishedRun.id, completion: handoff },
          );
          continue;
        }
        // Only a genuinely retired narrow action applies nothing (nucleus#1388).
        // It is recorded as not applied and its refusal names the owner verb that
        // does the same work now; every other report keeps its own path below.
        const retired =
          accepted?.status === "pending" ? retiredNarrowAction(accepted) : null;
        if (accepted && retired) {
          this.episode.refuseAcceptedAction(
            t,
            run,
            accepted,
            retiredNarrowRefusal(retired),
            needsAttention(this.store.task(t.id), this.store),
          );
          continue;
        }
        // A report that names no owner verb is a settled observation: the
        // coordinator found the work live, or could not act and said why. Nucleus
        // applies nothing, refuses nothing and raises no attention notice; the
        // episode resolves with the report's own words (nucleus#1388). An
        // escalating report keeps its escalation.
        if (accepted?.status === "pending" && reportNamesNoAction(accepted)) {
          if (accepted.reportStatus === "escalate")
            this.store.transaction(() => {
              const latest = this.store.run(finishedRun.id);
              if (latest)
                this.episode.settleFinishedRun(
                  this.store.task(t.id),
                  latest,
                  "the coordinator escalated this stop",
                );
            });
          else
            this.episode.settleObservedNoAction(
              this.store.task(t.id),
              finishedRun,
              accepted,
            );
          continue;
        }
        if (accepted?.status === "pending" && accepted.coordinatorAction) {
          if (this.coordinatorActionHandler)
            await this.coordinatorActionHandler(t, run, accepted);
          else
            this.episode.refuseAcceptedAction(
              t,
              run,
              accepted,
              "the task reconciler cannot apply coordinator owner verbs in this context",
              false,
            );
          continue;
        }
        this.store.transaction(() => {
          const latestRun = this.store.run(finishedRun.id)!;
          t = this.store.task(t.id);
          incident = t.resolution.recovery;
          if (incident?.id !== episodeId || incident.runId !== episodeRunId)
            return;
          const action = this.episode.bindingFrom(latestRun, incident);
          if (
            !action ||
            action.status === "applied" ||
            action.status === "refused"
          ) {
            if (!latestRun.released)
              this.store.putRun({
                ...latestRun,
                completion:
                  latestRun.completion ??
                  (action
                    ? this.episode.completionFromBinding(t, latestRun, action)
                    : null),
                released: true,
                status: "finished",
              });
            return;
          }
          // A pending accepted report that reached here named a verb the shared
          // plan no longer applies to (its episode, generation or task moved on).
          // The stale report is recorded as not applied — audibly, with the
          // escalation kept — and the run releases. The stale action is never
          // executed; a report with no verb settled above as an observation.
          this.episode.refuseAcceptedAction(
            t,
            latestRun,
            action,
            "the report's action no longer applies to this task stop; continue with the owner verbs",
            needsAttention(t, this.store),
          );
        });
      } catch (error) {
        if (this.resolution.startsNoRuns()) continue;
        const reason = error instanceof Error ? error.message : String(error);
        const current = this.store.task(t.id);
        const latest = run ? this.store.run(run.id) : null;
        if (
          !recoveryContinuationMatches({
            task: [t, current],
            ...(run ? { run: [run, latest] } : {}),
          })
        )
          continue;
        t = current;
        incident = current.resolution.recovery;
        const binding =
          latest && incident
            ? this.episode.bindingFrom(latest, incident)
            : null;
        // Observation (or another live check) failed after an authenticated report:
        // keep the pending action and name it. A later pass can still apply it.
        if (binding?.status === "pending")
          this.episode.escalate(
            t,
            escalationSummary(
              `${reason}. ${ACCEPTED_RECOVERY_NOT_APPLIED_PREFIX}${this.episode.acceptedActionIdentity(binding)} remains pending`,
            ),
          );
        else this.episode.escalate(t, escalationSummary(reason));
      }
    }
  }
}
