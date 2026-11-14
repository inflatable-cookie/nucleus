import { digest, type Store } from '../store/store';
import { awaitingProofRoute, awaitingProofTexts, clipDecisionQuestion, currentTaskStop, holdsOf, isDispositionActive, type Task, type TaskNextVerb } from '../../shared/contracts';
import { isWaitingTaskStop, type TaskStopRecord } from '../../shared/task-stop';
import { taskBudget } from '../../shared/task-budget';
import { collectOwnerVerbFacts, ownerVerbViews, qualifiedAcceptanceEligibility, type OwnerVerbFacts } from '../verbs/owner-verbs';
import { proofWaitApplies, proofWorkerRequests } from '../qa/proof-execution';
import { isForgeCheckProofText } from '../forge/checks';
import { openProofOnlyGo, proofOnlyGoQuestionId } from '../qa/proof-only-go';

/**
 * Spec 058 (task 523): which stops a responsible task cannot clear without a
 * person, and the concrete choices that person has.
 *
 * Queue raises the question by prompting the task's own thread to ask one
 * native Paseo question, exactly as the joint review question does. This module
 * only decides — from store facts, never a remote call — whether a stop is
 * operator-only and what the answer could apply. The caller records the durable
 * send intent before raising, so a lost observation stays unknown.
 */
export type OperatorQuestionControl =
  | { action: 'owner'; args: Record<string, unknown> }
  /** `move to=merge` at the exact approved head: the acceptance stands in for the proof. */
  | { action: 'move'; to: 'merge'; head: string }
  /** `move to=work`: return the task to its own worker with an instruction. */
  | { action: 'move'; to: 'work'; instruction: string }
  /** `proof`: spend the task's one author-side proof execution. */
  | { action: 'proof' }
  /** `stop`: halt the task and park it under an owner dispatch hold; its branch and PR stay. */
  | { action: 'stop' }
  /** `hold` (merge fence): leave the task held, with the proof list as the hold's reason. */
  | { action: 'hold'; reason: string };

export type OperatorQuestionChoice = {
  /** The exact answer text the operator selects; also the option Queue offers. */
  label: string;
  /** What applying this answer does to the task. */
  consequence?: string;
  /** The existing owner verb Queue applies for this answer, when the answer names one. */
  control?: OperatorQuestionControl;
  /** Spec 058 budgets: the answer grants one default budget increment before any control applies. */
  extendBudget?: true;
};

/**
 * Spec 058 (task 540): every question Queue raises carries a kind. Only `scope`
 * (changing what the task delivers, abandoning work) and `release` (publishing,
 * production enablement, external resources) stay the operator's. Budget
 * extensions, including past 2x, are delegated; frontier or above-ceiling profiles
 * remain operator decisions. Every other kind is
 * delegated to the project's planner, then to a decider agent.
 */
export type OperatorQuestionKind =
  /** A reviewer approved the head with external proofs parked. */
  | 'proof_acceptance'
  /** A responsible task reached or exceeded its budget. */
  | 'budget'
  /** Three review rounds without convergence. */
  | 'review'
  /** A change to what the task delivers. */
  | 'scope'
  /** Publishing, production enablement or external resources. Reserved for kinds that raise one. */
  | 'release'
  /** Spec 058 (task 550): a worker's or reviewer's own `nucleus_ask` question; delegated like every non-operator kind. */
  | 'process';

export const OPERATOR_ONLY_QUESTION_KINDS: readonly OperatorQuestionKind[] = ['scope', 'release'];

/** Only a kind outside the operator-only set may be answered by an agent. */
export const isDelegableQuestionKind = (kind: OperatorQuestionKind): boolean => !OPERATOR_ONLY_QUESTION_KINDS.includes(kind);

export type OperatorQuestion = {
  /** Stable identity for one stop episode and head: the durable send intent's key. */
  id: string;
  kind: OperatorQuestionKind;
  question: string;
  choices: OperatorQuestionChoice[];
};

/** What `raiseOperatorQuestions` does with one candidate after proof autorun. */
export type OperatorQuestionStep =
  | { kind: 'skip' }
  | { kind: 'proof_go'; recordIntent: boolean; ensureBoard: boolean }
  | { kind: 'skip_marked' }
  | { kind: 'skip_open' }
  | { kind: 'raise' };

export function operatorQuestionStep(facts: {
  question: Pick<OperatorQuestion, 'id' | 'kind'> | null;
  entrypoint: string | null | undefined;
  alreadyMarked: boolean;
  decisionMarked: boolean;
  openQuestion: boolean;
}): OperatorQuestionStep {
  if (!facts.question) return { kind: 'skip' };
  if (facts.entrypoint === 'proof' && facts.question.kind === 'release')
    return { kind: 'proof_go', recordIntent: !facts.alreadyMarked, ensureBoard: !facts.decisionMarked };
  if (facts.alreadyMarked) return { kind: 'skip_marked' };
  if (facts.openQuestion) return { kind: 'skip_open' };
  return { kind: 'raise' };
}

