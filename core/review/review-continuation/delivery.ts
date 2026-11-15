/**
 * One reviewer delivery's identity and the stop that authorizes one more turn.
 * The identity is derived here, never supplied by a caller: an ordinary
 * continuation is bound to its checkpoint, and a stop-backed resume adds the
 * individual owner-stop occurrence, so a replay reconciles the same effect and a
 * second stop is the only way to authorize another.
 */
import type { ReviewDeliveryAuthorization, Run, Task } from "../../../shared/contracts";
import { digest, type Store } from "../../store/store";

/** The task reason while a continuation send is reserved or uncertain; one text for every writer. */
export const reviewDeliveryReason = (deliveryId: string, status: 'reserved' | 'uncertain') =>
  status === 'reserved'
    ? `Reviewer continuation ${deliveryId} is reserved; awaiting the same-run send result`
    : `Reviewer delivery ${deliveryId} is uncertain; inspect the same reviewer thread before any further action`;

/** The newest durable event that records one delivery's own reservation or outcome. */
export function deliveryOutcomeEventId(store: Pick<Store, 'eventsAll'>, taskId: string, deliveryId: string): number | null {
  return store.eventsAll(taskId)
    .filter(event => ['review_delivery_reserved', 'review_delivery_delivered', 'review_delivery_uncertain', 'review_delivery_refused'].includes(event.kind)
      && event.detail.includes(deliveryId))
    .reduce<number | null>((max, event) => max === null || event.id > max ? event.id : max, null);
}

/**
 * The durable operator authorization identity for one continuation intent. The
 * ordinary checkpoint continuation keeps the identity the parent revision wrote
 * (so a reserved or uncertain delivery it recorded is still recognised and
 * inspected, never rejected as a different authorization); a stop-backed resume
 * adds the individual owner-stop occurrence, which is what makes it a new,
 * explicit authorization (review 5672703363, finding 3).
 */
export function reviewAuthorizationId(input: { taskId: string; runId: string; head: string; checkpointOrdinal: number; reason: string; instruction: string },
  stop: { eventId: number } | null | undefined): string {
  const base = [input.taskId, input.runId, input.head, input.checkpointOrdinal];
  return `review-auth-${digest(JSON.stringify(stop ? [...base, stop.eventId, input.reason, input.instruction] : [...base, input.reason, input.instruction]))}`;
}

/** The latest delivered continuation turn of a review run's latest checkpoint. */
export function latestDeliveredReviewTurn(run: Run): ReviewDeliveryAuthorization | null {
  const ordinal = run.reviewCheckpoints?.at(-1)?.ordinal;
  if (ordinal === undefined) return null;
  return (run.reviewDeliveries ?? []).findLast(item => item.checkpointOrdinal === ordinal
    && (item.head ?? run.head) === run.head && item.status === 'delivered') ?? null;
}

export type StoppedDeliveryResume =
  | { kind: 'none' }
  | { kind: 'refused'; reason: string }
  | { kind: 'resume'; eventId: number; at: string; delivery: ReviewDeliveryAuthorization };

/** Every `owner_stop_sent` occurrence recorded against one review run, in event order. */
export function reviewStopOccurrences(store: Pick<Store, 'eventsAll'>, task: Task, run: Run): { eventId: number; at: string }[] {
  const occurrences: { eventId: number; at: string }[] = [];
  for (const event of store.eventsAll(task.id)) {
    if (event.kind !== 'owner_stop_sent') continue;
    try { if ((JSON.parse(event.detail) as { runId?: unknown }).runId !== run.id) continue; } catch { continue; }
    occurrences.push({ eventId: event.id, at: event.at });
  }
  return occurrences;
}

/**
 * Whether a positively confirmed OWNER STOP ended the review turn a checkpoint
 * continuation was delivered into (Tom, 2026-10-27). The evidence is one
 * individual immutable `owner_stop_sent` occurrence — never an idle
 * observation, never a stop from `move` or `route` displacement — whose verb is
 * `stop`, whose recorded task/run/agent/workspace match this reviewer, and
 * which is ordered after that delivered turn. The occurrence's own event id is
 * the authorization identity, so replaying the same stop authorizes one effect
 * and a second stop is a new, explicit owner act. Unknown (`owner_stop_uncertain`)
 * or ambiguous cancellation refuses: an unproven stop is inspect-only.
 */
