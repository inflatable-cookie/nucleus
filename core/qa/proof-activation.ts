import { DISPOSITION_CONTROL_REFUSAL, REMOVED_TASK_REFUSAL } from '../verbs/control-refusals';
import { holdOwnerOf, holdsOf, isDispositionActive, type Run, type Task, type TaskControlInput, type DecisionView } from '../../shared/contracts';
import { proofHeadAdmission, proofSingleFlightRefusal } from './proof-execution';
import { digest } from '../store/store';

/** Stored proof admission facts shared by previews and activation. */
function proofActivationFacts(task: Task, runs: Run[]) {
  return {
    merging: Boolean(task.resolution.mergeIntent || task.resolution.mergedCommit || task.resolution.syncedCommit),
    beforeReview: ['queued', 'awaiting_review', 'reviewing', 'changes_requested'].includes(task.phase) || task.resolution.stop?.reason === 'awaiting_proof',
    publishedHead: Boolean(task.prHead && task.prUrl),
    live: runs.find(run => !run.released),
  };
}

/** Refusals derived from task facts at each existing activation boundary. */
export function proofActivationRefusal(task: Task, runs: Run[], stage: 'removed' | 'disposition' | 'terminal' | 'proof-only' | 'selector' | 'ordinary' | 'merging' | 'before-review' | 'published-head' | 'idle' | 'paused' | 'hold', paused = false): string | null {
  const facts = proofActivationFacts(task, runs);
  if (stage === 'removed') return task.removedAt ? REMOVED_TASK_REFUSAL : null;
  if (stage === 'disposition') return isDispositionActive(task) ? DISPOSITION_CONTROL_REFUSAL : null;
  if (stage === 'terminal') return ['done', 'cancelled'].includes(task.phase) ? `The task is ${task.phase}; proof execution is closed` : null;
  if (stage === 'proof-only') return !['queued', 'blocked'].includes(task.phase) ? `A proof-only qualification without release GO activates only from queued or after a pre-selector refusal; the task is ${task.phase}` : null;
  if (stage === 'selector') return !task.proofExecution ? 'This task names no author-side proof selector; the brief or handoff must set queue.proofExecution with the selector and input hashes' : null;
  if (stage === 'ordinary') {
    return proofActivationRefusal(task, runs, 'merging')
      ?? proofActivationRefusal(task, runs, 'before-review')
      ?? proofActivationRefusal(task, runs, 'published-head');
  }
  if (stage === 'merging') return facts.merging || task.resolution.externalMerge
    ? 'The task is merging or merged; author-side proof execution applies before merge only' : null;
  if (stage === 'before-review') return !facts.beforeReview
    ? `Author-side proof execution applies before independent review; the task is ${task.phase}` : null;
  if (stage === 'published-head') return !facts.publishedHead
    ? 'Proof execution needs the exact published PR head this task records' : null;
  if (stage === 'idle') {
    const live = facts.live;
    if (live) return `A ${live.role} run is live; the proof executor starts only on an idle task, and nothing was dispatched`;
  } else if (stage === 'paused') {
    if (paused) return 'Nucleus is paused; the proof executor waits for unpause and no execution was activated';
  } else {
    const fence = holdsOf(task).dispatch;
    if (fence) return `The dispatch hold owned by ${holdOwnerOf(task, fence.owner)} blocks the proof executor (${fence.reason}); release kind=dispatch is the ordinary exit, and a merge hold stays untouched`;
  }
  return null;
}

/** Preview preserves its automatic-qualification and recorded-GO admission order. */
export function proofActivationPreview(task: Task, runs: Run[], events: Array<{ kind: string; detail: string }>):
  { available: true; fill: string[]; args: Record<string, unknown> } | { available: false; refusal: string } {
    const goQuestionId = task.entrypoint === 'proof' && task.proofOnly && task.requiresOperatorGo
      ? digest(['operator-question', task.id, 'proof_only_release_go', task.proofOnly.commit].join(':')) : null;
    const answeredGo = goQuestionId && events.find(event => event.kind === 'operator_question_answered'
      && event.detail.startsWith(`${goQuestionId}: GO — run the qualification`));
    const proofOnlyGo = Boolean(answeredGo && task.phase === 'blocked' && !task.proofOnlyResult
      && !task.proofExecutions.length && !runs.some(run => run.role === 'executor'));
    // Task 574: a qualification without a declared release GO carries no GO
    // evidence. It activates from queued or after a pre-selector refusal, with
    // no PR head to name and no review phase to precede.
    const proofOnlyWithoutGo = task.entrypoint === 'proof' && Boolean(task.proofOnly) && !task.requiresOperatorGo;
    if (proofOnlyWithoutGo && task.phase === 'queued')
      return { available: false, refusal: 'This queued proof-only task runs its qualification by itself when a task slot is available; no proof action is needed' };
    for (const stage of ['removed', 'disposition'] as const) {
      const refusal = proofActivationRefusal(task, runs, stage);
      if (refusal) return { available: false, refusal };
    }
    if (task.proofExecutionRetired) return { available: false, refusal: "The author-side proof declaration was retired by amendment" };
    const selector = proofActivationRefusal(task, runs, 'selector');
    if (selector) return { available: false, refusal: selector };
    if (task.entrypoint === 'proof' && task.proofOnly) {
      const spent = proofSingleFlightRefusal(task, runs, task.proofOnly.commit);
      if (spent) return { available: false, refusal: spent };
    }
    if (!proofOnlyGo && task.prHead) {
      const proofRefusal = proofHeadAdmission(task, runs, task.prHead);
      if (proofRefusal) return { available: false, refusal: proofRefusal };
    }
    for (const stage of ['terminal', 'merging'] as const) {
      const refusal = proofActivationRefusal(task, runs, stage);
      if (refusal) return { available: false, refusal };
    }
    if (proofOnlyWithoutGo) {
      const refusal = proofActivationRefusal(task, runs, 'proof-only');
      if (refusal) return { available: false, refusal };
    }
    if (!proofOnlyGo && !proofOnlyWithoutGo) {
      for (const stage of ['before-review', 'published-head'] as const) {
        const refusal = proofActivationRefusal(task, runs, stage);
        if (refusal) return { available: false, refusal };
      }
    }
    for (const stage of ['idle', 'hold'] as const) {
      const refusal = proofActivationRefusal(task, runs, stage);
      if (refusal) return { available: false, refusal };
    }
    return { available: true, fill: ["reason"], args: { taskId: task.id, version: task.version,
      ...(proofOnlyGo && answeredGo ? { relayed: true, note: `Recorded board GO: ${answeredGo.detail}`.slice(0, 4000) } : {}) } };
}

