import type { Task } from '../../shared/contracts';
import { UNCERTAIN_MERGE_PROOF_TIMEOUT_MS } from '../../shared/contracts';
import { ForgeOutageError } from '../forge/forge-health';
import type { MergeGateResult, Resolution, ResolutionAdapter } from '../resolution';
import { now } from '../store/store';
import { mergedWithNonePatch } from '../recovery/task-reasons';

export type MergeIntentContext = Pick<Resolution, 'adapter' | 'attention' | 'gateSettingsCurrent' | 'gitTransientFailure' | 'mergeGateEvidence' | 'paused' | 'store' | 'uncertainMergeRetryMs' | 'update' | 'waiting'>;

/** Decide whether fresh gate evidence permits the recorded intent's re-issue. */
export function reissueGateDecision(current: Task, fresh: MergeGateResult, elapsed: number):
  { kind: 'issue' } | { kind: 'wait' | 'escalate'; reason: string } {
  if (fresh.head !== current.resolution.mergeHead)
    return { kind: 'escalate', reason: `The PR head is ${fresh.head} while the recorded merge intent is for ${current.resolution.mergeHead}; the unmerged intent needs operator inspection` };
  if (fresh.base !== current.resolution.mergeBase)
    return { kind: 'escalate', reason: `The integration base is ${fresh.base} while the recorded merge intent and its verification are for ${current.resolution.mergeBase}; the guarded re-issue is not sent without verification of the current candidate` };
  if (fresh.wait) {
    if (fresh.checksFailed || fresh.overdue)
      return { kind: 'escalate', reason: `The merge intent is unmerged and current exact-head gates refuse the guarded re-issue: ${fresh.wait}` };
    if (elapsed >= UNCERTAIN_MERGE_PROOF_TIMEOUT_MS)
      return { kind: 'escalate', reason: `A complete non-merge proof did not lead to a permitted re-issue within 30 minutes; the fresh exact-head gate holds: ${fresh.wait}` };
    return { kind: 'wait', reason: `Recorded merge intent is unmerged; the guarded re-issue waits for current exact-head gates: ${fresh.wait}` };
  }
  return { kind: 'issue' };
}

type MergeObservation = Awaited<ReturnType<NonNullable<ResolutionAdapter['merged']>>>;

/** Interpret the latest observation before changing the durable intent. */
export function mergeObservationDecision(task: Task, result: MergeObservation): 'verified' | 'identity_mismatch' | 'reconcile' {
  if (!result.merged) return 'reconcile';
  return result.head === task.resolution.mergeHead && result.base === task.baseBranch && result.commit
    ? 'verified' : 'identity_mismatch';
}

/** Decide what incomplete proof or an absent proof window permits. */
export function mergeProofDecision(proven: boolean, proofSince: string | null, elapsed: number, retryMs: number):
  'incomplete_wait' | 'incomplete_escalate' | 'reset' | 'start' | 'window_escalate' | 'continue' {
  if (!proven) return elapsed >= UNCERTAIN_MERGE_PROOF_TIMEOUT_MS ? 'incomplete_escalate' : 'incomplete_wait';
  if (proofSince && !Number.isFinite(Date.parse(proofSince))) return 'reset';
  if (!proofSince) return elapsed + retryMs > UNCERTAIN_MERGE_PROOF_TIMEOUT_MS ? 'window_escalate' : 'start';
  return 'continue';
}

/** Decide the next step once a continuous non-merge proof has started. */
export function mergeIntentDecision(task: Task, proofSince: number, elapsed: number, retryMs: number, clock: number): 'gate_then_reissue' | 'escalate' | 'wait' {
  if (Number.isFinite(proofSince) && clock - proofSince >= retryMs &&
      task.resolution.mergeResponseOutcome === 'uncertain' && !task.resolution.mergeRetryAt && !task.resolution.mergeAutoRetryExhausted)
    return 'gate_then_reissue';
  if (elapsed >= UNCERTAIN_MERGE_PROOF_TIMEOUT_MS &&
      (!task.resolution.mergeRetryAt || task.resolution.mergeRetryOutcome === 'accepted')) return 'escalate';
  return 'wait';
}

