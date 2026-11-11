import { delegateQuestion } from './planner-delegation';
import { taskControlInputSchema } from '../../shared/contracts';
import { Decisions } from '../planning/decisions';
import { applyBinaryApproval,parseNativeDelegatedReply } from './question-delegation';
import type { Resolution } from '../resolution';
import { DelegatedHostUnavailable } from './delegation';
import { retainedProgressRun } from '../dispatch/retained-work';
import { digest } from '../store/store';
import { qualifyLegacyAgentId } from '../../shared/agent-identity';

/** What an answered native question on a blocked worker or reviewer thread does. */
export type AnsweredQuestionOutcome =
  | { kind: 'skip' }
  | { kind: 'unknown_agent_changed'; from: string; to: string }
  | { kind: 'refuse_no_applier' }
  | { kind: 'resume_worker' }
  | { kind: 'resume_reviewer' };

/**
 * Worker checks agent identity before blocked evidence; reviewer checks blocked
 * evidence first. A skip writes nothing; the other arms record a durable outcome.
 */
export function answeredQuestionOutcome(facts: {
  seen: boolean;
  phaseOk: boolean;
  unreleasedRun: boolean;
  watchKind: 'worker' | 'reviewer';
  stillBlocked: boolean;
  watchAgentId: string;
  currentAgentId: string | null;
  hasApplier: boolean;
}): AnsweredQuestionOutcome {
  if (facts.seen || !facts.phaseOk || facts.unreleasedRun) return { kind: 'skip' };
  if (facts.watchKind === 'worker') {
    if (facts.currentAgentId !== facts.watchAgentId)
      return { kind: 'unknown_agent_changed', from: facts.watchAgentId, to: facts.currentAgentId ?? 'none' };
    if (!facts.stillBlocked) return { kind: 'skip' };
  } else {
    if (!facts.stillBlocked) return { kind: 'skip' };
    if (facts.currentAgentId !== facts.watchAgentId)
      return { kind: 'unknown_agent_changed', from: facts.watchAgentId, to: facts.currentAgentId ?? 'none' };
  }
  if (!facts.hasApplier) return { kind: 'refuse_no_applier' };
  return { kind: facts.watchKind === 'worker' ? 'resume_worker' : 'resume_reviewer' };
}

