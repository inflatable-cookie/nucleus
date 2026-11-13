/**
 * Spec 058 (task 540): delegated answers to Queue's non-operator questions.
 *
 * A delegable question goes first to the project's planner thread, then to a
 * short-lived decider agent when no planner is set or the planner does not answer
 * in time. This module owns only the pure parts: the prompt, reading the command receipt
 * and the note the answer records. The caller records the send intent first, and
 * the answer applies through the ordinary verbs with `delegated` authority.
 */

/** How long a planner or a decider may take before the question falls through or stays with the operator. */
export const DELEGATED_ANSWER_TIMEOUT_MS = 10 * 60_000;

export type DelegateRole = 'planner' | 'decider';

export interface DelegatedAnswer {
  role: DelegateRole;
  budgetAuthority?: 'approve_by_default';
  /** The planner thread, or the decider agent Queue started for this one question. */
  agentId: string;
  /** Exactly one of the question's choices. */
  choice: string;
  /** One line, bounded. */
  reason: string;
  /** Exact IDs the planner says this answer settles; deciders never retain this field. */
  overtakes?: string[];
}

export interface DelegationContext {
  /** The question text Queue raised, as the operator would read it. */
  question: string;
  choices: string[];
  /** Task facts: the title and id, the brief, the latest review and proofs. Bounded by the caller. */
  context: string[];
}

const ROLE_WORDS: Record<DelegateRole, string> = { planner: 'the project planner', decider: 'a short-lived decider' };

const APPROVE = /\b(?:approve|approved|yes|go ahead|proceed|continue|allow|accept)\b/i;
const HOLD = /\b(?:hold|wait|deny|no|reject|decline|stop)\b/i;
const OPERATOR_GATED = /\b(?:release|publish(?:ing)?|deploy(?:ment)?|production|outward action|external action|external resource|frontier|above[- ]ceiling)\b|\b(?:emails?|send|post|publish|notify|contact|create|open)\b.{0,60}\b(?:customer|user|public|external|third.party)\b|\b(?:customer|user|public|external|third.party)\b.{0,60}\b(?:emails?|send|post|publish|notify|contact|create|open)\b|\b(?:product|scope|deliver(?:s|able|ing)?)\b.{0,60}\b(?:change|modify|expand|replace|alter|new|add)\b|\b(?:change|modify|expand|replace|alter|add|new)\b.{0,60}\b(?:product|scope|deliver(?:s|able|ing)?)\b/i;

/** The approved option in a two-choice approval/hold question, unless its subject is operator-gated. */
export function binaryApprovalChoice(question: string, choices: readonly string[], context = ''): string | null {
  if (choices.length !== 2 || OPERATOR_GATED.test([question, context, ...choices].join(' '))) return null;
  const approved = choices.filter(choice => APPROVE.test(choice));
  const held = choices.filter(choice => HOLD.test(choice));
  return approved.length === 1 && held.length === 1 ? approved[0]! : null;
}

/**
 * The delegate's answer when it picked the approval of a binary approve/hold question, so it can
 * record approve by default as its authority. Null for anything else: a delegate's hold stands
 * and never becomes an approval (Tom, 2026-11-06).
 */
export function delegateApprovedChoice(question: string, choices: readonly string[], answer: string, context = ''): string | null {
  const approved = binaryApprovalChoice(question, choices, context);
  return approved && answer.trim().toLowerCase() === approved.toLowerCase() ? approved : null;
}

/** The recorded authority for a binary approval (Tom, 2026-11-03). */
export const APPROVE_BY_DEFAULT_REASON = 'approve by default, Tom 2026-11-03';

/**
 * The final reply when a delegate picked the approval of a binary approve/hold
 * question. Null for a hold or an operator-gated subject (bug 23).
 */
export function applyBinaryApproval(question: string, choices: readonly string[], answer: string, context = ''): { choice: string; reason: string } | null {
  const choice = delegateApprovedChoice(question, choices, answer, context);
  return choice ? { choice, reason: APPROVE_BY_DEFAULT_REASON } : null;
}

const TASK_CONTEXT_MAX_CHARS = 12_000;

/**
 * The task facts every delegate reads (Spec 058). Each fact is one indented line, so a brief or
 * review can't add a line the delegated-answer command would read as an offered choice.
 */
