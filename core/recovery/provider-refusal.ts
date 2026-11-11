import type { Run, Task } from '../../shared/contracts';
import { isDispositionActive, isDispositionComplete } from '../../shared/contracts';
import { dispatchBlocked } from '../dispatch/capacity';
import { isQuotaExhaustion, providerRetryAt } from './exhaustion';
import { taskPrNumber } from '../forge/index';
import type { AgentObservation } from '../host/adapter';
import type { Resolution } from '../resolution';
import { reviewAuthorizationRequired } from '../review/review-continuation';
import { modelKey } from '../dispatch/routing';
import type { TimelineEntry, TimelinePage } from './stall';
import { PROVIDER_REFUSAL_UNVERIFIED, UNVERIFIABLE_REFUSAL_READ_LIMIT, reviewerRefusalKey } from './task-reasons';

/**
 * Spec 016: an exact callback-free reviewer provider refusal.
 *
 * A reviewer whose provider plan or quota is exhausted can answer its dispatch
 * turn with a terminal refusal instead of doing review work. It never reaches
 * its authenticated reporting callback, so Paseo's own error field stays empty
 * and Queue cannot see the exhaustion from the agent record. Queue reads the
 * reviewer's own identity-bound timeline instead.
 *
 * Attribution is exact: the page must contain the dispatch user message that
 * names this run (`ns-run-<runId>`), and the refusal must be the terminal
 * provider response after that message, in the same reported turn and with no
 * intervening user turn. Quoted text in a user message, prompt, tool output or
 * document, a foreign run or provider, a resolved older response, a partial or
 * gapped page, a running tool, an absent or contradictory turn identity, or a
 * non-terminal response is not evidence, and every stored diagnostic is
 * redacted and bounded. Every unproven read is `unverified`, never absence.
 */

/** Prefix Paseo attaches to a Queue run's dispatch user message. */
export const RUN_DISPATCH_PREFIX = 'ns-run-';

/** Provider-response carriers; their order in the dispatch turn decides terminality. */
const RESPONSE_TYPES = new Set(['assistant_message', 'error', 'notification']);

/** The canonical Cursor refusal as its own message, never a quotation inside longer prose. */
const CANONICAL_CURSOR_REFUSAL = /^\s*upgrade your plan to continue[\s.!…]*$/i;

/** A message that could end or continue the dispatch turn. */
function substantive(entry: TimelineEntry): boolean {
  return RESPONSE_TYPES.has(entry.item.type) || entry.item.type === 'tool_call' || entry.item.type === 'user_message';
}

/**
 * Provider-generated refusal text and its classification, or null for a
 * non-refusal entry. A model message qualifies only as the canonical Cursor
 * sentence; an error or notification record qualifies through the shared
 * quota/balance classifier. Quoted prose, prompts, tool output and documents
 * never carry this evidence.
 */
function refusalEntry(entry: TimelineEntry): { text: string; kind: ProviderRefusalKind } | null {
  const item = entry.item;
  if (item.type === 'assistant_message')
    return typeof item.text === 'string' && CANONICAL_CURSOR_REFUSAL.test(item.text)
      ? { text: item.text, kind: 'cursor_plan_refusal' } : null;
  if (item.type === 'error' || item.type === 'notification')
    return typeof item.message === 'string' && isQuotaExhaustion(item.message)
      ? { text: item.message, kind: 'quota_balance_exhaustion' } : null;
  return null;
}

/**
 * Whether a reviewer run's own dispatch message is positively on one timeline
 * page. `delivered` needs only the exact dispatch message id on a complete
 * page; `absent` needs the same completeness without it. A missing page, a
 * gap, or a page that may continue into older entries is `unverified`, never
 * absence: the dispatch may live on a page this read did not reach.
 */
export function timelineDispatchState(page: TimelinePage | null, runId: string): 'delivered' | 'absent' | 'unverified' {
  if (!page || page.gap) return 'unverified';
  const dispatchMessageId = `${RUN_DISPATCH_PREFIX}${runId}`;
  const delivered = page.entries.some(entry => entry?.item?.type === 'user_message'
    && (entry.item.messageId === dispatchMessageId || entry.item.clientMessageId === dispatchMessageId));
  if (delivered) return 'delivered';
  return page.hasOlder ? 'unverified' : 'absent';
}

export type ProviderRefusalKind = 'cursor_plan_refusal' | 'quota_balance_exhaustion';