export class NativeQuestions {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  async delegateNativeQuestions(scopedHost?: string): Promise<void> {
    if (!scopedHost) {
      const hosts = new Set(this.store.maintenanceTasks(true).flatMap(task => task.hostId ? [task.hostId] : []));
      for (const host of hosts) await this.resolution.withHost(host, () => this.delegateNativeQuestions(host));
      return;
    }
    if (!this.resolution.originHostAvailable(scopedHost)) return;
    if (this.resolution.paused() || !this.adapter.pendingQuestions || !this.adapter.answerNativeQuestion) return;
    for (const candidate of this.store.maintenanceTasks(true)) {
      const task = this.store.task(candidate.id);
      if (task.hostId !== scopedHost) continue;
      if (task.removedAt || ['done', 'cancelled'].includes(task.phase)) continue;
      const reviewer = task.resolution.reviewerAgentId;
      const reviewerRun = reviewer ? this.store.runs(task.id).filter(run => run.role === 'reviewer' && run.agentId === reviewer && run.hostId === scopedHost).at(-1) : null;
      const watches = [{ agentId: task.agentId, workspaceId: task.workspaceId }, { agentId: reviewer, workspaceId: reviewerRun?.workspaceId }];
      for (const watch of watches) {
        if (!watch.agentId || !watch.workspaceId) continue;
        let pending: Awaited<ReturnType<NonNullable<typeof this.adapter.pendingQuestions>>>;
        try { pending = await this.adapter.pendingQuestions(watch.agentId); } catch { continue; }
        for (const request of pending) {
          // Queue's own marked questions already have their own delegation and durable intent.
          if (request.questions.some(q => q.question.startsWith('[Queue decision '))) continue;
          const events = this.store.eventsAll(task.id);
          const legacyId = digest(`native-question:${watch.agentId}:${request.requestId}`);
          // Old event and delivery IDs are durable fences; continue the same
          // occurrence if this task already recorded it, never mint a new send.
          const hasLegacy = events.some(event => event.kind.startsWith('native_question_') && event.detail.startsWith(`${legacyId}:`));
          const id = hasLegacy ? legacyId : digest(JSON.stringify(['native-question-v2', qualifyLegacyAgentId(watch.agentId, scopedHost), request.requestId]));
          if (this.resolution.responsibleQuestions.has(id) || events.some(event => ['native_question_answered', 'native_question_operator', 'native_question_unknown', 'native_question_unanswered', 'native_question_response_intent'].includes(event.kind) && event.detail.startsWith(`${id}:`))) continue;
          if (events.some(event => event.kind === 'native_question_delegated' && event.detail.startsWith(`${id}:`))
              && this.resolution.delegatedDelivery(`queue-native-${id}-0`)
              && !this.resolution.recoverableDelegation([`queue-native-${id}-0`, `queue-native-${id}-0-project`, `ns-decider-${id}-0`])) continue;
          if (!events.some(event => event.kind === 'native_question_delegated' && event.detail.startsWith(`${id}:`))) this.store.event(task.id, 'native_question_delegated', `${id}: ${watch.agentId}; permission ${request.requestId}`);
          const controller = new AbortController();
          this.resolution.responsibleQuestions.set(id, controller);
          void this.resolution.answerNativeQuestions(task.id, watch.agentId, watch.workspaceId, id, request, controller.signal)
            .catch(error => { if (!(error instanceof DelegatedHostUnavailable) && !this.resolution.stopped()) this.store.event(task.id, 'native_question_unknown', `${id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000)); })
            .finally(() => this.resolution.responsibleQuestions.delete(id));
        }
      }
    }
  }
  async answerNativeQuestions(taskId: string, agentId: string, workspaceId: string, id: string,
    request: { requestId: string; questions: Array<{ header: string; question: string; options: string[] }> }, signal: AbortSignal): Promise<void> {
    const task = this.store.task(taskId);
    if (!task.hostId || !this.resolution.withHost(task.hostId, () => this.resolution.originHostAvailable(task.hostId)))
      throw new DelegatedHostUnavailable('Native question host is unavailable or unknown');
    return this.resolution.withHost(task.hostId, () => this.answerNativeQuestionsOnHost(taskId, agentId, workspaceId, id, request, signal));
  }
  private async answerNativeQuestionsOnHost(taskId: string, agentId: string, workspaceId: string, id: string,
    request: { requestId: string; questions: Array<{ header: string; question: string; options: string[] }> }, signal: AbortSignal): Promise<void> {
    const task = this.store.task(taskId);
    // Task 1109: the task's own planner is asked first; the project planner is the fallback rung.
    const { rungs } = await this.resolution.plannerRungsFor(task);
    const answers: Record<string, string> = {};
    const records: string[] = [];
    const plannerOvertakes: Array<{ ids: string[]; label: string }> = [];
    for (const [index, question] of request.questions.entries()) {
      const input = { question: question.question, choices: question.options, context: this.resolution.decisionContext(task) };
      let unknown = false;
      const result = await delegateQuestion(this.resolution, task, {
        planners: rungs.map(item => ({ ...item, messageId: `queue-native-${id}-${index}${item.rung === 'project' ? '-project' : ''}` })),
        decisionId: `${id}-${index}`,
        context: input, signal, parse: parseNativeDelegatedReply,
        onIntent: (role, recipient, rung) => this.store.event(taskId, 'native_question_delegate_intent', `${id}: ${role}${role === 'planner' ? ` (${rung ?? 'project'} rung)` : ''} ${recipient ?? 'requested'}; question ${index}`),
        onSkip: (rung, recipient, detail) => this.store.event(taskId, 'native_question_delegate_skipped', `${id}: ${rung} planner ${recipient} skipped: ${detail}`.slice(0, 4000)),
        onMiss: () => {},
        onUnknown: (role, recipient, error) => {
          unknown = true;
          this.store.event(taskId, 'native_question_unknown', `${id}: ${role} ${recipient ?? ''}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
        },
      });
      if (unknown) return;
      const reply = result?.reply;
      const role = result?.role;
      if (signal.aborted) return;
      if (!reply) { this.store.event(taskId, 'native_question_unanswered', `${id}: no usable delegate answer`); return; }
      if (reply.kind === 'operator') { this.store.event(taskId, 'native_question_operator', `${id}: Operator decision needed — ${reply.reason}`.slice(0, 4000)); return; }
      const approved = applyBinaryApproval(question.question, question.options, reply.answer, reply.reason);
      Object.defineProperty(answers, question.header, { value: approved?.choice ?? reply.answer, enumerable: true, configurable: true });
      records.push(`Answered by ${role}: ${approved?.choice ?? reply.answer} — ${approved ? approved.reason : reply.reason}`);
      if (role === 'planner' && reply.overtakes?.length) plannerOvertakes.push({ ids: reply.overtakes, label: `Planner answer to ${question.header}: ${reply.answer}`.slice(0, 240) });
    }
    const current = this.store.task(taskId);
    if (current.removedAt || ['done', 'cancelled'].includes(current.phase)
      || current.hostId !== task.hostId || !current.hostId
      || (current.agentId !== agentId && current.resolution.reviewerAgentId !== agentId)) return;
    if (!this.resolution.withHost(current.hostId, () => this.resolution.originHostAvailable(current.hostId))) throw new DelegatedHostUnavailable('Native question host is offline');
    // The command receipt authorizes an answer, not replay of an uncertain host response.
    if (this.store.eventsAll(taskId).some(event => event.kind === 'native_question_response_intent' && event.detail.startsWith(`${id}:`))) return;
    // A permission that has left the thread was answered there: that answer wins. A failed read proves nothing.
    const stillPending = await this.adapter.pendingQuestions?.(agentId).then(pending => pending.some(item => item.requestId === request.requestId), () => true) ?? true;
    if (!stillPending) {
      this.store.event(taskId, 'native_question_stale_answered', `${id}: ${records.join('; ')}; no effect because the permission was already answered on the thread`.slice(0, 4000));
      return;
    }
    if (!this.resolution.withHost(current.hostId, () => this.resolution.originHostAvailable(current.hostId))) throw new DelegatedHostUnavailable('Native question host is offline');
    this.store.event(taskId, 'native_question_response_intent', `${id}: agent ${agentId}; permission ${request.requestId}; answers ${JSON.stringify(answers)}`);
    await this.adapter.answerNativeQuestion!(agentId, workspaceId, request.requestId, answers);
    if (plannerOvertakes.length) this.store.transaction(() => {
      const decisions = new Decisions(this.store);
      const reference = { kind: 'planner_answer' as const, id: taskId, sourceId: id,
        label: plannerOvertakes.map(item => item.label).join('; ').slice(0, 240), at: new Date().toISOString() };
      for (const decisionId of [...new Set(plannerOvertakes.flatMap(item => item.ids))].slice(0, 100)) {
        try {
          decisions.markOvertaken(decisionId, reference);
          this.store.event(taskId, 'native_question_overtakes', `${id}: ${decisionId}`);
        } catch (error) {
          this.store.event(taskId, 'native_question_overtakes_refused', `${id}: ${decisionId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000));
        }
      }
    });
    for (const record of records) this.store.event(taskId, 'native_question_answered', `${id}: ${record}`.slice(0, 4000));
  }
  async resumeResponsibleAnsweredQuestions(scopedHost?: string): Promise<void> {
    if (this.resolution.paused()) return;
    if (!scopedHost) {
      await this.resolution.resumeBusyProofGoAnswers();
      const hosts = new Set(this.store.maintenanceTasks(true).flatMap(task => task.hostId ? [task.hostId] : []));
      for (const host of hosts) await this.resolution.withHost(host, () => this.resumeResponsibleAnsweredQuestions(host));
      return;
    }
    if (!this.resolution.originHostAvailable(scopedHost)) return;
    if (!this.adapter.answeredQuestions) return;
    for (const candidate of this.store.maintenanceTasks(true)) {
      if (this.resolution.paused()) return;
      const task = this.store.task(candidate.id);
      if (task.hostId !== scopedHost) continue;
      if (!task.agentId || task.removedAt) continue;
      if (!['blocked', 'error', 'needs_attention'].includes(task.phase)) continue;
      const runs = this.store.runs(task.id);
      if (runs.some(run => !run.released)) continue;
      const workerBlocked = retainedProgressRun(this.store, task)
        ?? (task.completion && ['blocked', 'error'].includes(task.completion.status) && task.completion.runId === task.runId ? task.completion : null);
      const reviewerBlockedRun = runs
        .filter(run => run.role === 'reviewer' && run.completion && ['blocked', 'error'].includes(run.completion.status))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1) ?? null;
      if (!workerBlocked && !reviewerBlockedRun) continue;
      const watches: Array<{ kind: 'worker' | 'reviewer'; agentId: string }> = [];
      if (workerBlocked && task.agentId) watches.push({ kind: 'worker', agentId: task.agentId });
      if (reviewerBlockedRun) {
        const reviewerAgent = reviewerBlockedRun.agentId ?? task.resolution.reviewerAgentId ?? null;
        if (reviewerAgent) watches.push({ kind: 'reviewer', agentId: reviewerAgent });
      }
      for (const watch of watches) {
        let answered: Array<{ requestId: string; question: string; answers: Record<string, string> }>;
        try {
          answered = await this.adapter.answeredQuestions!(watch.agentId);
        } catch {
          continue;
        }
        for (const item of answered) {
          if (!item.requestId.trim() || !Object.keys(item.answers).length) continue;
          const answeredKind = `${watch.kind}_question_answered`;
          const resumedKind = `${watch.kind}_question_resumed`;
          const unknownKind = `${watch.kind}_question_unknown`;
          const refusedKind = `${watch.kind}_question_refused`;
          const events = this.store.eventsAll(task.id);
          const seen = (kind: string) => events.some(event => event.kind === kind && event.detail.startsWith(`${item.requestId}:`));
          if (seen(answeredKind) || seen(resumedKind) || seen(unknownKind) || seen(refusedKind)) continue;
          // Re-read fresh state before consuming the question. A version change
          // between enumeration and now is not a refusal: the control below is
          // built from the fresh version, so the still-blocked task continues.
          // Transient conditions (phase moved on, an unreleased run appeared,
          // the blocked evidence cleared) skip without recording, so a later
          // sweep retries; once the answered event is written every exit path
          // records a durable outcome (resumed, refused or unknown).
          const current = this.store.task(task.id);
          const freshRuns = this.store.runs(current.id);
          const freshWorkerBlocked = retainedProgressRun(this.store, current)
            ?? (current.completion && ['blocked', 'error'].includes(current.completion.status) && current.completion.runId === current.runId ? current.completion : null);
          const freshReviewerBlocked = freshRuns
            .filter(run => run.role === 'reviewer' && run.completion && ['blocked', 'error'].includes(run.completion.status))
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1) ?? null;
          const answerText = Object.entries(item.answers).map(([key, value]) => `${key}: ${value}`).join('; ');
          const apply = this.resolution.applyOperatorControl;
          const outcome = answeredQuestionOutcome({
            seen: false,
            phaseOk: ['blocked', 'error', 'needs_attention'].includes(current.phase),
            unreleasedRun: freshRuns.some(run => !run.released),
            watchKind: watch.kind,
            stillBlocked: watch.kind === 'worker' ? Boolean(freshWorkerBlocked) : Boolean(freshReviewerBlocked),
            watchAgentId: watch.agentId,
            currentAgentId: watch.kind === 'worker'
              ? current.agentId ?? null
              : freshReviewerBlocked?.agentId ?? current.resolution.reviewerAgentId ?? null,
            hasApplier: Boolean(apply),
          });
          if (outcome.kind === 'skip') continue;
          this.store.event(task.id, answeredKind, `${item.requestId}: ${item.question} :: ${answerText}`.slice(0, 4000));
          if (outcome.kind === 'unknown_agent_changed') {
            this.store.event(task.id, unknownKind, `${item.requestId}: ${watch.kind} agent changed from ${outcome.from} to ${outcome.to}; the answer was not applied to the new ${watch.kind}`.slice(0, 4000));
            continue;
          }
          if (outcome.kind === 'refuse_no_applier' || !apply) {
            this.store.event(task.id, refusedKind, `${item.requestId}: no control applier is bound`);
            continue;
          }
          try {
            if (outcome.kind === 'resume_worker') {
              const instruction = `The operator answered your native question "${item.question}" on this thread: ${answerText}. Continue the work in the same run with these answers.`.slice(0, 12000);
              await apply(taskControlInputSchema.parse({
                taskId: current.id, version: current.version, action: 'move', to: 'work', instruction,
                reason: `The operator answered the worker's native question ${item.requestId}; the task resumes with those answers`.slice(0, 4000),
                caller: current.agentId ?? undefined, relayed: true,
                note: `The operator answered the worker's native question ${item.requestId} on this task's thread: ${answerText}`.slice(0, 4000),
              }));
            } else {
              const instruction = `The operator answered your native question "${item.question}" on this thread: ${answerText}. Continue the retained review with these answers.`.slice(0, 12000);
              await apply(taskControlInputSchema.parse({
                taskId: current.id, version: current.version, action: 'restart', role: 'reviewer', instruction,
                reason: `The operator answered the reviewer's native question ${item.requestId}; the retained review continues with those answers`.slice(0, 4000),
                caller: current.agentId ?? undefined, relayed: true,
                note: `The operator answered the reviewer's native question ${item.requestId} on this task's thread: ${answerText}`.slice(0, 4000),
              }));
            }
            this.store.event(task.id, resumedKind, `${item.requestId}: resumed ${watch.kind} with answers`.slice(0, 4000));
          } catch (error) {
            this.store.event(task.id, unknownKind, `${item.requestId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
          }
        }
      }
    }
  }
}
