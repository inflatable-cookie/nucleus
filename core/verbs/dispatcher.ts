import { FORCE_CALLER_REFUSAL, FORCE_REASON_REFUSAL, FORCE_ACTION_REFUSAL } from './verb-refusal-text';
import { REMOVED_TASK_REFUSAL } from './control-refusals';
import { taskNeverDispatched } from '../task-decision-rules';
import type { Task, TaskControlInput, TaskControlTask } from "../../shared/contracts";
import { OPERATOR_BOARD_CALLER, REVISION_BUDGET } from "../../shared/contracts";
import { taskBudget } from "../../shared/task-budget";
import { withdrawCancellation } from "./disposition";
import { taskPrNumber } from "../forge/index";
import { noAutomaticRetryRule } from "../recovery/non-delivery";
import { currentReadyPrEvidence, deriveRestartRole, ownerControlEventDetail, reviewerSharesAuthorModel } from "./owner-verbs";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { openProofOnlyGo, PROOF_GO_WAIT_REFUSAL, PROOF_GO_WAIT_VERBS } from "../qa/proof-only-go";
import { ProvenPreSendRefusalError } from "../recovery/task-reasons";
import type { Engine } from "../engine";
import { receiptAcceptanceRefusal } from "../review/proof-receipt-acceptance";
import { now } from "../store/store";
import { taskControlChanges } from "../../shared/task-control-changes";

/**
 * Every task control enters here: the audit lines, the force and cap gates, and
 * the action switch that hands each one to its verb. The authority proofs and the
 * thin wrappers that wake a task after its verb live here too. Same-name `Engine`
 * methods delegate here, and sibling calls go back through them, so an override
 * still fires. `store` and `resolution` read the engine per call.
 */