const questionId = (task: Task, stop: TaskStopRecord): string =>
  digest(['operator-question', task.id, stop.reason, stop.since, task.prHead ?? ''].join(':'));
/**
 * Spec 058 (task 539): a proof question is identified by its head and the proofs it
 * asks about, not by the stop episode. A worker round that reports blocked clears and
 * re-records the stop, so an episode-keyed id would ask the same question again.
 */
const proofQuestionId = (task: Task, head: string, proofs: string[]): string =>
  digest(['operator-question', task.id, 'awaiting_proof', head, ...[...proofs].sort()].join(':'));
export { proofOnlyGoQuestionId };

type ProofOnlyQuestionTask = Pick<Task, 'proofOnly' | 'requiresOperatorGo' | 'proofExecution'>;
/** Legacy wording remains verifiable for release questions already recorded. */
export const proofOnlyGoQuestionText = (task: ProofOnlyQuestionTask, legacy = false): string => {
  const product = legacy ? 'Queue' : 'Nucleus';
  // Every producer stays within the view limit; the limit helper is a no-op
  // while the bounded parts keep this short.
  return clipDecisionQuestion(`The proof-only qualification for merged commit ${task.proofOnly?.commit ?? ''} touches ${bounded(task.requiresOperatorGo ?? '', 900)}. ${product} will not run selector ${bounded(task.proofExecution?.selector ?? 'not recorded', 300)} until you approve this live-environment action. Should ${product} run the qualification?`);
};
/** Select only a question whose exact bytes match the recorded digest and length. */
export const recordedProofOnlyGoQuestion = (task: ProofOnlyQuestionTask, detail: string): string | null =>
  [proofOnlyGoQuestionText(task), proofOnlyGoQuestionText(task, true)].find(question =>
    detail.includes(`question ${digest(question)} (${question.length} chars)`)) ?? null;

/** Reuse legacy question bytes only when the existing intent proves that exact text. */
export function preserveRecordedOperatorQuestion(question: OperatorQuestion, legacy: OperatorQuestion, intent: string | undefined): OperatorQuestion {
  return intent?.includes(`question ${digest(legacy.question)} (${legacy.question.length} chars)`)
    ? legacy : question;
}

const bounded = (text: string, max = 1200): string => text.trim().replace(/\s+/g, ' ').slice(0, max);

/** The move view's target, when the view is an available move. */
const movesTo = (views: TaskNextVerb[], to: string): boolean =>
  views.some(view => view.verb === 'move' && view.available === true && view.args?.to === to);

/**
 * The question this stop asks the operator, or null when the wait is not one
 * only a person can clear. Null covers every task that did not opt in, every
 * wait code or the task's own threads settle, and every state where a verb
 * Queue can run applies.
 */
export function operatorQuestionFor(store: Store, task: Task): OperatorQuestion | null {
  const proofGo = task.entrypoint === 'proof' && Boolean(task.proofOnly && task.requiresOperatorGo);
  if (task.removedAt || ['done', 'cancelled'].includes(task.phase)) return null;
  if (isDispositionActive(task)) return null;
  // The task's own thread is what asks; without it there is nobody to prompt.
  if (!task.agentId) return null;
  const holds = holdsOf(task);
  // A dispatch hold blocks runs and therefore suppresses every prompt. A merge
  // hold only blocks merging; it cannot strand a budget stop.
  if (holds.dispatch) return null;
  const facts = collectOwnerVerbFacts(store, task);
  // An unreleased run is a thread still settling its own wait.
  if (facts.runs.some(run => !run.released)) return null;
  if (proofGo) return proofOnlyGoQuestion(store, task);
  const now = Date.now();
  // nucleus#1187: the question is a projection of the same budget figure every gate
  // and view reads, so a recorded budget pause that figure no longer shows asks
  // nothing — nobody is asked to answer a pause the task is not in.
  const stop = currentTaskStop(task, taskBudget(task, facts.runs, now, facts.events));
  if (!stop || (holds.merge && stop.reason !== 'budget')) return null;
  const build = (legacy: boolean) => stop.reason === 'budget' ? budgetQuestion(store, task, stop, now, legacy)
    : stop.reason === 'awaiting_proof' && proofWaitApplies(task)
      ? proofWaitQuestion(store, task, stop, facts, legacy)
      : strandedStopQuestion(task, stop, facts, legacy);
  const question = build(false);
  if (!question) return null;
  const intent = store.eventsAll(task.id).find(event => event.kind === 'operator_question' && event.detail.startsWith(`${question.id}:`));
  const legacy = intent && build(true);
  return legacy ? preserveRecordedOperatorQuestion(question, legacy, intent?.detail) : question;
}