/**
 * Provider errors that prove the prompt was refused before acceptance for
 * size: the provider names its input/maximum-length bound (or an equivalent
 * explicit "too large" rejection) rather than a quota, plan or rate limit.
 * A quota/balance/plan/rate wording is never a size refusal, so a starved
 * route keeps its exact-lookup reconciliation instead of a size receipt.
 */
const PROMPT_TOO_LARGE_PATTERNS: readonly RegExp[] = [
  /input exceeds (the )?maximum length/i,
  /maximum (input|prompt|request|message|content) (length|size)/i,
  /maximum context (length|window|size)/i,
  /context length exceeded|context window (exceeded|exhausted|too small)/i,
  /(input|prompt|request|message|content) (is )?too (large|long)/i,
  /prompt .*exceeds.*(maximum|limit|context)/i,
  /(exceeds|exceeded|exceeding).{0,60}(maximum )?(context|input|prompt) (length|window|limit|size)/i,
];
const NOT_PROMPT_TOO_LARGE = /\b(rate|quota|balance|credit|plan|upgrade|billing|payment|insufficient|permission|forbidden|unauthorized)\b/i;

export function isPromptTooLargeError(error: unknown): boolean {
  const text = (error instanceof Error ? `${error.name} ${error.message}` : String(error)).replace(/\s+/g, ' ').trim();
  if (!text || NOT_PROMPT_TOO_LARGE.test(text)) return false;
  return PROMPT_TOO_LARGE_PATTERNS.some(pattern => pattern.test(text));
}

/** Credential shapes never leave Queue: common token prefixes and long opaque tokens. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/gi,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{10,}/gi,
  /\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*\S+/gi,
  /\b[A-Za-z0-9_/-]{32,}\b/g,
];

/** Collapse, redact and bound one provider diagnostic before it is ever stored. */
export function redactDiagnostic(text: string): string {
  let value = text.replace(/\s+/g, ' ').trim();
  for (const pattern of SECRET_PATTERNS) value = value.replace(pattern, '[redacted]');
  return value.slice(0, 300);
}

export interface ProviderRefusalEvidence {
  /** The run's own dispatch message that bound this timeline turn. */
  dispatchMessageId: string;
  /** The turn that carried the dispatch and the refusal; both must report the same turn. */
  turnId: string;
  /** Timestamp of the terminal refusal entry. */
  at: string;
  /** The canonical classification of the refusal. */
  kind: ProviderRefusalKind;
  /** Canonical classification plus a redacted, bounded diagnostic. */
  reason: string;
}

export type ProviderRefusalRead =
  | { state: 'refusal'; evidence: ProviderRefusalEvidence }
  | { state: 'none' }
  | { state: 'unverified'; gap: string };

const at = (entry: TimelineEntry) => Date.parse(entry.timestamp);

/**
 * Read one tail page of a reviewer's own timeline for a terminal provider
 * refusal. `runId` is the Queue run the dispatch message must name.
 */
