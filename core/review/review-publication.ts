import { isDispositionActive, type Completion, type Run, type Task } from '../../shared/contracts';
import { dispatchBlocked } from '../dispatch/capacity';
import type { ResolutionAdapter } from '../resolution';
import type { ParticipantLease } from '../dispatch/participant-lease';
import type { TaskStops } from '../recovery/task-stops';
import type { ReviewerSetting } from '../forge/index';


import { reviewPublicationBody } from './review-body';
import { digest, type Store } from '../store/store';

export interface ReviewPublicationContext {
  readonly store: Store;
  readonly adapter: Pick<Partial<ResolutionAdapter>, 'reconcileReviewPublication'>;
  reviewerSetting(t: Task): ReviewerSetting | null;
  paused(): boolean;
  lease: ParticipantLease['lease'];
  operatorReturn: TaskStops['operatorReturn'];
}

/**
 * Spec 016/033/039: classify the durable `reviewPublication:<run>` effect key
 * with the shared recovery effect-state vocabulary.
 *
 * The key is written before a GitHub side effect as an intent and is retained
 * afterwards as the idempotency record for the settled side effect. A bare
 * `getMeta(...)` truth test therefore cannot answer "is this effect still
 * unresolved": a genuine historical receipt would fence every later control.
 * This module derives the answer from the authenticated store only. It never
 * writes, and never grants approval, control authority or a retry right.
 */
export const reviewPublicationKey = (runId: string) => `reviewPublication:${runId}`;

/** The classification rule version. Bump when the accepted evidence changes. */
export const REVIEW_PUBLICATION_CLASSIFICATION_VERSION = 2;

export type ReviewPublicationKind = 'review' | 'comment';
/**
 * The shared recovery effect state vocabulary (see `recovery-effects.ts`).
 * `superseded` is history, never a blocker: a later reviewer run of the same
 * retained reviewer at the same head applied a verdict with a positive
 * publication ID, so that verdict answers for the exact head and this run's
 * own unknown delivery is never retried or re-published.
 */
export type ReviewPublicationState = 'absent' | 'settled' | 'in-flight' | 'uncertain' | 'invalid' | 'superseded';

/** Bounded owner-facing projection. Carries hashes only, never a credential. */
export type ReviewPublicationClassification = {
  version: number;
  taskId: string;
  runId: string;
  state: ReviewPublicationState;
  reason: string;
  kind: ReviewPublicationKind | null;
  publicationId: number | null;
  head: string | null;
  status: string | null;
  bodyHash: string | null;
  expectedHash: string | null;
  reportDigest: string | null;
  /** The later same-reviewer, same-head run whose applied publication answers for this head. Superseded rows only. */
  supersededBy: { runId: string; publicationId: number } | null;
};

/** The record written beside one run's effect key: the body hash and at most one publication ID. */
export type PublicationRecord = { hash?: unknown; commentId?: unknown; reviewId?: unknown; transientFailure?: boolean };
const HEX64 = /^[0-9a-f]{64}$/;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const ACCEPTED_REVIEW_STATUSES: string[] = ['ready_to_merge', 'changes_required'];

/**
 * Task 704: the durable single-flight claim on one run's publication effect.
 *
 * The first pass to reach GitHub writes the intent inside one store
 * transaction, so the read-then-write is atomic across every connection: two
 * passes, or two processes during a handover, cannot both see "no intent" and
 * both post. `claimed` means this call owns the side effect and must record the
 * publication ID beside the intent once GitHub answers; `settled` means the
 * effect already completed and this caller reuses that ID; `intent` means
 * another pass owns an unresolved delivery, so this caller observes the remote
 * result and never reposts blindly.
 *
 * A record carrying a different findings hash, or a different publication
 * kind, is a real mismatch and still refuses.
 */
export type ReviewPublicationClaim =
  | { kind: 'claimed' }
  | { kind: 'settled'; id: number }
  | { kind: 'intent' };

