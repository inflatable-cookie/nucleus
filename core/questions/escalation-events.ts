import { plannerEscalations, type EscalationVerbChoice, type LadderEvent, type PlannerEscalation } from './blocker-ladder';

/**
 * The one decoder for one planner escalation's durable records.
 *
 * Every `planner_escalation_*` record writes the escalation id as its detail's
 * leading token, so the escalation's state is those records read together.
 * `blocker-ladder.ts` owns its identity, cause, answered and unknown state; this
 * module reads the rest of each record once — the wait it is parked on, the answer
 * it is applying, the choices it offered, the payload it carried, the refusal and
 * the follow-up it reopened, and the attention its unknown delivery raised. The
 * routing, wait and recovery owners read these typed facts and never slice an
 * event detail themselves.
 */

/** One escalation's recorded wait: the seat the task is parked on. */
export interface EscalationWait {
  kind: 'task' | 'time' | 'decision';
  target: string;
  /** The prerequisite wait this escalation's own task wait belongs to. */
  waitId?: string;
  stopDetail?: string;
  stopReason?: 'lifecycle' | 'escalated';
}

/** One recorded wait, with the event that carries it. */
export interface EscalationWaitRecord {
  eventId: number;
  /** The decoded wait; null when the record holds no wait this reader knows. */
  wait: EscalationWait | null;
}

/** One recorded answer intent: the wait its answer applies, when it applies one. */
export interface EscalationAnswerIntent {
  eventId: number;
  questionId: string | null;
  who: string | null;
  answer: string | null;
  wait: { kind: 'time' | 'decision'; target: string } | null;
}

/** The follow-up offer a refused answer opened: the identity the next reply answers. */
export interface EscalationFollowupOffer {
  questionId: string;
  choices: string[];
  ownerChoices: EscalationVerbChoice[];
}

/** What the records say about one escalation's unknown-delivery attention. */
export interface EscalationAttention {
  /** The task surfaced as visible attention for this escalation. */
  recorded: boolean;
  /** The durable send intent, written before the message. */
  sent: boolean;
  delivered: boolean;
  /** Why the attention could not be sent at all, when it could not. */
  missed: string | null;
  /** The delivery error, when the send was attempted and unobserved. */
  unknown: string | null;
}

/** One escalation's decoded durable facts, beyond what `blocker-ladder.ts` reads. */
export interface EscalationFacts {
  escalation: PlannerEscalation;
  /** The question and the run the escalation recorded, from its payload. */
  payload: { question: string | null; runId: string | null } | null;
  /** The owner-verb choices the escalation offered, in order. */
  offered: EscalationVerbChoice[] | null;
  followup: EscalationFollowupOffer | null;
  /** The last refusal recorded for an answer, as its reason. */
  lastRefusal: string | null;
  /** The operator decision the escalation was classified into. */
  decisionLink: { decisionId: string; eventId: number } | null;
  /** Every wait the escalation recorded, in order. */
  waits: EscalationWaitRecord[];
  /** An answered or resolved record exists, whether or not its answer has applied. */
  answeredRecorded: boolean;
  /** A send that landed without a usable answer: the ladder's own no-answer miss. */
  noAnswerMissed: boolean;
  /** The durable send intent, written before the delegate was asked. */
  sent: boolean;
  /** A refused answer's follow-up was sent back to the delegate. */
  refusalSent: boolean;
  /** A reply's action outcome was never observed. */
  actionUncertain: boolean;
  attention: EscalationAttention;
  /** The escalation was classified to the operator: the record that says so. */
  decidedEventId: number | null;
  /**
   * A record this escalation wrote cannot be read as the shape it names. Routing
   * refuses to act on an unreadable intent rather than re-sending it blind.
   */
  unreadable: { offered: boolean; payload: boolean; followup: boolean };
}

/**
 * A stand-in event for "this task recorded no such record"; reading it yields an
 * empty body, so one branch covers a missing record and an unreadable one alike.
 */
const ABSENT: LadderEvent = { id: 0, taskId: '', at: '', kind: '', detail: '' };

/** The detail after the escalation id, or null when this record is another escalation's. */
function bodyOf(event: LadderEvent, id: string): string | null {
  if (!event.detail.startsWith(`${id}:`)) return null;
  return event.detail.slice(id.length + 1).trim();
}

/** This escalation's records of one kind, in order. */
function recordsOf(events: LadderEvent[], kind: string, id: string): LadderEvent[] {
  return events.filter(event => event.kind === kind && event.detail.startsWith(`${id}:`));
}

