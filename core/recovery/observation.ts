import { runActivityObservation } from "../telemetry/task-activity-observation";
import { missingReportBindingCompletion } from "../intake/reporting-failure";
import {
  observeReviewerReplacement,
  releaseUnreachableRun,
} from "../workspaces/thread-archive-replacement";
/**
 * One sweep of unreleased runs: observe each pending run's agent, then settle,
 * recover, remind or leave it. `Resolution.observe` and `observationTargets`
 * delegate here, so callers and test overrides keep the same entry points.
 */
import {
  type Run,
  isDispositionActive,
  isDispositionComplete,
  pausedStopWaitReason,
} from "../../shared/contracts";
import { coordinative, stages, active } from "./task-reasons";
import { dispatchBlocked } from "../dispatch/capacity";
import {
  reviewAuthorizationRequired,
  reviewContinuationState,
  reviewInProgress,
  reviewContinuationWait,
} from "../review/review-continuation";
import { type AgentObservation } from "../host/adapter";
import { now } from "../store/store";
import { isQuotaExhaustion, providerRetryAt } from "./exhaustion";
import { isTransportFailure } from "../../shared/transport";
import {
  LoginSessionFaultError,
  isLoginSessionFault,
} from "../../shared/session-fault";
import type { Resolution } from "../resolution";
import { settlementHeld, startsNoRuns } from "../closeout/queue-drain";
import { hostFaultHost, reportHostCallFailure } from "../host/adapter-routing";
import { HostReadRefusalError } from "../host";
import { readHostReadTransientEpisode } from "./host-read-transient";
import { runsUnchangedSince } from "./observation-advance";

export type ObservationContext = Pick<
  Resolution,
  | "adapter"
  | "attention"
  | "environmentDeferred"
  | "extendCallbackReminder"
  | "graceMs"
  | "heavyRunAlive"
  | "host"
  | "hostAvailable"
  | "hostReadTransientFailure"
  | "clearHostReadTransient"
  | "inventoryHostMatches"
  | "launchingRuns"
  | "onTaskHost"
  | "orphanRuns"
  | "paused"
  | "reconcileStalledTurnStop"
  | "recoverRefusedReviewer"
  | "remindStoppedRun"
  | "resolveIncident"
  | "resumeTransientProviderThread"
  | "retainedProfileIssue"
  | "stalls"
  | "stopped"
  | "store"
  | "supersedeOrphans"
  | "transportDeferred"
  | "update"
  | "waiting"
  | "withHost"
>;