export function claimReviewPublication(store: Store, runId: string, hash: string, kind: ReviewPublicationKind): ReviewPublicationClaim {
  const claim = (): ReviewPublicationClaim => {
    const key = reviewPublicationKey(runId);
    const value = store.getMeta<unknown>(key);
    if (value === undefined || value === null) {
      store.setMeta(key, { hash }); // Intent before any GitHub side effect.
      return { kind: 'claimed' };
    }
    if (typeof value !== 'object' || Array.isArray(value))
      throw new Error('Retained review publication record is not an object');
    const record = value as PublicationRecord;
    if (record.hash !== hash) throw new Error('This run already has a different review publication');
    const published = kind === 'review' ? record.reviewId : record.commentId;
    const other = kind === 'review' ? record.commentId : record.reviewId;
    if (other !== undefined && other !== null)
      throw new Error('This run already has a different review publication');
    if (published === undefined || published === null) return { kind: 'intent' };
    if (!positive(published))
      throw new Error('Retained review publication record has no positive publication ID');
    return { kind: 'settled', id: published };
  };
  // One connection's own transaction is the caller's; never nest a BEGIN.
  return store.db.isTransaction ? claim() : store.transaction(claim);
}

/** The positive publication ID a retained record names for `kind`, or null. */
export function recordedPublicationId(store: Store, runId: string, kind: ReviewPublicationKind): number | null {
  const record = store.getMeta<unknown>(reviewPublicationKey(runId));
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const value = kind === 'review' ? (record as PublicationRecord).reviewId : (record as PublicationRecord).commentId;
  return positive(value) ? value : null;
}

/**
 * Task 704: retain one run's settled publication. Two reviews carrying this
 * run's marker are the real outcome of a publication race: the earliest is the
 * record, the later one stays on GitHub, and the caller carries the retained ID
 * so the completion and the record agree. The same body hash means there is
 * nothing to refuse; a different hash or a different publication kind is a real
 * mismatch and still throws `Review publication record differs`.
 */
export function retainReviewPublication(store: Store, task: Task, run: Run, completion: Completion,
  reviewer: { login: string } | null, id: number): number {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Review publication did not return a positive ID');
  // A callback that names its own durable publication carries no findings text:
  // Queue published nothing of its own, so there is no body to hash and no
  // retained intent to record — the completion's own ID stays the evidence.
  if (!completion.reviewText) return id;
  const key = reviewPublicationKey(run.id);
  const hash = digest(reviewPublicationBody(task, run, completion.status, completion.reviewText, completion.verdicts ?? []));
  const previous = store.getMeta<unknown>(key);
  if (previous !== undefined && previous !== null) {
    if (typeof previous !== 'object' || Array.isArray(previous))
      throw new Error('Review publication record differs from the authenticated review');
    const record = previous as PublicationRecord;
    if (record.hash !== hash) throw new Error('Review publication record differs from the authenticated review');
    const recorded = reviewer ? record.reviewId : record.commentId;
    if ((reviewer ? record.commentId : record.reviewId) !== undefined && (reviewer ? record.commentId : record.reviewId) !== null)
      throw new Error('Review publication record differs from the authenticated review');
    if (recorded !== undefined && recorded !== null && !positive(recorded))
      throw new Error('Review publication record differs from the authenticated review');
    const retained = typeof recorded === 'number' ? Math.min(recorded, id) : id;
    if (retained !== recorded) store.setMeta(key, reviewer ? { hash, reviewId: retained } : { hash, commentId: retained });
    return retained;
  }
  store.setMeta(key, reviewer ? { hash, reviewId: id } : { hash, commentId: id });
  return id;
}

