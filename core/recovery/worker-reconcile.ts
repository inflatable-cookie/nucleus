import { parseAgentId, sameCallerIdentity } from '../../shared/agent-identity';
import type { Resolution } from '../resolution';
import { recordResultApplied, resultApplied } from '../intake/applied-result';
import { wireLabel } from "../../shared/wire-labels";
import type { Task } from "../../shared/contracts";
import { isDispositionActive, isDispositionComplete, pausedStopWaitReason } from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { dispatchBlocked } from "../dispatch/capacity";
import type { Engine } from "../engine";
import { isTransientProviderError } from "./exhaustion";
import { hookHoldReason } from "../hooks/hooks";
import { interactiveSessionOpen } from "../dispatch/interactive";
import { clearLiveEvidence, liveEvidenceEpisode, recordLiveEvidenceFailure } from "../machine/live-evidence";
import { consecutiveNonDeliveries, continuationInstruction, NON_DELIVERY_PUSHBACK, recognisedExternalWording, unfinishedContinuationEvents } from "./non-delivery";
import { automaticRetryForbidden } from "../../shared/automatic-retry";
import type { Adapter } from "../host/adapter";
import { reportingIdentityMismatch } from "../intake/reporting-identity";
import { settlementHeld, startsNoRuns } from "../closeout/queue-drain";
import { latestRunCompletion, now } from "../store/store";
import { OPERATOR_WORKER_REMAP_REASON, observedActive } from "./task-reasons";

/** Classify an observed branch lookup without treating a failed read as absence. */
export function branchPrLookupOutcome(error: unknown, count: number): 'unverified' | 'ambiguous' | 'found' | 'empty' {
  if (error !== null) return 'unverified';
  if (count > 1) return 'ambiguous';
  return count === 1 ? 'found' : 'empty';
}

/** Classify an observation using the task snapshot held by the reconcile pass. */
export function classifyWorkerObservation(task: Task, state: Awaited<ReturnType<Adapter['observe']>>): 'live_recover' | 'live' | 'transient' | 'stopped' {
  if (state.active || ['running', 'initializing'].includes(state.status) || state.permissions) {
    if (task.phase === 'needs_attention' && !task.completion && !task.resolution.currentRunId && !task.resolution.attention
      && !task.resolution.recovery?.runId && task.resolution.recovery?.status !== 'escalated') return 'live_recover';
    return 'live';
  }
  const retry = task.transientProviderRetry;
  if (retry?.runId === task.runId &&
    (['waiting', 'intent', 'uncertain', 'exhausted'].includes(retry.status) || retry.status === 'sent' && isTransientProviderError(state.error))) return 'transient';
  return 'stopped';
}

/** Choose the next blocked-return action from the already-read facts. */
export function blockedReturnDecision(facts: {
  unfinished: boolean; providerFailureWithoutImpediment: boolean; unfinishedPushed: boolean;
  firstNonDelivery: boolean; nonDeliveryPushed: boolean;
}): 'unfinished' | 'non_delivery' | 'continue' {
  if (facts.unfinished && !facts.providerFailureWithoutImpediment && !facts.unfinishedPushed) return 'unfinished';
  if (facts.firstNonDelivery && !facts.nonDeliveryPushed) return 'non_delivery';
  return 'continue';
}

/**
 * Papercut fa4a53a7: repeated pre-PR branch lookups back off in idle-grace
 * steps — 1, 2, 5, 15, then 60 minutes at the production grace — resetting on
 * any new worker activity, so a blocked lane cannot crowd task detail with an
 * unchanged lookup pair every minute.
 */
const BRANCH_PR_LOOKUP_BACKOFF_STEPS = [1, 2, 5, 15, 60];
/**
 * True only when a task's own completion actually reported a pull request.
 *
 * A blocked or error completion is a report of a blocker, not of a PR - it may even name one in
 * its summary, as a live task did while its prUrl stayed null. Treating any completion as PR
 * identity meant the branch-PR reconciliation skipped exactly the tasks whose worker had pushed
 * a PR and then reported a blocker, so the open PR was never bound to the task that owned it.
 */
export const completionReportsPr = (task: Task) => task.completion?.status === "ready_for_review";
/** Spec 051: the visible reasons while an interactive task's worker is in its operator session. */
export const INTERACTIVE_RUNNING_REASON = "Interactive session: the worker is running";
export const INTERACTIVE_WAIT_REASON = "Interactive session: waiting for the operator in the worker's thread";

/**
 * The initial worker's reconcile pass: observe the worker, settle a live one,
 * look for its branch PR, repair a split reporting binding, take a blocked
 * return, then accept its recorded result. Same-name `Engine` methods delegate
 * here. `store`, `adapter` and `resolution` read the engine per call: tests
 * replace the adapter.
 */