/** The first of this escalation's records of one kind, if it has one. */
function firstOf(events: LadderEvent[], kind: string, id: string): LadderEvent {
  return recordsOf(events, kind, id)[0] ?? ABSENT;
}

/** The last of this escalation's records of one kind, if it has one. */
function lastOf(events: LadderEvent[], kind: string, id: string): LadderEvent {
  return recordsOf(events, kind, id).at(-1) ?? ABSENT;
}

/** A record's body decoded as JSON; an unreadable body stays absent. */
function decodeBody<T>(event: LadderEvent, id: string): T | null {
  const body = bodyOf(event, id);
  if (body === null) return null;
  try { return JSON.parse(body) as T; } catch { return null; }
}

/** A record's body as its own text; an absent record stays absent. */
function textOf(event: LadderEvent, id: string): string | null {
  return bodyOf(event, id);
}

/** The wait one record's payload describes, decoded into one typed wait. */
function decodeWait(value: unknown): EscalationWait | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'task' && record.kind !== 'time' && record.kind !== 'decision') return null;
  return {
    kind: record.kind,
    target: typeof record.target === 'string' ? record.target : '',
    ...(typeof record.waitId === 'string' ? { waitId: record.waitId } : {}),
    ...(typeof record.stopDetail === 'string' ? { stopDetail: record.stopDetail } : {}),
    ...(record.stopReason === 'lifecycle' || record.stopReason === 'escalated' ? { stopReason: record.stopReason } : {}),
  };
}

/** One wait record, decoded; `wait` is null when the record holds no wait this reader knows. */
export function escalationWaitRecord(event: LadderEvent, id: string): EscalationWaitRecord {
  let value: unknown = null;
  const body = bodyOf(event, id);
  if (body !== null) {
    try { value = JSON.parse(body); } catch { value = null; }
  }
  return { eventId: event.id, wait: decodeWait(value) };
}

/** The wait a record must hold, naming the escalation when it cannot be read as one. */
export function requireEscalationWait(record: EscalationWaitRecord, id: string): EscalationWait {
  if (!record.wait) throw Error(`Escalation ${id}: wait record ${record.eventId} is not a readable wait`);
  return record.wait;
}

/** Every wait record one escalation wrote, in order, decoded. */
export function escalationWaitsOf(events: LadderEvent[], id: string): EscalationWaitRecord[] {
  return recordsOf(events, 'planner_escalation_wait', id).map(event => escalationWaitRecord(event, id));
}

/** One recorded answer intent, decoded. */
function decodeAnswerIntent(event: LadderEvent, id: string): EscalationAnswerIntent {
  const decoded = decodeBody<{ questionId?: unknown; who?: unknown; answer?: unknown; control?: { kind?: unknown; target?: unknown } | null }>(event, id);
  const control = decoded?.control;
  let wait: EscalationAnswerIntent['wait'] = null;
  if (control && (control.kind === 'time' || control.kind === 'decision') && typeof control.target === 'string')
    wait = { kind: control.kind, target: control.target };
  return {
    eventId: event.id,
    questionId: typeof decoded?.questionId === 'string' ? decoded.questionId : null,
    who: typeof decoded?.who === 'string' ? decoded.who : null,
    answer: typeof decoded?.answer === 'string' ? decoded.answer : null,
    wait,
  };
}

