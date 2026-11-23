import { recordPromptSize } from "../prompt-text/measure";
import type { LaunchDeliverContext } from "../launch";
import type { LaunchMachinePorts } from "./machine";
import { dispatchBlocked } from "../capacity";
import { taskPrNumber } from "../../forge/index";
import { git } from "../../git/index";
import { NON_DELIVERY_ROUTE_REASON } from "../../recovery/non-delivery";
import {
  assertOrdinaryReviewIdentity,
  ordinaryReviewSource,
} from "../../review/ordinary-review";
import { unreviewedMergeRoute } from "../../../shared/task-view";
import { ownerReviewContext } from "../../review/owner-review-context";
import type { Adapter } from "../../host/adapter";
import {
  proofExecutionRecord,
  recordProofExecution,
} from "../../qa/proof-records";
import { verifyProofSource } from "../../qa/proof-source";
import {
  isPromptTooLargeError,
  redactDiagnostic,
} from "../../recovery/provider-refusal";
import {
  BlockingRecoveryEffectsError,
  blockingRecoveryEffects,
  blockingRecoveryEffectsRefusal,
  recoveryEffectsRefusal,
  reviewEffectWaitKey,
} from "../../recovery/recovery-effects";
import { settleObservedHostEffectOperations } from "../../recovery/effect-gates";
import {
  assertReviewEntryWriterYielded,
  reviewEntryInputForTask,
  type ReviewEntryAdapter,
} from "../../review/review-entry";
import {
  ABSENT_RESOLUTION_REASON,
  HostSnapshotPendingError,
  ProvenPreSendRefusalError,
  coordinative,
  message,
  proofExecutor,
} from "../../recovery/task-reasons";
import {
  isDispositionActive,
  type Profile,
  type Run,
  type Task,
} from "../../../shared/contracts";
import { isTransportFailure } from "../../../shared/transport";
import { HostTransportFault } from "../../host/adapter-routing";
import {
  HostReadRefusalError,
  isHostOperationTimeout,
} from "../../host/errors";
import { threadRunningReason } from "../../intake/thread-waits";
import { waitOnUncertainCreation } from "../../recovery/creation-lookup";
import { declaredLaneDocumentKeys } from "../../planning/brief-lane-documents";
import { dirname } from "node:path";
import { ensureTaskNodeModules } from "../../workspaces/task-node-modules";
import { verifyBargeLeaseAndCustody } from "../../workspaces/barge-allocator";

// Proof executors keep their own refusal path; every other creation waits for its lookup.
/**
 * The detached reviewer round's PR identity (nucleus#1425). A recorded unreviewed external
 * merge of the task's PR binds its exact merged source; any other task keeps the strict
 * open-PR identity.
 */
async function reviewPrIdentity(
  machine: LaunchMachinePorts,
  t: Task,
  number: number,
): Promise<{ url: string; head: string }> {
  const route = unreviewedMergeRoute(t);
  if (!route) return machine.verifyPrIdentity!(t, number);
  return machine.verifyMergedReviewSource!(t, route);
}

// Spec 068 §3: the observation pass settles every role's uncertain creation by
// lookup (`creation-lookup.ts`); these roles also skip the owner stop here.
const creationRoles = new Set<Run["role"]>(["reviewer", "closeout"]);

/** The guard a host re-runs immediately before a reviewer's native send or creation. */
type ReviewAdmissionGuard = {
  allowed: () => Promise<boolean>;
  stillAllowed: () => boolean;
};

/**
 * Deliver the run a launch reserved: the ordinary review custody and checkout
 * proofs, the guarded native send or creation, then the binding and the
 * uncertain or refused settlement when a step throws.
 */
