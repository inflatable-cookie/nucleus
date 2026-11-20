import { recordPromptSize } from '../prompt-text/measure';
import type { LaunchDeliverContext } from '../launch';
import type { LaunchMachinePorts } from './machine';
import { dispatchBlocked } from '../capacity';
import { taskPrNumber } from '../../forge/index';
import { git } from '../../git/index';
import { NON_DELIVERY_ROUTE_REASON } from '../../recovery/non-delivery';
import { assertOrdinaryReviewIdentity, ordinaryReviewSource } from '../../review/ordinary-review';
import { unreviewedMergeRoute } from '../../../shared/task-view';
import { ownerReviewContext } from '../../review/owner-review-context';
import type { Adapter } from '../../host/adapter';
import { proofExecutionRecord, recordProofExecution } from '../../qa/proof-records';
import { verifyProofSource } from '../../qa/proof-source';
import { isPromptTooLargeError, redactDiagnostic } from '../../recovery/provider-refusal';
import { BlockingRecoveryEffectsError, blockingRecoveryEffects, blockingRecoveryEffectsRefusal, recoveryEffectsRefusal } from '../../recovery/recovery-effects';
import { settleObservedHostEffectOperations } from '../../recovery/effect-gates';
import { assertReviewEntryWriterYielded, reviewEntryInputForTask, type ReviewEntryAdapter } from '../../review/review-entry';
import { ABSENT_RESOLUTION_REASON, HostSnapshotPendingError, ProvenPreSendRefusalError, coordinative, message, proofExecutor } from '../../recovery/task-reasons';
import { isDispositionActive, type Profile, type Run, type Task } from '../../../shared/contracts';
import { isTransportFailure } from '../../../shared/transport';
import { HostTransportFault } from '../../host/adapter-routing';
import { isHostOperationTimeout } from '../../host/errors';
import { threadRunningReason } from '../../intake/thread-waits';
import { declaredLaneDocumentKeys } from '../../planning/brief-lane-documents';
import { dirname } from 'node:path';
import { ensureTaskNodeModules } from '../../workspaces/task-node-modules';
import { verifyBargeLeaseAndCustody } from '../../workspaces/barge-allocator';

// Proof executors keep their own refusal path; reviewer and closeout creations wait for their exact lookup.
/**
 * The detached reviewer round's PR identity (nucleus#1425). A recorded unreviewed external
 * merge of the task's PR binds its exact merged source; any other task keeps the strict
 * open-PR identity.
 */
async function reviewPrIdentity(machine: LaunchMachinePorts, t: Task, number: number): Promise<{ url: string; head: string }> {
  const route = unreviewedMergeRoute(t);
  if (!route) return machine.verifyPrIdentity!(t, number);
  return machine.verifyMergedReviewSource!(t, route);
}

const creationRoles = new Set<Run['role']>(['reviewer', 'closeout']);

/**
 * Deliver the run a launch reserved: the ordinary review custody and checkout
 * proofs, the guarded native send or creation, then the binding and the
 * uncertain or refused settlement when a step throws.
 */
