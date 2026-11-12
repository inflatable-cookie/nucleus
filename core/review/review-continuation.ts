import { REVIEW_CONTINUATION_LIMIT, holdsOf, isDispositionActive, isDispositionComplete, type ReviewCheckpointRecord, type ReviewDeliveryAuthorization, type Run, type Task } from '../../shared/contracts';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digest, now, type Store } from '../store/store';
import { briefDigest, currentBrief } from '../planning/brief';
import { dispatchBlocked } from '../dispatch/capacity';
import { OWNER_STOP_HOLD_PREFIX } from '../merge/merge-hold';
import { taskPrNumber } from '../forge/index';
import { proveReviewRunSource } from './ordinary-review';
import type { AgentObservation } from '../host/adapter';
import { operatorReviewContinuationPrompt } from '../dispatch/prompts';
import type { Adapter } from '../host/adapter';
import type { HostFacade } from '../host/host-facade';
import type { EffectReconcile } from '../recovery/effect-reconcile';
import type { OwnedTools } from '../machine/owned-tool';
import type { ContinuationFences } from '../verbs/verb-fences';


import { reviewerRuntimeChanged } from './reviewer-runtime';
import { matchingInactiveParticipant } from '../intake/run-settlement';
import { ProvenPreSendRefusalError } from '../recovery/task-reasons';

export interface ReviewContinuationContext {
  readonly store: Store;
  readonly adapter: Pick<Adapter, 'verifyPr' | 'verifyPrIdentity' | 'continueReviewer'>;
  /** The task-owner host binding every agent-naming call reads (#1154). */
  onTaskHost: <T>(owner: { hostId?: string | null } | null | undefined, work: () => T) => T;
  readonly host: Pick<HostFacade, 'observe'>;
  paused(): boolean;
  ownedToolHold: OwnedTools['ownedToolHold'];
  settleVerbFences: ContinuationFences['settleContinuationFences'];
  settleReviewDelivery: EffectReconcile['settleReviewDelivery'];
  reconcileReviewDelivery: EffectReconcile['reconcileReviewDelivery'];
  assertReviewProfileIndependent(task: Task, run: Run): void;
  stopResumeState: ReviewContinuations['stopResumeState'];
  reviewContinuationGate: ReviewContinuations['reviewContinuationGate'];
  assertIdleReviewerObservation: ReviewContinuations['assertIdleReviewerObservation'];
  inspectReviewContinuation: ReviewContinuations['inspectReviewContinuation'];
  admitReviewContinuation: ReviewContinuations['admitReviewContinuation'];
  assertReviewCheckpointProvenance: ReviewContinuations['assertReviewCheckpointProvenance'];
}

/** Shared stored-state part of the retained-reader rule. The move additionally observes the agent. */
export function retainedReaderStateDecision(state: ReturnType<typeof reviewContinuationState>): 'unsettled' | 'exhausted' | 'closed' | 'awaiting' | 'reading' {
  if (state === 'reserved' || state === 'uncertain') return 'unsettled';
  if (state === 'exhausted' || state === 'closed' || state === 'awaiting') return state;
  return 'reading';
}

/** Whether a retained reviewer remains bound when a move starts a new review. */
export function keepRetainedReviewer(freshAsked: boolean, retainedClosed: boolean, retainedUnavailable: boolean): boolean {
  return !freshAsked && !retainedClosed && !retainedUnavailable;
}

/** The per-task reviewer checkpoint allowance, a Queue setting with a fixed default. */
export function reviewContinuationLimit(store: Pick<Store, 'getMeta'>): number {
  const value = store.getMeta<number>('reviewContinuationLimit');
  return Number.isInteger(value) && (value as number) > 0 ? value as number : REVIEW_CONTINUATION_LIMIT;
}

/** Owner-only per-run directory under the Queue data directory for review checkpoints. */
export const reviewCheckpointRoot = (dataDir: string, taskId: string, runId: string) => join(dataDir, 'review-checkpoints', digest(taskId), runId);
export const reviewCheckpointPath = (dataDir: string, taskId: string, runId: string, ordinal: number) => join(reviewCheckpointRoot(dataDir, taskId, runId), `checkpoint-${ordinal}.json`);
/** The Queue data directory that owns review checkpoints; a memory store has no durable directory. */
export function reviewCheckpointDataDir(store: Pick<Store, 'path'>): string | null {
  return store.path === ':memory:' ? null : dirname(store.path);
}
/** The stable path recorded with an accepted checkpoint, independent of later delivery. */
export function reviewCheckpointPathFor(store: Pick<Store, 'path'>, taskId: string, runId: string, ordinal: number): string {
  // Recorded checkpoints accepted before the rename may sit in the old folder.
  const dataDir = reviewCheckpointDataDir(store) ?? join('.northstar-queue-review-checkpoints');
  return reviewCheckpointPath(dataDir, taskId, runId, ordinal);
}

export const REVIEW_BUDGET_EXHAUSTED = 'The reviewer spent its checkpoint budget and stopped; the project planner decides through the blocker ladder (Spec 058), and restart role=reviewer fresh replaces the retained reviewer deliberately at the same head (move to=review preserves the reader it can continue, so it refuses this one).';
export const REVIEW_AUTHORIZATION_REQUIRED = 'The reviewer saved a checkpoint; Queue continues the same reviewer from it once its turn ends. Checkpoints are preserved, not approval.';
/**
 * The reviewer's own agent was positively observed closed with its checkpoint
 * preserved. A closed Paseo session cannot receive a same-run continuation, so
 * the supported recovery is the existing fresh-review paths; the lease, the
 * checkpoints and the eventual verdict stay with the original run.
 */
export const REVIEW_AGENT_CLOSED = 'The reviewer\'s agent was observed closed in its workspace with the checkpoint preserved; the same-agent continuation is impossible. The project planner decides through the blocker ladder (Spec 058), and restart role=reviewer fresh replaces the retained reviewer deliberately at the same head (move to=review preserves the reader it can continue, so it refuses this one).';
/**
 * The reviewer's own agent was observed errored with no active turn and no
 * pending permission. A dead provider session cannot receive a same-run
 * continuation, like a closed one, so it takes the same fresh-review exit
 * with its own reason.
 */
export const REVIEW_AGENT_ERRORED = 'The reviewer\'s agent was observed errored in its workspace with no active turn and no pending permission; the same-agent continuation is impossible. The project planner decides through the blocker ladder (Spec 058), and restart role=reviewer fresh replaces the retained reviewer deliberately at the same head (move to=review preserves the reader it can continue, so it refuses this one).';
/** The exits named when a delivered review turn cannot be resumed from the recorded facts. */
export const REVIEW_FRESH_REPLACEMENT_EXIT = 'restart role=reviewer fresh replaces the retained reviewer deliberately at the same head; route role=reviewer with now does the same through the stop path';