function proofOnlyGoQuestion(store: Store, task: Task): OperatorQuestion | null {
  const events = store.eventsAll(task.id);
  const id = openProofOnlyGo(task, store.runs(task.id), events);
  if (!id) return null;
  return {
    id,
    kind: 'release',
    question: recordedProofOnlyGoQuestion(task, events.find(event => event.kind === 'operator_question' && event.detail.startsWith(`${id}:`))?.detail ?? '') ?? proofOnlyGoQuestionText(task),
    choices: [
      { label: 'GO — run the qualification', consequence: 'Runs once on the existing qualification workspace; no install or consumer.', control: { action: 'proof' } },
      { label: 'Do not run the qualification', consequence: 'Keeps the proof-only task from running this qualification.' },
    ],
  };
}

/**
 * A source approval parked on proofs Queue cannot run by itself. The reviewer
 * approved the exact head and named proofs that only an executor activation, an
 * environment or the operator can produce, so nothing here clears without a
 * person. Spec 058 (task 533): an author-producible or environment-tagged proof
 * never reaches this question — it was routed before the wait — so only an
 * external proof asks. Spec 058 (task 539): a proof the worker already had at this
 * head is not offered back to the worker, and the question is asked once per head
 * and proof set.
 */
function proofWaitQuestion(store: Store, task: Task, stop: TaskStopRecord, facts: OwnerVerbFacts, legacy: boolean): OperatorQuestion | null {
  const review = task.resolution.review;
  const head = review?.head ?? task.prHead;
  if (!head) return null;
  // Papercut c0fb3df9: forge CI checks are never awaiting proofs; the merge
  // gate's required-check wait covers them, so they raise no proof question.
  const externals = (review?.awaitingProofs ?? []).filter(proof => awaitingProofRoute(proof) === 'external'
    && !isForgeCheckProofText(awaitingProofTexts([proof])[0] ?? ''));
  if (!externals.length) return null;
  const external = awaitingProofTexts(externals);
  const proofs = external.join('; ').slice(0, 9000);
  const sent = proofWorkerRequests(store, task.id, head);
  const returnable = external.some(text => !sent.has(text));
  const views = ownerVerbViews(facts);
  const eligibility = qualifiedAcceptanceEligibility(task, facts.runs);
  const choices: OperatorQuestionChoice[] = [];
  // The operator source acceptance is the merge verb's own qualification: it
  // records the accepted risk at the exact head and enters ordinary
  // verification. A review that is already mergeable has an ordinary move
  // instead, and the merge verb offers it.
  if (eligibility.available && eligibility.acceptance === 'operator_source')
    choices.push({ label: 'Merge now without these proofs (run them after merge)', consequence: 'Merges the approved head without these proofs; they run only after merge.', control: { action: 'move', to: 'merge', head } });
  if (views.some(view => view.verb === 'proof' && view.available === true))
    choices.push({ label: 'Run the proof now', consequence: 'Runs the named proof at the approved head.', control: { action: 'proof' } });
  // Returning the task carries the proof list, so the worker produces what it can
  // at this head and says what it cannot. A worker round that already had these
  // proofs would only repeat, so the option is withheld then.
  if (returnable && movesTo(views, 'work'))
    choices.push({ label: 'Return the task to the worker', consequence: 'Returns the task to its worker to produce the proofs it can at this head.', control: { action: 'move', to: 'work',
      instruction: `This task was returned to you from the approval that was waiting on proof at ${head}. `
        + `Produce each proof you can at ${head} (its exact command, the head it ran at and the observed result) and say plainly which you can't and why. `
        + `Proofs: ${proofs}` } });
  choices.push({ label: 'Leave held for the planner', consequence: 'Keeps the task held until the planner or operator resolves the missing proofs.', control: { action: 'hold',
    reason: `Proofs Queue cannot run, left for the planner or operator at ${head}: ${proofs}. Run them through the proof verb or accept the head, then release this merge hold.`.slice(0, 4000) } });
  // The accept answer is a merge without the proofs, so the option and the body
  // say that plainly rather than naming the approval as the thing accepted
  // (Queue #531, Tom on effigy#524).
  const question = `The task "${task.title}" is stopped: ${stop.reason}. ${bounded(stop.detail)} `
    + `The reviewer approved ${head}, but its named proofs (${bounded(proofs, 600)}) cannot run from ${legacy ? 'Queue' : 'Nucleus'}'s side, so they will not run before a merge. `
    + `Merging now accepts ${head} as it is and runs no proof until after the merge. `
    + (returnable ? '' : 'The worker already had these proofs at this head, so returning it to the worker is not offered. ')
    + `How should the task proceed at that head?`;
  return { id: proofQuestionId(task, head, external), kind: 'proof_acceptance', question: clipDecisionQuestion(question), choices };
}

