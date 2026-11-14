import type { Completion, Run, Task } from '../../shared/contracts';
import { automaticRetryForbidden } from '../../shared/automatic-retry';
import { readGitCheckout } from '../git/git-identity';
import { classifyGitCommandFailure } from '../forge/forge-health';
import { GIT_TRANSIENT_LIMIT_MS } from '../git/git-transient-backoff';
import { isQuotaExhaustion, isRateLimitError, isTransientProviderError } from './exhaustion';
import { isPromptTooLargeError } from './provider-refusal';

export const NON_DELIVERY_ROUTE_REASON = 'Automatic same-capability non-delivery replacement';
export const NON_DELIVERY_PUSHBACK = 'You reported no external blocker and produced no change. Under the ownership rule, decide within the brief and implement; record decisions in the PR. Report blocked only for an external cause, naming it.';

/** Task 576: the same push-back for a return that pushed progress but stopped while work remains. */
export const UNFINISHED_CONTINUATION_INSTRUCTION = 'You pushed new commits but reported the work unfinished. Under the ownership rule, continue the same approved round from the retained worktree and existing PR until the brief is complete; record decisions in the PR. Report blocked only for an external cause, naming it.';

/** The external-cause phrases Queue reads from a summary when a report carries no structured cause. */
const LEGACY_EXTERNAL_WORDING = /\b(missing dependency|dependency is missing|broken environment|environment is broken|external system|operator decision|operator-only|provider quota|quota exhausted|rate limit|network unavailable|service unavailable|credentials? unavailable|permission denied|awaiting operator|needs operator)\b/;
const NO_EXTERNAL_BLOCKER = /\b(no|without|not|isn't|is not)\s+(?:an?\s+)?external\s+(?:blockers?|causes?)\b/;

/**
 * The one legacy wording reader: an owner or report phrase that names an external
 * cause. It is migration evidence for reports that predate the structured
 * `cause`, so it lives here alone and the gates never restate it.
 */
function legacyExternalWording(text: string): boolean {
  const lower = text.toLowerCase();
  return !NO_EXTERNAL_BLOCKER.test(lower) && LEGACY_EXTERNAL_WORDING.test(lower);
}

/**
 * Wording Queue already recognises as an external cause or a provider failure keeps today's handling:
 * quota, plan, rate limit, transient and prompt-size provider errors, plus the legacy external phrases.
 * The no-impediment continuation never takes such a return. Wording only excludes; it never triggers.
 * Accepts a summary or an observed agent error.
 */
export function recognisedExternalWording(text: string): boolean {
  if (isQuotaExhaustion(text) || isRateLimitError(text) || isTransientProviderError(text) || isPromptTooLargeError(text)) return true;
  return legacyExternalWording(text);
}

/**
 * Task 676: a blocked or error return with no `impediment` and no new commit
 * continues the same worker. Two per thread; the third goes to the blocker ladder.
 */
export const NO_IMPEDIMENT_CONTINUATION_LIMIT = 2;
export const NO_IMPEDIMENT_CONTINUATION_INSTRUCTION = 'You reported no impediment and pushed no commit. Setup is confirmed; do the work now from the retained worktree and existing branch. Report only when the PR is open, or with `impediment` naming the concrete failure.';

export type NonDelivery = {
  runId: string;
  role: 'worker' | 'revision';
  status: 'blocked' | 'error';
  provider: string | null;
  model: string | null;
  baselineHead: string;
  observedHead: string;
};

/**
 * Typed and durable external causes only: provider, proof and approval state,
 * a structured `external` cause, a recorded ask, or admission/guard/budget/proof
 * evidence for this run. The summary's words never decide these.
 */
function recordedExternalCause(completion: Completion, events: Array<{ kind: string; detail: string }>, runId: string) {
  if (completion.providerUnavailable || completion.sourceApproved || completion.awaitingProofs?.length) return true;
  if (completion.cause?.kind === 'external') return true;
  if (events.some(event => event.kind === 'agent_ask'
      && (event.detail.includes(`run ${runId} `) || event.detail.endsWith(`run ${runId}`)))) return true;
  // Durable proof/native execution and admission refusal are outside causes even
  // when the worker did not get far enough to observe the target.
  return events.some(event => event.detail.includes(runId)
    && /proof|native|admission|guard|budget/i.test(event.kind));
}

export function reportsExternalCause(completion: Completion, events: Array<{ kind: string; detail: string }>, runId: string) {
  if (recordedExternalCause(completion, events, runId)) return true;
  // A structured cause, internal or unfinished, is the whole classification.
  if (completion.cause) return false;
  return legacyExternalWording(completion.summary);
}

export type UnfinishedReturn = {
  runId: string;
  role: 'worker' | 'revision';
  status: 'blocked' | 'error';
  provider: string | null;
  model: string | null;
  baselineHead: string;
  observedHead: string;
  /** Task 676: absent on the Task 576 unfinished records; `no_impediment` marks the same-thread continuation. */
  reason?: 'no_impediment' | 'forge_transient';
  forgeStartedAt?: number;
  /** Task 676: the worker thread the continuation keeps; the per-thread bound counts by it. */
  agentId?: string | null;
};

/**
 * Task 576: an unfinished return with partial progress. Same gates as the #575
 * no-change rule (a responsible worker or revision `blocked`/`error` with no
 * recorded external cause), plus positively observed new commits past the run's
 * starting head. New pushed commits are the whole evidence of unfinished work:
 * the summary's wording never decides it.
 *
 * Task 676: a return with no `impediment`, no recorded external cause and no new
 * commit since the run started continues the same worker too, at most
 * NO_IMPEDIMENT_CONTINUATION_LIMIT times per thread. Its summary words never decide
 * it. After the bound, or with an impediment, the return keeps the ladder and the
 * #575 non-delivery path. Unreadable Git state keeps the existing path.
 */
export function unfinishedReturnFor(task: Task, run: Run | null, completion: Completion, events: Array<{ kind: string; detail: string }>): UnfinishedReturn | null {
  const role = run ? run.role === 'revision' ? 'revision' : null : 'worker';
  if (!role || (completion.status !== 'blocked' && completion.status !== 'error')) return null;
  const runId = run?.id ?? task.runId;
  if (!runId || automaticRetryForbidden(task, run ? [run] : undefined)) return null;
  const baselineHead = run?.head ?? task.planningBase;
  if (!task.directory) return null;
  const agentId = run?.agentId ?? task.agentId ?? null;
  const record = { runId, role, status: completion.status, provider: run?.profile?.provider ?? task.profile?.provider ?? null,
    model: run?.profile?.model ?? task.profile?.model ?? null, baselineHead } as const;
  try {
    const observedHead = readGitCheckout(task.directory).head;
    // Older retained threads may report an outage before receiving the wait rule.
    // Reuse the retained-worker continuation; it must observe before retrying a write.
    if (transientForgeReport(completion)) {
      const previous = unfinishedContinuationEvents(events).filter(item => item.reason === 'forge_transient' && item.agentId === agentId).at(-1);
      const forgeStartedAt = previous?.forgeStartedAt ?? Date.now();
      if (Date.now() - forgeStartedAt < GIT_TRANSIENT_LIMIT_MS)
        return { ...record, observedHead, reason: 'forge_transient', forgeStartedAt, agentId };
      return null;
    }
    // Positive Git evidence decides: new commits past the run's starting head are
    // an unfinished continuation whatever words the summary used. Only a
    // recorded external cause keeps the return on its existing handling.
    if (observedHead !== baselineHead && !reportsExternalCause(completion, events, runId))
      return { ...record, observedHead };
    if (completion.impediment || recordedExternalCause(completion, events, runId) || recognisedExternalWording(completion.summary)) return null;
    // Every path that reaches here holds an unchanged head: a moved head with no
    // external cause returned above, and a moved head with one returned here. The
    // range baseline..observed is therefore empty by construction, so no git
    // process is spawned to count its commits.
    if (noImpedimentContinuationCount(events, agentId) >= NO_IMPEDIMENT_CONTINUATION_LIMIT) return null;
    return { ...record, observedHead, reason: 'no_impediment', agentId };
  } catch {
    return null;
  }
}

/** Task 676: the same-thread continuations already recorded for one worker thread. */
export function noImpedimentContinuationCount(events: Array<{ kind: string; detail: string }>, agentId: string | null): number {
  return unfinishedContinuationEvents(events).filter(item => item.reason === 'no_impediment' && item.agentId === agentId).length;
}

/** The push-back text for one recorded continuation: the Task 576 unfinished shape or the Task 676 no-impediment shape. */
export function continuationInstruction(continuation: Pick<UnfinishedReturn, 'reason' | 'forgeStartedAt'>): string {
  if (continuation.reason === 'forge_transient') return `Your report records a transient Git or GitHub failure. Continue this task in the retained worktree. Wait with backoff from 5 seconds up to 60 seconds, observing the remote branch or existing PR before every retry of a push or PR creation; an unknown write may have succeeded. Retry until ${new Date((continuation.forgeStartedAt ?? Date.now()) + GIT_TRANSIENT_LIMIT_MS).toISOString()} before reporting blocked with the observed failure and elapsed wait. No new approval is needed.`;
  return continuation.reason === 'no_impediment' ? NO_IMPEDIMENT_CONTINUATION_INSTRUCTION : UNFINISHED_CONTINUATION_INSTRUCTION;
}

export function unfinishedContinuationEvents(events: Array<{ kind: string; detail: string }>): UnfinishedReturn[] {
  return events.flatMap(event => {
    if (event.kind !== 'unfinished_continuation') return [];
    try {
      const value = JSON.parse(event.detail) as UnfinishedReturn;
      return value.runId && ['worker', 'revision'].includes(value.role) && ['blocked', 'error'].includes(value.status) ? [value] : [];
    } catch { return []; }
  });
}

/** Report evidence identifies a forge operation as well as the shared network classifier. */
export function transientForgeReport(completion: Completion): boolean {
  if (completion.providerUnavailable || completion.sourceApproved || completion.awaitingProofs?.length) return false;
  const evidence = `${completion.summary}\n${completion.impediment ?? ''}`;
  return /\b(?:git push|push|PR creation|create (?:a |the )?PR|gh pr create|github|api\.github\.com)\b/i.test(evidence)
    && classifyGitCommandFailure({ stderr: evidence }) === 'network';
}

/**
 * Detect only a positively observed unchanged checkout and a report with no known external cause.
 * Task 676: a return with no `impediment` is the same-thread continuation's
 * (unfinishedReturnFor), so only a return that names its impediment reaches here.
 */
export function nonDeliveryFor(task: Task, run: Run | null, completion: Completion, events: Array<{ kind: string; detail: string }>): NonDelivery | null {
  const role = run ? run.role === 'revision' ? 'revision' : null : 'worker';
  if (!role || (completion.status !== 'blocked' && completion.status !== 'error') || !completion.impediment || transientForgeReport(completion)) return null;
  const runId = run?.id ?? task.runId;
  if (!runId || automaticRetryForbidden(task, run ? [run] : undefined) || reportsExternalCause(completion, events, runId)) return null;
  const baselineHead = run?.head ?? task.planningBase;
  if (!task.directory) return null;
  try {
    const observedHead = readGitCheckout(task.directory).head;
    if (observedHead !== baselineHead) return null;
    return { runId, role, status: completion.status, provider: run?.profile?.provider ?? task.profile?.provider ?? null,
      model: run?.profile?.model ?? task.profile?.model ?? null,
      baselineHead, observedHead };
  } catch {
    return null;
  }
}

export function nonDeliveryEvents(events: Array<{ kind: string; detail: string }>): NonDelivery[] {
  return events.flatMap(event => {
    if (event.kind !== 'non_delivery') return [];
    try {
      const value = JSON.parse(event.detail) as NonDelivery;
      return value.runId && ['worker', 'revision'].includes(value.role) && ['blocked', 'error'].includes(value.status) ? [value] : [];
    } catch { return []; }
  });
}

export function consecutiveNonDeliveries(events: Array<{ id?: number; kind: string; detail: string }>): NonDelivery[] {
  const ordered = events.slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  let sinceSuccess: NonDelivery[] = [];
  for (const event of ordered) {
    if (event.kind === 'non_delivery_reset') sinceSuccess = [];
    else if (event.kind === 'non_delivery') {
      const value = nonDeliveryEvents([event])[0];
      if (value) sinceSuccess.push(value);
    }
  }
  return sinceSuccess;
}
