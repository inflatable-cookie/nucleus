import type { Task, TaskControlInput } from "../../shared/contracts";
import { Decisions } from "../planning/decisions";
import type { Engine } from "../engine";
import { proofOnlyGoQuestionId, recordedProofOnlyGoQuestion } from "../questions/operator-question";
import { proofHeadAdmission, proofSingleFlightRefusal } from "../qa/proof-execution";
import { proofActivationRefusal, proofGoDecision } from "../qa/proof-activation";

/**
 * Activating a task's one named author-side proof execution. The same-name
 * `Engine` method delegates here. `store` and `resolution` read the engine per
 * call.
 */
export class ProofControls {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get resolution() { return this.engine.resolution; }

  /**
   * Task 405: activate the ONE explicit author-side proof execution a task's
   * brief names. This is owner authority over stored facts only; it creates no
   * second task, adopts no worker and releases no hold. The run itself is an
   * ordinary Queue-created executor receiving normal admission, and its evidence
   * is recorded separately from the unchanged source-author declaration.
   */
  async applyTaskControlProof(input: TaskControlInput, operated: <T>(result: T) => T, operationId?: string): Promise<Task> {
    const task = this.store.task(input.taskId);
    const removed = proofActivationRefusal(task, [], 'removed');
    if (removed) throw new Error(removed);
    this.engine.requireOwnerControlCurrent(task, input.version, 'Task changed; refresh before retrying');
    const disposition = proofActivationRefusal(task, [], 'disposition');
    if (disposition) throw new Error(disposition);
    const proofOnly = task.entrypoint === 'proof' && Boolean(task.proofOnly);
    let goEvidence: { questionId: string; decisionId: string | null; question: string; answer: string;
      answeredBy: string; quote: string | null; askedAt: string; answeredAt: string } | undefined;
    const terminal = proofActivationRefusal(task, [], 'terminal');
    if (terminal) throw new Error(terminal);
    if (proofOnly) {
      // Task 574: the release GO gate is the task's own declaration. A
      // proof-only qualification without queue.requiresOperatorGo is a
      // synthetic qualification the planner already authorized, so activation
      // needs no GO evidence — only the one-ever single-flight below.
      if (task.requiresOperatorGo) {
        const events = this.store.eventsAll(task.id);
        const questionId = proofOnlyGoQuestionId(task);
        const questionEvent = events.find(event => event.kind === 'operator_question' && event.detail.startsWith(`${questionId}:`));
        const question = questionEvent ? recordedProofOnlyGoQuestion(task, questionEvent.detail) : null;
        let decision = proofGoDecision(task, input, events, questionId, question);
        if (decision.kind === 'decision') decision = proofGoDecision(task, input, events, questionId, question, new Decisions(this.store).get({ id: decision.id }));
        if (decision.kind === 'refuse') throw new Error(decision.message);
        if (decision.kind !== 'accepted') throw new Error('Proof GO decision did not settle');
        goEvidence = decision.evidence;
      } else {
        const refusal = proofActivationRefusal(task, [], 'proof-only');
        if (refusal) throw new Error(refusal);
      }
      // A qualification is one-ever per proof-only task; ordinary author-side proofs keep
      // their per-head allowance below (Spec 055/#549). A failed receipt never refunds it.
      const refusal = proofSingleFlightRefusal(task, this.store.runs(task.id), task.proofOnly!.commit);
      if (refusal) throw new Error(refusal);
    } else {
      const refusal = proofActivationRefusal(task, [], 'ordinary');
      if (refusal) throw new Error(refusal);
    }
    const selector = proofActivationRefusal(task, [], 'selector');
    if (selector) throw new Error(selector);
    const authority = input.delegated
      ? this.engine.assertDelegatedAuthority(input.caller, input.note, 'Proof execution activation')
      : this.engine.assertOwnerAuthority(input.caller, input.relayed, input.note, 'Proof execution activation');
    // Per-head admission is an ordinary author-side rule (Spec 055/#549). A proof-only task was
    // already admitted one-ever above, and the non-proof branch refuses unless the exact
    // published PR head is recorded, so the admission head is always a string here.
    const proofRefusal = proofOnly ? null : proofHeadAdmission(task, this.store.runs(task.id), task.prHead!);
    if (proofRefusal) throw new Error(proofRefusal);
    const idleRefusal = proofActivationRefusal(task, this.store.runs(task.id), 'idle');
    if (idleRefusal) throw new Error(idleRefusal);
    const pausedRefusal = proofActivationRefusal(task, [], 'paused', this.store.getMeta('paused') === true);
    if (pausedRefusal) throw new Error(pausedRefusal);
    const holdRefusal = proofActivationRefusal(task, [], 'hold');
    if (holdRefusal) throw new Error(holdRefusal);
    const result = await this.resolution.proofExecution(task, {
      authorizedBy: { role: authority.role, caller: input.caller ?? null, note: authority.note }, operationId: operationId ?? null,
      ...(goEvidence ? { goEvidence } : {}),
    });
    void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
    void this.engine.cleanContext(() => this.engine.wakeRepository(result.repoPath));
    return operated(result);
  }
}
