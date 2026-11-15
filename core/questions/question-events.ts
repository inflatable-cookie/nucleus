import { digest } from '../store/store';
import type { OperatorQuestion, OperatorQuestionKind } from './operator-question';

/**
 * The one decoder for the operator-question records the question service reads.
 *
 * Every operator question writes its question id as the detail's leading token,
 * so a question's state is those records read together. This module reads each
 * record once — the intent it raised, the decision it was raised on, the marks
 * that fence a re-raise or a re-answer, the delegation outcome that sends it back
 * to the ladder, and the payloads a restart recovers. The raise, answer and
 * recovery owners read these typed facts and never slice an event detail.
 */
export interface OperatorQuestionIntent {
  /** The question kind the intent names. */
  kind: string;
  /** The stop the question was raised on. */
  stop: string;
  /** The head the question was raised at. */
  head: string;
  /** The question's own digest, so an exact match never reads the text. */
  questionDigest: string;
  questionLength: number;
  /** The labels the raise offered, in order. */
  options: string[];
}

/** One native request a question was delivered as. */
export interface OperatorQuestionNativeRequest {
  requestId: string;
  header: string;
  agentId: string;
}

/** One question's decoded records. */
export interface OperatorQuestionRecord {
  id: string;
  /** The raise intent, when this question recorded one. */
  intent: OperatorQuestionIntent | null;
  /** The decision this question was raised on, and why the raise chose the board. */
  link: { decisionId: string; why: string } | null;
  /** Every question-scoped record kind this id wrote, for the existence fences. */
  kinds: ReadonlySet<string>;
  /** The last refusal recorded for this question, as its reason. */
  refusal: string | null;
  /** Every native request this question recorded, in order, so a repeated callback writes one. */
  nativeRequests: OperatorQuestionNativeRequest[];
  /** Its delegation's delivery is unknown. */
  delegationUnknown: boolean;
  /** A delegation miss that recorded no delegated answer. */
  noAnswerMissed: boolean;
}

/**
 * An operator question's raise intent, decoded. A Queue-era intent carries only
 * the kind, the question and its options; the stop and head are current fields,
 * so a reader that only needs the question never depends on them.
 */
function decodeIntent(body: string): OperatorQuestionIntent | null {
  const question = /(?:^|; )question (\S+) \((\d+) chars\)/.exec(body);
  if (!question) return null;
  const options = /(?:^|; )options (.*)$/.exec(body)?.[1] ?? 'none';
  return {
    kind: /(?:^|; )kind ([^;]+)/.exec(body)?.[1] ?? '',
    stop: /(?:^|; )stop ([^;]+)/.exec(body)?.[1] ?? '',
    head: /(?:^|; )head (.+?);/.exec(body)?.[1] ?? '',
    questionDigest: question[1]!,
    questionLength: Number(question[2]),
    options: options === 'none' ? [] : options.split(' | '),
  };
}

/** The detail after one record's leading id, or null when this record is another id's. */
function bodyOf(detail: string): { id: string; body: string } | null {
  const separator = detail.indexOf(':');
  if (separator <= 0) return null;
  return { id: detail.slice(0, separator), body: detail.slice(separator + 1).trim() };
}

/** The kinds each id-scoped record wrote, keyed by its leading id. */
export function questionRecordKinds(events: ReadonlyArray<{ kind: string; detail: string }>): Map<string, Set<string>> {
  const kinds = new Map<string, Set<string>>();
  for (const event of events) {
    const parts = bodyOf(event.detail);
    if (!parts) continue;
    const recorded = kinds.get(parts.id) ?? new Set<string>();
    recorded.add(event.kind);
    kinds.set(parts.id, recorded);
  }
  return kinds;
}