/** The accepted-callback serializations Queue may have retained for one review. */
function receiptPayloads(completion: Completion): Completion[] {
  return [completion, ...['reviewId', 'reviewCommentId', 'both'].map(field => {
    const copy = { ...completion };
    if (field === 'reviewId' || field === 'both') delete copy.reviewId;
    if (field === 'reviewCommentId' || field === 'both') delete copy.reviewCommentId;
    return copy;
  })];
}

/** The application-marker events a verdict leaves when Queue accepts and applies it. */
const APPLIED_REVIEW_EVENTS = ['review_result_applied', 'review_reapplied'];

/** Whether Queue has applied this reviewer run's verdict. The marker commits with the verdict's state. */
export function reviewVerdictApplied(store: Store, taskId: string, runId: string): boolean {
  return Boolean(store.db.prepare(`SELECT 1 FROM events WHERE taskId=? AND detail=? AND kind IN (${APPLIED_REVIEW_EVENTS.map(() => '?').join(',')}) LIMIT 1`)
    .get(taskId, runId, ...APPLIED_REVIEW_EVENTS));
}

/**
 * The later reviewer run of the same retained reviewer at the same head whose
 * verdict Queue applied and whose retained publication record carries a
 * positive ID, or null. Runs compare by durable creation order (`store.runs`
 * rowid), never by wall-clock strings. That applied verdict answers for the
 * exact head, so the earlier run's uncertain publication is superseded
 * history — never retried or re-published; a differing earlier report stays
 * unapplied history and the applied verdict governs.
 */
function supersedingAppliedPublication(store: Store, task: Task, run: Run): { runId: string; publicationId: number } | null {
  if (run.role !== 'reviewer' || !run.agentId || !run.head) return null;
  const applied = new Set(store.eventsAll(task.id)
    .filter(event => APPLIED_REVIEW_EVENTS.includes(event.kind)).map(event => event.detail));
  if (!applied.size) return null;
  const runs = store.runs(task.id);
  const index = runs.findIndex(item => item.id === run.id);
  if (index < 0) return null;
  for (const later of runs.slice(index + 1)) {
    if (later.role !== 'reviewer' || later.agentId !== run.agentId || later.head !== run.head || !applied.has(later.id)) continue;
    const record = store.getMeta<PublicationRecord>(reviewPublicationKey(later.id));
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    if (positive(record.reviewId)) return { runId: later.id, publicationId: record.reviewId };
    if (positive(record.commentId)) return { runId: later.id, publicationId: record.commentId };
  }
  return null;
}

/**
 * Classify one run's retained publication effect. Reads the store only. The
 * caller decides how a non-`settled`, non-`superseded` answer fences its own
 * control: a `superseded` row is history that blocks nothing and owes no retry.
 */