/** Verifies a durable merge intent and spends its one SHA-guarded re-issue. */
export class MergeIntent {
  constructor(readonly resolution: MergeIntentContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  get uncertainMergeRetryMs() { return this.resolution.uncertainMergeRetryMs; }
  paused() { return this.resolution.paused(); }
  update(...args: Parameters<MergeIntentContext['update']>) { return this.resolution.update(...args); }
  attention(...args: Parameters<MergeIntentContext['attention']>) { return this.resolution.attention(...args); }
  waiting(...args: Parameters<MergeIntentContext['waiting']>) { return this.resolution.waiting(...args); }
  gitTransientFailure(...args: Parameters<NonNullable<MergeIntentContext['gitTransientFailure']>>) { return this.resolution.gitTransientFailure?.(...args); }
  mergeGateEvidence(...args: Parameters<MergeIntentContext['mergeGateEvidence']>) { return this.resolution.mergeGateEvidence(...args); }
  gateSettingsCurrent(...args: Parameters<MergeIntentContext['gateSettingsCurrent']>) { return this.resolution.gateSettingsCurrent(...args); }

  mergeProofDetail(result: Awaited<ReturnType<NonNullable<ResolutionAdapter['merged']>>>): string {
    return result.proof?.detail || 'GitHub did not provide complete non-merge proof, including merge-queue state';
  }
  resetMergeProof(t: Task, detail: string) {
    const current = this.store.task(t.id);
    if (current.resolution.mergeProofSince) {
      this.update(current, { mergeProofSince: null }, {}, 'uncertain_merge_proof_reset', detail.slice(0, 2000));
    }
    return this.store.task(t.id);
  }
  mergeElapsed(t: Task) {
    const requestedAt = Date.parse(t.resolution.mergeRequestedAt ?? '');
    return Number.isFinite(requestedAt) ? Date.now() - requestedAt : UNCERTAIN_MERGE_PROOF_TIMEOUT_MS;
  }
  escalateUncertainMerge(t: Task, evidence: string) {
    const reason = `Uncertain merge requires operator attention: ${evidence}`.slice(0, 2000);
    this.attention(t, reason);
    const current = this.store.task(t.id);
    this.update(current, { attention: true, mergeAutoRetryExhausted: true },
      { phase: 'needs_attention', reason }, 'uncertain_merge_escalated', evidence.slice(0, 2000));
  }
  /** Verify a durable merge intent, then allow at most one SHA-guarded re-issue after continuous proof. */
  async reconcileMergeIntent(t: Task) {
    let result: Awaited<ReturnType<NonNullable<ResolutionAdapter['merged']>>>;
    try { result = await this.adapter.merged!(t); }
    catch (error) {
      if (this.paused()) return;
      t = this.resetMergeProof(t, `GitHub merge observation unavailable: ${String(error)}`);
      if (error instanceof ForgeOutageError) {
        // Outage time cannot consume the healthy observation window. The next
        // pass starts from this last failed probe and must prove non-merge anew.
        t = this.update(t, { mergeRequestedAt: now() }, {}, 'uncertain_merge_outage_wait');
        if (t.resolution.mergeRetryAt && t.resolution.mergeRetryOutcome === 'pending')
          t = this.update(t, { mergeRetryOutcome: 'uncertain' }, {}, 'merge_retry_uncertain', 'GitHub unavailable after guarded re-issue');
        if (!this.gitTransientFailure?.(t, error)) this.waiting(t, error.message, 'external_unavailable');
        return;
      }
      if (t.resolution.mergeRetryAt && t.resolution.mergeRetryOutcome === 'pending') {
        t = this.update(t, { mergeRetryOutcome: 'uncertain' }, {}, 'merge_retry_uncertain', `Nucleus restarted before recording the re-issue response; observation failed: ${String(error)}`.slice(0, 2000));
      }
      if (t.resolution.mergeRetryAt && t.resolution.mergeRetryOutcome === 'uncertain') {
        this.escalateUncertainMerge(t, `The single guarded re-issue had an uncertain response and the latest merge lookup failed: ${String(error)}`);
        return;
      }
      const elapsed = this.mergeElapsed(t);
      if (elapsed >= UNCERTAIN_MERGE_PROOF_TIMEOUT_MS) {
        this.escalateUncertainMerge(t, `No complete non-merge proof within 30 minutes; latest observation failed: ${String(error)}`);
      } else this.waiting(t, 'Merge outcome is uncertain; GitHub evidence is incomplete, so Nucleus is holding the integration turn', 'lifecycle');
      return;
    }
    if (this.paused()) return;
    const observed = mergeObservationDecision(t, result);
    if (observed === 'identity_mismatch') throw new Error('Merged PR identity differs from the approved task');
    if (observed === 'verified' && result.merged) {
      this.update(t, { mergedCommit: result.commit!, attention: false, ...mergedWithNonePatch(t, result.head) }, { phase: 'syncing', reason: 'Merge verified; synchronizing local integration branch' }, 'merge_verified');
      return;
    }
    if (t.resolution.mergeResponseOutcome === 'pending') {
      const detail = 'Nucleus restarted before recording the guarded merge response; treating delivery as uncertain';
      t = this.update(t, { mergeResponseOutcome: 'uncertain' }, {}, 'merge_response_uncertain', detail);
    }
    if (t.resolution.mergeRetryAt && t.resolution.mergeRetryOutcome === 'pending') {
      const detail = `Nucleus restarted before recording the single guarded re-issue response; latest GitHub evidence: ${this.mergeProofDetail(result)}`;
      t = this.update(t, { mergeRetryOutcome: 'uncertain' }, {}, 'merge_retry_uncertain', detail.slice(0, 2000));
    }
    if (t.resolution.mergeRetryAt && t.resolution.mergeRetryOutcome === 'uncertain') {
      this.escalateUncertainMerge(t, `The single guarded re-issue also had an uncertain response. ${this.mergeProofDetail(result)}`);
      return;
    }

    const proof = result.proof?.proven === true;
    const proofDetail = this.mergeProofDetail(result);
    const elapsed = this.mergeElapsed(t);
    let proofDecision = mergeProofDecision(proof, t.resolution.mergeProofSince, elapsed, this.uncertainMergeRetryMs);
    if (proofDecision === 'incomplete_wait' || proofDecision === 'incomplete_escalate') {
      t = this.resetMergeProof(t, proofDetail);
      if (proofDecision === 'incomplete_escalate') {
        this.escalateUncertainMerge(t, `A continuous non-merge proof window could not be established within 30 minutes. ${proofDetail}`);
      } else this.waiting(t, `Merge outcome is uncertain; non-merge proof is incomplete, so Nucleus is holding the integration turn (${proofDetail})`, 'lifecycle');
      return;
    }
    if (proofDecision === 'reset') {
      t = this.resetMergeProof(t, 'Stored non-merge proof timestamp was invalid; restarting the proof window');
      proofDecision = mergeProofDecision(proof, t.resolution.mergeProofSince, elapsed, this.uncertainMergeRetryMs);
    }
    if (proofDecision === 'start' || proofDecision === 'window_escalate') {
      if (proofDecision === 'window_escalate') {
        this.escalateUncertainMerge(t, `A ${Math.round(this.uncertainMergeRetryMs / 60000)}-minute proof window cannot finish within the 30-minute bound. ${proofDetail}`);
        return;
      }
      const since = now();
      t = this.update(t, { mergeProofSince: since }, {}, 'uncertain_merge_proof_started', JSON.stringify({ since, evidence: proofDetail }).slice(0, 2000));
    }
    const proofSince = Date.parse(t.resolution.mergeProofSince!);
    const decision = mergeIntentDecision(t, proofSince, elapsed, this.uncertainMergeRetryMs, Date.now());
    if (decision === 'gate_then_reissue') {
      // A proven non-merge effect is re-issued only under the current policy and
      // the exact head's current requirements. A gate that holds or refuses
      // leaves the recorded intent and retry fences untouched.
      // A fresh-gate hold is still a bounded uncertain merge: it never keeps the
      // task integrating past the same 30-minute window. Only a permitted
      // re-issue may extend the episode to the retry itself.
      const holdForGate = (current: Task, reason: string) => {
        if (elapsed >= UNCERTAIN_MERGE_PROOF_TIMEOUT_MS)
          this.escalateUncertainMerge(current, `A complete non-merge proof did not lead to a permitted re-issue within 30 minutes; the fresh exact-head gate holds: ${reason}`);
        else this.waiting(current, `Recorded merge intent is unmerged; the guarded re-issue waits for current exact-head gates: ${reason}`, 'lifecycle');
      };
      let fresh: MergeGateResult;
      try { fresh = await this.mergeGateEvidence(t); }
      catch (error) {
        if (this.paused()) return;
        if (error instanceof ForgeOutageError) { if (!this.gitTransientFailure?.(this.store.task(t.id), error)) this.waiting(this.store.task(t.id), error.message, 'external_unavailable'); }
        else holdForGate(this.store.task(t.id), `the gate observation failed: ${String(error).slice(0, 400)}`);
        return;
      }
      if (this.paused()) return;
      const current = this.store.task(t.id);
      const gateDecision = reissueGateDecision(current, fresh, elapsed);
      if (gateDecision.kind === 'escalate') { this.escalateUncertainMerge(current, gateDecision.reason); return; }
      if (gateDecision.kind === 'wait') { this.waiting(current, gateDecision.reason, 'lifecycle'); return; }
      t = this.store.task(t.id);
      const retryAt = now();
      t = this.update(t, { mergeRetryAt: retryAt, mergeRetryOutcome: 'pending', mergeAutoRetryExhausted: true },
        { reason: 'Continuous exact non-merge proof held; issuing the one guarded merge re-try' }, 'merge_retry_intent',
        JSON.stringify({ at: retryAt, sha: t.resolution.mergeHead, evidence: proofDetail }).slice(0, 2000));
      let retryWithdrawn = false;
      try {
        await this.adapter.merge!(t, () => {
          if (this.paused()) return false;
          if (!this.gateSettingsCurrent(this.store.task(t.id), fresh)) { retryWithdrawn = true; return false; }
          return true;
        });
        if (this.paused()) return;
        t = this.store.task(t.id);
        this.update(t, { mergeRetryOutcome: 'accepted' }, {}, 'merge_retry_accepted', `GitHub accepted the one guarded re-issue for ${t.resolution.mergeHead}`);
      } catch (error) {
        if (this.paused()) return;
        t = this.store.task(t.id);
        if (retryWithdrawn) {
          // Nothing was sent: the retry is not spent, and the settings change is
          // observed before another attempt.
          this.store.event(t.id, 'merge_gate_settings_changed', `Repository settings changed between the guarded re-issue intent and the merge request at ${t.resolution.mergeHead}; the request was not sent and the retry is not spent`);
          this.update(t, { mergeRetryAt: null, mergeRetryOutcome: null, mergeAutoRetryExhausted: false }, {}, 'merge_retry_withdrawn', 'Repository settings changed before the guarded re-issue; no request was sent');
          holdForGate(this.store.task(t.id), 'repository settings changed before the guarded re-issue; the request was not sent');
          return;
        }
        const detail = String(error).slice(0, 1500);
        this.update(t, { mergeRetryOutcome: 'uncertain' }, {}, 'merge_retry_uncertain', detail);
        this.waiting(this.store.task(t.id), 'The one guarded merge re-issue had an uncertain response; checking GitHub before escalation', 'lifecycle');
      }
      return;
    }
    if (decision === 'escalate') {
      this.escalateUncertainMerge(t, `The continuous non-merge proof did not reach the configured retry bound within 30 minutes. ${proofDetail}`);
      return;
    }
    this.waiting(t, `Merge outcome is uncertain; definitive non-merge proof has held for ${Math.max(0, Date.now() - proofSince)}ms`, 'lifecycle');
  }

  /** Owner retry entry to re-observe one recorded merge response intent. */
  async reconcileMergeResponseEffect(taskId: string): Promise<Task> {
    const task = this.store.task(taskId);
    if (!task.resolution.mergeIntent || task.resolution.mergedCommit) return task;
    await this.reconcileMergeIntent(task);
    return this.store.task(taskId);
  }
}
