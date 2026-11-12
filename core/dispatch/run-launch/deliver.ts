import type { LaunchDeliverContext } from '../launch';
import type { LaunchMachinePorts } from './machine';
import { dispatchBlocked } from '../capacity';
import { taskPrNumber } from '../../forge/index';
import { git } from '../../git/index';
import { NON_DELIVERY_ROUTE_REASON } from '../../recovery/non-delivery';
import { assertReviewRunSource, proveReviewRunSource } from '../../review/ordinary-review';
import { ownerReviewContext } from '../../review/owner-review-context';
import type { Adapter } from '../../host/adapter';
import { proofExecutionRecord, recordProofExecution } from '../../qa/proof-execution';
import { isPromptTooLargeError, redactDiagnostic } from '../../recovery/provider-refusal';
import { BlockingRecoveryEffectsError, blockingRecoveryEffects, blockingRecoveryEffectsRefusal, recoveryEffectsRefusal } from '../../recovery/recovery-effects';
import { assertReviewEntryWriterYielded, reviewEntryInputForTask, type ReviewEntryAdapter } from '../../review/review-entry';
import { ABSENT_RESOLUTION_REASON, ProvenPreSendRefusalError, coordinative, message, proofExecutor } from '../../recovery/task-reasons';
import { isDispositionActive, type Profile, type Run, type Task } from '../../../shared/contracts';
import { currentBrief } from '../../planning/brief';
import { briefLaneDocumentReferences } from '../../planning/brief-lane-documents';

/**
 * Deliver the run a launch reserved: the ordinary review custody and checkout
 * proofs, the guarded native send or creation, then the binding and the
 * uncertain or refused settlement when a step throws.
 */