export class Observation {
  constructor(readonly resolution: ObservationContext) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }
  get graceMs() {
    return this.resolution.graceMs;
  }

  /**
   * The pending runs one pass would observe, before its per-run identity and
   * authority checks. Audit A6 reads this only to decide which identities to ask
   * the shared inventory for; `observe` stays the authoritative walk and falls
   * back to a narrow read for anything the inventory does not answer.
   */
  private observationRuns(): Run[] {
    return this.store
      .pendingRuns()
      .filter(
        (r) =>
          r.role !== "recovery" && !this.resolution.launchingRuns.has(r.id),
      )
      .filter(
        (r) =>
          !r.released ||
          (r.status === "superseded" &&
            (!coordinative(r) ||
              r.generation ===
                this.store.task(r.taskId).coordinatorGeneration) &&
            stages.includes(this.store.task(r.taskId).phase) &&
            this.store.task(r.taskId).phase !== "done"),
      );
  }
  /** The agent identities one observation pass may read, for the shared per-pass inventory. */
  observationTargets(): string[] {
    const ids: string[] = [];
    for (const original of this.observationRuns()) {
      const run = this.store.run(original.id);
      if (!run?.agentId) continue;
      const task = this.store.task(run.taskId);
      if (!this.resolution.hostAvailable(task, run)) continue;
      if (isDispositionActive(task) || isDispositionComplete(task)) continue;
      if (dispatchBlocked(task) && !run.completion) continue;
      ids.push(run.agentId);
    }
    return ids;
  }
  /**
   * Audit A6: `inventory` is the pass's one complete labelled Paseo inventory.
   * An identity it answers is used as read; anything it does not answer — absent,
   * partial or unreadable — takes the narrow fresh per-agent observation, so a
   * list can never turn missing evidence into inactivity.
   */
  async observe(
    inventory?: ReadonlyMap<string, AgentObservation> | null,
    completedTaskId?: string,
    onReleased?: (taskId: string) => void,
    scopedHost?: string,
  ) {
    // A task wake observes its reported runs and active runs with stale observations.
    // The ordinary inventory pass retains its broader recovery responsibilities.
    const candidates = completedTaskId
      ? this.store
          .runs(completedTaskId)
          .filter(
            (run) =>
              run.role !== "recovery" &&
              !run.released &&
              (run.completion ||
                (run.active &&
                  Date.now() -
                    Date.parse(run.lastObservedAt ?? run.createdAt) >=
                    16000)) &&
              !this.resolution.launchingRuns.has(run.id),
          )
      : this.observationRuns();
    if (!scopedHost) {
      const hosts = new Set(
        candidates.flatMap((run) => (run.hostId ? [run.hostId] : [])),
      );
      for (const hostId of hosts) {
        try {
          await this.resolution.withHost(hostId, () =>
            this.observe(
              this.resolution.inventoryHostMatches(hostId) ? inventory : null,
              completedTaskId,
              onReleased,
              hostId,
            ),
          );
        } catch (error) {
          // One failed host read fails only this host's observation step (Spec 069
          // §2): its health takes the sample, no run on it is written, and the next
          // pass observes them again.
          const failedHost = hostFaultHost(error);
          if (!failedHost) throw error;
          reportHostCallFailure(this.adapter, failedHost, error);
        }
      }
      return;
    }
    for (const original of candidates) {
      if (original.hostId !== scopedHost) continue;
      if (this.resolution.stopped()) return;
      let run = this.store.run(original.id)!;
      const task = this.store.task(run.taskId);
      try {
        if (!this.resolution.hostAvailable(task, run)) continue;
        if (isDispositionActive(task) || isDispositionComplete(task)) continue;
        if (
          !dispatchBlocked(task) &&
          !settlementHeld(this.store, this.resolution.stopped()) &&
          (await observeReviewerReplacement(this.store, this.adapter, run))
        )
          continue;
        // An operator stop preserves its lease and checkpoint.
        if (dispatchBlocked(task) && !run.completion) continue;
        if (!run.agentId) {
          if (
            settlementHeld(this.store, this.resolution.stopped()) ||
            run.released
          )
            continue;
          const current = this.store.task(task.id);
          if (!current.resolution.stop) {
            const roleLabel =
              run.role === "recovery" ? "coordinator" : run.role;
            this.resolution.waiting(
              current,
              `Uncertain ${run.role} creation ${run.id}; use run.start ${roleLabel} fresh replacing=${run.id} or run.release run=${run.id}`,
              "lifecycle",
              { fact: { code: "creation_lookup", subject: run.id } },
            );
          }
          continue;
        }
        const observationStartedAt = now();
        // A superseded or replaced run whose thread its host reports archived or
        // gone can never report or take another turn. Releasing it here keeps the
        // archive the same proof the ordinary archive path accepts, so the run
        // neither reminds nor fences the next launch or relaunch. Anything short
        // of that direct answer stays unknown and falls through to the ordinary
        // observation below.
        if (
          await releaseUnreachableRun(this.store, this.adapter, run, () =>
            settlementHeld(this.store, this.resolution.stopped()),
          )
        )
          continue;
        // Checkpoint delivery can occur after the pass's inventory was read.
        // Its new turn needs a narrow read started against the delivered state.
        const state =
          (reviewInProgress(run) ? null : inventory?.get(run.agentId!)) ??
          (await this.resolution.onTaskHost(run, () =>
            this.resolution.host.observe(run.agentId!),
          ));
        if (this.resolution.stopped()) return;
        const latest = this.store.run(run.id);
        if (!latest || JSON.stringify(latest) !== JSON.stringify(run)) continue;
        const transientBeforeClear = readHostReadTransientEpisode(
          this.store,
          task.id,
          "task",
        );
        this.resolution.clearHostReadTransient?.(task.id, "task");
        const taskStop = this.store.taskOrNull(task.id);
        if (
          taskStop &&
          transientBeforeClear?.movedToAttention &&
          transientBeforeClear.resumePhase &&
          taskStop.phase === "needs_attention"
        ) {
          this.resolution.update(
            taskStop,
            { stop: null },
            {
              phase: transientBeforeClear.resumePhase,
              reason: "Fresh host observation recovered; resuming task",
            },
            "host_read_transient_phase_restored",
            transientBeforeClear.resumePhase,
          );
        } else if (
          taskStop &&
          (taskStop.resolution.stop?.reason === "external_unavailable" ||
            transientBeforeClear?.exhaustedAt != null)
        )
          this.resolution.update(
            taskStop,
            { stop: null },
            {},
            "task_wait_cleared",
            taskStop.resolution.stop?.reason ?? "host_read_transient",
          );
        if (state.id !== run.agentId || state.workspaceId !== run.workspaceId)
          throw new Error(
            "Observed agent or workspace differs from the recorded run lease",
          );
        const busy = active(state) || Boolean(state.activeTurnId);
        if (!busy && !["idle", "error", "closed"].includes(state.status)) {
          if (state.status === "gone")
            this.store.putRun({ ...run, participantActivity: runActivityObservation(run, state, observationStartedAt) });
          throw new Error("Run state is unknown");
        }
        if (
          !busy &&
          !run.released &&
          this.resolution
            .orphanRuns(task.id, run.agentId!)
            .some((orphan) => orphan.id === run.id)
        ) {
          const settled = this.store.transaction(() =>
            this.resolution.supersedeOrphans(
              task.id,
              this.resolution
                .orphanRuns(task.id, run.agentId!)
                .filter((orphan) => orphan.id === run.id),
            ),
          );
          if (settled.length)
            this.adapter.purgeReportingFiles?.(task.id, settled);
          continue;
        }
        if (run.role === "revision" && state.model) {
          const current = this.store.task(task.id);
          if (!current.workerModels.includes(state.model))
            this.store.update(task.id, {
              workerModel: state.model,
              workerModels: [
                ...new Set([...current.workerModels, state.model]),
              ],
            });
        }
        run = {
          ...this.store.run(run.id)!,
          active: busy,
          lastObservedAt: observationStartedAt,
          lastActivityAt: state.updatedAt || null,
          participantActivity: runActivityObservation(run, state, observationStartedAt),
          idleSince: busy ? null : (run.idleSince ?? observationStartedAt),
        };
        this.store.putRun(run);
        if (
          settlementHeld(this.store, this.resolution.stopped()) ||
          run.released
        )
          continue;
        if (dispatchBlocked(this.store.task(task.id))) {
          if (
            run.completion &&
            !busy &&
            ["idle", "error", "closed"].includes(state.status)
          )
            this.store.putRun({ ...run, status: "finished", released: true });
          continue;
        }
        // Pause still releases a finished idle thread and skips resume, replace
        // and continuation. An exhausted run stays bound so resume can replace it.
        if (startsNoRuns(this.store, this.resolution.stopped())) {
          const exhausted =
            isQuotaExhaustion(state.error) ||
            Boolean(run.exhaustionReason && !run.completion);
          // Recovery escalate/actions stay bound so unpause can apply them.
          if (
            run.role !== "recovery" &&
            run.completion &&
            !busy &&
            ["idle", "error", "closed"].includes(state.status) &&
            !exhausted
          )
            this.store.putRun({ ...run, status: "finished", released: true });
          continue;
        }
        // A checkpoint fences new work, not observation or another run's
        // release. Keep continuation delivery on its ordinary admission path;
        // the current reader's saved activity must still reflect this pass.
        if (
          run.id === this.store.task(task.id).resolution.currentRunId &&
          !run.completion &&
          reviewAuthorizationRequired(this.store.task(task.id), this.store) &&
          reviewContinuationState(this.store.task(task.id), this.store) !==
            "continuing"
        )
          continue;
        if (
          this.resolution.reconcileStalledTurnStop(
            this.store.task(task.id),
            run,
            state,
          )
        )
          continue;
        if (
          await this.resolution.resumeTransientProviderThread(
            this.store.task(task.id),
            run,
            state,
          )
        )
          continue;
        if (
          run.role !== "revision" &&
          (!coordinative(run) ||
            this.store.task(task.id).coordinatorGeneration === run.generation)
        ) {
          // A callback can describe auxiliary-provider failures. Subscription
          // failover is safe only when Paseo attributes quota exhaustion to the
          // exact agent that owns this Queue run.
          const failed = isQuotaExhaustion(state.error);
          if (failed || (run.exhaustionReason && !run.completion)) {
            const group =
              run.profileGroup ??
              (run.profile &&
                this.store.pool().find((p) => p.profileId === run.profile!.id)
                  ?.group);
            if (!group) {
              this.resolution.attention(
                task,
                "Exhausted role has no known subscription profile; remap it explicitly",
              );
              continue;
            }
            const reason =
              run.exhaustionReason || run.completion?.summary || state.error;
            if (!run.exhaustionReason)
              this.store.transaction(() => {
                this.store.setAvailability(
                  group,
                  JSON.stringify({
                    group,
                    unavailable: true,
                    reason: reason.slice(0, 2000),
                    retryAt: providerRetryAt(
                      state.error,
                      run.completion?.providerRetryAt,
                    ),
                  }),
                );
                run = { ...run, exhaustionReason: reason.slice(0, 2000) };
                this.store.putRun(run);
                this.store.event(
                  task.id,
                  "provider_exhausted",
                  `${run.role}: ${group}: ${reason.slice(0, 2000)}`,
                );
              });
            if (busy) continue;
            if (!["idle", "error", "closed"].includes(state.status))
              throw new Error("Exhausted role has not released its workspace");
            const current = this.store.task(task.id);
            if (current.resolution.roleReplacements >= 8) {
              this.resolution.attention(
                current,
                "Role replacement limit reached; operator attention required",
              );
              continue;
            }
            this.store.transaction(() => {
              this.store.putRun({
                ...run,
                status: "superseded",
                released: true,
              });
              if (run.role === "reviewer")
                this.resolution.update(
                  current,
                  {
                    currentRunId: null,
                    reviewerAgentId: null,
                    reviewerProfile: null,
                    review: null,
                    attention: false,
                    roleReplacements: current.resolution.roleReplacements + 1,
                  },
                  {
                    phase: "awaiting_review",
                    reason: "Replacing exhausted reviewer",
                  },
                  "role_replacement",
                );
              else if (run.role === "executor")
                this.resolution.update(
                  current,
                  {
                    currentRunId: null,
                    attention: false,
                    roleReplacements: current.resolution.roleReplacements + 1,
                  },
                  {
                    phase: run.proofExecution?.returnPhase ?? "awaiting_review",
                    reason:
                      "Exhausted proof executor released; returning to the prior phase",
                  },
                  "role_replacement",
                );
              else
                this.resolution.update(
                  current,
                  {
                    currentRunId: null,
                    attention: false,
                    coordinatorWorkspaceId: run.workspaceId,
                    roleReplacements: current.resolution.roleReplacements + 1,
                  },
                  {
                    coordinatorAgentId: "",
                    coordinatorGeneration: current.coordinatorGeneration + 1,
                    phase: run.role === "closeout" ? "syncing" : "verifying",
                    reason: "Replacing exhausted coordinator",
                  },
                  "role_replacement",
                );
            });
            continue;
          }
        }
        if (busy) {
          // Mid-turn stall detection is brief scope: revision and reviewer runs
          // only. Closeout coordinators keep their existing
          // callback-reminder recovery, and a long shell command shows on the
          // task instead of reading as healthy work.
          if (run.role === "revision" || run.role === "reviewer") {
            const notice = await this.resolution.stalls.check(
              this.store.task(task.id),
              run,
              state,
            );
            this.resolution.stalls.settleNotice(
              this.store.task(task.id),
              notice,
            );
          }
          continue;
        }
        if (!["idle", "error", "closed"].includes(state.status))
          throw new Error("Run state is unknown");
        const current = this.store.task(task.id);
        if (
          run.role === "reviewer" &&
          !run.completion &&
          !run.pausedStop &&
          current.resolution.currentRunId === run.id
        ) {
          const latestRun = this.store.run(run.id)!;
          const issue = this.resolution.retainedProfileIssue(latestRun.profile);
          if (issue && !latestRun.completion && !latestRun.released) {
            if (current.resolution.roleReplacements >= 8) {
              this.resolution.attention(
                current,
                "Role replacement limit reached; operator attention required",
              );
              continue;
            }
            this.store.transaction(() => {
              this.store.putRun({
                ...latestRun,
                status: "superseded",
                released: true,
              });
              this.resolution.update(
                current,
                {
                  currentRunId: null,
                  reviewerAgentId: null,
                  reviewerProfile: null,
                  review: null,
                  attention: false,
                  roleReplacements: current.resolution.roleReplacements + 1,
                },
                {
                  phase: "awaiting_review",
                  reason: `Replacing unavailable reviewer (${issue})`,
                },
                "role_replacement",
              );
            });
            continue;
          }
        }
        if (
          coordinative(run) &&
          current.coordinatorGeneration !== run.generation
        ) {
          this.store.putRun({ ...run, status: "superseded", released: true });
          if (current.resolution.currentRunId === run.id)
            this.resolution.update(current, {
              currentRunId: null,
              attention: false,
            });
          continue;
        }
        if (
          run.status === "running" &&
          !run.completion &&
          !run.pausedStop &&
          Date.now() - Date.parse(run.idleSince!) >= this.graceMs
        ) {
          const failure = missingReportBindingCompletion(
            this.adapter.helperPath,
            {
              taskId: task.id,
              runId: run.id,
              head: run.head,
              coordinatorGeneration: run.generation,
            },
            state,
          );
          if (failure)
            this.store.transaction(() => {
              run = { ...this.store.run(run.id)!, completion: failure };
              this.store.putRun(run);
              this.store.event(task.id, "report_failed", failure.summary);
            });
        }
        // A delivered continuation whose reviewer turn has stopped is not
        // "continuing": record the current stop from these facts so the task names
        // the delivered checkpoint and the exits it has, instead of claiming work
        // that is not running (project-c #155 checkpoint 3 at 889a6d0, where the
        // reviewer failed on provider capacity after a delivered continuation).
        if (
          run.role === "reviewer" &&
          !run.completion &&
          run.active === false &&
          !run.reviewBudgetExhaustedAt &&
          !run.retainedAgentClosedAt &&
          reviewContinuationState(this.store.task(task.id), this.store) ===
            "continuing"
        ) {
          const current = this.store.task(task.id);
          const wait = reviewContinuationWait(current, this.store);
          if (wait.stop === "operator_needed")
            this.resolution.waiting(current, wait.reason, wait.stop);
        }
        if (run.completion) {
          this.store.putRun({ ...run, status: "finished", released: true });
        } else if (run.status === "uncertain" || run.status === "intent") {
          this.resolution.attention(
            current,
            "Prompt delivery is uncertain; inspect the retained thread before retrying",
          );
        } else if (run.pausedStop) {
          // Queue #650: the operator stopped this thread while Queue was paused.
          // No reminder, refusal recovery or replacement races the unpause resume;
          // the task names the visible paused-stop wait until the thread resumes.
          this.resolution.waiting(
            current,
            pausedStopWaitReason(run.role),
            "paused_stop",
          );
        } else if (
          await this.resolution.heavyRunAlive(this.store.task(task.id))
        ) {
          this.resolution.extendCallbackReminder(
            this.store.task(task.id),
            run.id,
          );
        } else if (Date.now() - Date.parse(run.idleSince!) >= this.graceMs) {
          if (
            await this.resolution.recoverRefusedReviewer(
              this.store.task(task.id),
              run,
            )
          )
            continue;
          // Replaced is not released (planner ruling, 2026-11-09): the replaced
          // run's claim ends when it ends without a verdict — a proven-closed run
          // settles here; a checkpointed idle run holds remaining work and settles
          // when the review settles instead. The release revokes its credential
          // and tickets unconditionally.
          if (
            run.replacedAt &&
            !run.completion &&
            !run.released &&
            (state.status === "closed" || !run.reviewCheckpoints?.length)
          ) {
            this.store.putRun({ ...run, released: true });
            continue;
          }
          await this.resolution.remindStoppedRun(this.store.task(task.id), run);
        }
      } catch (error) {
        // A failed host read fails only this run's observation (Spec 069 §2): its
        // host's health takes the sample, and the next pass observes the run again.
        const failedHost = hostFaultHost(error);
        if (failedHost) {
          reportHostCallFailure(this.adapter, failedHost, error);
          continue;
        }
        if (
          this.resolution.paused() ||
          dispatchBlocked(this.store.task(task.id))
        )
          continue;
        if (error instanceof HostReadRefusalError) {
          if (this.resolution.hostReadTransientFailure) {
            this.resolution.hostReadTransientFailure(
              this.store.task(task.id),
              error,
              "Participant observation",
            );
          } else {
            this.resolution.waiting(
              this.store.task(task.id),
              error.message,
              "external_unavailable",
            );
          }
          continue;
        }
        // A transport failure is not a task fault: leave the lane where it is so the next
        // sweep retries it, instead of parking it and letting the daemon's error text
        // become a worker instruction.
        if (
          isTransportFailure(error) ||
          error instanceof LoginSessionFaultError ||
          isLoginSessionFault(error)
        ) {
          if (
            error instanceof LoginSessionFaultError ||
            isLoginSessionFault(error)
          )
            this.resolution.environmentDeferred(
              this.store.task(task.id),
              error,
            );
          else
            this.resolution.transportDeferred(this.store.task(task.id), error);
          continue;
        }
        this.resolution.attention(
          task,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (!original.released && this.store.run(original.id)?.released)
          onReleased?.(task.id);
      }
    }
  }
}