/** Persist the progress receipt's owner-only file, without creating a delivery intent. */
export function writeReviewCheckpoint(store: Pick<Store, 'path'>, taskId: string, record: ReviewCheckpointRecord) {
  const dataDir = reviewCheckpointDataDir(store);
  if (!dataDir) return;
  const root = reviewCheckpointRoot(dataDir, taskId, record.runId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(record.path, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
}

/** Read, but never rewrite, an exact owner-only checkpoint before operator delivery. */
export function readReviewCheckpoint(store: Pick<Store, 'path'>, taskId: string, record: ReviewCheckpointRecord): ReviewCheckpointRecord {
  const dataDir = reviewCheckpointDataDir(store);
  if (!dataDir) throw new Error('Reviewer checkpoint delivery requires durable Nucleus storage');
  const expected = reviewCheckpointPath(dataDir, taskId, record.runId, record.ordinal);
  if (record.path !== expected) throw new Error('Reviewer checkpoint path does not match its task/run/ordinal identity');
  const stat = statSync(expected);
  if ((stat.mode & 0o077) !== 0) throw new Error('Reviewer checkpoint file permissions are not owner-only');
  const stored = JSON.parse(readFileSync(expected, 'utf8')) as unknown;
  if (!isDeepStrictEqual(stored, record)) throw new Error('Reviewer checkpoint file differs from its authenticated stored record');
  return record;
}

/**
 * The one exact authenticated reviewer-progress checkpoint proof. A stored
 * `reviewCheckpoints` entry is never evidence by itself: this re-reads the
 * owner-only file, the accepted receipt that hashed the recorded callback, its
 * ordinal and progress digest, and the checkpoint's own run/head/brief binding.
 * Returns a precise refusal, or null when the record is authentic for this
 * task and run. Shared by the recovery-effect creation projection, checkpoint
 * retirement and the bounded external-owner recheck, so every gate reads the
 * same proof.
 */
export function reviewCheckpointRefusal(store: Store, task: Task, run: Run, record: ReviewCheckpointRecord): string | null {
  if (record.runId !== run.id) return `checkpoint ${record.ordinal} belongs to run ${record.runId}, not ${run.id}`;
  if (record.head !== run.head) return `checkpoint ${record.ordinal} is at head ${record.head.slice(0, 12)}, not the run head ${run.head.slice(0, 12)}`;
  if (!record.eventId || !record.callbackDigest || !record.checkpointDigest)
    return `checkpoint ${record.ordinal} lacks authenticated callback receipt provenance`;
  try { readReviewCheckpoint(store, task.id, record); }
  catch (error) { return `checkpoint ${record.ordinal} owner-only file is not provable (${error instanceof Error ? error.message : String(error)})`; }
  const row = store.db.prepare('SELECT task,run,hash,response FROM receipts WHERE id=?').get(record.eventId) as
    { task?: string; run?: string; hash?: string; response?: string } | undefined;
  if (!row || row.task !== task.id || row.run !== run.id || row.hash !== record.callbackDigest)
    return `checkpoint ${record.ordinal} callback receipt does not match its task/run identity`;
  let response: { accepted?: unknown; eventId?: unknown; checkpoint?: { ordinal?: unknown; continued?: unknown; checkpointDigest?: unknown } };
  try { response = JSON.parse(String(row.response)); }
  catch { return `checkpoint ${record.ordinal} callback receipt is unreadable`; }
  if (response.accepted !== true || response.eventId !== record.eventId || response.checkpoint?.ordinal !== record.ordinal
    || response.checkpoint.continued !== false || response.checkpoint.checkpointDigest !== record.checkpointDigest
    || digest(JSON.stringify(record.checkpoint)) !== record.checkpointDigest)
    return `checkpoint ${record.ordinal} receipt is not an accepted reviewer progress callback`;
  // The checkpoint's brief is the brief its run held, proved by the task's own
  // stored version: a contradictory version or digest is not evidence.
  const version = record.briefVersion ?? null;
  if (version !== null) {
    const stored = task.briefVersions.find(candidate => candidate.version === version);
    if (!stored || record.briefDigest !== briefDigest(stored.text))
      return `checkpoint ${record.ordinal} brief v${version} does not match the task's stored brief`;
  } else if (record.briefDigest != null) return `checkpoint ${record.ordinal} carries a brief digest without a version`;
  return null;
}

/** Old publication continuations and unfinished reviewer checkpoints cannot auto-resume.
 * The wait is derived from a current, unreleased reviewer run (nucleus#1106): a
 * superseded or released named run cannot be continued, so a recorded cause alone
 * never holds the authorization and the task proceeds to its next step. */
export function reviewAuthorizationRequired(task: Task, store: Pick<Store, 'run'>): boolean {
  const run = task.resolution.currentRunId ? store.run(task.resolution.currentRunId) : null;
  // A result ends checkpoint reading, including tasks carrying an older
  // publication-continuation cause. Ordinary intake owns release and application.
  if (run?.role === 'reviewer' && run.completion) return false;
  if (task.resolution.pendingRevisionCause === 'continuation' && !reviewInProgress(run)) return false;
  return reviewInProgress(run) || Boolean(run && run.role === 'revision' && run.revisionCause === 'continuation' && !run.completion && !run.released);
}

/**
 * Where the current reviewer checkpoint stands: `awaiting` a continuation,
 * `reserved` (Queue is sending one), `continuing` (one was delivered for this
 * checkpoint and the reviewer is working), `uncertain` (a send's outcome is
 * unknown), `exhausted` (the budget is spent) or `closed` (the run's own agent
 * was positively observed closed, so no same-run continuation can land). Null
 * when no reviewer checkpoint is current, for example the older
 * publication-continuation revision fence.
 */
export function reviewContinuationState(task: Task, store: Pick<Store, 'run'>): 'awaiting' | 'reserved' | 'continuing' | 'uncertain' | 'exhausted' | 'closed' | null {
  const run = task.resolution.currentRunId ? store.run(task.resolution.currentRunId) : null;
  if (!reviewInProgress(run) || !run) return null;
  // A checkpoint rejected past the budget leaves the reviewer stopped, whatever its last delivery said.
  if (run.reviewBudgetExhaustedAt) return 'exhausted';
  // A positively closed agent can never receive the retained-run continuation.
  if (run.retainedAgentClosedAt) return 'closed';
  const ordinal = run.reviewCheckpoints?.at(-1)?.ordinal;
  if (ordinal === undefined) return null;
  const status = run.reviewDeliveries?.findLast(item => item.checkpointOrdinal === ordinal && item.status !== 'refused')?.status;
  return status === 'delivered' ? 'continuing' : status === 'reserved' || status === 'uncertain' ? status : 'awaiting';
}

/** The task reason while a continuation send is reserved or uncertain; one text for every writer. */
export const reviewDeliveryReason = (deliveryId: string, status: 'reserved' | 'uncertain') =>
  status === 'reserved'
    ? `Reviewer continuation ${deliveryId} is reserved; awaiting the same-run send result`
    : `Reviewer delivery ${deliveryId} is uncertain; inspect the same reviewer thread before any further action`;

/**
 * The wait a checkpointed review records. A delivered or reserved continuation
 * is the reviewer or Queue at work, and so is an awaiting checkpoint: Queue
 * continues it by itself (Tom, 2026-10-31). An uncertain send needs a person to
 * inspect it.
 */
export function reviewContinuationWait(task: Task, store: Pick<Store, 'run' | 'eventsAll'>): { reason: string; stop: 'lifecycle' | 'operator_needed' } {
  const run = task.resolution.currentRunId ? store.run(task.resolution.currentRunId) : null;
  const state = reviewContinuationState(task, store);
  const delivery = run?.reviewDeliveries?.findLast(item => item.checkpointOrdinal === run.reviewCheckpoints?.at(-1)?.ordinal && item.status !== 'refused');
  if (state === 'continuing') {
    // Saved inactivity only describes this delivered turn after a matching
    // observation started later than its delivery was proven. Pre-send idle
    // state and an observation concurrent with delivery prove no stop.
    const observed = run?.active === false && run.lastObservedAt != null && delivery?.observedAt != null
      && Date.parse(run.lastObservedAt) > Date.parse(delivery.observedAt);
    if (!observed) return { reason: `Reviewer continuing from checkpoint ${delivery!.checkpointOrdinal}`, stop: 'lifecycle' };
    // Tom, 2026-10-27: a positively confirmed owner stop of that delivered turn
    // is the one thing that lets the same reader continue it once, through the
    // ordinary retained restart. Say that instead of only naming replacement.
    const stopped = run && delivery ? stoppedDeliveryResume(store, task, run, delivery) : { kind: 'none' as const };
    if (stopped.kind === 'resume')
      return { reason: `The reviewer's delivered continuation for checkpoint ${delivery!.checkpointOrdinal} on run ${run!.id} (agent ${run!.agentId}) was stopped by the owner at ${stopped.at} and has no verdict or new checkpoint; restart role=reviewer resumes that one turn on the same reader, and ${REVIEW_FRESH_REPLACEMENT_EXIT}`, stop: 'operator_needed' };
    if (stopped.kind === 'refused') return { reason: stopped.reason, stop: 'operator_needed' };
    return { reason: `The reviewer's delivered continuation for checkpoint ${delivery!.checkpointOrdinal} on run ${run!.id} (agent ${run!.agentId}) stopped without a verdict or a new checkpoint; route the reviewer to an available profile or start a fresh reviewer at the same head`, stop: 'operator_needed' };
  }
  if (state === 'reserved') return { reason: reviewDeliveryReason(delivery!.deliveryId, 'reserved'), stop: 'lifecycle' };
  if (state === 'uncertain') return { reason: reviewDeliveryReason(delivery!.deliveryId, 'uncertain'), stop: 'operator_needed' };
  if (state === 'awaiting') return { reason: REVIEW_AUTHORIZATION_REQUIRED, stop: 'lifecycle' };
  if (state === 'exhausted') return { reason: REVIEW_BUDGET_EXHAUSTED, stop: 'operator_needed' };
  if (state === 'closed') return { reason: `${REVIEW_AGENT_CLOSED} (run ${run!.id}, agent ${run!.agentId}, checkpoint ${run!.reviewCheckpoints?.at(-1)?.ordinal ?? 'none'} at ${run!.head})`, stop: 'operator_needed' };
  // No checkpoint continuation stands on the named run (nucleus#1106): a
  // superseded or released named run cannot be continued, so this states the
  // facts instead of claiming a continuation that can never happen.
  return { reason: run
    ? `Reviewer run ${run.id} is ${run.released ? `released (${run.status})` : 'current'} with no checkpoint continuation to deliver; the task proceeds to its next step`
    : 'No current reviewer run holds a checkpoint continuation; the task proceeds to its next step', stop: 'lifecycle' };
}

/** True when a task's current reviewer run holds a durable progress checkpoint. */
export function reviewInProgress(run: Run | null): boolean {
  return Boolean(run && run.role === 'reviewer' && !run.completion && !run.released && (run.reviewCheckpoints?.length ?? 0) > 0);
}

/**
 * What the task's current reviewer run is at one exact head, resolved once from
 * current facts: `absent` (no unfinished current reviewer, or one that belongs to
 * another source head), `valid` (the recorded reviewer, at this head, with its
 * source and participant binding proved), or `refused` (an existing unfinished
 * reviewer whose binding cannot be proved). `refused` is never read as `absent`:
 * an unprovable binding must not silently send the caller down the fresh-review
 * fallback and abandon the retained reader's coverage (Tom, 2026-10-27; review
 * 5673604194). The same derivation feeds the `move to=review` view and its
 * applying control.
 */
export type ReviewerIdentity =
  | { kind: 'absent' }
  | { kind: 'valid'; run: Run }
  | { kind: 'refused'; run: Run; refusal: string };

export function reviewerIdentityAtHead(task: Task, store: Pick<Store, 'run'>, head: string): ReviewerIdentity {
  const run = task.resolution.currentRunId ? store.run(task.resolution.currentRunId) : null;
  if (!run || run.taskId !== task.id || run.role !== 'reviewer' || run.released || run.completion) return { kind: 'absent' };
  // A reader that is not at this head belongs to another source state: moving to
  // review at this head is the deliberate fresh review of a changed source.
  if (!task.prHead || task.prHead !== head || run.head !== head) return { kind: 'absent' };
  if (!run.agentId || task.resolution.reviewerAgentId !== run.agentId)
    return { kind: 'refused', run, refusal: `the task records reviewer agent ${task.resolution.reviewerAgentId ?? 'none'}, not the current reviewer run ${run.id} (agent ${run.agentId ?? 'unknown'}), so the participant identity cannot be proven and Nucleus cannot tell which reviewer is reading; it does not replace that reader — restart role=reviewer fresh or route role=reviewer with now replaces it deliberately` };
  if (task.workspaceId !== run.workspaceId)
    return { kind: 'refused', run, refusal: `the retained reviewer ${run.id} is bound to workspace ${run.workspaceId}, which its recorded source no longer names; Nucleus does not replace a retained reader it cannot prove — restart role=reviewer fresh or route role=reviewer with now replaces it deliberately` };
  return { kind: 'valid', run };
}

/** The proven current reviewer at this head, or null. */
export function currentReviewerAtHead(task: Task, store: Pick<Store, 'run'>, head: string): Run | null {
  const identity = reviewerIdentityAtHead(task, store, head);
  return identity.kind === 'valid' ? identity.run : null;
}

/** The same reader once it holds durable, continuable review coverage. */
export function retainedReviewerAtHead(task: Task, store: Pick<Store, 'run'>, head: string): Run | null {
  const run = currentReviewerAtHead(task, store, head);
  return run && reviewInProgress(run) ? run : null;
}

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

export type { ReviewCheckpointRecord, ReviewDeliveryAuthorization };

/** Whether the review fence keeps coordinators away. An awaiting checkpoint is Queue's to continue, not a coordinator's. */
export function reviewFenceHoldsCoordinators(task: Task, store: Pick<Store, 'run'>): boolean {
  return task.resolution.stop?.reason === 'awaiting_proof' || reviewAuthorizationRequired(task, store);
}


/**
 * Whether the task's recorded review result fences this reviewer run's
 * checkpoint continuation. It does unless lifecycle evidence proves the result
 * ended an earlier round: the result is a `changes_required` whose task, run,
 * event, status and head all match one released reviewer run of this task and
 * that run's recorded completion; that run was created before this run, at a
 * different head; and an accepted (`ready_for_review`) author result arrived
 * after it and before this run. The author result is either a released
 * revision run bound to itself and this task, or the current worker's own
 * initial result (a replacement worker's, which has no Run record): bound to the
 * task's run, authenticated by its receipt, and received in that window. That
 * changes_required → author result → new review sequence is the only history
 * exception; anything unprovable, contradictory or out of order fences.
 */
export function reviewResultFencesRun(store: Store, task: Task, run: Run): boolean {
  const review = task.resolution.review;
  if (!review) return false;
  if (review.status !== 'changes_required' || review.taskId !== task.id || !review.runId || review.runId === run.id || !review.head) return true;
  const source = store.run(review.runId);
  const completion = source?.completion;
  if (!source || !completion || source.taskId !== task.id || source.role !== 'reviewer' || !source.released) return true;
  if (completion.runId !== source.id || completion.taskId !== task.id || completion.eventId !== review.eventId
    || completion.status !== review.status || (completion.head ?? null) !== review.head || source.head !== review.head) return true;
  if (review.head === run.head || source.createdAt >= run.createdAt) return true;
  const revised = store.runs(task.id).some(item => item.role === 'revision' && item.released && item.taskId === task.id
    && item.completion?.status === 'ready_for_review' && item.completion.runId === item.id && item.completion.taskId === task.id
    && item.createdAt > source.createdAt && item.createdAt < run.createdAt);
  return !revised && !initialAuthorResultBetween(store, task, source.createdAt, run.createdAt);
}

/**
 * The current worker's own receipted initial `ready_for_review`, from a worker
 * run created inside (after, before). Timing binds to that exact run: its
 * `agent_intent` event (detail = the run ID, written with `task.runId`) must
 * exist and every one of them must fall inside the window. A worker result is
 * accepted only in a worker phase, so after that intent and before any reviewer
 * run on it. A task-wide `completion_received` event names no run and is not used.
 */
function initialAuthorResultBetween(store: Store, task: Task, after: string, before: string): boolean {
  const completion = task.completion;
  if (!completion || completion.status !== 'ready_for_review' || completion.taskId !== task.id || !task.runId || completion.runId !== task.runId) return false;
  if (store.run(completion.runId)) return false;
  const receipt = store.db.prepare('SELECT hash FROM receipts WHERE id=? AND task=? AND run=?').get(completion.eventId, task.id, completion.runId) as { hash: string } | undefined;
  if (!receipt || receipt.hash !== digest(JSON.stringify(completion))) return false;
  const intents = store.db.prepare("SELECT at FROM events WHERE taskId=? AND kind='agent_intent' AND detail=?").all(task.id, completion.runId) as { at: string }[];
  return intents.length > 0 && intents.every(intent => intent.at > after && intent.at < before);
}

/**
 * The reviewer-continuation gate's locally observable checks, shared by the
 * gate and `next`, so the view never advertises a continuation the gate
 * refuses. Execution adds the version check, checkpoint provenance (through
 * `provenance`) and reviewer-profile independence. Returns the first refusal
 * in the gate's own order, or the latest checkpoint and current brief.
 */
export function reviewContinuationLocalRefusal(store: Store, task: Task, run: Run | null, input: { runId: string; head: string; checkpointOrdinal: number },
  options: { settling?: { runIds: string[] }; paused: boolean; operationId?: string; provenance?: (task: Task, record: ReviewCheckpointRecord) => void; ownerStopYields?: boolean }):
  { refusal: string } | { record: ReviewCheckpointRecord; briefVersion: ReturnType<typeof currentBrief>; resumeStop?: { eventId: number; at: string } } {
  const refuse = (refusal: string) => ({ refusal });
  // Round 4: the owner's own stop hold yields to the owner's own restart.
  const stopHoldYields = options.ownerStopYields === true && Boolean(holdsOf(task).dispatch?.reason.startsWith(OWNER_STOP_HOLD_PREFIX));
  if (task.phase !== 'reviewing' || isDispositionActive(task) || isDispositionComplete(task) || (dispatchBlocked(task) && !stopHoldYields))
    return refuse('Reviewer continuation requires an ordinary reviewing task without pause, dispatch or disposition fences');
  // A recorded creation-delivery outcome can stay `uncertain` after the bound
  // reader demonstrably started: the authenticated checkpoint read below is that
  // same run's own callback, so it proves the creation occurrence reached this
  // exact reader. The continuation authorized here is a *distinct, later*
  // occurrence, never a replay of the creation. An uncertain run with no
  // authenticated checkpoint still sends nothing: its creation is unknown, not
  // absent (Spec 017).
  const knownCreation = run?.status === 'running' || (run?.status === 'uncertain' && (run.reviewCheckpoints?.length ?? 0) > 0);
  if (task.resolution.currentRunId !== input.runId || !run || run.taskId !== task.id || run.role !== 'reviewer' || !knownCreation || run.released || run.completion)
    return refuse('The current reviewer run is completed, released, replaced or unavailable');
  // Both established causes of an impossible retained-agent continuation use the
  // same existing recovery: a fresh reviewer at the same exact head. Refuse the
  // same-run continuation itself, whatever the live observation would say.
  if (run.reviewBudgetExhaustedAt) return refuse(REVIEW_BUDGET_EXHAUSTED);
  if (run.retainedAgentClosedAt) return refuse(REVIEW_AGENT_CLOSED);
  if (reviewResultFencesRun(store, task, run)) return refuse('A reviewer result already exists; checkpoints cannot authorize another review turn');
  // A reader is bound to its own recorded run workspace, which the pre-send
  // observation then proves is still the agent's workspace. A task-workspace
  // substitution is never read into that binding.
  const boundWorkspace = run.workspaceId;
  if (!task.workspaceId || !task.directory || !run.agentId || !boundWorkspace || run.workspaceId !== boundWorkspace || task.resolution.reviewerAgentId !== run.agentId)
    return refuse('Original reviewer agent/workspace identity changed');
  if (!task.prUrl || !task.prHead || task.prHead !== run.head || input.head !== run.head)
    return refuse('Reviewer continuation must remain on the exact recorded PR head');
  // With a settlement armed, the episode fences it will retire (attention,
  // recovery, incident) do not refuse here: the calling verb settles them in
  // the same transaction as its action, so a refused action changes nothing.
  // A stalled-turn stop is not settled by that helper and still fences.
  if (task.resolution.attention || task.resolution.recoveryActive || task.resolution.recovery && task.resolution.recovery.status !== 'resolved' ||
      task.resolution.incident && task.resolution.incident.status !== 'resolved') {
    if (!options.settling) return refuse('An unresolved task incident or recovery fence blocks reviewer continuation');
  }
  if (task.resolution.stalledTurnStop && task.resolution.stalledTurnStop.status !== 'completed')
    return refuse('An unresolved task incident or recovery fence blocks reviewer continuation');
  const settledRuns = options.settling?.runIds ?? [];
  const fencing = store.runs(task.id).filter(item => !item.released && !settledRuns.includes(item.id));
  if (fencing.length !== 1 || fencing[0]!.id !== run.id) return refuse('Another unreleased run or changed run identity fences reviewer continuation');
  const checkpoints = run.reviewCheckpoints ?? [];
  const record = checkpoints.at(-1);
  if (!record || record.ordinal !== input.checkpointOrdinal || record.ordinal !== checkpoints.length || record.runId !== run.id || record.head !== input.head)
    return refuse('The requested checkpoint is stale; only the latest authenticated checkpoint can be continued');
  // A checkpoint whose continuation was already delivered has had its turn: the
  // same intent only replays the recorded delivery and a changed one is refused,
  // so re-sending is never an available action. Name the real exits instead of
  // advertising a continuation nothing can send (review 5668722168 follow-up;
  // project-c #155 checkpoint 3 at 889a6d0).
  //
  // Tom, 2026-10-27: one positively confirmed OWNER STOP of that delivered turn
  // authorizes one new continuation effect on the same reader. The evidence is
  // the individual immutable stop occurrence, never an idle observation and
  // never a `move`/`route` displacement, and the delivery identity carries its
  // event id so a replay reconciles the same effect instead of sending again.
  const delivered = (run.reviewDeliveries ?? []).findLast(item => item.checkpointOrdinal === record.ordinal
    && (item.head ?? run.head) === run.head && item.status === 'delivered');
  let resumeStop: { eventId: number; at: string } | undefined;
  if (delivered) {
    const stopped = stoppedDeliveryResume(store, task, run, delivered);
    if (stopped.kind === 'refused') return refuse(stopped.reason);
    if (stopped.kind === 'none')
      return refuse(`Checkpoint ${record.ordinal} on run ${run.id} already has its delivered continuation (${delivered.deliveryId}); no second turn is sent for it. If it is still reading, wait for its verdict or next checkpoint. If that turn stopped without a verdict, an owner stop of it is what authorizes one resumed continuation on the same reader; route role=reviewer with now replaces the reviewer deliberately, and restart role=reviewer fresh starts a fresh reader at the same head (move to=review preserves the reader it can continue, so it sends nothing here)`);
    resumeStop = { eventId: stopped.eventId, at: stopped.at };
  }
  options.provenance?.(task, record);
  if (run.reviewContinuation && run.reviewContinuation.status !== 'delivered') return refuse('A legacy continuation intent is retained; it cannot authorize a new reviewer delivery');
  // A stale external-merge pre-attention record is part of the fence set the
  // settling verb retires in its own transaction (Spec 050), so an armed
  // settlement tolerates it here; every other merge, publication and
  // validation intent still refuses.
  const externalMergePreAttention = options.settling ? null : task.resolution.externalMergePreAttention;
  if (task.resolution.mergeIntent || task.resolution.mergeHead || task.resolution.mergedCommit || task.resolution.externalMerge || externalMergePreAttention || task.resolution.integrationTurn ||
      task.resolution.mergeResponseOutcome === 'uncertain' || task.resolution.mergeRetryOutcome === 'uncertain' ||
      task.resolution.projectValidation && task.resolution.projectValidation.state !== 'passed' || task.resolution.pendingRevisionCause === 'continuation' ||
      store.getMeta(`reviewPublication:${run.id}`))
    return refuse('Merge, publication or validation intent blocks reviewer continuation');
  const unsettledOperations = store.operations({ taskId: task.id, states: ['pending', 'running', 'needs_attention'], limit: 1000 }).filter(item => item.id !== options.operationId);
  if (unsettledOperations.length) return refuse('Another unresolved task operation fences reviewer continuation');
  if (store.hookEvents(task.id).some(hook => !['result', 'published'].includes(hook.state) || hook.result?.outcome !== 'ok'))
    return refuse('An unresolved repository effect fences reviewer continuation');
  // A brief amended after the checkpoint does not strand the reviewer (Tom,
  // 2026-10-18): the continuation delivers the current brief and re-pins the
  // run to it, so the eventual verdict is bound to the brief it read. An
  // amendment always adds a version; the same version with other text is not one.
  const briefVersion = currentBrief(task), pinned = record.briefVersion ?? null;
  const unchanged = pinned === (briefVersion?.version ?? null) && (record.briefDigest ?? null) === (briefVersion ? briefDigest(briefVersion.text) : null);
  const amended = pinned !== null && briefVersion !== null && briefVersion.version > pinned;
  if (!unchanged && !amended) return refuse('The Nucleus-held brief changed without an amendment after this reviewer checkpoint');
  // Tom, 2026-10-27: continuing an amended brief is the ordinary
  // awaiting-checkpoint authority, and it cannot stretch across a stop. A
  // stop-backed resume is a new effect on a turn that already read one brief, so
  // it is bound to *that delivery's* brief: a further amendment would deliver
  // text the stopped turn never read and silently change the work the owner
  // authorized. The deliberate exit is the fresh reviewer.
  if (resumeStop) {
    const deliveryBrief = delivered!.briefVersion ?? null;
    const deliveryDigest = delivered!.briefDigest ?? null;
    const currentVersion = briefVersion?.version ?? null;
    const currentDigest = briefVersion ? briefDigest(briefVersion.text) : null;
    if (deliveryBrief !== currentVersion || deliveryDigest !== currentDigest)
      return refuse(`The Nucleus-held brief changed after the delivered continuation for checkpoint ${record.ordinal} on run ${run.id} was stopped (that turn read brief ${deliveryBrief ?? 'none'}); a stop-backed resume is bound to the brief it read, so restore that brief or replace the reader with restart role=reviewer fresh`);
  }
  return { record, briefVersion, ...(resumeStop ? { resumeStop } : {}) };
}

/** One authorized reviewer turn. Same-name `Resolution` methods delegate here. */
export class ReviewContinuations {
  constructor(readonly resolution: ReviewContinuationContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }

  /** The current reviewer run when it holds a durable progress checkpoint; null otherwise. */
  reviewContinuationOwner(t: Task): Run | null {
    const run = t.resolution.currentRunId ? this.store.run(t.resolution.currentRunId) : null;
    return reviewInProgress(run) ? run : null;
  }

  /**
   * The stop-backed resume the latest checkpoint of one run currently
   * authorizes, when the caller's checkpoint is that latest one. The identity is
   * derived here, never supplied by a caller.
   */
  stopResumeState(input: { taskId: string; runId: string; checkpointOrdinal: number }): StoppedDeliveryResume {
    const initialRun = this.store.run(input.runId);
    const delivered = initialRun ? latestDeliveredReviewTurn(initialRun) : null;
    if (!initialRun || !delivered || delivered.checkpointOrdinal !== input.checkpointOrdinal) return { kind: 'none' };
    return stoppedDeliveryResume(this.store, this.store.task(input.taskId), initialRun, delivered);
  }

  async inspectReviewContinuation(input: { taskId: string; version: number; runId: string; head: string; checkpointOrdinal: number; reason: string; instruction: string }, operationId: string): Promise<Task | null> {
    if (!operationId) throw new Error('Reviewer continuation requires its durable operation identity');
    const initialRun = this.store.run(input.runId);
    // An unproven or ambiguous stop is inspect-only, with its own reason: it is
    // never silently treated as "no stop" and replaced by the spent delivery.
    const stopped = this.resolution.stopResumeState(input);
    if (stopped.kind === 'refused') throw new Error(stopped.reason);
    const resumeStop = stopped.kind === 'resume' ? { eventId: stopped.eventId, at: stopped.at } : null;
    // A recorded stop-backed delivery keeps its own identity after the turn it
    // resumed: the stop occurrence is no longer "after the latest delivery", so
    // a replay of the same intent is found by the stop occurrence it recorded
    // rather than by the plain checkpoint identity.
    //
    // Only that stop occurrence's own delivery can be its replay (Tom,
    // 2026-10-27). The historical stop that produced an earlier resumed delivery
    // belongs to that earlier effect: a second, later stop must reserve its own
    // new continuation, never reconcile the first one.
    const stopOccurrences = initialRun && !resumeStop ? reviewStopOccurrences(this.store, this.store.task(input.taskId), initialRun) : [];
    // Newest first: the most recent stop occurrence is the one whose recorded
    // delivery (if any) is this intent's replay.
    const candidates = (resumeStop ? [resumeStop] : [...stopOccurrences].reverse());
    const recorded = candidates.map(stop => ({ stop, delivery: initialRun?.reviewDeliveries?.find(item =>
      item.checkpointOrdinal === input.checkpointOrdinal && item.deliveryId === reviewDeliveryId(input, stop)) }))
      .find(entry => entry.delivery);
    const record = recorded?.delivery;
    // A new stop occurrence is its own authorization: only the delivery it already
    // recorded can be its replay. The plain checkpoint delivery is the *previous*
    // turn, not this intent.
    const prior = record ?? (resumeStop ? undefined : initialRun?.reviewDeliveries?.find(item => item.deliveryId === reviewDeliveryId(input)));
    const recordedStop = recorded?.stop ?? resumeStop;
    const deliveryId = prior?.deliveryId ?? reviewDeliveryId(input, resumeStop);
    const authorizationId = reviewAuthorizationId(input, recordedStop);
    if (prior) {
      if (prior.status === 'refused') {
        if (input.version !== this.store.task(input.taskId).version)
          throw new Error('Task version is stale after a proven pre-send refusal; refresh task detail before a fresh operator authorization');
      } else {
        if (prior.authorizationId !== authorizationId) throw new Error(prior.status === 'delivered'
          ? `Checkpoint ${prior.checkpointOrdinal} on run ${input.runId} already has its delivered continuation (${prior.deliveryId}); no second turn is sent for it. Route the reviewer to a profile with capacity (route role=reviewer, with now to replace the run) or start a fresh reviewer at the same head (restart role=reviewer fresh)`
          : 'This checkpoint already has a different durable operator authorization; no second delivery is allowed');
        if (prior.operationId !== operationId && input.version !== this.store.task(input.taskId).version)
          throw new Error('Task version is stale for same-intent delivery inspection; refresh task detail');
        // Same-intent inspection: never resends; a delivered record may still gain its brief pin from timeline proof.
        const reconciled = await this.resolution.reconcileReviewDelivery(initialRun!, prior);
        if (reconciled.status === 'delivered') return this.store.task(input.taskId);
        throw new Error(`Reviewer delivery ${deliveryId} remains uncertain; the durable hold is retained and no resend occurred`);
      }
    }

    // A previous checkpoint's unknown send must be reconciled before another
    // authorization can be reserved, even if the reviewer later checkpointed.
    const unresolved = initialRun?.reviewDeliveries?.findLast(item => item.status === 'reserved' || item.status === 'uncertain');
    if (unresolved) {
      const reconciled = await this.resolution.reconcileReviewDelivery(initialRun!, unresolved);
      if (reconciled.status !== 'delivered') throw new Error(`Earlier reviewer delivery ${unresolved.deliveryId} remains uncertain; no new turn was sent`);
      throw new Error('Earlier reviewer delivery was reconciled; refresh the task and explicitly authorize the latest checkpoint');
    }

    return null;
  }

  async admitReviewContinuation(input: { taskId: string; version: number; runId: string; head: string; checkpointOrdinal: number; reason: string; instruction: string; settleFences?: { runIds: string[]; displacedRunIds?: string[] } }, operationId: string) {
    try {
      const checkpoint = this.resolution.reviewContinuationGate(input, input.version, operationId, { settle: input.settleFences });
      const { task, run } = checkpoint;
      const recheck = () => {
        const current = this.resolution.reviewContinuationGate(input, input.version, operationId, { settle: input.settleFences });
        if (!isDeepStrictEqual(current.run, run)) throw Error('The reviewer run changed during continuation admission; no delivery was sent');
      };
      const number = taskPrNumber(task);
      if (!number || !task.prUrl || !task.prHead || task.prHead !== run.head || input.head !== run.head)
        throw new Error('Reviewer continuation requires the same recorded open PR and full exact head');
      const verifyPr = run.ordinaryDetached ? async (task: Task, number: number) => {
        await proveReviewRunSource(task, run.head, true);
        if (!this.adapter.verifyPrIdentity) throw Error('Ordinary review canonical PR observation unavailable');
        const pr = await this.adapter.verifyPrIdentity(task, number);
        await proveReviewRunSource(task, run.head, true);
        return pr;
      } : this.adapter.verifyPr;
      const continueReviewer = this.adapter.continueReviewer;
      if (!verifyPr || !continueReviewer) throw new Error('Paseo cannot prove and deliver a permission-free same-run reviewer continuation; no delivery was sent');
      const verified = await verifyPr(task, number);
      recheck();
      if (verified.url !== task.prUrl || verified.head !== run.head || verified.head !== input.head) {
        throw new Error('Open PR, task and reviewer heads do not match; no reviewer delivery was sent');
      }
      const observed = await this.resolution.onTaskHost(task, () => this.resolution.host.observe(run.agentId!));
      recheck();
      this.resolution.assertIdleReviewerObservation(task, run, observed);
      // A stop-backed resume is the one continuation that follows a delivered
      // turn, so it carries the same owned-tool proof every displaced run needs:
      // a live tool on the stopped turn is not a stopped turn.
      if (checkpoint.resumeStop) {
        const held = await this.resolution.ownedToolHold(run.agentId!, { requireCompleteEvidence: true, runId: run.id, taskId: task.id });
        recheck();
        if (held) throw new Error(`The stopped reviewer cannot be shown to hold no live tool (${held}); no resumed continuation was sent`);
      }
      return { ...checkpoint, number, verifyPr, continueReviewer };
    } catch (error) {
      throw error instanceof ProvenPreSendRefusalError ? error : new ProvenPreSendRefusalError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Deliver one operator-authorized continuation to the exact checkpointed
   * reviewer. Reservation is durable before messaging; every ambiguous outcome
   * is reconciled from a matching timeline message or authenticated callback,
   * and is never replayed.
   */
  async continueReview(input: { taskId: string; version: number; runId: string; head: string; checkpointOrdinal: number; reason: string; instruction: string; settleFences?: { detail: string; runIds: string[]; displacedRunIds?: string[] } }, operationId: string): Promise<Task> {
    if (await this.resolution.inspectReviewContinuation(input, operationId)) return this.store.task(input.taskId);
    let deliveryId = reviewDeliveryId(input);
    // Earlier same-intent inspection stays outside this boundary: an existing
    // unknown send is never reclassified by a new preflight refusal.
    let reservedRunId: string | undefined;
    let adapterInvoked = false, adapterRefused = false;
    try {
      const { task, run, record, briefVersion, number, verifyPr, continueReviewer, resumeStop } = await this.resolution.admitReviewContinuation(input, operationId);
      // The admitted turn's own identity: a stop-backed resume carries the
      // individual owner-stop occurrence, so its replay reconciles instead of
      // sending and a second resume needs a second explicit stop.
      deliveryId = reviewDeliveryId(input, resumeStop);
      const authorizationId = reviewAuthorizationId(input, resumeStop);
      const currentBriefVersion = currentBrief(task);
      const authorization: ReviewDeliveryAuthorization = {
        authorizationId, operationId, deliveryId, taskId: task.id, runId: run.id, head: run.head,
        checkpointOrdinal: record.ordinal, taskVersion: input.version,
        briefVersion: briefVersion?.version ?? null, briefDigest: briefVersion ? briefDigest(briefVersion.text) : null,
        reason: input.reason.trim(), instruction: input.instruction.trim(), createdAt: now(), status: 'reserved', evidence: '', observedAt: null,
      };
      if ((currentBriefVersion?.version ?? null) !== authorization.briefVersion || (currentBriefVersion ? briefDigest(currentBriefVersion.text) : null) !== authorization.briefDigest)
        throw new Error('Nucleus-held brief changed before reviewer authorization was reserved');
      const reservation = this.store.transaction(() => {
        const fresh = this.resolution.reviewContinuationGate(input, input.version, operationId, { settle: input.settleFences });
        if ((fresh.resumeStop?.eventId ?? null) !== (resumeStop?.eventId ?? null))
          throw new Error('The stopped review turn changed during admission; refresh the task and explicitly authorize the latest checkpoint');
        const latestRun = this.store.run(run.id)!;
        this.resolution.assertReviewCheckpointProvenance(fresh.task, latestRun, fresh.record);
        const deliveries = [...(latestRun.reviewDeliveries ?? [])];
        const existingIndex = deliveries.findIndex(item => item.deliveryId === deliveryId);
        if (existingIndex >= 0) {
          if (deliveries[existingIndex].status !== 'refused') throw new Error('Reviewer delivery changed after refusal inspection; no second delivery was reserved');
          // A positive pre-send refusal proves this message ID was never delivered.
          // Keep its refusal event as audit evidence, but allow a fresh operator
          // authorization to reserve the same checkpoint-bound delivery identity.
          deliveries[existingIndex] = authorization;
        } else deliveries.push(authorization);
        // Spec 050 (#3569): the fences this continuation obsoletes settle in the
        // same transaction as the reservation, so a refused continuation changes
        // nothing. The strict re-gate proves the settled world still matches.
        let expectedVersion = input.version;
        if (input.settleFences) {
          this.resolution.settleVerbFences(task.id, input.settleFences);
          expectedVersion = this.store.task(task.id).version;
          this.resolution.reviewContinuationGate(input, expectedVersion, operationId);
        }
        const nextRun = { ...latestRun, reviewDeliveries: deliveries };
        this.store.putRun(nextRun);
        const nextTask = this.store.update(task.id, { reason: reviewDeliveryReason(deliveryId, 'reserved') }, 'review_delivery_reserved', authorizationId, expectedVersion);
        return { task: nextTask, run: nextRun };
      });
      reservedRunId = reservation.run.id;
      const reservationVersion = reservation.task.version;
      const reservedGate = () => this.resolution.reviewContinuationGate(input, reservationVersion, operationId);
      const allowed = async () => {
        try {
          const before = reservedGate();
          const pr = await verifyPr(before.task, number);
          const after = reservedGate();
          return pr.url === after.task.prUrl && pr.head === after.run.head && pr.head === input.head;
        } catch { return false; }
      };
      const stillAllowed = () => {
        try { this.store.transaction(() => { reservedGate(); }); return true; }
        catch { return false; }
      };
      const { task: sendTask, run: sendRun, record: sendCheckpoint } = reservedGate();
      const prompt = operatorReviewContinuationPrompt(sendTask, sendRun, sendCheckpoint, authorization, reviewContinuationLimit(this.store));
      adapterInvoked = true;
      const result = await continueReviewer(sendTask, sendRun, deliveryId, prompt, allowed, stillAllowed);
      if (!result.sent) {
        adapterRefused = true;
        this.resolution.settleReviewDelivery(sendRun.id, deliveryId, 'refused', result.reason);
        throw new ProvenPreSendRefusalError(result.reason);
      }
      this.resolution.settleReviewDelivery(sendRun.id, deliveryId, 'delivered', `Paseo accepted message ${deliveryId}`, true);
      return this.store.task(task.id);
    } catch (error) {
      if (!adapterInvoked || adapterRefused) {
        if (reservedRunId) this.resolution.settleReviewDelivery(reservedRunId, deliveryId, 'refused', String(error));
        throw error instanceof ProvenPreSendRefusalError ? error : new ProvenPreSendRefusalError(error instanceof Error ? error.message : String(error));
      }
      // Even a transport exception can follow a successful remote enqueue.
      // Marking uncertain is durable; operation replay will inspect evidence only.
      this.resolution.settleReviewDelivery(reservedRunId!, deliveryId, 'uncertain', String(error).slice(0, 1600));
      throw new Error(`Reviewer delivery ${deliveryId} has an uncertain send outcome; inspect the same reviewer thread, never resend (${String(error).slice(0, 500)})`);
    }
  }

  reviewContinuationGate(input: { taskId: string; version: number; runId: string; head: string; checkpointOrdinal: number }, expectedVersion: number, operationId: string, options: { settle?: { runIds: string[]; displacedRunIds?: string[] } } = {}) {
    const task = this.store.task(input.taskId), run = this.store.run(input.runId);
    if (task.removedAt || task.version !== expectedVersion) throw new Error('Task changed; refresh before continuing reviewer progress');
    // Every unreleased run the settling transition displaces is as settled as a
    // finished one for this gate: the continuation's own transaction releases it.
    const settling = options.settle ? { runIds: [...options.settle.runIds, ...(options.settle.displacedRunIds ?? [])] } : undefined;
    const local = reviewContinuationLocalRefusal(this.store, task, run, input, {
      settling, paused: this.resolution.paused(), operationId, ownerStopYields: (input as { ownerStopYields?: boolean }).ownerStopYields === true,
      provenance: (current, record) => this.resolution.assertReviewCheckpointProvenance(current, run!, record),
    });
    if ('refusal' in local) throw new Error(local.refusal);
    this.resolution.assertReviewProfileIndependent(task, run!);
    return { task, run: run!, record: local.record, briefVersion: local.briefVersion, resumeStop: local.resumeStop };
  }

  /** Recheck the exact authenticated receipt and owner-only checkpoint file. */
  assertReviewCheckpointProvenance(task: Task, run: Run, record: ReviewCheckpointRecord): string {
    const refusal = reviewCheckpointRefusal(this.store, task, run, record);
    if (refusal) throw new Error(refusal);
    return record.eventId!;
  }

  assertIdleReviewerObservation(task: Task, run: Run, observed: AgentObservation) {
    // A closed session is a positive terminal observation, not a busy reviewer:
    // the same-run continuation can never land on it, and the supported recovery
    // is the existing fresh reviewer (restart role=reviewer fresh) at the
    // same exact head. An errored agent with no active turn and no pending
    // permission is the same dead weight, so it takes the same exit with its
    // own reason (matchingInactiveParticipant admits error wherever it admits
    // closed).
    if (matchingInactiveParticipant(run, observed, ['closed']))
      throw new Error(observed.status === 'error' ? REVIEW_AGENT_ERRORED : REVIEW_AGENT_CLOSED);
    if (!matchingInactiveParticipant(run, observed, ['idle']))
      throw new Error('The original reviewer is active, initializing, closed, unavailable or awaiting permission; no delivery was sent');
    if (!run.profile || reviewerRuntimeChanged(run.profile, observed))
      throw new Error('The original reviewer workspace/model is unknown or changed; no delivery was sent');
  }
}


/** Stored reader fences use the same message before and after host observation. */
export function retainedReaderStoredRefusal(state: ReturnType<typeof reviewContinuationState>, waitReason: string): string | null {
  const stored = retainedReaderStateDecision(state);
  if (stored === 'unsettled') return `Move to review cannot act while a reviewer delivery is unsettled: ${waitReason}. Inspect the retained reviewer thread; no review turn was sent`;
  if (stored === 'exhausted') return retainedReaderUnavailableRefusal(REVIEW_BUDGET_EXHAUSTED);
  if (stored === 'closed') return retainedReaderUnavailableRefusal(REVIEW_AGENT_CLOSED);
  return null;
}
export function retainedReaderUnavailableRefusal(reason = REVIEW_AGENT_CLOSED): string {
  return `Move to review preserves a reader it can continue, and this one cannot: ${reason} ${REVIEW_FRESH_REPLACEMENT_EXIT}`;
}
