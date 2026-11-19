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
import {
  reportNamesNoAction,
  retiredNarrowAction,
  retiredNarrowRefusal,
} from "./coordinator-report";
import {
  liveRecoveryWait,
  liveWorkingParticipant,
  observeRecoveryParticipants,
} from "./live-noop";

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
              latestRun.agentId !== run.agentId ||
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
              this.store.task(t.id).version !== t.version
            )
              continue;
            const latest = candidate ? this.store.run(candidate.id) : null;
            if (
              candidate &&
              (!latest ||
                latest.released ||
                latest.completion ||
                latest.agentId !== candidate.agentId)
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
      if (
        isDispositionActive(t) ||
        isDispositionComplete(t) ||
        dispatchBlocked(t)
      )
        continue;
      // Queue #691: a finished task's coordinator gets no further authority. Its silence never escalates
      // the done task, and its report is evidence (Resolution.complete); terminal cleanup releases the run.
      if (["done", "cancelled"].includes(t.phase)) continue;
      const episodeRunId = incident.runId;
      if (reviewFenceHoldsCoordinators(t, this.store)) {
        // A finished accepted recovery still settles its bookkeeping while review
        // authorization holds (Spec 050: no verb is refused by a stale record);
        // nothing else about the task moves until authorization returns.
        await this.episode.settleAuthorizationFencedRun(t);
        continue;
      }
      let run = this.store.run(incident.runId);
      if (!run || run.released) continue;
      try {
        if (run.generation !== t.coordinatorGeneration) {
          const latest = this.store.run(run.id)!;
          const binding = this.episode.bindingFrom(latest, incident);
          if (binding && (binding.status === "pending" || latest.completion)) {
            this.episode.refuseAcceptedAction(
              t,
              latest,
              binding,
              "coordinator generation changed after the accepted report",
              needsAttention(this.store.task(t.id), this.store),
            );
            continue;
          }
          this.store.putRun({
            ...latest,
            released: true,
            status: "superseded",
          });
          this.resolution.update(t, { recoveryActive: false });
          this.episode.save(t, { status: "resolved" });
          continue;
        }
        if (!run.agentId) {
          if (this.resolution.startsNoRuns()) continue;
          const observed = await observeRecoveryCreation(
            this.resolution,
            t,
            run,
          );
          if (this.resolution.stopped() || this.resolution.startsNoRuns())
            return;
          t = this.store.task(t.id);
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
        const state = await this.resolution.onTaskHost(t, () =>
          this.resolution.host.observe(run!.agentId!),
        );
        if (this.resolution.stopped()) return;
        const idle =
          !state.active &&
          !state.permissions &&
          ["idle", "error", "closed"].includes(state.status);
        if (state.workspaceId !== run.workspaceId)
          throw Error("Recovery coordinator workspace changed");
        // Re-read before writing observation: complete() can land during observe and
        // a stale putRun would wipe the accepted completion (#2016).
        const observed = this.store.run(run.id);
        if (!observed || observed.released) continue;
        run = {
          ...observed,
          active: !idle,
          lastObservedAt: now(),
          idleSince: idle ? (observed.idleSince ?? now()) : null,
        };
        this.store.putRun(run);
        if (reviewFenceHoldsCoordinators(this.store.task(t.id), this.store)) {
          await this.episode.settleAuthorizationFencedRun(
            this.store.task(t.id),
          );
          continue;
        }
        if (dispatchBlocked(this.store.task(t.id))) continue;
        if (
          !run.completion &&
          (await this.resolution.resumeTransientProviderThread(t, run, state))
        )
          continue;
        if (!idle || this.resolution.startsNoRuns()) continue;
        t = this.store.task(t.id);
        incident = t.resolution.recovery;
        if (!incident) continue;
        run = this.store.run(run.id)!;
        if (
          run.status === "running" &&
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
          await observeRecoveryParticipants(
            this.resolution,
            this.store.task(t.id),
          );
          t = this.store.task(t.id);
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
          await this.resolution.responsibleBlockerLadder(
            this.store.task(t.id),
            { source: "recovery", runId: finishedRun.id, completion: reported },
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
              if (latest && !latest.released)
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
          incident = t.resolution.recovery!;
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
        t = this.store.task(t.id);
        incident = t.resolution.recovery;
        const latest = incident?.runId ? this.store.run(incident.runId) : null;
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