export function taskContextLines(context: readonly string[]): string[] {
  const facts = context.map(fact => fact.trim().replace(/\s+/g, ' ')).filter(Boolean);
  return facts.length ? ['Task context:', facts.map(fact => `  ${fact}`).join('\n').slice(0, TASK_CONTEXT_MAX_CHARS)] : [];
}

/** Native questions may be free text and must first be classified by the delegate. */
export function nativeDelegationPrompt(role: DelegateRole, input: DelegationContext, planner?: 'task' | 'project'): string {
  // Task 1109: a task's own planner is asked first; naming the rung keeps the prompt honest.
  const who = role === 'planner' ? (planner === 'task' ? "the task's planner" : ROLE_WORDS[role]) : ROLE_WORDS[role];
  return [
    `Question for ${who}: ${input.question}`,
    ...input.choices.map(choice => `- ${choice}`),
    ...taskContextLines(input.context),
    'If only the operator can decide, use decision: "operator" with a one-line reason.',
  ].join('\n');
}

export type NativeDelegatedReply = { kind: 'answer'; answer: string; reason: string; overtakes?: string[] } | { kind: 'operator'; reason: string };

type DelegateReply = NativeDelegatedReply | { kind: 'choice'; choice: string; reason: string; overtakes?: string[] };

/** One receipt reader; each surface retains its allowed reply shapes and precedence. */
export function parseDelegateReply(text: string | null | undefined, mode: 'native' | 'choice' | 'escalation', choices: readonly string[] = []): DelegateReply | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const field = (name: string) => lines.filter(line => line.toLowerCase().startsWith(`${name}:`)).at(-1)?.slice(name.length + 1).trim();
  const reason = (mode === 'choice' ? field('reason')?.replace(/\s+/g, ' ') : field('reason'))?.slice(0, 500);
  const answer = field('answer')?.slice(0, 4000);
  const choice = field('choice');
  const references = field('overtakes')?.split(',').map(id => id.trim()).filter(id => id.length > 0 && id.length <= 160);
  const overtakes = references?.length ? [...new Set(references)].slice(0, 100) : undefined;
  if (mode !== 'choice' && lines.some(line => /^decision:\s*operator\s*$/i.test(line))) return reason ? { kind: 'operator', reason } : null;
  if (mode === 'native') return answer && reason ? { kind: 'answer', answer, reason, ...(overtakes ? { overtakes } : {}) } : null;
  const named = (value: string | undefined) => {
    if (!value) return undefined;
    if (choices.includes(value)) return value;
    if (mode !== 'escalation') return undefined;
    const shortLabels = choices.filter(item => item.replace(/\s*\([^)]*\)$/, '') === value);
    if (shortLabels.length === 1) return shortLabels[0];
    const matches = choices.filter(item => item.startsWith(`${value}: `));
    return matches.length === 1 ? matches[0] : undefined;
  };
  const selected = named(choice) ?? (mode === 'escalation' ? named(answer) : undefined);
  if (selected && reason) return { kind: 'choice', choice: selected, reason, ...(mode === 'choice' && overtakes ? { overtakes } : {}) };
  return mode === 'escalation' && answer && !/^(?:leave it waiting|wait|keep waiting)(?:\b|$)/i.test(answer)
    ? { kind: 'answer', answer, reason: reason ?? '' } : null;
}

export function parseNativeDelegatedReply(text: string | null | undefined): NativeDelegatedReply | null {
  const reply = parseDelegateReply(text, 'native');
  return reply?.kind === 'choice' ? null : reply;
}

/** Choice receipts require an exact offered choice and a nonempty reason. */
export function parseDelegatedAnswer(text: string | null | undefined, choices: string[]): { choice: string; reason: string; overtakes?: string[] } | null {
  const reply = parseDelegateReply(text, 'choice', choices);
  if (reply?.kind !== 'choice') return null;
  const { kind, ...answer } = reply;
  return answer;
}

/** The line the activity and the recorded authority show: who decided, what, and why. */
export function delegatedDecisionText(answer: DelegatedAnswer): string {
  return `Decided by ${answer.role}: ${answer.choice} — ${answer.reason}`.slice(0, 4000);
}

/** The note an applied verb records for a delegated answer: the answering agent, its choice and reason. */
export function delegatedAuthorityNote(questionId: string, answer: DelegatedAnswer): string {
  return `Delegated answer to Queue's question ${questionId} by ${answer.role} ${answer.agentId}: ${answer.choice}. Reason: ${answer.reason}`.slice(0, 4000);
}