/** Every operator question this task recorded, decoded once, in record order. */
export function operatorQuestionRecords(events: ReadonlyArray<{ kind: string; detail: string }>): Map<string, OperatorQuestionRecord> {
  const kinds = questionRecordKinds(events);
  const records = new Map<string, OperatorQuestionRecord>();
  const record = (id: string): OperatorQuestionRecord => {
    const existing = records.get(id);
    if (existing) return existing;
    const created: OperatorQuestionRecord = {
      id, intent: null, link: null, kinds: kinds.get(id) ?? new Set<string>(),
      refusal: null, nativeRequests: [], delegationUnknown: false, noAnswerMissed: false,
    };
    records.set(id, created);
    return created;
  };
  for (const event of events) {
    if (!event.kind.startsWith('operator_question') && !event.kind.startsWith('responsible_question')) continue;
    const parts = bodyOf(event.detail);
    if (!parts) continue;
    const decoded = record(parts.id);
    switch (event.kind) {
      case 'operator_question': {
        const intent = decodeIntent(parts.body);
        if (intent) decoded.intent = intent;
        break;
      }
      case 'operator_question_decision': {
        const decisionId = /^decision ([0-9a-f-]{36})(?:; (.*))?$/.exec(parts.body);
        if (decisionId) decoded.link = { decisionId: decisionId[1]!, why: decisionId[2] ?? '' };
        break;
      }
      case 'operator_question_refused': {
        const refusal = parts.body.replace(/^[^:]+: /, '');
        decoded.refusal = refusal;
        break;
      }
      case 'operator_question_native_request': {
        const requestId = /request (\S+)/.exec(parts.body)?.[1];
        if (requestId)
          decoded.nativeRequests.push({ requestId,
            header: /header (.*) on /.exec(parts.body)?.[1] ?? '',
            agentId: /on (\S+)$/.exec(parts.body)?.[1] ?? '' });
        break;
      }
      case 'operator_question_delegation_unknown':
        decoded.delegationUnknown = true;
        break;
      case 'operator_question_delegation_missed':
        if (parts.body.startsWith('no delegated answer was produced;')) decoded.noAnswerMissed = true;
        break;
      default:
        break;
    }
  }
  return records;
}

/** One operator question's decoded records, or null when this task never recorded it. */
export function operatorQuestionRecord(events: ReadonlyArray<{ kind: string; detail: string }>, id: string): OperatorQuestionRecord | null {
  return operatorQuestionRecords(events).get(id) ?? null;
}

/** The options line the raise intent writes for one question's labels. */
export function intentOptions(labels: readonly string[]): string {
  return labels.join(' | ') || 'none';
}

/** The raise intent names exactly this question: same digest, length and options. */
export function intentNamesQuestion(intent: OperatorQuestionIntent, question: OperatorQuestion): boolean {
  return intent.questionDigest === digest(question.question)
    && intent.questionLength === question.question.length
    && intent.options.join(' | ') === intentOptions(question.choices.map(choice => choice.label));
}

/** The links one decision's answer reconciles: the record kind and the id it answers. */
export interface DecisionAnswerLink {
  kind: string;
  id: string;
}

/** Every record that names one decision, decoded into the kind and id it answers. */
export function decisionAnswerLinks(events: ReadonlyArray<{ kind: string; detail: string }>, decisionId: string): DecisionAnswerLink[] {
  const links: DecisionAnswerLink[] = [];
  for (const event of events) {
    if (!event.detail.includes(`decision ${decisionId}`)) continue;
    const parts = bodyOf(event.detail);
    if (!parts) continue;
    links.push({ kind: event.kind, id: parts.id });
  }
  return links;
}

/** The payload a Queue ask was raised from, recovered after a restart. */
export interface QueueAskPayload {
  id: string;
  kind: OperatorQuestionKind;
  question: string;
  options: string[];
}

/** Every recoverable Queue ask payload, in record order; an invalid payload authorizes nothing. */
export function queueAskPayloads(events: ReadonlyArray<{ kind: string; detail: string }>): QueueAskPayload[] {
  const payloads: QueueAskPayload[] = [];
  for (const event of events) {
    if (event.kind !== 'queue_ask_payload') continue;
    try {
      const payload = JSON.parse(event.detail) as Partial<QueueAskPayload>;
      if (typeof payload.id !== 'string' || typeof payload.kind !== 'string' || typeof payload.question !== 'string' || !Array.isArray(payload.options)) continue;
      payloads.push({ id: payload.id, kind: payload.kind as OperatorQuestionKind, question: payload.question, options: payload.options });
    } catch { /* Invalid payload cannot authorize recovery. */ }
  }
  return payloads;
}

/** One delegated decision route's recovered identity: the question and its native request. */
export interface DelegatedDecisionRoute {
  decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[] };
  request: { requestId: string; header: string } | null;
}

/** One recorded delegated decision route: what it names, or null when it cannot be read. */
export interface DelegatedDecisionRouteRecord {
  eventId: number;
  route: DelegatedDecisionRoute | null;
}

/**
 * Every recorded delegated decision route, in record order, decoded one record at a
 * time: a route that cannot be read never hides the routes recorded before it, so a
 * sweep resumes them in the order they were written.
 */
export function delegatedDecisionRouteRecords(events: ReadonlyArray<{ kind: string; detail: string; id: number }>): DelegatedDecisionRouteRecord[] {
  const routes: DelegatedDecisionRouteRecord[] = [];
  for (const event of events) {
    if (event.kind !== 'delegated_decision_route') continue;
    try {
      routes.push({ eventId: event.id, route: JSON.parse(event.detail) as DelegatedDecisionRoute });
    } catch {
      routes.push({ eventId: event.id, route: null });
    }
  }
  return routes;
}
