import { FORCE_MOVE_REFUSAL, FORCE_MERGED_REFUSAL, FORCE_PAUSED_REFUSAL, FORCE_MERGE_UNAVAILABLE_REFUSAL, FORCE_HOLD_REFUSAL, FORCE_MERGE_OBSERVATION_REFUSAL, FORCE_EFFECT_REQUIRED_REFUSAL, FORCE_PUBLICATION_REFUSAL, missingForcedEffectRefusal } from './verb-refusal-text';
import { randomUUID } from "node:crypto";
import type { OwnerAcceptanceRecord, Run, Task, TaskControlInput } from "../../shared/contracts";
import { OPERATOR_BOARD_CALLER, holdsOf, syncHoldProjection } from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import type { Engine } from "../engine";
import { executionParticipants } from "../machine/execution-participants";
import { settleSupersededFencesInTx } from "../recovery/fence-settlement";
import { assertCanonicalPrSource, taskPrNumber } from "../forge/index";
import { runsUnchangedSince } from "../recovery/observation-advance";
import { collectOwnerVerbFacts, ownerEffectOccurrence, ownerPendingEffects, qualifiedAcceptanceEligibility } from "./owner-verbs";
import type { Adapter } from "../host/adapter";
import { recoveryEffects, recoverySettlementKey } from "../recovery/recovery-effects";
import type { ResolutionAdapter } from "../resolution";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { now } from "../store/store";
import { appliedMergeVerdict, plannerIdMatches, readyReviewAtHead } from "../recovery/task-reasons";

/** Refuse a force merge before observing checks when its source authority is insufficient. */
export function forceMergeSourceRefusal(task: Task, input: TaskControlInput, head: string, selfRole: string | null): string | null {
  if (input.head && input.head !== head || !input.head && task.prHead !== head)
    return `The PR head is ${head}; review that exact head or provide its explicit operator source acceptance`;
  if (selfRole && !readyReviewAtHead(task, head))
    return 'Self-force merge requires an applied ready_to_merge verdict at the exact head';
  return null;
}

/** Decide whether an acceptance is needed and, if so, whether it is qualified. */
export function forceMergeAcceptance(task: Task, input: TaskControlInput, head: string, runs: Run[]):
  { kind: 'none' } | { kind: 'refuse'; reason: string } |
  { kind: 'accept'; eligibility: Extract<ReturnType<typeof qualifiedAcceptanceEligibility>, {available: true}> } {
  if (readyReviewAtHead(task, head)) return { kind: 'none' };
  const eligibility = qualifiedAcceptanceEligibility({ ...task, phase: 'verifying', disposition: null, prHead: head,
    resolution: { ...task.resolution, mergeIntent: false, mergedCommit: null } }, runs);
  if (!eligibility.available) return { kind: 'refuse', reason: eligibility.refusal };
  if (eligibility.acceptance === 'operator_source' && (!input.qualification || (input.caller !== OPERATOR_BOARD_CALLER && (!input.relayed || !input.note?.trim()))))
    return { kind: 'refuse', reason: 'No applied verdict exists at this head. Only explicit operator source acceptance can replace exact-head review: provide qualification and a relayed note quoting Tom' };
  return { kind: 'accept', eligibility };
}

/** Decide whether observed non-required failures may be forced by the reviewer. */
export function forceMergeAdmission(head: string, reason: string, gate: import('../resolution').MergeGateResult,
  requiredGate: import('../resolution').MergeGateResult):
  { refusal: string } | { forcedChecks: {name: string; jobUrl: string}[] } {
  if (requiredGate.head !== head || requiredGate.wait || !requiredGate.requirements?.known)
    return { refusal: 'GitHub-required or unknown checks cannot be forced' };
  const failures = [...(requiredGate.requiredEvidence ?? []), ...(requiredGate.advisory ?? [])].filter(c => /FAILURE|FAILED|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE/i.test(c.conclusion || c.state));
  if (!gate.checksFailed || !failures.length) return { refusal: 'GitHub-required or unknown checks cannot be forced' };
  if (failures.some(c => !c.jobUrl || !reason.includes(c.name) || !reason.includes(c.jobUrl))
    || !/unrelated|cannot have caused|could not have caused/i.test(reason))
    return { refusal: 'Name each failed check, its job URL and why this diff cannot have caused it' };
  return { forcedChecks: failures.map(({name,jobUrl}) => ({name,jobUrl})) };
}