export function detectReviewerProviderRefusal(page: TimelinePage | null, runId: string): ProviderRefusalRead {
  if (!page) return { state: 'unverified', gap: 'the reviewer timeline read failed' };
  const dispatchMessageId = `${RUN_DISPATCH_PREFIX}${runId}`;
  // The tail is newest entries first or last depending on the provider; sort a
  // copy by timestamp so the
  // dispatch/refusal/reminder relationship is judged chronologically.
  const ordering = page.entries.filter(substantive);
  if (ordering.some(entry => !Number.isFinite(at(entry))))
    return { state: 'unverified', gap: 'the reviewer timeline carries no readable timestamp for a turn entry' };
  if (new Set(ordering.map(at)).size !== ordering.length)
    return { state: 'unverified', gap: 'the reviewer timeline carries ambiguous equal timestamps for turn entries' };
  const entries = [...ordering].sort((a, b) => at(a) - at(b));
  const dispatchIndex = entries.findIndex(entry => entry.item.type === 'user_message'
    && (entry.item.messageId === dispatchMessageId || entry.item.clientMessageId === dispatchMessageId));
  if (dispatchIndex < 0) return { state: 'unverified', gap: page.hasOlder
    ? `the reviewer timeline page does not reach the dispatch message ${dispatchMessageId}`
    : `the reviewer timeline does not contain the dispatch message ${dispatchMessageId}` };
  if (page.gap) return { state: 'unverified', gap: 'the reviewer timeline reports a gap in its entries' };
  const dispatch = entries[dispatchIndex]!;
  if (!Number.isFinite(at(dispatch))) return { state: 'unverified', gap: 'the reviewer dispatch message carries no readable timestamp' };
  const turn = entries.slice(dispatchIndex + 1).filter(substantive);
  const last = turn.at(-1);
  if (!last) return { state: 'none' };
  const refusal = refusalEntry(last);
  if (refusal === null) return { state: 'none' };
  // A later user turn means the dispatch turn ended before this response, so it
  // belongs to a different (possibly operator-driven) turn.
  if (turn.slice(0, -1).some(entry => entry.item.type === 'user_message'))
    return { state: 'unverified', gap: 'a later user turn follows the dispatch before the refusal' };
  // Both sides must name the same turn; an absent or contradictory turn
  // identity is another exact-binding gap, never a refusal.
  if (!dispatch.turnId || !last.turnId)
    return { state: 'unverified', gap: 'the dispatch or the terminal response carries no turn identity' };
  if (dispatch.turnId !== last.turnId)
    return { state: 'unverified', gap: 'the terminal response carries a different turn identity from the dispatch' };
  if (turn.some(entry => entry.item.type === 'tool_call' && entry.item.status === 'running'))
    return { state: 'unverified', gap: 'the reviewer dispatch turn still shows a running tool call' };
  const label = refusal.kind === 'cursor_plan_refusal' ? 'plan refusal' : 'quota/balance exhaustion';
  return { state: 'refusal', evidence: {
    dispatchMessageId,
    turnId: last.turnId,
    at: last.timestamp,
    kind: refusal.kind,
    reason: `Provider ${label} for run ${runId}: ${redactDiagnostic(refusal.text)}`,
  }};
}

/** Why the exact current reviewer run cannot be recovered from a refusal, or null. */
export function refusalGap(facts: {
  current: Task;
  run: Run;
  expectedVersion?: number;
  paused: boolean;
  reviewAuthorizationRequired: boolean;
  latest: Run | null;
  otherUnreleased: boolean;
  publicationUnresolved: boolean;
}): string | null {
  const { current, run, latest } = facts;
  if (facts.expectedVersion !== undefined && current.version !== facts.expectedVersion) return 'the task changed during refusal recovery';
  if (current.removedAt) return 'the task was removed';
  if (current.phase !== 'reviewing') return `the task is not reviewing (${current.phase})`;
  if (facts.paused) return 'Nucleus is paused';
  if (dispatchBlocked(current)) return 'a dispatch hold is active';
  if (facts.reviewAuthorizationRequired) return 'a review authorization is required';
  if (isDispositionActive(current) || isDispositionComplete(current)) return 'a disposition fence is active';
  if (current.resolution.mergeIntent || current.resolution.mergedCommit || current.resolution.externalMerge || current.resolution.mergeHead) return 'a merge intent exists';
  if (!latest || latest.released || latest.status !== 'running' || latest.completion) return 'the reviewer run is released or completed';
  if (current.resolution.currentRunId !== run.id) return 'the reviewer run is no longer current';
  if (!current.workspaceId || !current.directory || run.workspaceId !== current.workspaceId) return 'the reviewer workspace differs from the task workspace';
  if (!run.agentId || current.resolution.reviewerAgentId !== run.agentId) return 'the reviewer agent identity changed';
  if (current.resolution.review) return 'a reviewer result already exists';
  if (!current.prUrl || !current.prHead || current.prHead !== run.head) return 'the reviewer is not bound to the task\'s exact open head';
  if (facts.otherUnreleased) return 'another run still owns this task';
  if ((latest.reviewCheckpoints ?? []).length) return 'the reviewer recorded progress checkpoints';
  if (latest.reviewContinuation && latest.reviewContinuation.status !== 'delivered') return 'a reviewer continuation effect is unresolved';
  if ((latest.reviewDeliveries ?? []).some(item => item.status === 'reserved' || item.status === 'uncertain')) return 'a reviewer delivery effect is unresolved';
  if (facts.publicationUnresolved) return 'a review publication is unresolved';
  if (current.resolution.attention || current.resolution.recoveryActive
    || current.resolution.recovery && current.resolution.recovery.status !== 'resolved'
    || current.resolution.incident && current.resolution.incident.status !== 'resolved') return 'an unresolved incident or recovery fences this run';
  if (current.resolution.stalledTurnStop && current.resolution.stalledTurnStop.status !== 'completed') return 'a stalled-turn stop is outstanding';
  if (current.resolution.roleReplacements >= 8) return 'the role replacement budget is spent';
  return null;
}