export function stoppedDeliveryResume(store: Pick<Store, 'eventsAll'>, task: Task, run: Run, delivery: ReviewDeliveryAuthorization): StoppedDeliveryResume {
  const after = Date.parse(delivery.observedAt ?? delivery.createdAt);
  if (!Number.isFinite(after)) return { kind: 'refused', reason: `Reviewer delivery ${delivery.deliveryId} records no delivery time, so no stop can be shown to end that turn` };
  // Ordering proof is the durable event order, not a timestamp comparison: the
  // delivery's own recorded outcome event is an immutable anchor, so a stop
  // written before it belongs to an earlier turn even when both carry the same
  // millisecond. A record with no anchor falls back to timestamps and refuses an
  // equal-timestamp ambiguity instead of treating it as later (review
  // 5672703363, finding 1).
  const anchor = deliveryOutcomeEventId(store, task.id, delivery.deliveryId);
  const ordering = (event: { id: number; at: string }): 'after' | 'before' | 'ambiguous' => {
    if (anchor !== null) return event.id > anchor ? 'after' : 'before';
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) return 'ambiguous';
    return at > after ? 'after' : at < after ? 'before' : 'ambiguous';
  };
  const events = store.eventsAll(task.id).filter(event => event.kind === 'owner_stop_sent' || event.kind === 'owner_stop_uncertain');
  type StopDetail = { verb?: unknown; runId?: unknown; agentId?: unknown; workspaceId?: unknown };
  const stops: { id: number; at: string; verb: string; runId: string | null; agentId: string | null; workspaceId: string | null }[] = [];
  let ambiguous = false;
  for (const event of events) {
    const order = ordering(event);
    if (order === 'before') continue;
    let detail: StopDetail | null = null;
    try { detail = JSON.parse(event.detail) as StopDetail; } catch { continue; }
    if (!detail || detail.runId !== run.id) continue;
    // An event that cannot be shown to follow the delivered turn (no anchor and
    // the same timestamp) is ambiguous, never authority.
    if (order === 'ambiguous') { ambiguous = true; continue; }
    if (event.kind === 'owner_stop_uncertain')
      return { kind: 'refused', reason: `The owner stop of the delivered review turn ${delivery.deliveryId} on run ${run.id} is uncertain; inspect the reviewer thread before any further action, and no turn was sent` };
    stops.push({ id: event.id, at: event.at, verb: String(detail.verb ?? ''), runId: String(detail.runId),
      agentId: detail.agentId === undefined || detail.agentId === null ? null : String(detail.agentId),
      workspaceId: detail.workspaceId === undefined || detail.workspaceId === null ? null : String(detail.workspaceId) });
  }
  if (!stops.length && ambiguous)
    return { kind: 'refused', reason: `A stop against run ${run.id} cannot be shown to follow the delivered continuation for ${delivery.deliveryId}: the records order them ambiguously, so no turn was sent` };
  if (!stops.length) return { kind: 'none' };
  const newest = stops.at(-1)!;
  if (newest.verb !== 'stop')
    return { kind: 'refused', reason: `The ${newest.verb || 'recorded'} control displaced work on run ${run.id} after its delivered continuation; only an explicit owner stop of that turn can authorize another one, and no turn was sent` };
  if (newest.agentId !== run.agentId || newest.workspaceId !== run.workspaceId)
    return { kind: 'refused', reason: `The recorded owner stop names ${newest.agentId ?? 'no agent'} in ${newest.workspaceId ?? 'no workspace'}, not the delivered reviewer ${run.agentId ?? 'unknown'} in ${run.workspaceId}; no turn was sent` };
  if (stops.length > 1 && stops.slice(0, -1).some(stop => stop.verb !== 'stop' || stop.agentId !== run.agentId || stop.workspaceId !== run.workspaceId))
    return { kind: 'refused', reason: `Stops recorded against run ${run.id} after its delivered continuation are ambiguous; inspect the reviewer thread, and no turn was sent` };
  return { kind: 'resume', eventId: newest.id, at: newest.at, delivery };
}

/** The stop-backed resume a review run's latest checkpoint currently authorizes, if any. */
export function reviewStopBackedResume(store: Pick<Store, 'eventsAll' | 'run'>, task: Task, run: Run | null): StoppedDeliveryResume {
  const delivered = run ? latestDeliveredReviewTurn(run) : null;
  if (!run || !delivered) return { kind: 'none' };
  return stoppedDeliveryResume(store, task, run, delivered);
}

/**
 * The one durable delivery identity for a checkpoint continuation. The normal
 * continuation keeps its checkpoint-bound identity; a stop-backed resume adds
 * the individual owner-stop occurrence, so replaying one stop reconciles one
 * effect and a new stop is the only way to authorize another.
 */
export function reviewDeliveryId(input: { taskId: string; runId: string; head: string; checkpointOrdinal: number }, resumeStop?: { eventId: number } | null): string {
  const base = `${input.taskId}:${input.runId}:${input.head}:${input.checkpointOrdinal}`;
  return `ns-review-${digest(resumeStop ? `${base}:owner-stop:${resumeStop.eventId}` : base)}`;
}