/** Construct the forced move from facts gathered after participants are settled. */
export function forceMovePatch(f: {
  settled: Task; input: TaskControlInput; reason: string; observedHead: string | null;
  observedUrl: string | null; observedNumber: number | null; mergedCommit: string | null;
  acceptance: OwnerAcceptanceRecord | null; records: ReturnType<Engine['forceSettlementRecord']>[];
  forcedChecks: {name: string; jobUrl: string}[]; selfForceRunId: string | undefined;
  participants: Map<string, string>; uncertainties: string[]; requestedAt: string | null;
}): Partial<Task> {
  const { settled, input, reason, observedHead, observedUrl, observedNumber, mergedCommit, acceptance,
    records, forcedChecks, selfForceRunId, participants, uncertainties, requestedAt } = f;
  const phase = input.to === 'work' ? 'changes_requested' : input.to === 'review' ? 'awaiting_review'
    : input.to === 'merge' ? 'merging' : 'syncing';
  const acceptances = acceptance ? [...settled.resolution.ownerAcceptances, acceptance] : settled.resolution.ownerAcceptances;
  const closeoutWithoutVerdict = input.to === 'closeout' && !settled.resolution.mergedWithNone
    && !appliedMergeVerdict({ ...settled, prHead: observedHead ?? settled.prHead, resolution: { ...settled.resolution, ownerAcceptances: acceptances } }, observedHead);
  return { ...syncHoldProjection({}), phase, disposition: null,
    ...(observedHead ? { prHead: observedHead } : {}),
    ...(observedUrl ? { prUrl: observedUrl } : {}),
    ...(input.to === 'review' && observedNumber ? { resumePrNumber: observedNumber } : {}),
    reason: `Forced move to ${input.to}: ${reason}${uncertainties.length ? `; participant activity or cancellation is uncertain: ${uncertainties.join('; ')}` : ''}`.slice(0, 2000),
    resolution: { ...settled.resolution, ownerSettlements: [...settled.resolution.ownerSettlements, ...records],
      ownerAcceptances: acceptances,
      forcedChecks: [...settled.resolution.forcedChecks, ...(forcedChecks.length ? [{head: observedHead!, runId: selfForceRunId!, reason, checks: forcedChecks}] : [])],
      currentRunId: null, stop: null, attention: false, recoveryActive: false, integrationTurn: null,
      ownerCloseoutParticipants: input.to === 'closeout' ? [...participants].map(([agentId, workspaceId]) => ({ agentId, workspaceId })) : [],
      ...(input.to === 'work' ? { pendingWorkerInstruction: input.instruction?.trim() || reason } : {}),
      ...(input.to === 'review' ? { review: null, pendingReviewReason: reason } : {}),
      ...((input.to === 'work' || input.to === 'review') ? { mergeIntent: false, mergeHead: null,
        mergeRequestedAt: null, mergeRetryAt: null, mergeRetryOutcome: null } : {}),
      ...(input.to === 'merge' ? { mechanicalVerification: null, mergeIntent: true,
        mergeHead: observedHead, mergeRequestedAt: requestedAt, mergeResponseOutcome: 'pending' as const,
        mergeProofSince: null, mergeRetryAt: null, mergeRetryOutcome: null, mergeAutoRetryExhausted: false } : {}),
      ...(input.to === 'closeout' ? { externalMerge: true, mergeHead: observedHead, mergedCommit, mergeIntent: false,
        ...(closeoutWithoutVerdict ? { mergedWithNone: true } : {}) } : {}) } };
}