/** Proves a reviewer's provider refused its turn, then replaces the reviewer or records a finite blocker. */
export type ProviderRefusalsContext = Pick<Resolution, 'adapter' | 'applyReviewerRefusal' | 'attention' | 'clearUnverifiableRefusalWait' | 'host' | 'observeStoppedReviewer' | 'paused' | 'recordRefusalBlocked' | 'recordUnverifiableRefusalRead' | 'refusalExclusions' | 'refusalGap' | 'select' | 'stopped' | 'store' | 'unverifiableRefusalReads' | 'update' | 'usageCeilingNote' | 'verifyRefusedRevision' | 'waiting'>;

export class ProviderRefusals {
  constructor(readonly resolution: ProviderRefusalsContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }

  /**
   * Spec 016: recover one exact callback-free reviewer provider refusal.
   *
   * The reviewer's own identity-bound timeline must prove that its dispatch turn
   * ended in a terminal plan/quota refusal. One read-only selection proves an
   * eligible independent reader exists with the affected group excluded; one
   * transaction then records the refusal, marks only that group unavailable and
   * supersedes the run, so ordinary selection can never re-dispatch the
   * exhausted route. Without an eligible reader the run keeps its lease, its
   * credential and its history, and the task shows a finite blocker. Returns
   * true when this pass must not send a callback reminder.
   */
  async recoverRefusedReviewer(task: Task, run: Run): Promise<boolean> {
    if (run.role !== 'reviewer' || !run.agentId || !this.adapter.agentTimelinePage) return false;
    const recorded = this.store.getMeta<{ group: string; evidence: ProviderRefusalEvidence }>(reviewerRefusalKey(run.id));
    if (recorded) {
      const current = this.store.task(task.id);
      if (this.resolution.refusalGap(current, run)) { this.store.deleteMeta(reviewerRefusalKey(run.id)); return false; }
      return this.resolution.applyReviewerRefusal(current, run, recorded.group, recorded.evidence, current.version);
    }
    // The check has already spent its reads on this run: the ordinary
    // stopped-without-verdict path owns it now, and a further timeline read would
    // neither prove a refusal nor change that answer.
    if (this.resolution.unverifiableRefusalReads(task.id, run.id).length >= UNVERIFIABLE_REFUSAL_READ_LIMIT) {
      this.resolution.clearUnverifiableRefusalWait(this.store.task(task.id), run);
      return false;
    }
    const before = this.store.task(task.id);
    const version = before.version;
    if (this.resolution.refusalGap(before, run, version)) return false;
    const page = await this.resolution.host.agentTimelinePage(run.agentId, 100);
    if (this.resolution.stopped()) return false;
    const afterRead = this.store.task(task.id);
    if (this.resolution.refusalGap(afterRead, run, version)) return false;
    const read = detectReviewerProviderRefusal(page, run.id);
    if (read.state === 'unverified') {
      // Bounded, never indefinite (papercut fe93582a): the first read surfaces its
      // exact gap and holds one grace; the last read hands the run back to the
      // ordinary path — one re-report continuation of the retained reviewer, then
      // the existing fresh-restart rule. A lane is never left waiting on a read
      // that cannot settle.
      const reads = this.resolution.recordUnverifiableRefusalRead(afterRead, run, read.gap);
      if (reads < UNVERIFIABLE_REFUSAL_READ_LIMIT) {
        this.resolution.waiting(afterRead, `Reviewer run ${run.id} provider refusal is unverified: ${read.gap}`, 'provider_unavailable');
        return true;
      }
      this.resolution.clearUnverifiableRefusalWait(this.store.task(task.id), run);
      return false;
    }
    if (read.state === 'none') return false;
    const group = run.profileGroup ?? (run.profile ? this.store.pool().find(entry => entry.profileId === run.profile!.id)?.group : undefined);
    if (!group) { this.resolution.attention(afterRead, `Provider refused reviewer run ${run.id} but it has no recorded subscription group; inspect routing. Evidence: ${read.evidence.reason}`); return true; }
    return this.resolution.applyReviewerRefusal(afterRead, run, group, read.evidence, version);
  }