export class RunLaunchDeliver {
  constructor(
    readonly resolution: LaunchDeliverContext,
    private readonly ensureTaskDependencies: typeof ensureTaskNodeModules = ensureTaskNodeModules,
  ) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }
  get machine(): LaunchMachinePorts {
    return this.adapter;
  }
  /**
   * The admission a reviewer send or creation re-proves at its last safe point,
   * after the reservation and the pre-send proofs: an ordinary round's custody,
   * the live PR identity, the writer yield on review entry, the exact source, the
   * pause, dispatch hold, task version, run ownership and effect fence. A retained
   * send and a fresh creation share it. `false` and a thrown ProvenPreSendRefusalError
   * are proven refusals; a blocking effect throws its typed fence so the launch waits.
   * Every ordinary round proves the attached task branch at the reviewed head.
   */
  private reviewAdmission(
    fresh: Task,
    savedRun: Run,
    run: Run,
  ): ReviewAdmissionGuard {
    const version = fresh.version,
      snapshot = this.resolution.ordinaryReviewRuns(fresh.id);
    // The profile proof matches a recorded reviewer binding. A continuation and a
    // review-entry creation keep that proof. An ordinary fresh reviewer replaces
    // the closed reader still recorded on the task, and its reservation already
    // selected and proved the profile it starts with, so it skips the match.
    const matchesBinding =
      Boolean(savedRun.agentId) || Boolean(fresh.reviewEntry);
    const stillAllowed = () => {
      const latest = this.store.task(fresh.id);
      if (
        latest.version !== version ||
        latest.resolution.currentRunId !== run.id ||
        latest.prHead !== run.head ||
        this.resolution.paused() ||
        dispatchBlocked(latest) ||
        isDispositionActive(latest) ||
        snapshot !== this.resolution.ordinaryReviewRuns(fresh.id)
      )
        return false;
      assertOrdinaryReviewIdentity(latest, run.head);
      if (matchesBinding)
        this.resolution.assertReviewProfileIndependent(latest, savedRun);
      const effects = blockingRecoveryEffects(this.store, latest, {
        noticeKinds: "all",
      });
      if (effects.length) throw new BlockingRecoveryEffectsError(effects);
      return true;
    };
    return {
      allowed: async () => {
        if (run.ordinaryDetached)
          await this.resolution.ordinaryRoundCustody(fresh, savedRun);
        const pr = await reviewPrIdentity(
          this.machine,
          fresh,
          taskPrNumber(fresh),
        );
        if (pr.head !== run.head || pr.url !== fresh.prUrl) return false;
        if (fresh.reviewEntry)
          await assertReviewEntryWriterYielded(
            reviewEntryInputForTask(fresh),
            this.adapter as Adapter & ReviewEntryAdapter,
            fresh.id,
          );
        await ordinaryReviewSource(this.store.task(fresh.id), run.head);
        return stillAllowed();
      },
      stillAllowed,
    };
  }
  async deliverLaunchRun(
    t: Task,
    role: Run["role"],
    context: {
      agentId: string | null;
      profile: Profile | null;
      group: string | null;
      workspaceId: string;
      firstReviewEntryWorker: boolean;
      nonDeliveryReplacement: boolean;
      run: Run;
      token: string;
    },
  ): Promise<void> {
    let {
      agentId,
      profile,
      group,
      workspaceId,
      firstReviewEntryWorker,
      nonDeliveryReplacement,
      run,
      token,
    } = context;
    t = this.store.task(t.id);
    // Observation before any refusal (nucleus#1159): an uncertain host-effect
    // control whose effect later evidence has answered is settled here, so this
    // launch gates only on uncertainty the task has yet to answer. Nothing is
    // resent; the settlement is the observation's own record.
    if (settleObservedHostEffectOperations(this.store, t.id).length)
      t = this.store.task(t.id);
    let dispatchInvoked = false;
    try {
      // A follow-up round reads the exact head in the task checkout on its own
      // branch; no launch detaches it (Spec 068 §4). The source is proved in the
      // shape the round reads, before and after the forge observation, which
      // itself reads the branch.
      if (run.ordinaryDetached) {
        await this.resolution.ordinaryRoundCustody(t, run);
        await ordinaryReviewSource(t, run.head);
        await git(t.directory!, "fetch", "origin", `refs/heads/${t.branch}`);
        await this.machine.verifyPr(t, taskPrNumber(t));
        await this.resolution.ordinaryRoundCustody(t, run);
        await ordinaryReviewSource(t, run.head);
      }
      // Ordinary review takes custody of a detached exact-head checkout only
      // after reservation. Recheck its dependencies after that final source
      // transition and before the retained reviewer reads the worktree.
      if (role !== "closeout" && t.workspaceAllocation?.provider === "barge") {
        const bridge = this.adapter.workspaceAllocationBridge;
        await verifyBargeLeaseAndCustody({
          allocation: t.workspaceAllocation,
          saveAllocation: bridge
            ? (updated) => bridge.saveWorkspaceAllocation(t.id, updated)
            : undefined,
          cliOptions: bridge?.bargeCliOptions,
        });
      }
      if (role !== "closeout" && t.directory)
        await this.ensureTaskDependencies(
          t.directory,
          t.repoPath,
          dirname(t.directory),
          t.workspaceAllocation?.provider === "barge"
            ? {
                expectedCommonDir: t.workspaceAllocation.gitCommonDir,
                expectedCheckoutPath: t.workspaceAllocation.checkoutPath,
              }
            : undefined,
        );
      // Proof launch preparation checked the exact source before reservation,
      // but this delivery path may refresh dependencies again. Recheck after
      // that setup and before any executor send or creation.
      if (proofExecutor(role)) {
        const source = await verifyProofSource(t, run.head, { remote: false });
        if (source.tree !== run.proofExecution?.tree)
          throw new Error(
            "Proof source tree changed after run reservation; refusing to start an agent",
          );
      }
      if (agentId) {
        let fresh = this.store.task(t.id);
        // Spec 026: the task's own typed lane-document declaration is the whole
        // source, so a continued run refreshes exactly the pins it was admitted with.
        const references = declaredLaneDocumentKeys(
          fresh.laneDocuments,
          this.store.lanes(),
        );
        const missing = references.keys.filter(
          (key) => !this.store.laneDocument(key),
        );
        const pins = new Map(
          (fresh.laneDocumentPins ?? []).map((pin) => [pin.key, pin]),
        );
        for (const key of references.keys) {
          const document = this.store.laneDocument(key);
          if (document)
            pins.set(key, {
              key,
              version: document.version,
              digest: document.digest,
              text: document.text,
            });
        }
        const refreshedPins = [...pins.values()];
        const issues = [...references.unresolved, ...missing];
        if (
          JSON.stringify(refreshedPins) !==
            JSON.stringify(fresh.laneDocumentPins ?? []) ||
          JSON.stringify(issues) !==
            JSON.stringify(fresh.laneDocumentIssues ?? [])
        ) {
          this.store.update(
            fresh.id,
            { laneDocumentPins: refreshedPins, laneDocumentIssues: issues },
            "lane_document_pins_refreshed",
            "Cited lane documents were refreshed for the continued run",
          );
          fresh = this.store.task(t.id);
        }
        const savedRun = this.store.run(run.id)!;
        const guardedReviewEntry = role === "reviewer" && fresh.reviewEntry;
        const sendGuard =
          run.ordinaryDetached || guardedReviewEntry
            ? this.reviewAdmission(fresh, savedRun, run)
            : undefined;
        dispatchInvoked = true;
        await this.adapter.sendRun!(
          fresh,
          savedRun,
          token,
          null,
          ownerReviewContext(this.store, fresh, savedRun),
          sendGuard,
          this.store.canonicalRepository(fresh.repoPath, fresh.repository)
            ?.affectedTests?.command,
        );
        recordPromptSize(
          this.store,
          fresh.id,
          savedRun.id,
          savedRun.temporaryDirectory,
        );
        if (proofExecutor(run.role)) {
          // Task 582: a continued executor turn is still its own run and its
          // own receipt; the retained thread carries no authority or credit
          // from earlier proof runs.
          const binding = savedRun.proofExecution!;
          recordProofExecution(
            this.store,
            t.id,
            proofExecutionRecord(
              savedRun,
              this.store.task(t.id),
              binding.authorizedBy,
              binding.operationId,
            ),
            `Executor ${agentId} continued for selector ${binding.selector} at ${run.head}`,
          );
        }
      } else {
        if (run.ordinaryDetached) {
          await this.resolution.ordinaryRoundCustody(
            t,
            this.store.run(run.id)!,
          );
          if (!this.machine.verifyPrIdentity)
            throw Error(
              "Ordinary reviewer PR identity observation unavailable",
            );
          const pr = await reviewPrIdentity(this.machine, t, taskPrNumber(t));
          if (pr.head !== run.head || pr.url !== t.prUrl)
            throw Error(
              "Ordinary reviewer PR identity changed before creation",
            );
          await this.resolution.ordinaryRoundCustody(
            t,
            this.store.run(run.id)!,
          );
          if (t.reviewEntry)
            await assertReviewEntryWriterYielded(
              reviewEntryInputForTask(t),
              this.adapter as Adapter & ReviewEntryAdapter,
              t.id,
            );
          await ordinaryReviewSource(t, run.head);
        }
        if (role === "reviewer" && t.reviewEntry && !run.ordinaryDetached) {
          const pr = await this.machine.verifyPrIdentity!(t, taskPrNumber(t));
          if (pr.head !== run.head || pr.url !== t.prUrl)
            throw Error(
              "Review-entry PR identity changed before reviewer creation",
            );
          await assertReviewEntryWriterYielded(
            reviewEntryInputForTask(t),
            this.adapter as Adapter & ReviewEntryAdapter,
            t.id,
          );
          const latest = this.store.task(t.id);
          if (
            latest.resolution.currentRunId !== run.id ||
            latest.prHead !== run.head ||
            this.resolution.paused() ||
            dispatchBlocked(latest) ||
            isDispositionActive(latest)
          )
            throw Error(
              "Review-entry handover changed before reviewer creation",
            );
          await ordinaryReviewSource(latest, run.head);
        }
        const fresh = this.store.task(t.id),
          savedRun = this.store.run(run.id)!;
        dispatchInvoked = true;
        // Fresh creation of a reviewer that is review entry or an ordinary round
        // proves the same admission a retained send does, at the native boundary.
        const launchGuard =
          role === "reviewer" && (fresh.reviewEntry || run.ordinaryDetached)
            ? this.reviewAdmission(fresh, savedRun, run)
            : undefined;
        const created = await this.adapter.createRun!(
          fresh,
          savedRun,
          token,
          null,
          ownerReviewContext(this.store, fresh, savedRun),
          launchGuard,
          this.store.canonicalRepository(fresh.repoPath, fresh.repository)
            ?.affectedTests?.command,
        );
        agentId = created.id;
        if (this.store.run(run.id)?.explicitlyReleasedAt) {
          this.store.event(t.id, "released_run_delivery_observed", `${run.id}: ${agentId}`);
          return;
        }
        recordPromptSize(
          this.store,
          fresh.id,
          savedRun.id,
          savedRun.temporaryDirectory,
        );
        // Review-entry creation follows a fresh writer-yield, exact local
        // checkout and open-PR-head proof immediately before this native send.
        this.store.putRun({ ...this.store.run(run.id)!, agentId });
        if (created.workspaceId !== workspaceId)
          throw new Error("Created run is in the wrong workspace");
        if (role === "reviewer")
          this.resolution.update(
            t,
            { reviewerAgentId: agentId, reviewerProfile: profile },
            t.entrypoint === "proof" && !t.agentId ? { agentId } : {},
          );
        else if (role === "revision" && nonDeliveryReplacement) {
          const latest = this.store.task(t.id);
          const previous =
            latest.agentId && latest.runId && latest.profile
              ? [
                  {
                    agentId: latest.agentId,
                    runId: latest.runId,
                    profile: latest.profile,
                    reason: `${NON_DELIVERY_ROUTE_REASON}: ${latest.profile.provider}/${latest.profile.model} returned a second unchanged blocked/error result`,
                  },
                ]
              : [];
          this.store.update(
            t.id,
            {
              agentId,
              runId: run.id,
              ...(savedRun.temporaryDirectory
                ? { temporaryDirectory: savedRun.temporaryDirectory }
                : {}),
              profile,
              profileGroup: group,
              workerModel: profile!.model,
              workerModels: [
                ...new Set([...latest.workerModels, profile!.model]),
              ],
              retiredWorkers: [...latest.retiredWorkers, ...previous],
              resumePrNumber:
                latest.resumePrNumber ?? latest.completion?.prNumber ?? null,
              resolution: {
                ...latest.resolution,
                nonDeliveryRoutePending: false,
                pendingWorkerInstruction: null,
              },
            },
            "non_delivery_worker_routed",
            `${profile!.provider}/${profile!.model}; same capability as ${previous[0]?.profile.provider ?? "prior provider"}`,
          );
        } else if (role === "revision" && firstReviewEntryWorker)
          this.store.update(
            t.id,
            {
              agentId,
              runId: run.id,
              ...(savedRun.temporaryDirectory
                ? { temporaryDirectory: savedRun.temporaryDirectory }
                : {}),
              profile,
              profileGroup: group,
              workerModel: profile!.model,
              workerModels: [...new Set([...t.workerModels, profile!.model])],
            },
            "review_entry_worker_bound",
            agentId,
          );
        else if (role === "revision" && !t.agentId && t.profile) {
          // Spec 052 (Tom, 2026-11-17): the climb retired the previous worker
          // before this revision. The fresh revision agent becomes the task's
          // retained worker, so the next same-tier revision continues it.
          this.store.update(
            t.id,
            {
              agentId,
              runId: run.id,
              ...(savedRun.temporaryDirectory
                ? { temporaryDirectory: savedRun.temporaryDirectory }
                : {}),
              profile,
              profileGroup: group ?? t.profileGroup ?? null,
              workerModel: profile!.model,
              workerModels: [...new Set([...t.workerModels, profile!.model])],
            },
            "worker_climb_bound",
            agentId,
          );
        } else if (role === "revision" && t.agentId && t.agentId !== agentId) {
          const latest = this.store.task(t.id);
          const previous =
            latest.agentId && latest.runId && latest.profile
              ? [
                  {
                    agentId: latest.agentId,
                    runId: latest.runId,
                    profile: latest.profile,
                    reason: `Report binding lives outside the current data home`,
                  },
                ]
              : [];
          this.store.update(
            t.id,
            {
              agentId,
              runId: run.id,
              ...(savedRun.temporaryDirectory
                ? { temporaryDirectory: savedRun.temporaryDirectory }
                : {}),
              retiredWorkers: [...latest.retiredWorkers, ...previous],
            },
            "report_binding_relaunch",
            agentId,
          );
        } else if (
          coordinative(run) &&
          this.store.task(t.id).coordinatorGeneration === run.generation
        )
          this.store.update(
            t.id,
            { coordinatorAgentId: agentId },
            "coordinator_assigned",
            agentId,
          );
        if (proofExecutor(run.role)) {
          const binding = run.proofExecution!;
          recordProofExecution(
            this.store,
            t.id,
            proofExecutionRecord(
              this.store.run(run.id)!,
              this.store.task(t.id),
              binding.authorizedBy,
              binding.operationId,
            ),
            `Executor ${agentId} activated for selector ${binding.selector} at ${run.head}`,
          );
        }
      }
      if (this.store.run(run.id)?.explicitlyReleasedAt) return;
      this.store.putRun({ ...this.store.run(run.id)!, agentId, status: "running" });
      this.resolution.clearHostReadTransient?.(t.id, "task");
      this.resolution.waiting(
        this.store.task(t.id),
        threadRunningReason(role),
        "lifecycle",
      );
    } catch (error) {
      if (this.store.run(run.id)?.explicitlyReleasedAt) return;
      if (error instanceof BlockingRecoveryEffectsError) {
        const waitReason = `${run.ordinaryDetached ? "Ordinary review" : "Review-entry"} waits for ${recoveryEffectsRefusal(error.effects)}; settle it with retry_effect before continuing`;
        this.store.transaction(() => {
          const latestRun = this.store.run(run.id);
          if (latestRun && !latestRun.released)
            this.store.putRun({
              ...latestRun,
              status: "superseded",
              released: true,
              active: false,
            });
          const latest = this.store.task(t.id);
          if (latest.resolution.currentRunId === run.id)
            this.resolution.update(
              latest,
              { currentRunId: null, attention: false },
              { phase: role === "reviewer" ? "reviewing" : latest.phase },
              "review_waiting_on_effects",
              recoveryEffectsRefusal(error.effects) ?? "",
            );
        });
        this.resolution.waiting(this.store.task(t.id), waitReason, "lifecycle", {
          fact: { code: "review_effect_wait", subject: reviewEffectWaitKey(error.effects) },
        });
        return;
      }
      // A host that has not settled its model options has not refused this run:
      // nothing crossed the send boundary, so the run is released and the task
      // waits for the next pass to read a settled snapshot (nucleus#1375).
      if (error instanceof HostSnapshotPendingError) {
        this.store.transaction(() => {
          const latestRun = this.store.run(run.id);
          if (latestRun && !latestRun.released)
            this.store.putRun({
              ...latestRun,
              status: "superseded",
              released: true,
              active: false,
            });
          if (!agentId) this.store.deleteCredential(run.id);
          const latest = this.store.task(t.id);
          if (latest.resolution.currentRunId === run.id)
            this.resolution.update(
              latest,
              { currentRunId: null, attention: false },
              { phase: role === "reviewer" ? "reviewing" : latest.phase },
              "review_waiting_on_host_snapshot",
              error.detail,
            );
        });
        this.resolution.waiting(
          this.store.task(t.id),
          `Waiting for T3Code to settle the host catalogue: ${error.detail}`,
          "lifecycle",
        );
        return;
      }
      // A proved pre-send transient read failure (e.g. T3 inventory churn on
      // ordinary review admission's custody check) never crossed the send boundary:
      // release the unsent run without counting a launch or raising immediate
      // attention so the caller records the bounded retryable wait.
      if (
        error instanceof HostReadRefusalError &&
        (!dispatchInvoked || !agentId)
      ) {
        this.store.transaction(() => {
          const latestRun = this.store.run(run.id);
          if (latestRun && !latestRun.released)
            this.store.putRun({
              ...latestRun,
              status: "superseded",
              released: true,
              active: false,
            });
          if (!agentId) this.store.deleteCredential(run.id);
          const latest = this.store.task(t.id);
          if (latest.resolution.currentRunId === run.id)
            this.resolution.update(
              latest,
              { currentRunId: null },
              { phase: role === "reviewer" ? "reviewing" : latest.phase },
              "launch_transient_read_wait",
              error.message,
            );
        });
        throw error;
      }
      // A provider size rejection proves the prompt was refused before send:
      // nothing was bound or delivered, so the run settles as refused with a
      // pre-send receipt instead of `uncertain`. The next attempt dispatches
      // the bounded prompt. An ordinary retained round's own pre-send fence
      // settles the same way. A proven refusal on any other creation settles
      // the same: exact-lookup recovery would find nothing and a replacement
      // creation would refuse identically, so the task stops in attention with
      // the step that failed named (nucleus#1139).
      const reviewEntryGuarded = role === "reviewer" && t.reviewEntry;
      const creationRefusal =
        !agentId &&
        dispatchInvoked &&
        !run.ordinaryDetached &&
        !reviewEntryGuarded &&
        error instanceof ProvenPreSendRefusalError;
      if (
        !dispatchInvoked &&
        (run.ordinaryDetached || reviewEntryGuarded) &&
        !(error instanceof ProvenPreSendRefusalError) &&
        !isPromptTooLargeError(error) &&
        (isTransportFailure(error) ||
          isHostOperationTimeout(error) ||
          error instanceof HostTransportFault)
      ) {
        this.store.transaction(() => {
          this.store.putRun({
            ...this.store.run(run.id)!,
            status: "superseded",
            released: true,
          });
          this.store.deleteCredential(run.id);
          const current = this.store.task(t.id);
          if (current.resolution.currentRunId === run.id)
            this.resolution.update(current, { currentRunId: null });
        });
        throw error;
      }
      if (
        isPromptTooLargeError(error) ||
        creationRefusal ||
        ((run.ordinaryDetached || reviewEntryGuarded) &&
          (!dispatchInvoked || error instanceof ProvenPreSendRefusalError))
      ) {
        const tooLarge = isPromptTooLargeError(error);
        const creationStep = creationRefusal
          ? role === "reviewer"
            ? "Reviewer creation"
            : role === "revision"
              ? "Worker creation"
              : "Coordinator creation"
          : "";
        const reason = tooLarge
          ? `Review prompt refused before send for size: ${redactDiagnostic(error instanceof Error ? error.message : String(error))}`
          : creationRefusal
            ? `${creationStep} refused before send: ${(error as ProvenPreSendRefusalError).reason}`
            : `${run.ordinaryDetached ? "Ordinary review" : "Review-entry"} reviewer refused before send: ${message(error)}`;
        this.store.transaction(() => {
          this.store.putRun({
            ...this.store.run(run.id)!,
            status: "superseded",
            released: true,
          });
          this.store.deleteCredential(run.id);
          const current = this.store.task(t.id);
          if (current.resolution.currentRunId === run.id)
            this.resolution.update(
              current,
              { currentRunId: null, attention: true },
              { phase: "needs_attention", reason },
              tooLarge
                ? "review_prompt_refused_before_send"
                : creationRefusal
                  ? "creation_refused_before_send"
                  : "ordinary_review_refused_before_send",
              run.id,
            );
        });
        // The typed refusal carries the pre-send receipt to the operation
        // layer; the ordinary fence already proved its own refusal.
        if (tooLarge) throw new ProvenPreSendRefusalError(reason);
        return;
      }
      this.store.putRun({ ...this.store.run(run.id)!, status: "uncertain" });
      // Record the exact-lookup window now: automatic reconciliation owns the fault before any coordinator can engage.
      this.resolution.ensureIncident(
        this.store.task(t.id),
        run,
        ABSENT_RESOLUTION_REASON,
        "exact_lookup",
      );
      // An uncertain creation is decided by its exact lookup, which observation runs for every pending
      // run. The thrown error must not write an operator stop that blocks that lookup (a host call past
      // its deadline never answers, so its exact lookup is the only exit).
      if (
        !agentId &&
        dispatchInvoked &&
        !run.ordinaryDetached &&
        creationRoles.has(role)
      ) {
        waitOnUncertainCreation(
          this.resolution,
          this.store.task(t.id),
          role,
          run.id,
          error,
        );
        return;
      }
      throw error;
    }
  }
}