/**
 * `force: true` on `retry_effect` and `move`: who may force, the settlement
 * record, and the forced move itself. Same-name `Engine` methods delegate here.
 * `this.resolution.adapter` and `this.adapter` stay the two different adapters
 * they were on `Engine`, each read per call.
 */
export class ForceVerbs {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  forceSettleEffect(task: Task, input: TaskControlInput): Task {
    this.engine.requireOwnerControlCurrent(task, input.version, 'Task changed; refresh before retrying');
    if (!input.effect) throw new DurableFenceRefusal(FORCE_EFFECT_REQUIRED_REFUSAL);
    if (input.effect.startsWith('review_publication.'))
      throw new DurableFenceRefusal(FORCE_PUBLICATION_REFUSAL);
    const effects = ownerPendingEffects(collectOwnerVerbFacts(this.store, task));
    const selected = effects.find(effect => effect.effect === input.effect);
    if (!selected) throw new DurableFenceRefusal(missingForcedEffectRefusal(input.effect));
    return this.store.transaction(() => {
      const current = this.store.task(task.id);
      this.engine.requireOwnerControlCurrent(current, input.version, 'Task changed; refresh before retrying');
      const record = this.engine.forceSettlementRecord(current, selected, input);
      let resolution = { ...current.resolution, ownerSettlements: [...current.resolution.ownerSettlements, record] };
      if (selected.effect.startsWith('incident.') && current.resolution.incident?.id === selected.effect.slice('incident.'.length)) {
        const incident = current.resolution.incident;
        resolution = { ...resolution, incident: { ...incident, status: 'resolved', updatedAt: record.at,
          detail: `Owner settled: ${record.reason}; original: ${incident.detail}`.slice(0, 4000) } };
      }
      if (selected.effect === 'project-validation.project-validation' && current.resolution.projectValidation) {
        const historyKey = `ownerForceValidation:${task.id}:${randomUUID()}`;
        this.store.setMeta(historyKey, current.resolution.projectValidation);
        this.store.event(task.id, 'owner_settled_validation', JSON.stringify({ historyKey, caller: input.caller, reason: record.reason }));
        resolution = { ...resolution, projectValidation: { ...current.resolution.projectValidation, state: 'superseded' } };
      }
      if (selected.effect === 'merge-response.merge-response') {
        const historyKey = `ownerForceMerge:${task.id}:${randomUUID()}`;
        this.store.setMeta(historyKey, { head: current.resolution.mergeHead, requestedAt: current.resolution.mergeRequestedAt,
          response: current.resolution.mergeResponseOutcome, retryAt: current.resolution.mergeRetryAt, retryOutcome: current.resolution.mergeRetryOutcome });
        this.store.event(task.id, 'owner_settled_merge_intent', JSON.stringify({ historyKey, caller: input.caller, reason: record.reason }));
        resolution = { ...resolution, mergeIntent: false, mergeAutoRetryExhausted: true, integrationTurn: null };
      }
      return this.store.update(task.id, { resolution,
        ...(selected.effect === 'merge-response.merge-response' ? { phase: 'needs_attention' as const, reason: 'Owner settled the uncertain merge response; read next' } : {})
      }, 'owner_settled', JSON.stringify(record));
    });
  }
  forceSettlementRecord(task: Task, selected: ReturnType<typeof ownerPendingEffects>[number], input: TaskControlInput) {
    const hooks = this.store.hookEvents(task.id);
    const recoveryKeys = recoveryEffects(this.store, task, { noticeKinds: 'all' }).filter(effect => {
      const key = effect.kind === 'hook' ? `hook.${hooks.find(hook => hook.id === effect.identity)?.eventId ?? effect.identity}`
        : effect.kind === 'publication' ? `review_publication.${effect.identity}` : `${effect.kind}.${effect.identity}`;
      return key === selected.effect || (effect.kind === 'operation' && selected.effect === `task_control_operation.${effect.identity}`)
        || (effect.kind === 'hook' && selected.effect === `merged_task_retention.${hooks.find(hook => hook.id === effect.identity)?.eventId}`);
    }).map(effect => recoverySettlementKey(task, effect));
    return { effect: selected.effect, occurrence: ownerEffectOccurrence(collectOwnerVerbFacts(this.store, task), selected), summary: selected.summary, recoveryKeys,
      caller: input.caller!, source: this.engine.forceCallerSource(task, input.caller!), reason: input.reason!.trim(), at: now() };
  }
  forceCallerAuthorized(task: Task, caller: string | undefined): boolean {
    if (this.engine.selfForceRunId.getStore()) return Boolean(this.engine.selfForceRole(task));
    if (!caller) return false;
    if (caller === OPERATOR_BOARD_CALLER) return true;
    return this.engine.forcePlanners(task).some(id => plannerIdMatches(id, caller));
  }
  selfForceRole(task: Task): 'worker' | 'reviewer' | 'recovery' | null {
    const id = this.engine.selfForceRunId.getStore();
    if (!id || task.critical) return null;
    const run = this.store.run(id);
    if (run) {
      if (run.taskId !== task.id) return null;
      if (run.role === 'reviewer' && task.resolution.reviewerAgentId === run.agentId
        && (task.resolution.currentRunId === id || task.resolution.review?.runId === id)) return 'reviewer';
      if (run.released || run.completion) return null;
      if (run.role === 'recovery' && task.resolution.recovery?.runId === id) return 'recovery';
      if (run.role === 'revision' && task.resolution.currentRunId === id) return 'worker';
      return null;
    }
    return task.runId === id && !task.completion ? 'worker' : null;
  }
  forcePlanners(task: Task): Array<string | undefined> {
    const project = this.store.projectFor(task.repoPath, normalizeRepositoryOrigin(task.repository ?? ''));
    return [project?.planner?.agentId, this.store.queueProject()?.planner?.agentId];
  }
  forceCallerSource(task: Task, caller: string): 'operator_board' | 'project_planner' | 'queue_planner' | 'task_worker' | 'task_reviewer' | 'task_recovery' {
    const authenticatedRunId = this.engine.selfForceRunId.getStore();
    const run = authenticatedRunId ? this.store.run(authenticatedRunId) : null;
    const role = run?.role === 'reviewer' ? 'reviewer' : run?.role === 'recovery' ? 'recovery' : 'worker';
    if (authenticatedRunId) return `task_${role}`;
    if (caller === OPERATOR_BOARD_CALLER) return 'operator_board';
    const projectPlanner = this.store.projectFor(task.repoPath, normalizeRepositoryOrigin(task.repository ?? ''))?.planner?.agentId;
    return plannerIdMatches(projectPlanner, caller) ? 'project_planner' : 'queue_planner';
  }
  async forceMove(task: Task, input: TaskControlInput, operationId?: string): Promise<Task> {
    this.engine.requireOwnerControlCurrent(task, input.version, 'Task changed; refresh before retrying');
    if (task.removedAt || !input.to) throw new DurableFenceRefusal(FORCE_MOVE_REFUSAL);
    if (input.to === 'merge' && task.resolution.mergedCommit)
      throw new DurableFenceRefusal(FORCE_MERGED_REFUSAL);
    if (input.to === 'merge' && this.store.getMeta('paused') === true)
      throw new DurableFenceRefusal(FORCE_PAUSED_REFUSAL);
    if (input.to === 'merge' && !this.resolution.adapter.merge)
      throw new DurableFenceRefusal(FORCE_MERGE_UNAVAILABLE_REFUSAL);
    const reason = input.reason!.trim();
    const selfRole = this.engine.selfForceRole(task);
    if (selfRole && (Object.keys(holdsOf(task)).length || task.disposition))
      throw new DurableFenceRefusal(FORCE_HOLD_REFUSAL);
    let forcedChecks: {name: string; jobUrl: string}[] = [];
    let observedHead: string | null = task.prHead;
    let observedUrl: string | null = task.prUrl;
    let observedNumber: number | null = null;
    let mergedCommit: string | null = null;
    let acceptance: OwnerAcceptanceRecord | null = null;
    if (input.to === 'closeout') {
      if (!this.resolution.adapter.merged) throw new DurableFenceRefusal(FORCE_MERGE_OBSERVATION_REFUSAL);
      let merged: Awaited<ReturnType<ResolutionAdapter['merged']>>;
      try { merged = await this.resolution.adapter.merged(task); }
      catch (error) { throw new DurableFenceRefusal(`Could not read the PR merge: ${String(error)}; read next and retry when GitHub is available`); }
      if (!merged.merged || !merged.commit || !/^[a-f0-9]{40}$/.test(merged.commit) || !/^[a-f0-9]{40}$/.test(merged.head) || merged.base !== task.baseBranch)
        throw new DurableFenceRefusal('The task PR is not confirmed merged on its base; read next and choose another target');
      observedHead = merged.head;
      mergedCommit = merged.commit;
    } else if (input.to === 'review' || input.to === 'merge') {
      let pr: Awaited<ReturnType<Adapter['verifyPr']>>;
      try {
        const bound = task.reviewEntry?.prNumber ?? task.resumePrNumber ?? task.completion?.prNumber;
        if (input.prNumber && bound && input.prNumber !== bound) throw Error('The supplied prNumber differs from the bound task PR');
        const number = bound ?? (input.to === 'review' ? input.prNumber : undefined);
        if (!number) throw Error('Task has no PR; pass prNumber');
        if (!bound && !this.adapter.verifyPrIdentity) throw Error('PR identity verification is unavailable');
        observedNumber = number;
        pr = this.adapter.verifyPrIdentity ? await this.adapter.verifyPrIdentity(task, number) : await this.adapter.verifyPr(task, number);
        if (this.adapter.verifyPrIdentity) assertCanonicalPrSource(pr, number);
        if (task.prUrl && task.prUrl !== pr.url) throw Error('The observed PR does not match the task PR');
      }
      catch (error) { throw new DurableFenceRefusal(`Could not read the task PR: ${String(error)}; read next and retry when it is available`); }
      observedHead = pr.head;
      observedUrl = pr.url;
      if (input.to === 'merge') {
        const sourceRefusal = forceMergeSourceRefusal(task, input, pr.head, selfRole);
        if (sourceRefusal) throw new DurableFenceRefusal(sourceRefusal);
        const review = task.resolution.review;
        if (selfRole) {
          if (!this.resolution.adapter.mergeGate) throw new DurableFenceRefusal('Merge checks cannot be observed');
          const gate = await this.resolution.adapter.mergeGate(task, undefined, undefined, this.store.checksPolicyFor(task));
          if (gate.head !== pr.head) throw new DurableFenceRefusal('Merge check head changed; read next');
          if (gate.wait) {
            if (selfRole !== 'reviewer') throw new DurableFenceRefusal('Worker and recovery cannot force merge past a failed check');
            if (this.store.run(review!.runId)?.agentId !== this.store.run(this.engine.selfForceRunId.getStore()!)?.agentId) throw new DurableFenceRefusal('Only the reviewer own applied verdict may force checks');
            const requiredGate = await this.resolution.adapter.mergeGate(task, undefined, undefined, 'required');
            const admission = forceMergeAdmission(pr.head, reason, gate, requiredGate);
            if ('refusal' in admission) throw new DurableFenceRefusal(admission.refusal);
            forcedChecks = admission.forcedChecks;
          }
        }
        const reviewed = review?.head === pr.head && (review.status === 'ready_to_merge' || review.status === 'changes_required');
        if (!reviewed || review?.status === 'changes_required') {
          const selection = forceMergeAcceptance(task, input, pr.head, this.store.runs(task.id));
          if (selection.kind === 'refuse') throw new DurableFenceRefusal(selection.reason);
          if (selection.kind !== 'accept') throw new Error('Expected force merge acceptance');
          const eligible = selection.eligibility;
          const source = eligible.acceptance === 'operator_source';
          const actor = source ? this.engine.assertOwnerAuthority(input.caller, input.relayed, input.note) : null;
          const isBoard = input.caller === OPERATOR_BOARD_CALLER;
          const common = { at: now(), head: pr.head, prNumber: taskPrNumber(task), reason,
            qualification: input.qualification?.trim() || reason,
            actor: source ? { agentId: input.caller!, role: actor!.role } : { agentId: input.caller!, role: isBoard ? 'operator' as const : 'planner' as const },
            authority: source ? { kind: actor!.kind, note: actor!.note } : { kind: isBoard ? 'operator' as const : 'planner' as const, note: null } };
          acceptance = source ? { ...common, kind: 'operator_source', review: null, missingEvidence: eligible.missingEvidence }
            : { ...common, kind: 'reviewed', missingEvidence: null, review: { runId: review!.runId, eventId: review!.eventId,
              head: pr.head, status: review!.status as 'changes_required', reviewId: review!.reviewId ?? null, reviewCommentId: review!.reviewCommentId ?? null } };
        }
      }
    }
    // Attempt to stop possible writers, but an uncertain observation or stop is
    // itself a gate the owner can settle. Keep that uncertainty visible.
    const runsBeforeMove = this.store.runs(task.id);
    const live: Array<Pick<Run, "id" | "taskId" | "agentId" | "workspaceId"> & { role: Run["role"] | "worker" }> = [];
    const uncertainties: string[] = [];
    for (const run of runsBeforeMove.filter(run => !run.released || (run.agentId && ['revision', 'reviewer', 'executor'].includes(run.role)))) {
      const disposition = await this.engine.runDisposition(run);
      if (typeof disposition === 'object') {
        uncertainties.push(`Run ${run.id}: ${disposition.refusal}`);
        if (run.agentId) live.push(run);
      } else if (disposition === 'cancel') live.push(run);
    }
    let participants: Map<string, string>;
    try { participants = executionParticipants(task, runsBeforeMove); }
    catch (error) {
      uncertainties.push(`Participant bindings: ${String(error)}`);
      participants = new Map();
      if (task.agentId && task.workspaceId) participants.set(task.agentId, task.workspaceId);
      for (const run of runsBeforeMove) if (run.agentId && run.workspaceId) participants.set(run.agentId, run.workspaceId);
    }
    for (const [agentId, workspaceId] of participants) {
      if (runsBeforeMove.some(run => run.agentId === agentId && run.workspaceId === workspaceId
        && (!run.released || ['revision', 'reviewer', 'executor'].includes(run.role)))) continue;
      const participant = { id: task.runId ?? `task:${task.id}:${agentId}`, taskId: task.id, role: 'worker' as const, agentId, workspaceId };
      try {
        const observation = await this.engine.host.observe(agentId);
        if (observation.id !== agentId || observation.workspaceId !== workspaceId) {
          uncertainties.push(`Participant ${agentId} did not match workspace ${workspaceId}`);
          live.push(participant);
        } else if (observation.active || observation.activeTurnId || observation.permissions || !['idle', 'error', 'closed'].includes(observation.status)) live.push(participant);
      } catch (error) {
        uncertainties.push(`Participant ${agentId} could not be observed: ${String(error)}`);
        live.push(participant);
      }
    }
    this.engine.assertUnchangedBeforeCancel(task.id, input.version, runsBeforeMove);
    for (const run of live) {
      try { await this.engine.cancelDisplacedTurns(task.id, [run], `force move ${input.to}`); }
      catch (error) { uncertainties.push(`Stopping ${run.role} ${run.id} was not confirmed: ${String(error)}`); }
    }
    const result = this.store.transaction(() => {
      const current = this.store.task(task.id);
      if (!runsUnchangedSince(runsBeforeMove, this.store.runs(task.id))) throw new DurableFenceRefusal('A run changed during the forced move; read next and retry');
      this.engine.requireOwnerControlCurrent(current, input.version, 'Task changed during the move; read next');
      const pending = ownerPendingEffects(collectOwnerVerbFacts(this.store, current, operationId))
        .filter(effect => effect.effect !== `operation.${operationId}` && effect.effect !== `task_control_operation.${operationId}`);
      const records = pending.map(effect => this.engine.forceSettlementRecord(current, effect, input));
      for (const detail of uncertainties) this.store.event(task.id, 'owner_force_uncertain_participant', JSON.stringify({ detail, caller: input.caller, source: this.engine.forceCallerSource(current, input.caller!), reason }));
      for (const record of records) this.store.event(task.id, 'owner_settled', JSON.stringify(record));
      if (current.disposition) {
        const historyKey = `ownerForceDisposition:${task.id}:${randomUUID()}`;
        this.store.setMeta(historyKey, current.disposition);
        this.store.event(task.id, 'owner_settled_disposition', JSON.stringify({ historyKey, caller: input.caller, reason }));
      }
      for (const [kind, hold] of Object.entries(holdsOf(current)))
        this.store.event(task.id, 'owner_settled_hold', JSON.stringify({ kind, hold, caller: input.caller, reason }));
      for (const run of this.store.runs(task.id).filter(run => !run.released)) {
        this.store.deleteCredential(run.id);
        this.store.putRun({ ...run, released: true, active: false, status: run.completion ? 'finished' : 'superseded' });
        this.store.event(task.id, 'owner_run_superseded', `${run.id}: ${reason}`);
      }
      if (current.runId) this.store.deleteCredential(current.runId);
      settleSupersededFencesInTx(this.store, task.id, `forced move ${input.to}: ${reason}`, now());
      const settled = this.store.task(task.id);
      if (acceptance) this.store.event(task.id, 'owner_acceptance', JSON.stringify(acceptance));
      if (settled.resolution.mergeIntent) this.store.event(task.id, 'owner_settled_merge_intent', JSON.stringify({
        head: settled.resolution.mergeHead, requestedAt: settled.resolution.mergeRequestedAt, reason, caller: input.caller }));
      const patch = forceMovePatch({ settled, input, reason, observedHead, observedUrl, observedNumber, mergedCommit,
        acceptance, records, forcedChecks, selfForceRunId: forcedChecks.length ? this.engine.selfForceRunId.getStore() : undefined,
        participants, uncertainties, requestedAt: input.to === 'merge' ? now() : null });
      return this.store.update(task.id, patch,
        'owner_force_move', JSON.stringify({ to: input.to, caller: input.caller, source: this.engine.forceCallerSource(current, input.caller!), reason, settled: records.map(record => record.effect) }));
    });
    if (input.to === 'merge') {
      let permissionWithdrawn = false;
      try {
        await this.resolution.adapter.merge!(result, () => {
          const current = this.store.task(task.id);
          const allowed = this.store.getMeta('paused') !== true && current.phase === 'merging'
            && current.resolution.mergeIntent && current.resolution.mergeHead === observedHead
            && current.coordinatorGeneration === result.coordinatorGeneration && Object.keys(holdsOf(current)).length === 0;
          if (!allowed) permissionWithdrawn = true;
          return allowed;
        });
        const current = this.store.task(task.id);
        this.store.update(task.id, { resolution: { ...current.resolution, mergeResponseOutcome: 'accepted' } },
          'merge_response_accepted', `GitHub accepted the guarded merge for ${observedHead}`);
      } catch (error) {
        const current = this.store.task(task.id);
        if (permissionWithdrawn) {
          this.store.update(task.id, { reason: 'Forced merge was stopped before sending; read next',
            resolution: { ...current.resolution, mergeIntent: false } }, 'merge_request_withdrawn', reason);
        } else this.store.update(task.id, { reason: `Forced merge outcome is uncertain: ${String(error).slice(0, 1000)}`,
          resolution: { ...current.resolution, mergeResponseOutcome: 'uncertain' } }, 'merge_response_uncertain', String(error).slice(0, 2000));
      }
    }
    void this.engine.cleanContext(() => this.engine.wakeTask(task.id));
    void this.engine.cleanContext(() => this.engine.wakeRepository(task.repoPath));
    return this.store.task(task.id);
  }
}