  /** Every unverifiable refusal read already recorded against this run. */
  unverifiableRefusalReads(taskId: string, runId: string) {
    return this.store.events(taskId).filter(event => event.kind === PROVIDER_REFUSAL_UNVERIFIED
      && event.detail.startsWith(`${runId}: `));
  }

  /** Record one unverifiable read's exact gap and return the run's read count. */
  recordUnverifiableRefusalRead(current: Task, run: Run, gap: string): number {
    const latest = this.store.task(current.id);
    this.store.event(latest.id, PROVIDER_REFUSAL_UNVERIFIED, `${run.id}: ${gap}`.slice(0, 2000));
    return this.resolution.unverifiableRefusalReads(latest.id, run.id).length;
  }

  /**
   * Hand a run whose refusal read cannot settle to the ordinary
   * stopped-without-verdict path, retiring only the provider wait this check
   * itself recorded.
   */
  clearUnverifiableRefusalWait(current: Task, run: Run): void {
    const stop = current.resolution.stop;
    if (stop?.reason !== 'provider_unavailable' || !stop.detail.startsWith(`Reviewer run ${run.id} provider refusal is unverified`)) return;
    this.resolution.update(current, { stop: null }, {}, 'task_wait_cleared', 'provider_unavailable');
  }

  /**
   * One atomic supersede-and-choose for a proven reviewer refusal, or a finite
   * blocker that leaves the lease intact. Every live read runs against the exact
   * reviewer run and its assigned provider/model, and the task version, full run
   * identity, open PR and clean pushed head are rechecked after each await and
   * inside the commit.
   */
  async applyReviewerRefusal(current: Task, run: Run, group: string, evidence: ProviderRefusalEvidence, expectedVersion: number): Promise<boolean> {
    const stopped = await this.resolution.observeStoppedReviewer(current, run, expectedVersion);
    if (!stopped) return false;
    // Cheap pre-check so a task with no eligible reader does not spend live reads.
    if (!this.resolution.select(stopped, 'reviewer', [group], this.resolution.refusalExclusions(stopped))) {
      this.resolution.recordRefusalBlocked(stopped, run, group, evidence);
      return true;
    }
    // The live open PR, clean local worktree and pushed branch head must still
    // all equal the recorded head immediately before the run is superseded.
    if (!await this.resolution.verifyRefusedRevision(stopped, run, expectedVersion)) return false;
    // Revision checks await external reads. A previously idle reviewer may have
    // started a turn or gained a permission request while those checks ran.
    // Refresh the exact live proof last, with no further await before commit.
    const verified = await this.resolution.observeStoppedReviewer(this.store.task(current.id), run, expectedVersion);
    if (!verified) return true;
    // Re-choose after the awaited live proofs: the eligible independent reader
    // must still exist under the current pool, availability and exclusions.
    if (this.resolution.refusalGap(verified, run, expectedVersion)) return false;
    const selection = this.resolution.select(verified, 'reviewer', [group], this.resolution.refusalExclusions(verified));
    if (!selection) { this.resolution.recordRefusalBlocked(verified, run, group, evidence); return true; }
    this.store.transaction(() => {
      const latest = this.store.task(current.id);
      if (this.resolution.refusalGap(latest, run, expectedVersion)) return;
      // Synchronous final route revalidation before any durable write.
      const route = this.resolution.select(latest, 'reviewer', [group], this.resolution.refusalExclusions(latest));
      if (!route || route.profile.id !== selection.profile.id) return;
      const latestRun = this.store.run(run.id)!;
      this.store.setAvailability(group, JSON.stringify({ group, unavailable: true, reason: evidence.reason.slice(0, 2000), retryAt: providerRetryAt(evidence.reason) }));
      this.store.putRun({ ...latestRun, status: 'superseded', released: true, exhaustionReason: evidence.reason.slice(0, 2000) });
      this.store.deleteMeta(reviewerRefusalKey(run.id));
      this.store.event(latest.id, 'provider_refusal', JSON.stringify({
        runId: run.id, role: 'reviewer', agentId: run.agentId, workspaceId: run.workspaceId, head: run.head,
        group, replacementProfile: route.profile.id, turnId: evidence.turnId, dispatchMessageId: evidence.dispatchMessageId,
        at: evidence.at, kind: evidence.kind, reason: evidence.reason,
      }));
      this.resolution.update(latest, {
        currentRunId: null, reviewerAgentId: null, reviewerProfile: null, review: null,
        attention: false, roleReplacements: latest.resolution.roleReplacements + 1,
      }, { phase: 'awaiting_review', reason: `Replacing reviewer run ${run.id}: its own provider refused the review turn (${evidence.reason.slice(0, 300)}); selecting an eligible independent reviewer` }, 'role_replacement');
    });
    return true;
  }