/**
 * Spec 058 budgets: a responsible task over its effective-token or wall-time limit
 * starts no new run. The operator extends it by one default increment, changes its
 * approach (the answer becomes the worker's next instruction) or stops it and keeps
 * the work. Queue's own text names the limit reached and what each answer does.
 */
function budgetQuestion(store: Store, task: Task, stop: TaskStopRecord, now: number, legacy: boolean): OperatorQuestion {
  const events = store.eventsAll(task.id);
  const budget = taskBudget(task, store.runs(task.id), now, events);
  const reached = budget.exhausted === 'wall_time'
    ? `${Math.round(budget.wallMs.used / 60_000)} of ${budget.wallMs.limit / 60_000} minutes of wall time since the responsible lifecycle began`
    : `${budget.effectiveTokens.used.toLocaleString('en-US')} of ${budget.effectiveTokens.limit.toLocaleString('en-US')} effective tokens`;
  const question = clipDecisionQuestion(`The task "${task.title}" reached its budget (${bounded(stop.detail, 200)}): ${reached}. `
    + `${legacy ? 'Queue' : 'Nucleus'} starts no new run until you answer. How should the task continue?`);
  return {
    id: questionId(task, stop),
    // Tom, 2026-11-03: extensions past 2x use the same delegated path.
    kind: 'budget',
    question,
    choices: [
      { label: 'Extend the budget', consequence: 'Adds one default budget increment and resumes the current approach.', extendBudget: true },
      { label: 'Change the approach', extendBudget: true,
        consequence: 'Adds one default budget increment and returns the task to its worker with your direction.',
        control: { action: 'move', to: 'work', instruction: 'The approach was changed at the budget pause; continue under the answer below.' } },
      { label: 'Stop and keep the work', consequence: 'Stops the task and retains its current work.', control: { action: 'stop' } },
    ],
  };
}

/**
 * The verbs Queue itself can run on a task without the operator choosing
 * something only a person can: resume the retained worker, send it somewhere,
 * retry one recorded effect, or spend the named proof execution. `route` (which
 * profile) and `complete` (end the task) are the operator's own dispositions,
 * never a mechanical path out of a wait.
 */
const mechanicalVerbs: ReadonlySet<string> = new Set(['restart', 'move', 'retry_effect', 'proof']);

/**
 * A blocked, errored or attention stop on a responsible task whose `next`
 * offers no mechanical verb Queue or the task's own threads can run. The ruling
 * goes to the planner: the question offers the existing owner verbs, including
 * their forced forms, without inventing a control for the stop reason.
 */
function strandedStopQuestion(task: Task, stop: TaskStopRecord, facts: OwnerVerbFacts, legacy: boolean): OperatorQuestion | null {
  if (!['blocked', 'error', 'needs_attention'].includes(task.phase)) return null;
  // A wait the code or the task's own threads settle (capacity, a pending
  // check, a running reviewer, the joint review question) raises nothing.
  if (isWaitingTaskStop(stop.reason)) return null;
  const views = ownerVerbViews(facts);
  const mechanical = views.filter(view => mechanicalVerbs.has(view.verb));
  if (mechanical.some(view => view.available === true)) return null;
  const refusals = mechanical.filter(view => view.available !== true && view.refusal)
    .slice(0, 4).map(view => bounded(view.refusal!, 400)).join('; ');
  const candidates = views.filter(view => view.available || view.forceArgs);
  const preferred = task.resolution.mergedCommit ? 'closeout' : 'work';
  candidates.sort((a, b) => Number((b.args ?? b.forceArgs)?.to === preferred) - Number((a.args ?? a.forceArgs)?.to === preferred));
  const choices: OperatorQuestionChoice[] = candidates.map(view => {
    const forced = !view.available;
    const args = (forced ? view.forceArgs : view.args) ?? {};
    const label = `${view.verb}${args.to ? ` to=${args.to}` : ''}${args.effect ? ` effect=${args.effect}` : ''}${forced ? ' force' : ''}`;
    return { label, consequence: forced ? `Overrides the refusal: ${view.refusal}. Requires a recorded reason.` : `Applies ${label} to this task.`,
      ...(!(forced ? view.forceFill : view.fill)?.some(field => field !== 'reason') && view.verb !== 'route'
        ? { control: { action: 'owner' as const, args: { ...args, action: view.verb } } } : {}) };
  });
  const question = clipDecisionQuestion(`The task "${task.title}" is stopped: ${stop.reason}. ${bounded(stop.detail)} `
    + `No verb ${legacy ? 'Queue' : 'Nucleus'} can run applies to it now${refusals ? `: ${refusals}` : ''}. `
    + `The planner can settle it with the available or forced owner verbs below. Recommended: ${choices[0]?.label}.`);
  return { id: questionId(task, stop), kind: 'process', question, choices };
}