export function classifyReviewPublication(store: Store, task: Task, run: Run): ReviewPublicationClassification {
  const base = (state: ReviewPublicationState, reason: string,
    extra: Partial<Pick<ReviewPublicationClassification, 'kind' | 'publicationId' | 'status' | 'bodyHash' | 'expectedHash' | 'reportDigest' | 'supersededBy'>> = {}):
    ReviewPublicationClassification => ({
      version: REVIEW_PUBLICATION_CLASSIFICATION_VERSION,
      taskId: task.id, runId: run.id,
      state: state !== 'absent' && state !== 'settled' && task.prHead && run.head && run.head !== task.prHead ? 'superseded' : state,
      reason: state !== 'absent' && state !== 'settled' && task.prHead && run.head && run.head !== task.prHead
        ? 'publication belongs to an earlier PR head' : reason,
      kind: extra.kind ?? null, publicationId: extra.publicationId ?? null,
      head: run.head ?? null, status: extra.status ?? null,
      bodyHash: extra.bodyHash ?? null, expectedHash: extra.expectedHash ?? null, reportDigest: extra.reportDigest ?? null,
      supersededBy: extra.supersededBy ?? null,
    });
  const value = store.getMeta<unknown>(reviewPublicationKey(run.id));
  if (value === undefined || value === null) return base('absent', 'no retained publication intent');
  if (typeof value !== 'object' || Array.isArray(value)) return base('invalid', 'retained publication record is not an object');
  const record = value as PublicationRecord;
  const hasReview = record.reviewId !== undefined && record.reviewId !== null;
  const hasComment = record.commentId !== undefined && record.commentId !== null;
  if (hasReview && hasComment) return base('invalid', 'retained publication record names both a formal review and a comment');
  const kind: ReviewPublicationKind | null = hasReview ? 'review' : hasComment ? 'comment' : null;
  if (!kind) {
    // The live stuck shape (a GitHub outage, then an owner reviewer restart):
    // the intent stayed uncertain while a later run of the same retained
    // reviewer reviewed the exact same head and its verdict was applied with a
    // positive publication ID. That verdict answers for the head; the earlier
    // intent stays on record as superseded history and blocks nothing.
    const supersededBy = supersedingAppliedPublication(store, task, run);
    if (supersededBy) return base('superseded',
      `superseded by reviewer run ${supersededBy.runId}'s applied publication ${supersededBy.publicationId} at the same head`, { supersededBy });
    return base('uncertain', 'retained publication intent has no positive publication ID');
  }
  const publicationId = kind === 'review' ? record.reviewId : record.commentId;
  if (!positive(publicationId)) return base('invalid', 'retained publication ID is not a positive safe integer', { kind });
  if (typeof record.hash !== 'string' || !HEX64.test(record.hash))
    return base('invalid', 'retained publication record has no complete findings hash', { kind, publicationId });
  const shaped = { kind, publicationId };
  if (run.role !== 'reviewer') return base('invalid', 'retained publication record is not on a reviewer run', shaped);
  if (run.taskId !== task.id) return base('invalid', 'retained publication run belongs to another task', shaped);
  const c = run.completion;
  if (!c) {
    if (run.released) {
      const supersededBy = supersedingAppliedPublication(store, task, run);
      if (supersededBy) return base('superseded',
        `superseded by reviewer run ${supersededBy.runId}'s applied publication ${supersededBy.publicationId} at the same head`, { ...shaped, supersededBy });
      return base('uncertain', 'a released run retains a publication intent without an accepted completion', shaped);
    }
    return base('in-flight', 'retained publication intent has no accepted completion yet', shaped);
  }
  if (!run.released || run.status !== 'finished')
    return base('in-flight', 'retained publication run is not finished and released', { ...shaped, status: c.status });
  if (c.taskId !== task.id || c.runId !== run.id || c.head !== run.head)
    return base('invalid', 'accepted completion does not bind this task, run and head', { ...shaped, status: c.status });
  if (!ACCEPTED_REVIEW_STATUSES.includes(c.status))
    return base('invalid', 'accepted completion is not an accepted review verdict', { ...shaped, status: c.status });
  if (!c.reviewText) return base('invalid', 'accepted completion retains no findings text to hash', { ...shaped, status: c.status });
  const acceptedId = kind === 'review' ? c.reviewId : c.reviewCommentId;
  const otherId = kind === 'review' ? c.reviewCommentId : c.reviewId;
  if (otherId !== undefined && otherId !== null)
    return base('invalid', 'accepted completion carries a different publication kind', { ...shaped, status: c.status });
  if (acceptedId !== publicationId)
    return base('invalid', 'accepted completion publication ID does not match the retained record', { ...shaped, status: c.status });
  const receipt = store.db.prepare('SELECT response,hash FROM receipts WHERE id=? AND task=? AND run=?')
    .get(c.eventId, task.id, run.id) as { response?: unknown; hash?: unknown } | undefined;
  let accepted = false;
  try { accepted = JSON.parse(String(receipt?.response)).accepted === true; } catch { accepted = false; }
  if (!receipt || !accepted || typeof receipt.hash !== 'string')
    return base('invalid', 'accepted completion has no authenticated accepted receipt', { ...shaped, status: c.status });
  let expectedHash: string | null = null;
  try { expectedHash = digest(reviewPublicationBody(task, run, c.status, c.reviewText, c.verdicts ?? [])); }
  catch { return base('invalid', 'accepted review body does not carry this run exact protocol marker', { ...shaped, status: c.status }); }
  // The callback receipt hashes the pre-enrichment callback; Queue's later
  // publication enrichment adds the positive ID to the stored completion. Match
  // the same bounded payload variants retained-reviewer proof uses.
  if (!receiptPayloads(c).some(payload => digest(JSON.stringify(payload)) === receipt.hash))
    return base('invalid', 'accepted receipt does not bind this completion', { ...shaped, status: c.status });
  if (expectedHash !== record.hash)
    return base('invalid', 'retained findings hash does not match the accepted review body', { ...shaped, status: c.status, expectedHash });
  return base('settled', `settled ${kind} publication ${publicationId} at ${run.head}`,
    { ...shaped, status: c.status, bodyHash: expectedHash, expectedHash, reportDigest: receipt.hash });
}