/** Validate recorded release-GO evidence without reading or writing the store. */
export function proofGoDecision(task: Task, input: TaskControlInput,
  events: Array<{kind: string; detail: string; at: string}>, questionId: string, question: string | null, decision?: DecisionView):
  { kind: 'refuse'; message: string } | { kind: 'decision'; id: string } |
  { kind: 'accepted'; evidence: { questionId: string; decisionId: string | null; question: string; answer: string; answeredBy: string; quote: string | null; askedAt: string; answeredAt: string } } {
  const answerEvent = events.find(event => event.kind === 'operator_question_answered' && event.detail.startsWith(`${questionId}: GO — run the qualification`));
  if (!answerEvent || !input.relayed || !input.note?.includes(questionId))
    return { kind: 'refuse', message: 'A proof-only qualification requires the operator GO from its release-kind question before execution' };
  const questionEvent = events.find(event => event.kind === 'operator_question' && event.detail.startsWith(`${questionId}:`));
  if (!questionEvent || !question) return { kind: 'refuse', message: 'The proof-only release question evidence is incomplete; no execution was activated' };
  const link = events.find(event => event.kind === 'operator_question_decision' && event.detail.startsWith(`${questionId}: decision `));
  let evidence: { questionId: string; decisionId: string | null; question: string; answer: string; answeredBy: string; quote: string | null; askedAt: string; answeredAt: string };
  if (link) {
    const decisionId = link.detail.slice(`${questionId}: decision `.length).split(/[; ]/)[0]!;
    if (!decision) return { kind: 'decision', id: decisionId };
    const answer = decision.answer;
    if (decision.question !== question || !decision.links.tasks.includes(task.id) || !answer || !answerEvent.detail.startsWith(`${questionId}: ${answer.text} — answered by `))
      return { kind: 'refuse', message: 'The linked board decision does not match the recorded release answer; no execution was activated' };
    if (answer.relayed ? (!/planner/i.test(answer.answeredBy) || !answer.note.trim()) : !['operator', 'operator (board)'].includes(answer.answeredBy))
      return { kind: 'refuse', message: 'The release answer is not recorded as operator GO or a planner relay with the operator quote' };
    evidence = { questionId, decisionId, question, answer: answer.text,
      answeredBy: answer.relayed ? `${answer.answeredBy} (relaying the operator)` : answer.answeredBy,
      quote: answer.relayed ? answer.note : JSON.stringify({ answer: answer.text, answeredBy: answer.answeredBy, answeredAt: answer.answeredAt }),
      askedAt: questionEvent.at, answeredAt: answer.answeredAt };
  } else {
    const body = answerEvent.detail.slice(questionId.length + 2);
    const marker = body.lastIndexOf(' — answered by ');
    const answer = marker < 0 ? '' : body.slice(0, marker);
    const answeredBy = marker < 0 ? '' : body.slice(marker + ' — answered by '.length);
    if (!answer.startsWith('GO — run the qualification') || !['operator', 'operator (board)'].includes(answeredBy))
      return { kind: 'refuse', message: 'The native release answer is missing operator identity or the verbatim GO' };
    evidence = { questionId, decisionId: null, question, answer, answeredBy,
      quote: JSON.stringify({ answer, answeredBy, answeredAt: answerEvent.at }), askedAt: questionEvent.at, answeredAt: answerEvent.at };
  }
  if (task.phase !== 'blocked') return { kind: 'refuse', message: `The proof-only qualification is not waiting for operator GO; the task is ${task.phase}` };
  return { kind: 'accepted', evidence };
}