export class TaskControlDispatcher {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get resolution() { return this.engine.resolution; }
  neverDispatched(task: Task): boolean {
    return taskNeverDispatched(task, this.store.runs(task.id));
  }
  /**
   * Every task control, local or external-effect, in one place. Local actions
   * are one short transaction; external-effect actions perform their remote
   * work here, inside the durable operation lane and after its intent persisted.
   */
  async performTaskControl(input: TaskControlInput, operationId?: string): Promise<TaskControlTask> {
    if (input.action === "accept_receipt" && this.store.task(input.taskId).proofReceiptAcceptance) {
      if (input.delegated) throw Error("Receipt acceptance requires the operator, not a delegated answer");
      this.assertOwnerAuthority(input.caller, input.relayed, input.note, "Receipt acceptance");
      if (!input.reason?.trim()) throw Error("Receipt acceptance requires a reason");
      return this.store.task(input.taskId);
    }
    this.refuseWhileProofGoOpen(input);
    if (input.caller === undefined) {
      const before = this.store.task(input.taskId);
      const result = await this.engine.appliedWithVersionHint(input, operationId);
      this.engine.settleLadderControl(before, result, input.action);
      const after = this.engine.recordNoAutomaticRetryRule(input, result);
      return { ...after, changes: taskControlChanges(before, after) };
    }
    // Spec 050: a control applied with a caller identity — through the owner
    // verb registry — records one owner_control event: verb, caller, whether
    // the caller is the task project's owner thread, reason, phase before and
    // after, and the derived identities. Record only: the audit line never
    // refuses the control, and a lost line never fails an applied control.
    const before = (() => { try { return this.store.task(input.taskId); } catch { return null; } })();
    const routeWaiver = Boolean(before && input.action === "route" && input.role === "reviewer" && input.profileId
      && (() => { const profile = this.engine.profiles.find(candidate => candidate.id === input.profileId);
        return profile ? reviewerSharesAuthorModel(before, profile.model) : false; })());
    const result = await this.engine.appliedWithVersionHint(input, operationId);
    if (before) {
      this.engine.settleLadderControl(before, result, input.action);
      // An applied owner instruction replaces open questions about the prior
      // task state. Their later answers remain auditable but cannot steer it.
      this.resolution.supersedeOpenOwnerQuestions(input.taskId, `${input.action} applied at task version ${result.version}`);
    }
    try {
      this.store.event(input.taskId, "owner_control", ownerControlEventDetail(
        this.store.task(input.taskId), input,
        before?.phase ?? null, result.phase, routeWaiver));
    } catch { /* the applied control stands even if its audit line could not be written */ }
    const after = this.engine.recordNoAutomaticRetryRule(input, result);
    return { ...after, changes: before ? taskControlChanges(before, after) : [] };
  }
  /**
   * effigy#697: the same GO fact that bounds `next` bounds the control itself. While
   * a proof-only release GO is open, a control that would start or re-drive a run
   * is refused whoever sends it, including a stale planner answer.
   */
  refuseWhileProofGoOpen(input: TaskControlInput): void {
    if (!PROOF_GO_WAIT_VERBS.has(input.action)) return;
    let task: Task;
    try { task = this.store.task(input.taskId); } catch { return; }
    if (openProofOnlyGo(task, this.store.runs(task.id), this.store.eventsAll(task.id))) throw new DurableFenceRefusal(PROOF_GO_WAIT_REFUSAL);
  }
  /**
   * Task 645: an owner `move`, `restart`, `route` or `amend_brief` carries the
   * durable no-automatic-retry rule. The structured field wins; otherwise the
   * instruction, reason and brief text are read for the same phrases the
   * automatic gates read. The rule survives the run it launches because the
   * launch clears the pending instruction, never this flag; only a later owner
   * control that permits retry (or structured false) lifts it. The control's
   * own event is the provenance.
   */
  recordNoAutomaticRetryRule(input: TaskControlInput, result: Task): Task {
    if (!["move", "restart", "route", "amend_brief"].includes(input.action)) return result;
    const structured = input.noAutomaticRetry;
    const text = [input.instruction, input.reason, input.brief].filter((value): value is string => Boolean(value)).join('\n');
    const read = structured === true ? 'forbid' : structured === false ? 'lift' : noAutomaticRetryRule(text);
    if (!read) return result;
    const current = this.store.task(result.id);
    const want = read === 'forbid';
    // Skip only a redundant record: a lift on a legacy row whose flag merely
    // defaults to false must still persist the decision, or the old-run
    // fallback keeps forbidding retry after the owner permitted it.
    if (current.resolution.noAutomaticRetry === want && current.resolution.noAutomaticRetryDecided)
      return current.version === result.version ? result : current;
    const control = input.action === 'move' && input.to ? `move to=${input.to}`
      : input.action === 'restart' ? `restart${input.role ? ` role=${input.role}` : ''}${input.fresh ? ' fresh' : ''}`
      : input.action === 'route' ? `route${input.role ? ` role=${input.role}` : ''}` : 'amend_brief';
    const controlEvent = this.store.events(result.id).find(event => event.kind === 'owner_control')?.id ?? null;
    const provenance = `${control} at version ${result.version}${controlEvent ? ` (owner_control event ${controlEvent})` : ' (operator control)'}: ${(input.reason ?? input.instruction ?? '').slice(0, 500)}`;
    // Both directions are explicit owner decisions: the lift marker keeps the
    // old-run fallback from re-forbidding retry after the owner permitted it.
    const updated = this.store.update(current.id, { resolution: { ...current.resolution,
      noAutomaticRetry: want, noAutomaticRetryDecided: true, noAutomaticRetryProvenance: provenance } },
      want ? 'no_automatic_retry_recorded' : 'no_automatic_retry_lifted', provenance.slice(0, 2000));
    return updated;
  }
  /**
   * A stale-version refusal names the version the task is now at and the read
   * to make, so a caller re-reads `next` once instead of resending the stale
   * payload (lean audit 2026-10-15). Nothing is retried.
   */
  async appliedWithVersionHint(input: TaskControlInput, operationId?: string): Promise<Task> {
    // Round 4: every owner control's outcome is recorded, so the applied and
    // refused rate is measurable. A coordinator action records its outcome once
    // when its report settles, and a deferred verb's replay was recorded when the
    // owner sent it. Record only: a lost line never changes the outcome.
    const recordOutcome = (outcome: "applied" | "refused", reason?: string) => {
      if (this.engine.coordinatorActionRunId.getStore() || this.engine.replayingDeferredVerb.getStore()) return;
      try {
        this.store.recordVerbOutcome(input.taskId, input.action, outcome, "owner", {
          ...(input.to ? { to: input.to } : {}), ...(input.role ? { role: input.role } : {}),
          caller: input.caller ?? null, ...(reason ? { reason: reason.slice(0, 600) } : {}),
        }, operationId ? `operation:${operationId}` : null);
      } catch { /* the outcome stands even if its record could not be written */ }
    };
    let applied: Task;
    try { applied = await this.engine.performTaskControlApplied(input, operationId); }
    catch (error) {
      const committed=operationId?this.store.operation(operationId):null;
      if (committed?.result && committed.effect?.status==='reconciled' && !committed.preSendBoundaryStartedAt && !committed.preSendReceipt)
        return this.store.task(input.taskId);
      const message = error instanceof ProvenPreSendRefusalError ? error.reason : error instanceof Error ? error.message : String(error);
      recordOutcome("refused", message);
      // Keep the pre-send type when adding the same actionable version hint.
      if (error instanceof Error && (error.constructor === Error || error instanceof ProvenPreSendRefusalError) && /^Task changed\b/.test(message)) {
        let current: number | undefined;
        try { current = this.store.task(input.taskId).version; } catch { /* a missing task keeps the original refusal */ }
        if (current !== undefined && current !== input.version) {
          const hint = `${message} (the task is now version ${current}; read next again and reassess before retrying)`;
          throw error instanceof ProvenPreSendRefusalError ? new ProvenPreSendRefusalError(hint) : new Error(hint);
        }
      }
      throw error;
    }
    if (input.action === "release") {
      try { await this.engine.applyDeferredOwnerVerbs(); } catch { /* the durable deferred record remains available to the next pass */ }
      applied = this.store.task(input.taskId);
      void this.engine.cleanContext(() => this.engine.wakeTask(applied.id));
      void this.engine.cleanContext(() => this.engine.wakeRepository(applied.repoPath));
    }
    recordOutcome("applied");
    return applied;
  }