  /** Reviewer profile ids this task excluded; an excluded profile is never an automatic fallback. */
  refusalExclusions(task: Task): ReadonlySet<string> {
    return new Set((task.workerExclusions ?? []).flatMap(exclusion => exclusion.profileId ? [exclusion.profileId] : []));
  }

  /** Record a proven refusal and a finite blocker that leaves the lease, credential and history intact. */
  recordRefusalBlocked(current: Task, run: Run, group: string, evidence: ProviderRefusalEvidence): void {
    if (!this.store.getMeta(reviewerRefusalKey(run.id))) {
      this.store.setMeta(reviewerRefusalKey(run.id), { group, evidence });
      this.store.event(current.id, 'provider_refusal_blocked', `${run.id}: ${group}: no eligible independent reviewer profile; ${evidence.reason}`.slice(0, 2000));
    }
    this.resolution.waiting(current, `Reviewer run ${run.id} was refused by its provider (${group}); no eligible independent reviewer profile exists after excluding that subscription group${this.resolution.usageCeilingNote(current, 'reviewer', [group], this.resolution.refusalExclusions(current))}`, 'route_unavailable');
  }

  /**
   * Positively re-prove the exact stopped reviewer: same agent and task
   * workspace, assigned provider and model, idle or closed, no turn and no
   * pending request, still current on the unchanged task version.
   */
  async observeStoppedReviewer(current: Task, run: Run, expectedVersion: number): Promise<Task | null> {
    if (run.role !== 'reviewer' || !run.agentId) return null;
    const provider = run.profile?.provider?.trim() ?? '';
    const model = run.profile?.model?.trim() ?? '';
    if (!provider || !model || modelKey(model) === 'default') return null;
    if (!current.workspaceId || run.workspaceId !== current.workspaceId || !current.directory) return null;
    let observed: AgentObservation;
    try { observed = await this.resolution.host.observe(run.agentId); } catch { return null; }
    if (this.resolution.stopped()) return null;
    const latest = this.store.task(current.id);
    if (this.resolution.refusalGap(latest, run, expectedVersion)) return null;
    if (observed.id !== run.agentId || observed.workspaceId !== latest.workspaceId) return null;
    if (observed.active || observed.permissions || !['idle','error','closed'].includes(observed.status)) return null;
    if ((observed.provider ?? '').trim() !== provider) return null;
    if (!observed.model || modelKey(observed.model) !== modelKey(model)) return null;
    return latest;
  }

  /** Live open-PR identity plus clean local and pushed head proof at the recorded head. */
  async verifyRefusedRevision(current: Task, run: Run, expectedVersion: number): Promise<boolean> {
    try {
      if (!current.prUrl || !current.prHead || current.prHead !== run.head) return false;
      if (!this.adapter.verifyPrIdentity || !this.adapter.verifyInspectedRevisionHead) return false;
      const number = taskPrNumber(current);
      const pr = await this.adapter.verifyPrIdentity(current, number);
      if (this.resolution.stopped() || this.resolution.paused()) return false;
      const afterPr = this.store.task(current.id);
      if (this.resolution.refusalGap(afterPr, run, expectedVersion)) return false;
      if (pr.url !== afterPr.prUrl || pr.head !== afterPr.prHead || pr.head !== run.head) return false;
      await this.adapter.verifyInspectedRevisionHead(afterPr, number, run.head);
      if (this.resolution.stopped() || this.resolution.paused()) return false;
      return !this.resolution.refusalGap(this.store.task(current.id), run, expectedVersion);
    } catch { return false; }
  }

  /** Why the exact current reviewer run cannot be recovered from a refusal, or null. */
  refusalGap(current: Task, run: Run, expectedVersion?: number): string | null {
    return refusalGap({
      current, run, expectedVersion,
      paused: this.resolution.paused(),
      reviewAuthorizationRequired: reviewAuthorizationRequired(current, this.store),
      latest: this.store.run(run.id),
      otherUnreleased: this.store.runs(current.id).some(item => !item.released && item.id !== run.id),
      publicationUnresolved: Boolean(this.store.getMeta(`reviewPublication:${run.id}`)),
    });
  }
}