/** The escalation's decoded facts, or null when this task never recorded it. */
export function escalationFacts(events: LadderEvent[], id: string): EscalationFacts | null {
  const escalation = plannerEscalations(events).find(item => item.id === id);
  if (!escalation) return null;
  const payloadRecord = firstOf(events, 'planner_escalation_payload', id);
  const offeredRecord = firstOf(events, 'planner_escalation_offered', id);
  const followupRecord = lastOf(events, 'planner_escalation_followup_offered', id);
  const payload = decodeBody<{ question?: unknown; runId?: unknown }>(payloadRecord, id);
  const offered = decodeBody<EscalationVerbChoice[]>(offeredRecord, id);
  const followup = decodeBody<{ questionId?: unknown; choices?: unknown; ownerChoices?: unknown }>(followupRecord, id);
  const unreadable = (record: LadderEvent, decoded: unknown) => record.id > 0 && decoded === null;
  const link = lastOf(events, 'planner_escalation_decision_linked', id);
  const decisionId = /decision ([0-9a-f-]{36})/.exec(textOf(link, id) ?? '')?.[1] ?? null;
  return {
    escalation,
    payload: payload
      ? { question: typeof payload.question === 'string' ? payload.question : null,
          runId: typeof payload.runId === 'string' ? payload.runId : null }
      : null,
    offered: Array.isArray(offered) ? offered : null,
    followup: followup && typeof followup.questionId === 'string' && Array.isArray(followup.choices) && Array.isArray(followup.ownerChoices)
      ? { questionId: followup.questionId, choices: followup.choices, ownerChoices: followup.ownerChoices } : null,
    lastRefusal: textOf(lastOf(events, 'planner_escalation_answer_refused', id), id),
    decisionLink: decisionId && link.id > 0 ? { decisionId, eventId: link.id } : null,
    waits: escalationWaitsOf(events, id),
    answeredRecorded: recordsOf(events, 'planner_escalation_answered', id).length > 0
      || recordsOf(events, 'planner_escalation_resolved', id).length > 0,
    noAnswerMissed: recordsOf(events, 'planner_escalation_missed', id)
      .some(event => (bodyOf(event, id) ?? '').startsWith('no delegated answer was produced;')),
    sent: recordsOf(events, 'planner_escalation_sent', id).length > 0,
    refusalSent: recordsOf(events, 'planner_escalation_refusal_sent', id).length > 0,
    actionUncertain: recordsOf(events, 'planner_escalation_action_uncertain', id).length > 0,
    attention: {
      recorded: recordsOf(events, 'planner_escalation_attention', id).length > 0,
      sent: recordsOf(events, 'planner_escalation_attention_sent', id).length > 0,
      delivered: recordsOf(events, 'planner_escalation_attention_delivered', id).length > 0,
      missed: textOf(lastOf(events, 'planner_escalation_attention_missed', id), id),
      unknown: textOf(lastOf(events, 'planner_escalation_attention_unknown', id), id),
    },
    decidedEventId: recordsOf(events, 'planner_escalation_decision', id).at(-1)?.id ?? null,
    unreadable: {
      offered: unreadable(offeredRecord, offered),
      payload: unreadable(payloadRecord, payload),
      followup: unreadable(followupRecord, followup),
    },
  };
}

/** Whether this escalation's operator classification link names exactly this decision. */
export function decisionLinkedExactly(events: LadderEvent[], id: string, decisionId: string): boolean {
  return events.some(event => event.kind === 'planner_escalation_decision_linked' && bodyOf(event, id) === `decision ${decisionId}`);
}

/** One wait episode the resume sweep visits: the record and the facts that decide it. */
export interface EscalationWaitEpisode {
  id: string;
  record: EscalationWaitRecord;
  /** This escalation recorded a wake intent for its wait. */
  wakeIntent: boolean;
  /** The wake finished: it woke or it was refused. */
  wakeFinished: boolean;
  superseded: boolean;
  /** The answer intents recorded before this wait, in order. */
  pendingAnswers: EscalationAnswerIntent[];
}

/** Every wait episode a task recorded, in the order the records were written. */
export function escalationWaitEpisodes(events: LadderEvent[]): EscalationWaitEpisode[] {
  const pending = new Map<string, EscalationAnswerIntent[]>();
  const markers = new Map<string, { superseded: boolean; wakeIntent: boolean; woke: boolean; wakeRefused: boolean }>();
  for (const event of events) {
    const separator = event.detail.indexOf(':');
    if (separator <= 0 || !event.kind.startsWith('planner_escalation_')) continue;
    const id = event.detail.slice(0, separator);
    if (event.kind === 'planner_escalation_answer_pending') {
      const intents = pending.get(id) ?? [];
      intents.push(decodeAnswerIntent(event, id));
      pending.set(id, intents);
      continue;
    }
    const facts = markers.get(id) ?? { superseded: false, wakeIntent: false, woke: false, wakeRefused: false };
    markers.set(id, facts);
    switch (event.kind) {
      case 'planner_escalation_wait_superseded': facts.superseded = true; break;
      case 'planner_escalation_wake_intent': facts.wakeIntent = true; break;
      case 'planner_escalation_woke': facts.woke = true; break;
      case 'planner_escalation_wake_refused': facts.wakeRefused = true; break;
      default: break;
    }
  }
  const episodes: EscalationWaitEpisode[] = [];
  for (const event of events) {
    if (event.kind !== 'planner_escalation_wait') continue;
    const separator = event.detail.indexOf(':');
    if (separator <= 0) continue;
    const id = event.detail.slice(0, separator);
    const facts = markers.get(id) ?? { superseded: false, wakeIntent: false, woke: false, wakeRefused: false };
    episodes.push({
      id,
      record: escalationWaitRecord(event, id),
      wakeIntent: facts.wakeIntent,
      wakeFinished: facts.woke || facts.wakeRefused,
      superseded: facts.superseded,
      pendingAnswers: (pending.get(id) ?? []).filter(intent => intent.eventId < event.id),
    });
  }
  return episodes;
}