  async performTaskControlApplied(input: TaskControlInput, operationId?: string): Promise<Task> {
    const operated = <T>(result: T) => { this.store.event(input.taskId, "operator_control", input.action); return result; };
    const task = this.store.task(input.taskId);
    if (input.force) {
      if (!this.engine.forceCallerAuthorized(task, input.caller))
        throw new DurableFenceRefusal(FORCE_CALLER_REFUSAL);
      if (!input.reason?.trim()) throw new DurableFenceRefusal(FORCE_REASON_REFUSAL);
      if (input.action === 'retry_effect') return operated(this.engine.forceSettleEffect(task, input));
      if (input.action === 'move') return operated(await this.engine.forceMove(task, input, operationId));
      throw new DurableFenceRefusal(FORCE_ACTION_REFUSAL);
    }
    const authorControl = input.action === 'move' && input.to === 'work'
      || input.action === 'restart' && (input.role ?? deriveRestartRole(task, this.store.runs(task.id))) === 'worker'
      || input.action === 'route' && input.role === 'worker';
    // Only a task parked at the cap is the owner's disposition: no author round has
    // started since the cap last stopped it. A worker that stops inside an
    // owner-approved round is ordinary recovery, and the next changes_required
    // parks at the cap again. The cap stop is the latest recorded one: an older
    // park the owner already answered with a round is history.
    const parkedAtCap = authorControl && task.resolution.revisionRuns >= REVISION_BUDGET && (() => {
      const capAt = this.store.events(task.id).find(event => event.kind === 'revision_budget_exhausted')?.at;
      if (!capAt) return false;
      const lastRound = this.store.runs(task.id).filter(run => run.role === 'revision').map(run => run.createdAt).sort().at(-1);
      return !lastRound || lastRound < capAt;
    })();
    if (authorControl && parkedAtCap) {
      if (this.engine.coordinatorActionRunId.getStore())
        throw Error('The author revision allowance is exhausted; the project planner decides the next approach through the blocker ladder (Spec 058), and the owner\'s own verbs still override it');
      // Spec 058 slice 17: the ladder's delegated answer to the cap escalation is
      // the planner's disposition; it applies with the delegated authority its
      // answering agent records, and the owner's own verbs still override it.
      if (input.delegated) this.engine.assertDelegatedAuthority(input.caller, input.note, 'Exhausted author revision disposition');
      else this.engine.assertOwnerAuthority(input.caller, input.relayed, input.note, 'Exhausted author revision disposition');
    }
    if (input.action === "complete") return await this.engine.applyTaskControlComplete(input, operated, operationId);
    if (input.action === "cancel" || input.action === "supersede") return await this.engine.applyTaskControlDispose(input, operated);
    if (input.action === "withdraw_cancel") return await this.engine.applyTaskControlWithdrawCancellation(input, operated);
    if (input.action === "route") return await this.engine.applyTaskControlRoute(input, operated, operationId);
    if (input.action === "restart") {
      const restarted = await this.engine.applyTaskControlRestart(input, operated, operationId);
      // Round 4: the owner's restart supersedes their own stop.
      const role = input.role ?? deriveRestartRole(restarted, this.store.runs(restarted.id));
      const preserveStoppedWorker = role === "worker" && this.engine.ownerStopHold(restarted) && this.engine.ownerStopNamesRun(restarted, restarted.runId);
      if (restarted.resolution.deferredVerb || preserveStoppedWorker) return restarted;
      const deferredYield = Boolean(this.engine.replayingDeferredVerb.getStore() && this.engine.deferredRestartSupersedesOwnerStop(restarted));
      return this.engine.releaseOwnerStopHold(input.taskId, deferredYield) ? this.store.task(input.taskId) : restarted;
    }
    if (input.action === "stop") return operated(await this.engine.stopTask(input));
    if (input.action === "move" && input.to === "review" && input.prNumber) {
      const task = this.store.task(input.taskId);
      // A retained number is already the task's PR identity. An optional
      // number must agree with it, not select replacement adoption. On a task
      // with no bound PR, the number the current authenticated ready result
      // names is the move's own (Project-d #117); any other number still selects
      // replacement adoption.
      const evidenced = !task.prUrl && currentReadyPrEvidence(task, this.store.runs(task.id))?.prNumber === input.prNumber;
      if (!task.resumePrNumber && (!task.prUrl || taskPrNumber(task) !== input.prNumber) && !evidenced)
        return await this.engine.applyTaskControlReplacementPr(input, operated);
    }
    if (input.action === "move") {
      const moved = await this.engine.applyTaskControlMove(input, operated, operationId);
      return this.engine.releaseOwnerStopHold(input.taskId) ? this.store.task(input.taskId) : moved;
    }
    if (input.action === "proof") return await this.engine.applyTaskControlProof(input, operated, operationId);
    if (input.action === "accept_receipt") {
      if (input.delegated) throw Error("Receipt acceptance requires the operator, not a delegated answer");
      const authority = this.engine.assertOwnerAuthority(input.caller, input.relayed, input.note, "Receipt acceptance");
      const reason = input.reason?.trim();
      if (!reason) throw Error("Receipt acceptance requires a reason");
      return this.store.transaction(() => {
        const current = this.store.task(input.taskId);
        if (current.proofReceiptAcceptance) return current;
        this.engine.requireOwnerControlCurrent(current, input.version, 'Task changed; refresh before accepting the receipt');
        const refusal = receiptAcceptanceRefusal(current);
        if (refusal) throw Error(refusal);
        const receipt = current.proofExecutions.at(-1)!;
        const originalResult = current.proofOnlyResult!;
        const acceptance = { acceptedBy: input.caller!, acceptedAt: now(), reason, runId: receipt.runId,
          commit: receipt.head, selector: receipt.selector, inputs: receipt.inputs, originalResult,
          authorization: { role: authority.role, note: authority.note } };
        const detail = `Operator ${acceptance.acceptedBy} accepted passing receipt ${receipt.runId} as release evidence: ${reason}. Original reviewer verdict and failed qualification: ${originalResult.evidence}`;
        for (const notice of this.store.notices(current.id).filter(item => item.kind === 'completion')) {
          const text = `${notice.text}\nOperator accepted receipt ${receipt.runId} as release evidence: ${reason}\nOriginal failed qualification and reviewer verdict: ${originalResult.evidence}`;
          if (notice.status === 'pending') this.store.putNotice({ ...notice, text });
          else if (!notice.id.endsWith(':receipt-acceptance')) {
            const id = `${notice.id}:receipt-acceptance`;
            if (!this.store.notices(current.id).some(item => item.id === id)) this.store.putNotice({ ...notice, id, status: 'pending', error: '', text });
          }
        }
        return this.store.update(current.id, { proofReceiptAcceptance: acceptance,
          proofOnlyResult: { ...originalResult, status: 'passed', evidence: `Operator accepted receipt ${receipt.runId} as release evidence. ${receipt.evidence}`.slice(0, 4000) },
          reason: `Operator accepted receipt ${receipt.runId} as release evidence; original failed qualification remains in history` },
          'proof_receipt_accepted', detail);
      });
    }

    if (input.action === "extend_budget") {
      const current = this.store.task(input.taskId);
      const events = this.store.eventsAll(current.id);
      if (!taskBudget(current, this.store.runs(current.id), Date.now(), events).exhausted)
        throw Error("Budget extension applies only while the task budget is exhausted");
      const authorizedBoard = input.caller === OPERATOR_BOARD_CALLER;
      const authorizedRelay = input.relayed === true && Boolean(input.caller) && Boolean(input.note?.trim());
      // Spec 058, Tom 2026-11-03: delegated answers may extend budgets, including past 2x.
      const authorizedDelegate = input.delegated === true && Boolean(input.caller)
        && input.budgetAuthority === 'approve_by_default';
      if (!authorizedBoard && !authorizedRelay && !authorizedDelegate)
        throw Error("Budget extension needs the operator at the board or a relayed operator authorization note, or structured delegated budget authority");
      const updated = this.resolution.extendTaskBudget(input.taskId,
        `${input.caller}: ${input.delegated ? input.note : input.relayed ? input.note : input.reason}`.slice(0, 4000));
      if (!updated) throw Error("Task budget is no longer exhausted");
      return operated(updated);
    }
    if (input.action === "retry_effect") return await this.engine.applyTaskControlRetryEffect(input, operated, operationId);
    if (input.action === "amend_brief") return input.brief
      ? this.engine.applyTaskControlAmendBrief(input, operated)
      : await this.engine.applyTaskControlRepinInstruction(input, operated);
    if (input.action === "set_lane") return await this.engine.applyTaskControlSetLane(input, operated);
    if(input.action==="set_routing") return this.engine.applyTaskControlSetRouting(input, operated);
    if(input.action==="exclude_worker") return this.engine.applyTaskControlExcludeWorker(input, operated);
    return this.engine.applyTaskControlLocal(input, operated);
  }
  async applyTaskControlComplete(input: TaskControlInput, operated: <T>(result: T) => T, operationId?: string): Promise<Task> {
    const result = await this.engine.completeTask(input, operationId);
    return result.idempotent ? result.task : operated(result.task);
  }
  async applyTaskControlDispose(input: TaskControlInput, operated: <T>(result: T) => T): Promise<Task> {
    return operated(await this.engine.disposeTask({ taskId: input.taskId, version: input.version, action: input.action as "cancel" | "supersede",
      reason: input.reason, replacementTaskId: input.replacementTaskId, workDisposition: input.workDisposition }));
  }
  async applyTaskControlWithdrawCancellation(input: TaskControlInput, operated: <T>(result: T) => T): Promise<Task> {
    const withdrawn = await this.engine.control(() => withdrawCancellation(this.store, input.taskId, input.version, input.reason!, "operator control"), `task:${input.taskId}`);
    await this.engine.continueWithdrawnWorker(withdrawn);
    void this.engine.cleanContext(() => this.engine.wakeTask(withdrawn.id));
    void this.engine.cleanContext(() => this.engine.wakeRepository(withdrawn.repoPath));
    return operated(withdrawn);
  }
  async applyTaskControlRoute(input: TaskControlInput, operated: <T>(result: T) => T, operationId?: string): Promise<Task> {
    const result = await this.engine.routeTask(input, operationId);
    void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
    void this.engine.cleanContext(() => this.engine.wakeRepository(result.repoPath));
    return operated(result);
  }
  async applyTaskControlRestart(input: TaskControlInput, operated: <T>(result: T) => T, operationId?: string): Promise<Task> {
    const result = await this.engine.restartTask(input, operationId);
    const role = input.role ?? deriveRestartRole(result, this.store.runs(result.id));
    if (!result.resolution.deferredVerb && !(role === "worker" && this.engine.ownerStopHold(result) && this.engine.ownerStopNamesRun(result, result.runId))) {
      void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
      void this.engine.cleanContext(() => this.engine.wakeRepository(result.repoPath));
    }
    return operated(result);
  }
  async applyTaskControlReplacementPr(input: TaskControlInput, operated: <T>(result: T) => T): Promise<Task> {
    // The replacement-PR binding: strict canonical branch, base and head
    // reconciliation in resolution.adoptReplacementPr, then ordinary review.
    const task = this.store.task(input.taskId);
    if (task.removedAt) throw new Error(REMOVED_TASK_REFUSAL);
    this.engine.requireOwnerControlCurrent(task, input.version, "Task changed; refresh before retrying");
    const result = await this.resolution.adoptReplacementPr(task, input.prNumber!);
    void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
    void this.engine.cleanContext(() => this.engine.wakeRepository(result.repoPath));
    return operated(result);
  }
  async applyTaskControlRetryEffect(input: TaskControlInput, operated: <T>(result: T) => T, operationId?: string): Promise<Task> {
    const result = await this.engine.retryEffect(input, operationId);
    void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
    void this.engine.cleanContext(() => this.engine.wakeRepository(result.repoPath));
    return operated(result);
  }
  async applyTaskControlRepinInstruction(input: TaskControlInput, operated: <T>(result: T) => T): Promise<Task> {
    const result = await this.engine.repinInstruction({ taskId: input.taskId, version: input.version });
    void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
    void this.engine.cleanContext(() => this.engine.wakeRepository(result.repoPath));
    return operated(result);
  }
  applyTaskControlAmendBrief(input: TaskControlInput, operated: <T>(result: T) => T): Task {
    const result = this.engine.amendBrief({ taskId: input.taskId, version: input.version, brief: input.brief ?? "", reason: input.reason ?? "", overtakes: input.overtakes });
    return operated(result);
  }
  /**
   * Spec 058 (task 540): a delegated answer carries the answering agent as its caller and
   * the recorded delegation note. It is never the board and never relayed; only the verbs
   * that name it (merge acceptance, proof activation, budget extension) accept it.
   */
  assertDelegatedAuthority(caller:string|undefined,relayNote:string|undefined,purpose:string):
    {role:'delegated';kind:'delegated';note:string}{
    const note=relayNote?.trim();
    if(!note)throw Error(`A delegated ${purpose.toLowerCase()} requires the recorded delegation note`);
    if(!caller||caller===OPERATOR_BOARD_CALLER)throw Error(`A delegated ${purpose.toLowerCase()} needs the answering agent as its caller`);
    return {role:'delegated',kind:'delegated',note:note.slice(0,4000)};
  }
  /**
   * The authority a qualified owner acceptance needs, proved before anything is
   * written: the operator at the board, or an operator ruling relayed by an
   * authenticated caller with its recorded authorization note. (Spec 058 cutover
   * 5: the task project's owner thread is no longer an authority; project
   * ownership is retired, and a caller claiming it is refused like any other
   * non-authority.) A caller that only writes a reason, declares itself owner or
   * repeats a coordinatorAction has none, and an unattributed caller is refused
   * outright.
   */
  assertOwnerAuthority(caller:string|undefined,relayed:boolean|undefined,relayNote:string|undefined,purpose='Qualified owner acceptance'):
    {role:'operator'|'authorized_relay';kind:'operator'|'relayed_note';note:string|null}{
    if(relayed){
      const note=relayNote?.trim();
      if(!note)throw Error(`A relayed ${purpose.toLowerCase()} requires the recorded operator authorization note`);
      if(!caller)throw Error(`A relayed ${purpose.toLowerCase()} needs the relaying caller identity`);
      return {role:'authorized_relay',kind:'relayed_note',note:note.slice(0,4000)};
    }
    if(!caller)throw Error(`${purpose} refuses an unattributed caller; the board or a relayed authorization note records it`);
    if(caller===OPERATOR_BOARD_CALLER)return {role:'operator',kind:'operator',note:null};
    throw Error(`${purpose} needs the operator at the board or a relayed operator authorization note; ${caller} has none`);
  }
}