export type WorkerReconcileContext = Pick<Engine, 'acceptWorkerResult' | 'adapter' | 'admission' | 'branchPrLookupDue' | 'compareSiblings' | 'continuationOwnsReturn' | 'hooks' | 'host' | 'idleGraceMs' | 'note' | 'onTaskHost' | 'reconcileBlockedReturn' | 'reconcileBranchPr' | 'reconcileObservation' | 'reconcileReportingBinding' | 'recordObservation' | 'reportingBindingRecheckDue' | 'stopped' | 'store' | 'updateAfterOperatorRemap'>
  & { readonly resolution: Pick<Resolution, 'adoptReplacementPr' | 'attention' | 'extendCallbackReminder' | 'heavyRunAlive' | 'identifyOriginHost' | 'withHost' | 'reconcileStalledTurnStop' | 'recovery' | 'remindStoppedWorker' | 'resolveIncident' | 'responsiblePrReportRefused' | 'settleAutomaticReplayHold' | 'stalls' | 'suppressAutomaticRetry' | 'update' | 'waiting'> };

export class WorkerReconcile {
  constructor(readonly engine: WorkerReconcileContext) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  /**
   * Task 676 / #575: a same-thread push-back recorded for this return owns it. A pass that
   * was stalled on a read or the blocked hook when the push-back was written must not
   * overwrite changes_requested with blocked/error and start recovery.
   */
  continuationOwnsReturn(taskId: string): boolean {
    const latest = this.store.task(taskId);
    const runId = latest.completion?.runId;
    return latest.phase === 'changes_requested' && Boolean(runId)
      && this.store.eventsAll(taskId).some(event => ['non_delivery_pushback', 'unfinished_pushback'].includes(event.kind)
        && event.detail.startsWith(`${runId}:`));
  }
  async reconcile(task: Task) {
    const observed = await this.engine.reconcileObservation(task);
    if (!observed) return;
    const { state } = observed;
    let { current } = observed;
    if (!["idle", "error", "closed"].includes(state.status)) throw new Error("Worker status is unknown; not releasing its workspace");
    // The idle grace starts here rather than below. The split-binding path returns
    // before the later stamp, so a lane that can never deliver a report would keep
    // `idleSince` unset and hold its own branch-PR reconciliation shut forever.
    // The first observation still consumes the same pass before any reminder, so
    // only the gate moves.
    const firstIdleObservation = state.status === "idle" && !current.idleSince;
    const graceElapsed = Boolean(current.idleSince && Date.now() - Date.parse(current.idleSince) >= this.engine.idleGraceMs);
    if (firstIdleObservation) {
      const reason = (latestRunCompletion(this.store.runs(current.id)) ?? current.completion)?.summary ?? "Worker idle; allowing time for completion delivery";
      // Spec 050: a dispatch fence is the task's visible cause until its owner
      // releases it, so the first idle observation starts the completion-delivery
      // grace without replacing the stop that names the hold. A live worker the
      // owner stopped keeps the held stop the verb recorded in its control
      // quantum; overwriting it with the idle note here left `task.reason` and the
      // board card describing a wait that was no longer true while `next`, task
      // detail and the stored stop still named the hold (Queue #403, the
      // live-stop path found reviewing #641). No run, phase or stop record moves:
      // an unheld worker keeps the ordinary grace note and reminders, and a
      // release still retires the held stop with the last fence.
      current = this.store.update(task.id, dispatchBlocked(current) ? { idleSince: now() } : { idleSince: now(), reason });
    }
    // Read-only identity diagnostic (Contract 003): a stopped initial worker
    // whose retained reporting binding names another run can authenticate
    // nothing. The exact branch-PR reconciliation below runs first because it
    // re-issues the binding through the retained revision path; this reports the
    // remaining split before the lane stalls into an unrecoverable phase.
    const mismatch = reportingIdentityMismatch(current, wireLabel(state.labels, "mcpBinding"));
    const hasPrIdentity = Boolean(completionReportsPr(current) || current.prUrl || current.prHead || current.resumePrNumber);
    // A split binding cannot deliver the callback that would record the PR, and the
    // PR is what re-issues the binding, so this reconciliation is the repair rather
    // than a courtesy. Its grace is unsatisfiable while the split stands, so it must
    // not wait behind one. An identified worker and an elapsed grace keep their
    // existing behaviour: a matched binding still gets its full grace before the
    // queue reaches for a PR the worker may be about to report itself.
    const readyForBranchPrLookup = !hasPrIdentity &&
      (state.status === 'error' || state.status === 'closed' || graceElapsed || Boolean(mismatch));
    if (readyForBranchPrLookup && this.engine.branchPrLookupDue(current) && await this.engine.reconcileBranchPr(current)) return;
    // While the branch-PR live read is unverified, the lane holds for its
    // retry: a reporting-binding mismatch or an ordinary worker fault must
    // not escalate on a projection the pending read may still repair. A
    // late authenticated completion still advances below, and it supersedes
    // the pending read.
    current = this.store.task(current.id);
    if (current.completion) clearLiveEvidence(this.store, current.id, 'branch-pr');
    if (!current.completion && liveEvidenceEpisode(this.store, current.id, 'branch-pr')) return;
    if (mismatch) {
      await this.engine.reconcileReportingBinding(current, mismatch);
      return;
    }
    // An escalated live-evidence outcome owns the lane: routine handling
    // must not overwrite its reason or disturb its single notice. A late
    // authenticated completion still advances below.
    current = this.store.task(current.id);
    if (!current.completion && current.resolution.recovery?.status === 'escalated'
      && current.reason === current.resolution.recovery.summary) return;
    if (this.engine.reconcileBlockedReturn(task, current, state)) return;
    if (current.completion) {
      await this.engine.acceptWorkerResult(task, current);
    } else if (state.status === "closed" && !state.error) {
      // A cleanly closed retained session is resumable in Paseo. Give it the
      // same one-shot authenticated reporting reminder as an idle worker before
      // spending a coordinator run.
      await this.resolution.remindStoppedWorker(current);
    } else if (current.pausedStop) {
      // Queue #650: the operator stopped this thread while paused; even an error
      // observation is not a failure yet — the unpause resume owns delivery, and
      // a resume that cannot land arms the ordinary replacement with its reason.
      this.resolution.waiting(current, pausedStopWaitReason("worker"), "paused_stop");
    } else if (state.status === "error" || state.status === "closed") {
      this.engine.note(task.id, state.error || `Worker ${state.status} without a completion callback`, 'classify', "needs_attention");
    } else if (!firstIdleObservation && current.idleSince && Date.now() - Date.parse(current.idleSince) >= this.engine.idleGraceMs) {
      await this.resolution.remindStoppedWorker(current);
    }
  }
  /** Observe the worker and settle every live state. Null ends the pass; otherwise the worker has stopped. */
  async reconcileObservation(task: Task): Promise<{ state: Awaited<ReturnType<Adapter["observe"]>>; current: Task } | null> {
    // Callers pick lanes from an earlier read. A task that has since finished or been
    // disposed must not be reconciled: re-processing an old worker receipt reopened
    // g05.222 from cancelled to blocked.
    const terminal = (t: Task) => Boolean(t.removedAt) || ["done", "cancelled"].includes(t.phase) || isDispositionActive(t) || isDispositionComplete(t);
    if (terminal(this.store.task(task.id))) return null;
    const state = await this.engine.onTaskHost(task, () => this.engine.host.observe(task.agentId!));
    if (this.engine.stopped) return null;
    let current = this.store.task(task.id);
    if (terminal(current)) return null;
    if(current.phase==='working'&&!current.resolution.recoveryActive&&current.resolution.recovery?.status==='escalated'&&current.retiredWorkers.at(-1)?.reason.startsWith(OPERATOR_WORKER_REMAP_REASON)){
      current=this.engine.updateAfterOperatorRemap(current);
    }
    // A control action or review verdict may move a task into the resolution
    // state machine while this pass still holds the earlier worker snapshot.
    // A ready callback with durable PR identity has already been consumed; do
    // not replay it over a pending revision or retained-profile attention.
    // Worker failover clears PR identity, so its fresh callback still advances.
    const consumedReady=current.completion?.status==='ready_for_review'&&Boolean(current.prHead&&current.prUrl);
    // Once PR identity has been accepted, the worker receipt belongs to history.
    // Review, pre-merge and operator transitions own every later phase. Replaying
    // the same receipt from an idle worker would reset those phases to
    // awaiting_review and can create an unbounded same-head review loop.
    if (consumedReady && current.phase !== 'working') return null;
    if (current.phase === 'changes_requested') return null;
    if (current.failoverReason) return null;
    if (state.workspaceId !== current.workspaceId) throw new Error("Worker placement changed; workspace ownership is unknown");
    this.engine.recordObservation(current, state);
    // Pause still applies a stored result. Without one, skip classification so
    // pause does not start reminders or replacement.
    if (startsNoRuns(this.store) && !current.completion) return null;
    // A persisted checkpoint intent owns the pending turn: do not treat the
    // retained worker's deliberate stop as a missing callback.
    if (current.checkpoints.intent && current.checkpoints.intent.status !== 'delivered') return null;
    // Spec 051: until an interactive task's worker reports, its thread is the
    // operator's working session. A live turn shows as running and an idle one
    // waits on the operator: no stall detection, idle grace, callback reminder
    // or coordinator recovery. An errored or closed thread is handled as usual.
    if (current.phase === "working" && interactiveSessionOpen(current, this.store.runs(current.id))) {
      const live = state.active || ["running", "initializing"].includes(state.status) || state.permissions;
      if (live || state.status === "idle") {
        if (current.idleSince) this.store.update(task.id, { idleSince: null });
        if (live) this.engine.note(task.id, state.permissions ? "Worker is waiting for a permission response in Paseo" : INTERACTIVE_RUNNING_REASON, 'lifecycle');
        else this.resolution.waiting(this.store.task(task.id), INTERACTIVE_WAIT_REASON, 'interactive');
        return null;
      }
    }
    if(this.resolution.reconcileStalledTurnStop(current,null,state))return null;
    const observation = classifyWorkerObservation(current, state);
    if (observation === 'live' || observation === 'live_recover') {
      // New worker activity also resets the branch-PR lookup backoff (papercut
      // fa4a53a7): any empty result predating this observation is stale evidence.
      // The last outcome is kept across the reset so an unchanged result after
      // the restart is still coalesced rather than logged twice. The reset is a
      // one-time write: a stamp already at attempts 0 is left alone, so an
      // active worker's sweeps perform no substantive task write.
      const lookupReset = current.prLookup?.attempts ? { attempts: 0, lastAt: now(), outcome: current.prLookup.outcome } : null;
      if (current.idleSince || lookupReset) this.store.update(task.id, { idleSince: null, ...(lookupReset ? { prLookup: lookupReset } : {}) });
      // A task parked with no callback, no failover and no recovery run whose worker is
      // live again was parked by an outage, not a task fault: resume it rather than
      // leaving it in needs_attention with a pending coordinator (2026-09-29 Paseo restart).
      if (observation === 'live_recover') {
        this.store.update(task.id, { phase: "working", reason: "Worker running", resolution: { ...current.resolution, recovery: null, recoveryActive: false } }, "worker_live_after_outage", "Worker observed running; resuming");
        return null;
      }
      // Mid-turn stall detection for the initial worker: stale activity enters
      // coordinator recovery, while a long shell command shows on the task.
      const shellNotice = await this.resolution.stalls.check(current, null, state);
      const after = this.store.task(task.id);
      // An attention reason the stall check (or any other fault) just recorded owns
      // the visible cause; "Worker running" must never overwrite it mid-turn.
      if (after.phase === "needs_attention" || after.resolution.attention) return null;
      this.engine.note(task.id, state.permissions ? "Worker is waiting for a permission response in Paseo" : current.completion ? "Completion received; worker is still active" : shellNotice ?? "Worker running", 'lifecycle');
      return null;
    }
    if (observation === 'transient') return null;
    if (await this.resolution.heavyRunAlive(current)) {
      // Same one-time reset as the active-worker branch above: a stamp already
      // at attempts 0 is left alone so capacity-wait sweeps write nothing.
      const lookupReset = current.prLookup?.attempts ? { attempts: 0, lastAt: now(), outcome: current.prLookup.outcome } : null;
      if (current.idleSince || lookupReset) this.store.update(task.id, { idleSince: null, ...(lookupReset ? { prLookup: lookupReset } : {}) });
      if (current.runId) this.resolution.extendCallbackReminder(this.store.task(task.id), current.runId);
      return null;
    }
    return { state, current };
  }
  /** Look for the queue branch's open PR before coordinator recovery. True ends the pass. */
  async reconcileBranchPr(current: Task): Promise<boolean> {
    if (!this.adapter.findOpenBranchPr) {
      // Rule 5, capability absent: proceed on Queue's own knowledge and
      // record once that the live check was unavailable, so a later reader
      // cannot mistake the decision for a confirmed absence.
      if (!this.store.events(current.id).some(event => event.kind === 'initial_pr_lookup_unavailable')) {
        this.store.event(current.id, 'initial_pr_lookup_unavailable', `Open-PR live check for ${current.branch} is unavailable; deciding from Nucleus's own knowledge`);
      }
    } else {
      // Papercut fa4a53a7: the event pair is recorded only when the outcome
      // changes (for example empty to found); an unchanged result coalesces
      // onto the task's lookup stamp so real events keep their place.
      let matches: { number: number; url: string; head: string }[] | null = null;
      let lookupError: unknown = null;
      try {
        matches = await this.adapter.findOpenBranchPr(current);
      } catch (error) { lookupError = error; }
      const previousOutcome = current.prLookup?.outcome ?? null;
      const attempts = (current.prLookup?.attempts ?? 0) + 1;
      const stamp = (outcome: "empty" | "found" | null) => {
        current = this.store.update(current.id, { prLookup: { attempts, lastAt: now(), outcome: outcome ?? previousOutcome } });
      };
      const outcome = lookupError !== null ? branchPrLookupOutcome(lookupError, 0) : branchPrLookupOutcome(null, matches!.length);
      if (outcome === 'unverified') {
        stamp(null);
        // Rule 5: a failed, timed-out, refused or unavailable read is
        // `unverified`, never absence. Hold quietly inside the bounded
        // grace, retry after it, and produce at most one notice if the
        // failure persists, with the failure recorded on the escalation.
        const hold = recordLiveEvidenceFailure(this.store, current.id, 'branch-pr', lookupError, this.engine.idleGraceMs);
        if (hold === 'notice') {
          const summary = `Open-PR live check for ${current.branch} is unverified (${liveEvidenceEpisode(this.store, current.id, 'branch-pr')?.error}); holding for retry rather than treating the PR as absent`;
          this.resolution.attention(current, summary);
          this.resolution.recovery.escalate(this.store.task(current.id), summary);
        }
        return true;
      }
      clearLiveEvidence(this.store, current.id, 'branch-pr');
      if (outcome === 'ambiguous') {
        stamp(null);
        // Rule 5, ambiguity: more than one match is real identity conflict
        // and needs a human. Escalate naming the candidate identities as
        // operational uncertainty; no coordinator run is spent on it.
        const candidates = matches!.map(match => `#${match.number} (${match.url} @ ${match.head})`).join(', ');
        const summary = `Multiple open PRs use queue branch ${current.branch}: ${candidates}. Exact identity is ambiguous; this is operational uncertainty for the operator, not coordinator judgment. No PR was adopted and no resource was created.`;
        if (current.resolution.recovery?.status !== 'escalated' || current.resolution.recovery.summary !== summary) {
          this.resolution.attention(current, summary);
          this.resolution.recovery.escalate(this.store.task(current.id), summary);
        }
        return true;
      }
      if (outcome === 'found') {
        stamp("found");
        if (previousOutcome !== "found") this.store.event(current.id, 'initial_pr_lookup', 'Checking the queue-owned branch for an exact open PR before coordinator recovery');
        await this.resolution.adoptReplacementPr(this.store.task(current.id), matches![0].number); return true;
      }
      stamp("empty");
      if (previousOutcome !== "empty") {
        this.store.event(current.id, 'initial_pr_lookup', 'Checking the queue-owned branch for an exact open PR before coordinator recovery');
        this.store.event(current.id, 'initial_pr_lookup_empty', `No open PR found for ${current.branch}`);
      }
    }
    return false;
  }
  /** A split reporting binding: re-read it live once per grace window, then escalate only a confirmed split. */
  async reconcileReportingBinding(current: Task, mismatch: NonNullable<ReturnType<typeof reportingIdentityMismatch>>): Promise<void> {
    const reason = `Worker reporting binding names run ${mismatch.bindingRunId} but the task holds ${mismatch.runId}; the worker cannot authenticate a report until the binding follows the task run`;
    // Already escalated for this exact mismatch: the confirmation read is
    // spent, so no further live read until the projection changes.
    if (current.phase === 'needs_attention' && current.resolution.attention && current.reason === reason) return;
    // An escalation already owns the lane: reconcile neither overwrites
    // its reason nor spends another live read re-proving it. The lane
    // awaits its human or operator control.
    if (current.resolution.recovery?.status === 'escalated') return;
    // One confirmation read per grace window: a provider whose projection
    // flaps must not spend a re-read on every pass without an escalation.
    if (!this.engine.reportingBindingRecheckDue(current)) return;
    // Rule 4 gap: a stale mismatch projection must not force an
    // escalation. Re-read the retained worker's current binding and stopped
    // state live before escalating. The re-read goes through the existing
    // admission classes; the settled-idle cache is dropped first so it
    // cannot answer from the observation above.
    let fresh: Awaited<ReturnType<Adapter['observe']>> | null = null;
    let confirmError: unknown = null;
    try {
      this.engine.admission?.invalidate(current.agentId!);
      this.store.event(current.id, 'reporting_binding_recheck', 'Re-reading the retained worker binding and stopped state before a mismatch escalation');
      fresh = await this.engine.onTaskHost(current, () => this.engine.host.observe(current.agentId!));
    } catch (error) { confirmError = error; }
    if (this.engine.stopped) return;
    if (confirmError !== null) {
      const hold = recordLiveEvidenceFailure(this.store, current.id, 'reporting-binding', confirmError, this.engine.idleGraceMs);
      if (hold === 'notice') {
        const summary = `Worker reporting binding is unverified (${liveEvidenceEpisode(this.store, current.id, 'reporting-binding')?.error}); holding for retry rather than treating the binding as split`;
        this.resolution.attention(current, summary);
        this.resolution.recovery.escalate(this.store.task(current.id), summary);
      }
      return;
    }
    const latest = this.store.task(current.id);
    const still = reportingIdentityMismatch(latest, wireLabel(fresh!.labels, 'mcpBinding'));
    const stopped = !fresh!.active && !fresh!.permissions && ['idle', 'error', 'closed'].includes(fresh!.status);
    // The projection moved under the escalation: the binding now follows
    // the task run, the worker resumed, or the lane otherwise left the
    // mismatch window. No escalation; the next pass observes from fresh state.
    if (!still || !stopped || fresh!.workspaceId !== latest.workspaceId) {
      clearLiveEvidence(this.store, current.id, 'reporting-binding');
      this.store.event(current.id, 'reporting_binding_reverified', 'Retained binding re-read before a mismatch escalation no longer shows a split; no escalation');
      return;
    }
    clearLiveEvidence(this.store, current.id, 'reporting-binding');
    this.resolution.attention(current, reason);
    return;
  }
  /** A blocked or error receipt: same-thread push-back, or consumed once. True ends the pass; synchronous on purpose. */
  reconcileBlockedReturn(task: Task, current: Task, state: Awaited<ReturnType<Adapter["observe"]>>): boolean {
    // A blocked or error receipt is consumed once the lane sits in that phase. The
    // branch-PR audit keeps visiting such lanes to discover a pushed PR (above); it
    // must not re-run the task.blocked hook and rewrite the lane on every pass.
    if (current.completion && ['blocked', 'error'].includes(current.completion.status)) {
      if (resultApplied(this.store, current.id, current.completion.runId)) return true;
      const nonDeliveries = consecutiveNonDeliveries(this.store.eventsAll(current.id));
      const latest = nonDeliveries.at(-1);
      // Task 576: a worker unfinished return with new commits continues the same
      // round automatically, like the revision path. A return with no progress
      // falls through to the #575 non-delivery handling below.
      const unfinished = unfinishedContinuationEvents(this.store.eventsAll(current.id)).find(item => item.runId === current.completion!.runId);
      // Task 676: an observed provider failure keeps its existing failover; the same-thread continuation never takes it.
      const observedProviderFailure = recognisedExternalWording(String(state.error ?? ''));
      if (unfinished && blockedReturnDecision({ unfinished: true, providerFailureWithoutImpediment: observedProviderFailure && unfinished.reason === 'no_impediment', unfinishedPushed: !(observedProviderFailure && unfinished.reason === 'no_impediment') && this.store.eventsAll(current.id).some(event => event.kind === 'unfinished_pushback' && event.detail.startsWith(`${unfinished.runId}:`)), firstNonDelivery: false, nonDeliveryPushed: false }) === 'unfinished') {
        // Task 645: the owner's no-automatic-retry rule suppresses the push-back
        // and hands the kept result to the planner ladder instead of relaunching.
        if (automaticRetryForbidden(current, this.store.runs(current.id))) {
          this.store.transaction(() => {
            const fresh = this.store.task(current.id);
            if (fresh.completion?.eventId !== current.completion?.eventId || resultApplied(this.store, current.id, unfinished.runId)) return;
            this.resolution.update(fresh, {}, { phase: fresh.completion!.status as 'blocked' | 'error', reason: fresh.completion!.summary });
            this.resolution.suppressAutomaticRetry(this.store.task(current.id), 'unfinished', fresh.completion!.summary, unfinished.runId);
            recordResultApplied(this.store, current.id, unfinished.runId);
          });
          return true;
        }
        const instruction = continuationInstruction(unfinished);
        this.store.transaction(() => {
          const latest = this.store.task(current.id);
          if (latest.completion?.eventId !== current.completion?.eventId || resultApplied(this.store, current.id, unfinished.runId)) return;
          this.resolution.update(latest, { pendingRevisionCause: 'unfinished', pendingWorkerInstruction: instruction },
            { phase: 'changes_requested', reason: instruction }, 'unfinished_pushback', `${unfinished.runId}: same retained worker continues the unfinished round`);
          recordResultApplied(this.store, current.id, unfinished.runId);
        });
        return true;
      }
      if (latest?.runId === current.completion.runId && nonDeliveries.length === 1
        && blockedReturnDecision({ unfinished: false, providerFailureWithoutImpediment: false, unfinishedPushed: false,
          firstNonDelivery: true, nonDeliveryPushed: this.store.eventsAll(current.id).some(event => event.kind === 'non_delivery_pushback' && event.detail.startsWith(`${latest.runId}:`)) }) === 'non_delivery') {
        // Task 645: the owner's no-automatic-retry rule suppresses the push-back
        // and hands the kept result to the planner ladder instead of relaunching.
        if (automaticRetryForbidden(current, this.store.runs(current.id))) {
          this.store.transaction(() => {
            const fresh = this.store.task(current.id);
            if (fresh.completion?.eventId !== current.completion?.eventId || resultApplied(this.store, current.id, latest.runId)) return;
            this.resolution.update(fresh, {}, { phase: fresh.completion!.status as 'blocked' | 'error', reason: fresh.completion!.summary });
            this.resolution.suppressAutomaticRetry(this.store.task(current.id), 'non_delivery', fresh.completion!.summary, latest.runId);
            recordResultApplied(this.store, current.id, latest.runId);
          });
          return true;
        }
        this.store.transaction(() => {
          const fresh = this.store.task(current.id);
          if (fresh.completion?.eventId !== current.completion?.eventId || resultApplied(this.store, current.id, latest.runId)) return;
          this.resolution.update(fresh, { pendingRevisionCause: 'non_delivery', pendingWorkerInstruction: NON_DELIVERY_PUSHBACK },
            { phase: 'changes_requested', reason: NON_DELIVERY_PUSHBACK }, 'non_delivery_pushback', `${latest.runId}: same retained worker continues`);
          recordResultApplied(this.store, current.id, latest.runId);
        });
        return true;
      }
      if (current.phase === current.completion.status) return true;
      if (this.engine.continuationOwnsReturn(task.id)) return true;
    }
    return false;
  }
  /** Take the worker's recorded result: hold a report for its planner, verify a PR report, or record a blocked or error return. */
  async acceptWorkerResult(task: Task, current: Task): Promise<void> {
    if (current.completion && resultApplied(this.store, task.id, current.completion.runId)) return;
    if (current.completion?.status === 'report_ready') {
      if (current.phase === 'report_ready') return;
      const artifact = current.completion.artifact!;
      const reason = `Planner: report ready — ${current.completion.summary} (lane ${artifact.key} v${artifact.version}, ${artifact.digest}). Complete this dispatched task with reason and artifact {key, version, digest}, or move it to work with instructions if the report needs revision.`;
      const applied = this.store.transaction(() => {
        const latest = this.store.task(task.id);
        if (latest.completion?.eventId !== current.completion?.eventId || resultApplied(this.store, task.id, current.completion!.runId)) return false;
        this.store.update(task.id, { phase: 'report_ready', reason, idleSince: null }, 'workspace_released', 'report_ready');
        recordResultApplied(this.store, task.id, current.completion!.runId);
        return true;
      });
      if (!applied) return;
      const planner = this.store.projectPlannerRecipient(this.store.projectFor(current.repoPath, normalizeRepositoryOrigin(current.repository ?? '')));
      if (planner && this.adapter.notify && !this.store.eventsAll(task.id).some(event => event.kind === 'report_ready_planner_notice_intent')) {
        const messageId = `ns-report-ready-${task.id}-${current.completion.eventId}`;
        this.store.event(task.id, 'report_ready_planner_notice_intent', `${planner}: ${messageId}`);
        try {
          const hostId = parseAgentId(planner)?.hostId ?? (sameCallerIdentity(planner, current.notificationAgentId ?? current.originAgentId)
            ? current.originHostId : await this.resolution.identifyOriginHost(planner));
          if (!hostId) throw Error('Report acceptance planner host is unknown');
          await this.resolution.withHost(hostId, () => this.engine.host.sendMessage(planner, { messageId,
            text: `Nucleus: report ready for planner acceptance\nTask: ${current.title} (${current.id})\n${current.completion!.headline ?? current.completion!.summary}\nArtifact: ${artifact.key} v${artifact.version} (${artifact.digest})\nUse the existing complete owner verb with the artifact and an acceptance reason, or move to work with an instruction if the report needs revision. No PR or reviewer was started.` }));
          this.store.event(task.id, 'report_ready_planner_notice_delivered', planner);
        } catch (error) { this.store.event(task.id, 'report_ready_planner_notice_unknown', `${planner}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000)); }
      }
      return;
    }
    const c = current.completion!;
    current = await this.engine.compareSiblings(current, c.eventId);
    if (c.status === "ready_for_review") {
      let pr: Awaited<ReturnType<NonNullable<Adapter['verifyPr']>>>;
      try { pr = await this.adapter.verifyPr(current, c.prNumber!); }
      catch (error) {
        const handled = this.store.transaction(() => {
          const latest = this.store.task(task.id);
          if (resultApplied(this.store, task.id, c.runId) || latest.runId !== c.runId || latest.completion?.eventId !== c.eventId) return true;
          if (!this.resolution.responsiblePrReportRefused(latest, c.runId, c.prNumber!, error)) return false;
          recordResultApplied(this.store, task.id, c.runId);
          return true;
        });
        if (handled) return;
        throw error;
      }
      if (settlementHeld(this.store, this.engine.stopped)) return;
      if (current.prHead && pr.head !== current.prHead) throw new Error("PR head changed after the completion callback");
      current = { ...current, prHead: pr.head, prUrl: pr.url };
    }
    if (c.status !== "ready_for_review") {
      const hookState = await this.engine.hooks.emit("task.blocked", current, { event: "task.blocked", summary: c.summary, delivery: { prUrl: current.prUrl, prNumber: c.prNumber ?? null, head: current.prHead, review: current.resolution.review?.summary ?? null, summary: c.summary } });
      if (hookState.hold) { this.engine.note(task.id, hookHoldReason(hookState), 'operator_needed', "needs_attention"); return; }
      current = this.resolution.settleAutomaticReplayHold(current, hookState.records, 'task.blocked');
    }
    // A late authenticated result reconciles the stopped-worker incident instead of leaving attention behind.
    const awaitedReminder = current.resolution.incident?.runId === current.runId && current.resolution.incident.action === 'callback_reminder' && current.resolution.incident.status !== 'escalated';
    const stopAttention = current.resolution.attention && (awaitedReminder || current.reason === 'Worker stopped without a completion callback; inspect the thread');
    // The blocked hook above waited on I/O: a push-back recorded meanwhile owns this return.
    if (c.status !== "ready_for_review" && this.engine.continuationOwnsReturn(task.id)) return;
    const applied = this.store.transaction(() => {
      const latest = this.store.task(task.id);
      if (latest.completion?.eventId !== c.eventId || latest.runId !== c.runId || resultApplied(this.store, task.id, c.runId)) return false;
      this.store.update(task.id, { phase: c.status === "ready_for_review" ? "awaiting_review" : c.status === "blocked" ? "blocked" : "error", reason: c.summary, idleSince: null,
        ...(c.status === 'ready_for_review' ? { prHead: current.prHead, prUrl: current.prUrl } : {}),
        ...(stopAttention ? { resolution: { ...latest.resolution, attention: false } } : {}) }, "workspace_released", c.status);
      recordResultApplied(this.store, task.id, c.runId);
      return true;
    });
    if (applied && awaitedReminder) this.resolution.resolveIncident(current, current.runId, 'Late authenticated result received');
  }
  /**
   * Whether the queue-owned branch reconciliation may run again. A first empty
   * result is evidence for one moment, not a permanent verdict: the worker can
   * open its PR seconds later, and a lane that retires its only repair
   * instrument can no longer be repaired without an operator. Repeats back off
   * in idle-grace steps (papercut fa4a53a7) — 1, 2, 5, 15, then 60 minutes at
   * the production grace — and the schedule resets on any new worker activity,
   * the same observations that clear `idleSince`.
   */
  branchPrLookupDue(task: Task): boolean {
    const state = task.prLookup;
    // Null or a reset stamp (attempts 0): the next lookup is immediate, still
    // behind the reconciliation's own readiness gates.
    if (!state || state.attempts === 0) return true;
    const steps = BRANCH_PR_LOOKUP_BACKOFF_STEPS;
    const step = steps[Math.min(state.attempts - 1, steps.length - 1)];
    return Date.now() - Date.parse(state.lastAt) >= step * this.engine.idleGraceMs;
  }
  /**
   * Whether the reporting-binding confirmation may run again. Like the
   * branch-PR reconciliation above, one gated read per grace window: the
   * first stale or unverified outcome holds until the window reopens.
   */
  reportingBindingRecheckDue(task: Task): boolean {
    const last = this.store.events(task.id).find(event => event.kind === 'reporting_binding_recheck');
    return !last || Date.now() - Date.parse(last.at) >= this.engine.idleGraceMs;
  }
  recordObservation(task: Task, state: Awaited<ReturnType<Adapter["observe"]>>) {
    const active = observedActive(state);
    const changed = task.lastAgentStatus !== state.status || task.agentActive !== active;
    const modelChanged=Boolean(state.model&&(state.model!==task.workerModel||!task.workerModels.includes(state.model)));
    this.store.update(task.id, { lastAgentStatus: state.status, agentActive: active, lastObservedAt: now(), ...(modelChanged ? { workerModel: state.model, workerModels: [...new Set([...task.workerModels, state.model!])] } : {}) }, changed ? "agent_state" : undefined, state.status);
  }
  async observeOnly(task: Task) {
    const state = await this.engine.onTaskHost(task, () => this.engine.host.observe(task.agentId!));
    if (this.engine.stopped) return;
    if (state.workspaceId !== task.workspaceId) throw new Error("Worker placement changed; inspect ownership before resuming");
    this.engine.recordObservation(this.store.task(task.id), state);
  }
}