/** Formal publication recovery for an unpublished ordinary reviewer verdict. */
export class ReviewPublication {
  constructor(readonly resolution: ReviewPublicationContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  async reconcileReviewPublication(t: Task, runId: string, reason: string, reportingRunId?: string) {
    const run = this.store.run(runId), reviewer = this.resolution.reviewerSetting(t);
    if (!this.adapter.reconcileReviewPublication || !reviewer) throw Error('Formal publication recovery is unavailable');
    if (!run || ['done', 'cancelled'].includes(t.phase) || t.prHead !== run.head || run.taskId !== t.id || run.status !== 'finished' || !run.released || !run.completion || run.completion.reviewId || t.resolution.mergeIntent || t.resolution.mergedCommit || isDispositionActive(t) || t.removedAt)
      throw Error('Only the current released unpublished ordinary reviewer verdict can be reconciled');
    // Unknown delivery is never retried on a superseded record: a later run of
    // the same retained reviewer at the same head already applied its verdict
    // with a positive publication ID, so the earlier intent is history.
    if (classifyReviewPublication(this.store, t, run).state === 'superseded')
      throw Error('Its uncertain publication is superseded by a later applied review at the same head; it stays on record as history');
    const identity = JSON.stringify(run), setting = JSON.stringify(reviewer);
    const allowed = () => {
      const current = this.store.task(t.id);
      return current.version === t.version && !this.resolution.paused() && !dispatchBlocked(current) && !isDispositionActive(current) &&
        JSON.stringify(this.store.run(runId)) === identity && JSON.stringify(this.resolution.reviewerSetting(current)) === setting &&
        !this.store.runs(t.id).some(item => !item.released && item.id !== reportingRunId);
    };
    if (!allowed() || !await this.resolution.lease(t, undefined, reportingRunId) || !allowed()) throw Error('Resolve the retained thread, pause or dispatch fence before publication reconciliation');
    const id = await this.adapter.reconcileReviewPublication(this.store, t, run, reviewer, reason, allowed);
    retainReviewPublication(this.store, t, run, run.completion, reviewer, id);
    if (!await this.resolution.lease(t, undefined, reportingRunId)) throw Error('A retained thread became active during publication reconciliation');
    return this.store.transaction(() => {
      if (!allowed()) throw Error('Task or accepted review changed during publication reconciliation');
      this.store.putRun({ ...run, completion: { ...run.completion!, reviewId: id } });
      this.store.event(t.id, 'review_publication_reconciled', JSON.stringify({runId, head:run.head, reviewId:id, reason}));
      return this.resolution.operatorReturn(t, {attention:false,currentRunId:runId}, {phase:'reviewing',reason:'Original accepted review published; ordinary completion handling resumes'}, 'review_publication_returned', reason);
    });
  }
}