export class RunLaunchDeliver {
  constructor(readonly resolution: LaunchDeliverContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  get machine(): LaunchMachinePorts { return this.adapter; }
  async deliverLaunchRun(t:Task, role:Run['role'], context:{agentId:string|null;profile:Profile|null;group:string|null;workspaceId:string;firstReviewEntryWorker:boolean;nonDeliveryReplacement:boolean;run:Run;token:string}):Promise<void> {
    let {agentId, profile, group, workspaceId, firstReviewEntryWorker, nonDeliveryReplacement, run, token}=context;
    t = this.store.task(t.id);
    let dispatchInvoked = false;
    try {
      if (run.ordinaryDetached) {
        await this.resolution.ordinaryRoundCustody(t, run);
        await proveReviewRunSource(t, run.head, false);
        await git(t.directory!, 'fetch', 'origin', `refs/heads/${t.branch}`);
        await this.machine.verifyPr(t, taskPrNumber(t));
        await this.resolution.ordinaryRoundCustody(t, run);
        await proveReviewRunSource(t, run.head, false);
        await git(t.directory!, 'checkout', '--detach', run.head);
        await proveReviewRunSource(t, run.head, true);
      }
      if (agentId) {
        let fresh = this.store.task(t.id);
        const brief = currentBrief(fresh);
        if (brief) {
          const references = briefLaneDocumentReferences(brief.text, this.store.lanes());
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
        }
        const savedRun = this.store.run(run.id)!;
        const version = fresh.version, snapshot = this.resolution.ordinaryReviewRuns(t.id);
        const stillAllowed = () => {
          const latest = this.store.task(t.id);
          if (latest.version !== version || latest.resolution.currentRunId !== run.id || latest.prHead !== run.head
            || this.resolution.paused() || dispatchBlocked(latest) || isDispositionActive(latest) || snapshot !== this.resolution.ordinaryReviewRuns(t.id)) return false;
          assertReviewRunSource(latest, run.head, true);
          this.resolution.assertReviewProfileIndependent(latest, savedRun);
          const effects=blockingRecoveryEffects(this.store,latest,{noticeKinds:'all'});
          if(effects.length)throw new BlockingRecoveryEffectsError(effects);
          return true;
        };
        const guardedReviewEntry = role === 'reviewer' && fresh.reviewEntry;
        const sendGuard = run.ordinaryDetached || guardedReviewEntry ? {
          allowed: async () => {
            if (run.ordinaryDetached) await this.resolution.ordinaryRoundCustody(fresh, savedRun);
            const pr = await this.machine.verifyPrIdentity!(fresh, taskPrNumber(fresh));
            if (pr.head !== run.head || pr.url !== fresh.prUrl) return false;
            if (fresh.reviewEntry)
              await assertReviewEntryWriterYielded(reviewEntryInputForTask(fresh), this.adapter as Adapter & ReviewEntryAdapter, fresh.id);
            await proveReviewRunSource(this.store.task(fresh.id), run.head, Boolean(run.ordinaryDetached));
            return stillAllowed();
          },
          stillAllowed,
        } : undefined;
        dispatchInvoked = true;
        await this.adapter.sendRun!(fresh, savedRun, token, null, ownerReviewContext(this.store, fresh, savedRun), sendGuard);
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
          const pr = await this.machine.verifyPrIdentity(t, taskPrNumber(t));
          if (pr.head !== run.head || pr.url !== t.prUrl) throw Error('Ordinary reviewer PR identity changed before creation');
          await this.resolution.ordinaryRoundCustody(t, this.store.run(run.id)!);
          if (t.reviewEntry) await assertReviewEntryWriterYielded(reviewEntryInputForTask(t), this.adapter as Adapter & ReviewEntryAdapter, t.id);
          await proveReviewRunSource(t, run.head, true);
        }
        if (role === 'reviewer' && t.reviewEntry && !run.ordinaryDetached) {
          const pr = await this.machine.verifyPrIdentity!(t, taskPrNumber(t));
          if (pr.head !== run.head || pr.url !== t.prUrl) throw Error('Review-entry PR identity changed before reviewer creation');
          await assertReviewEntryWriterYielded(reviewEntryInputForTask(t), this.adapter as Adapter & ReviewEntryAdapter, t.id);
          const latest = this.store.task(t.id);
          if (latest.resolution.currentRunId !== run.id || latest.prHead !== run.head || this.resolution.paused()
            || dispatchBlocked(latest) || isDispositionActive(latest))
            throw Error('Review-entry handover changed before reviewer creation');
          await proveReviewRunSource(latest, run.head, false);
        }
        const fresh = this.store.task(t.id), savedRun = this.store.run(run.id)!;
        dispatchInvoked = true;
        const launchGuard = role === 'reviewer' && fresh.reviewEntry ? (() => {
          const version = fresh.version, snapshot = this.resolution.ordinaryReviewRuns(t.id);
          const stillAllowed = () => {
            const latest = this.store.task(t.id);
            if (latest.version !== version || latest.resolution.currentRunId !== run.id || latest.prHead !== run.head
              || this.resolution.paused() || dispatchBlocked(latest) || isDispositionActive(latest) || snapshot !== this.resolution.ordinaryReviewRuns(t.id)) return false;
            assertReviewRunSource(latest, run.head, Boolean(run.ordinaryDetached));
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
              await proveReviewRunSource(this.store.task(fresh.id), run.head, Boolean(run.ordinaryDetached));
              return stillAllowed();
            },
            stillAllowed,
          };
        })() : undefined;
        const created = await this.adapter.createRun!(fresh, savedRun, token, null,
          ownerReviewContext(this.store, fresh, savedRun), launchGuard); agentId = created.id;
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
          this.store.update(t.id, { agentId, runId: run.id, profile, profileGroup: group,
            workerModel: profile!.model, workerModels: [...new Set([...latest.workerModels, profile!.model])],
            retiredWorkers: [...latest.retiredWorkers, ...previous], resumePrNumber: latest.resumePrNumber ?? latest.completion?.prNumber ?? null,
            resolution: { ...latest.resolution, nonDeliveryRoutePending: false, pendingWorkerInstruction: null } },
            'non_delivery_worker_routed', `${profile!.provider}/${profile!.model}; same capability as ${previous[0]?.profile.provider ?? 'prior provider'}`);
        }
        else if(role==='revision'&&firstReviewEntryWorker)this.store.update(t.id,{agentId,runId:run.id,profile,profileGroup:group,workerModel:profile!.model,workerModels:[...new Set([...t.workerModels,profile!.model])]},'review_entry_worker_bound',agentId);
        else if (role === 'revision' && t.agentId && t.agentId !== agentId) {
          const latest = this.store.task(t.id);
          const previous = latest.agentId && latest.runId && latest.profile
            ? [{ agentId: latest.agentId, runId: latest.runId, profile: latest.profile, reason: `Report binding lives outside the current data home` }]
            : [];
          this.store.update(t.id, { agentId, runId: run.id, retiredWorkers: [...latest.retiredWorkers, ...previous] },
            'report_binding_relaunch', agentId);
        }
        else if (coordinative(run)&&this.store.task(t.id).coordinatorGeneration === run.generation) this.store.update(t.id, { coordinatorAgentId: agentId }, 'coordinator_assigned', agentId);
        if (proofExecutor(run.role)) {
          const binding = run.proofExecution!;
          recordProofExecution(this.store, t.id, proofExecutionRecord(this.store.run(run.id)!, this.store.task(t.id), binding.authorizedBy, binding.operationId), `Executor ${agentId} activated for selector ${binding.selector} at ${run.head}`);
        }
      }
      this.store.putRun({ ...this.store.run(run.id)!, agentId, status: 'running' });
      this.resolution.waiting(this.store.task(t.id), `${role} thread running`, 'lifecycle');
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
      throw error;
    }
  }
}