export class RunLaunchDeliver {
  constructor(readonly resolution: LaunchDeliverContext,
    private readonly ensureTaskDependencies: typeof ensureTaskNodeModules = ensureTaskNodeModules) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  get machine(): LaunchMachinePorts { return this.adapter; }
  async deliverLaunchRun(t:Task, role:Run['role'], context:{agentId:string|null;profile:Profile|null;group:string|null;workspaceId:string;firstReviewEntryWorker:boolean;nonDeliveryReplacement:boolean;run:Run;token:string}):Promise<void> {
    let {agentId, profile, group, workspaceId, firstReviewEntryWorker, nonDeliveryReplacement, run, token}=context;
    t = this.store.task(t.id);
    // Observation before any refusal (nucleus#1159): an uncertain host-effect
    // control whose effect later evidence has answered is settled here, so this
    // launch gates only on uncertainty the task has yet to answer. Nothing is
    // resent; the settlement is the observation's own record.
    if (settleObservedHostEffectOperations(this.store, t.id).length) t = this.store.task(t.id);
    let dispatchInvoked = false;
    try {
      if (run.ordinaryDetached) {
        await this.resolution.ordinaryRoundCustody(t, run);
        await ordinaryReviewSource(t, run.head, false);
        await git(t.directory!, 'fetch', 'origin', `refs/heads/${t.branch}`);
        await this.machine.verifyPr(t, taskPrNumber(t));
        await this.resolution.ordinaryRoundCustody(t, run);
        await ordinaryReviewSource(t, run.head, false);
        await git(t.directory!, 'checkout', '--quiet', '--detach', run.head);
        await ordinaryReviewSource(t, run.head, true);
      }
      // Ordinary review takes custody of a detached exact-head checkout only
      // after reservation. Recheck its dependencies after that final source
      // transition and before the retained reviewer reads the worktree.
      if (role !== 'closeout' && t.workspaceAllocation?.provider === 'barge') {
        const bridge = this.adapter.workspaceAllocationBridge;
        await verifyBargeLeaseAndCustody({
          allocation: t.workspaceAllocation,
          saveAllocation: bridge
            ? (updated) => bridge.saveWorkspaceAllocation(t.id, updated)
            : undefined,
          cliOptions: bridge?.bargeCliOptions,
        });
      }
      if (role !== 'closeout' && t.directory)
        await this.ensureTaskDependencies(
          t.directory,
          t.repoPath,
          dirname(t.directory),
          t.workspaceAllocation?.provider === 'barge'
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
          throw new Error('Proof source tree changed after run reservation; refusing to start an agent');
      }
      if (agentId) {
        let fresh = this.store.task(t.id);
        // Spec 026: the task's own typed lane-document declaration is the whole
        // source, so a continued run refreshes exactly the pins it was admitted with.
        const references = declaredLaneDocumentKeys(fresh.laneDocuments, this.store.lanes());
        const missing = references.keys.filter(key => !this.store.laneDocument(key));
        const pins = new Map((fresh.laneDocumentPins ?? []).map(pin => [pin.key, pin]));
        for (const key of references.keys) {
          const document = this.store.laneDocument(key);
          if (document) pins.set(key, { key, version: document.version, digest: document.digest, text: document.text });
        }
        const refreshedPins = [...pins.values()];
        const issues = [...references.unresolved, ...missing];
        if (JSON.stringify(refreshedPins) !== JSON.stringify(fresh.laneDocumentPins ?? []) || JSON.stringify(issues) !== JSON.stringify(fresh.laneDocumentIssues ?? [])) {
          this.store.update(fresh.id, { laneDocumentPins: refreshedPins, laneDocumentIssues: issues }, 'lane_document_pins_refreshed', 'Cited lane documents were refreshed for the continued run');
          fresh = this.store.task(t.id);
        }
        const savedRun = this.store.run(run.id)!;
        const version = fresh.version, snapshot = this.resolution.ordinaryReviewRuns(t.id);
        const stillAllowed = () => {
          const latest = this.store.task(t.id);
          if (latest.version !== version || latest.resolution.currentRunId !== run.id || latest.prHead !== run.head
            || this.resolution.paused() || dispatchBlocked(latest) || isDispositionActive(latest) || snapshot !== this.resolution.ordinaryReviewRuns(t.id)) return false;
          assertOrdinaryReviewIdentity(latest, run.head, true);
          this.resolution.assertReviewProfileIndependent(latest, savedRun);
          const effects=blockingRecoveryEffects(this.store,latest,{noticeKinds:'all'});
          if(effects.length)throw new BlockingRecoveryEffectsError(effects);
          return true;
        };
        const guardedReviewEntry = role === 'reviewer' && fresh.reviewEntry;
        const sendGuard = run.ordinaryDetached || guardedReviewEntry ? {
          allowed: async () => {
            if (run.ordinaryDetached) await this.resolution.ordinaryRoundCustody(fresh, savedRun);
            const pr = await reviewPrIdentity(this.machine, fresh, taskPrNumber(fresh));
            if (pr.head !== run.head || pr.url !== fresh.prUrl) return false;
            if (fresh.reviewEntry)
              await assertReviewEntryWriterYielded(reviewEntryInputForTask(fresh), this.adapter as Adapter & ReviewEntryAdapter, fresh.id);
            await ordinaryReviewSource(this.store.task(fresh.id), run.head, Boolean(run.ordinaryDetached));
            return stillAllowed();
          },
          stillAllowed,
        } : undefined;
        dispatchInvoked = true;
        await this.adapter.sendRun!(fresh, savedRun, token, null, ownerReviewContext(this.store, fresh, savedRun), sendGuard, this.store.canonicalRepository(fresh.repoPath, fresh.repository)?.affectedTests?.command);
        recordPromptSize(this.store, fresh.id, savedRun.id, savedRun.temporaryDirectory);
        if (proofExecutor(run.role)) {
          // Task 582: a continued executor turn is still its own run and its
          // own receipt; the retained thread carries no authority or credit
          // from earlier proof runs.
          const binding = savedRun.proofExecution!;
          recordProofExecution(this.store, t.id, proofExecutionRecord(savedRun, this.store.task(t.id), binding.authorizedBy, binding.operationId), `Executor ${agentId} continued for selector ${binding.selector} at ${run.head}`);
        }
      }
      else {
        if (run.ordinaryDetached) {
          await this.resolution.ordinaryRoundCustody(t, this.store.run(run.id)!);
          if (!this.machine.verifyPrIdentity) throw Error('Ordinary reviewer PR identity observation unavailable');
          const pr = await reviewPrIdentity(this.machine, t, taskPrNumber(t));
          if (pr.head !== run.head || pr.url !== t.prUrl) throw Error('Ordinary reviewer PR identity changed before creation');
          await this.resolution.ordinaryRoundCustody(t, this.store.run(run.id)!);
          if (t.reviewEntry) await assertReviewEntryWriterYielded(reviewEntryInputForTask(t), this.adapter as Adapter & ReviewEntryAdapter, t.id);
          await ordinaryReviewSource(t, run.head, true);
        }
        if (role === 'reviewer' && t.reviewEntry && !run.ordinaryDetached) {
          const pr = await this.machine.verifyPrIdentity!(t, taskPrNumber(t));
          if (pr.head !== run.head || pr.url !== t.prUrl) throw Error('Review-entry PR identity changed before reviewer creation');
          await assertReviewEntryWriterYielded(reviewEntryInputForTask(t), this.adapter as Adapter & ReviewEntryAdapter, t.id);
          const latest = this.store.task(t.id);
          if (latest.resolution.currentRunId !== run.id || latest.prHead !== run.head || this.resolution.paused()
            || dispatchBlocked(latest) || isDispositionActive(latest))
            throw Error('Review-entry handover changed before reviewer creation');
          await ordinaryReviewSource(latest, run.head, false);
        }
        const fresh = this.store.task(t.id), savedRun = this.store.run(run.id)!;
        dispatchInvoked = true;
        const launchGuard = role === 'reviewer' && fresh.reviewEntry ? (() => {
          const version = fresh.version, snapshot = this.resolution.ordinaryReviewRuns(t.id);
          const stillAllowed = () => {
            const latest = this.store.task(t.id);
            if (latest.version !== version || latest.resolution.currentRunId !== run.id || latest.prHead !== run.head
              || this.resolution.paused() || dispatchBlocked(latest) || isDispositionActive(latest) || snapshot !== this.resolution.ordinaryReviewRuns(t.id)) return false;
            assertOrdinaryReviewIdentity(latest, run.head, Boolean(run.ordinaryDetached));
            this.resolution.assertReviewProfileIndependent(latest, savedRun);
            const effects=blockingRecoveryEffects(this.store,latest,{noticeKinds:'all'});
            if(effects.length)throw new BlockingRecoveryEffectsError(effects);
            return true;
          };
          return {
            allowed: async () => {
              const pr = await this.machine.verifyPrIdentity!(fresh, taskPrNumber(fresh));
              if (pr.head !== run.head || pr.url !== fresh.prUrl) return false;
              await assertReviewEntryWriterYielded(reviewEntryInputForTask(fresh), this.adapter as Adapter & ReviewEntryAdapter, fresh.id);
              await ordinaryReviewSource(this.store.task(fresh.id), run.head, Boolean(run.ordinaryDetached));
              return stillAllowed();
            },
            stillAllowed,
          };
        })() : undefined;
        const created = await this.adapter.createRun!(fresh, savedRun, token, null,
          ownerReviewContext(this.store, fresh, savedRun), launchGuard, this.store.canonicalRepository(fresh.repoPath, fresh.repository)?.affectedTests?.command); agentId = created.id;
        recordPromptSize(this.store, fresh.id, savedRun.id, savedRun.temporaryDirectory);
        // Review-entry creation follows a fresh writer-yield, exact local
        // checkout and open-PR-head proof immediately before this native send.
        this.store.putRun({ ...this.store.run(run.id)!, agentId });
        if (created.workspaceId !== workspaceId) throw new Error('Created run is in the wrong workspace');
        if (role === 'reviewer') this.resolution.update(t, { reviewerAgentId: agentId, reviewerProfile: profile },
          t.entrypoint === 'proof' && !t.agentId ? { agentId } : {});
        else if (role === 'revision' && nonDeliveryReplacement) {
          const latest = this.store.task(t.id);
          const previous = latest.agentId && latest.runId && latest.profile
            ? [{ agentId: latest.agentId, runId: latest.runId, profile: latest.profile, reason: `${NON_DELIVERY_ROUTE_REASON}: ${latest.profile.provider}/${latest.profile.model} returned a second unchanged blocked/error result` }]
            : [];
          this.store.update(t.id, { agentId, runId: run.id, ...(savedRun.temporaryDirectory ? { temporaryDirectory: savedRun.temporaryDirectory } : {}), profile, profileGroup: group,
            workerModel: profile!.model, workerModels: [...new Set([...latest.workerModels, profile!.model])],
            retiredWorkers: [...latest.retiredWorkers, ...previous], resumePrNumber: latest.resumePrNumber ?? latest.completion?.prNumber ?? null,
            resolution: { ...latest.resolution, nonDeliveryRoutePending: false, pendingWorkerInstruction: null } },
            'non_delivery_worker_routed', `${profile!.provider}/${profile!.model}; same capability as ${previous[0]?.profile.provider ?? 'prior provider'}`);
        }
        else if(role==='revision'&&firstReviewEntryWorker)this.store.update(t.id,{agentId,runId:run.id,...(savedRun.temporaryDirectory?{temporaryDirectory:savedRun.temporaryDirectory}:{}),profile,profileGroup:group,workerModel:profile!.model,workerModels:[...new Set([...t.workerModels,profile!.model])]},'review_entry_worker_bound',agentId);
        else if (role === 'revision' && !t.agentId && t.profile) {
          // Spec 052 (Tom, 2026-11-17): the climb retired the previous worker
          // before this revision. The fresh revision agent becomes the task's
          // retained worker, so the next same-tier revision continues it.
          this.store.update(t.id, { agentId, runId: run.id, ...(savedRun.temporaryDirectory ? { temporaryDirectory: savedRun.temporaryDirectory } : {}), profile, profileGroup: group ?? t.profileGroup ?? null,
            workerModel: profile!.model, workerModels: [...new Set([...t.workerModels, profile!.model])] },
            'worker_climb_bound', agentId);
        }
        else if (role === 'revision' && t.agentId && t.agentId !== agentId) {
          const latest = this.store.task(t.id);
          const previous = latest.agentId && latest.runId && latest.profile
            ? [{ agentId: latest.agentId, runId: latest.runId, profile: latest.profile, reason: `Report binding lives outside the current data home` }]
            : [];
          this.store.update(t.id, { agentId, runId: run.id, ...(savedRun.temporaryDirectory ? { temporaryDirectory: savedRun.temporaryDirectory } : {}), retiredWorkers: [...latest.retiredWorkers, ...previous] },
            'report_binding_relaunch', agentId);
        }
        else if (coordinative(run)&&this.store.task(t.id).coordinatorGeneration === run.generation) this.store.update(t.id, { coordinatorAgentId: agentId }, 'coordinator_assigned', agentId);
        if (proofExecutor(run.role)) {
          const binding = run.proofExecution!;
          recordProofExecution(this.store, t.id, proofExecutionRecord(this.store.run(run.id)!, this.store.task(t.id), binding.authorizedBy, binding.operationId), `Executor ${agentId} activated for selector ${binding.selector} at ${run.head}`);
        }
      }
      this.store.putRun({ ...this.store.run(run.id)!, agentId, status: 'running' });
      this.resolution.waiting(this.store.task(t.id), threadRunningReason(role), 'lifecycle');
    } catch (error) {
      if (error instanceof BlockingRecoveryEffectsError) {
        const waitReason=`${run.ordinaryDetached?'Ordinary review':'Review-entry'} waits for ${recoveryEffectsRefusal(error.effects)}; settle it with retry_effect before continuing`;
        this.store.transaction(() => {
          const latestRun=this.store.run(run.id);
          if(latestRun&&!latestRun.released)this.store.putRun({...latestRun,status:'superseded',released:true,active:false});
          const latest=this.store.task(t.id);
          if(latest.resolution.currentRunId===run.id)this.resolution.update(latest,{currentRunId:null,attention:false},
            {phase:role==='reviewer'?'reviewing':latest.phase},'review_waiting_on_effects',recoveryEffectsRefusal(error.effects)??'');
        });
        this.resolution.waiting(this.store.task(t.id),waitReason,'lifecycle');
        return;
      }
      // A host that has not settled its model options has not refused this run:
      // nothing crossed the send boundary, so the run is released and the task
      // waits for the next pass to read a settled snapshot (nucleus#1375).
      if (error instanceof HostSnapshotPendingError) {
        this.store.transaction(() => {
          const latestRun = this.store.run(run.id);
          if (latestRun && !latestRun.released)
            this.store.putRun({ ...latestRun, status: 'superseded', released: true, active: false });
          if (!agentId) this.store.deleteCredential(run.id);
          const latest = this.store.task(t.id);
          if (latest.resolution.currentRunId === run.id)
            this.resolution.update(latest, { currentRunId: null, attention: false },
              { phase: role === 'reviewer' ? 'reviewing' : latest.phase }, 'review_waiting_on_host_snapshot', error.detail);
        });
        this.resolution.waiting(this.store.task(t.id), `Waiting for T3Code to settle the host catalogue: ${error.detail}`, 'lifecycle');
        return;
      }
      // A provider size rejection proves the prompt was refused before send:
      // nothing was bound or delivered, so the run settles as refused with a
      // pre-send receipt instead of `uncertain`. The next attempt dispatches
      // the bounded prompt. An ordinary retained round's own pre-send fence
      // settles the same way. A proven refusal on any other creation settles
      // the same: exact-lookup recovery would find nothing and a replacement
      // creation would refuse identically, so the task stops in attention with
      // the step that failed named (nucleus#1139).
      const reviewEntryGuarded = role === 'reviewer' && t.reviewEntry;
      const creationRefusal = !agentId && dispatchInvoked && !run.ordinaryDetached && !reviewEntryGuarded && error instanceof ProvenPreSendRefusalError;
      if (!dispatchInvoked && (run.ordinaryDetached || reviewEntryGuarded) && !(error instanceof ProvenPreSendRefusalError) && !isPromptTooLargeError(error)
        && (isTransportFailure(error) || isHostOperationTimeout(error) || error instanceof HostTransportFault)) {
        this.store.transaction(() => {
          this.store.putRun({ ...this.store.run(run.id)!, status: 'superseded', released: true });
          this.store.deleteCredential(run.id);
          const current = this.store.task(t.id);
          if (current.resolution.currentRunId === run.id) this.resolution.update(current, { currentRunId: null });
        });
        throw error;
      }
      if (isPromptTooLargeError(error) || creationRefusal || ((run.ordinaryDetached || reviewEntryGuarded) && (!dispatchInvoked || error instanceof ProvenPreSendRefusalError))) {
        const tooLarge = isPromptTooLargeError(error);
        const creationStep = creationRefusal ? (role === 'reviewer' ? 'Reviewer creation' : role === 'revision' ? 'Worker creation' : 'Coordinator creation') : '';
        const reason = tooLarge
          ? `Review prompt refused before send for size: ${redactDiagnostic(error instanceof Error ? error.message : String(error))}`
          : creationRefusal
          ? `${creationStep} refused before send: ${(error as ProvenPreSendRefusalError).reason}`
          : `${run.ordinaryDetached ? 'Ordinary review' : 'Review-entry'} reviewer refused before send: ${message(error)}`;
        this.store.transaction(() => {
          this.store.putRun({ ...this.store.run(run.id)!, status: 'superseded', released: true });
          this.store.deleteCredential(run.id);
          const current = this.store.task(t.id);
          if (current.resolution.currentRunId === run.id)
            this.resolution.update(current, { currentRunId: null, attention: true }, { phase: 'needs_attention', reason }, tooLarge ? 'review_prompt_refused_before_send' : creationRefusal ? 'creation_refused_before_send' : 'ordinary_review_refused_before_send', run.id);
        });
        // The typed refusal carries the pre-send receipt to the operation
        // layer; the ordinary fence already proved its own refusal.
        if (tooLarge) throw new ProvenPreSendRefusalError(reason);
        return;
      }
      this.store.putRun({ ...this.store.run(run.id)!, status: 'uncertain' });
      // Record the exact-lookup window now: automatic reconciliation owns the fault before any coordinator can engage.
      this.resolution.ensureIncident(this.store.task(t.id), run, ABSENT_RESOLUTION_REASON, 'exact_lookup');
      // An uncertain creation is decided by its exact lookup, which observation runs for every pending
      // run. The thrown error must not write an operator stop that blocks that lookup (a host call past
      // its deadline never answers, so its exact lookup is the only exit).
      if (!agentId && dispatchInvoked && !run.ordinaryDetached && creationRoles.has(role)) {
        this.resolution.waiting(this.store.task(t.id), `${role === 'reviewer' ? 'Reviewer' : role === 'closeout' ? 'Closeout' : 'Run'} creation is uncertain; exact lookup decides whether it produced an agent`, 'lifecycle');
        return;
      }
      throw error;
    }
  }
}
