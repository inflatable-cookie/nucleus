import type { Task } from '../../shared/contracts';
import type { VerifiedEnclosingOperation } from '../planning/enclosing-operation';
import { classifyReviewPublication, reviewPublicationKey, type ReviewPublicationClassification } from '../review/review-publication';
import { reviewCheckpointRefusal } from '../review/review-continuation';
import type { Store } from '../store/store';

/**
 * Spec 012/016/033/039/049: one read-only projection of the durable recovery
 * effects a task may still owe.
 *
 * Queue records a side effect as an intent before it happens and keeps the
 * record afterwards as idempotency evidence. A bare `getMeta` or guessed status
 * field therefore cannot answer "is this effect still pending": a settled
 * historical record would fence every later control, while a malformed or
 * contradictory one could slip past a truth test. This module derives one
 * canonical answer per recorded effect from the authenticated store.
 *
 * It is a projection, not a second source of truth: nothing is written, no
 * schema or flag is added. It judges effects only. It never decides content
 * approval, execution authority, profile policy, eligibility or action
 * prerequisites; each caller keeps its own identity, head, brief, profile and
 * lifecycle checks and consumes this projection for the effect question alone.
 * Creation and lease facts (an unreleased run, the current-run identity, or
 * workspace/agent intent) stay a caller-owned lifecycle prerequisite rather
 * than an effect row, so a replacement or continuation still requires every
 * other lease settled before it may act.
 */
const RECOVERY_EFFECT_VERSION = 2;

type RecoveryEffectState = 'absent' | 'settled' | 'in-flight' | 'uncertain' | 'invalid' | 'superseded';
type RecoveryEffectKind =
  | 'publication' | 'operation' | 'hook' | 'review-delivery' | 'run-delivery'
  | 'merge-response' | 'project-validation' | 'attention-notice';

/** Bounded owner-facing effect fact. `identity` is a run, operation, hook or delivery id. */
export type RecoveryEffect = {
  version: number;
  kind: RecoveryEffectKind;
  identity: string;
  taskId: string;
  runId: string | null;
  state: RecoveryEffectState;
  reason: string;
  /** Publication-only detail. Never a credential or provider secret. */
  publication: ReviewPublicationClassification | null;
};

/** Typed pre-send fence so an owner-settleable effect becomes a wait, not a recovery episode. */
export class BlockingRecoveryEffectsError extends Error {
  constructor(readonly effects: readonly RecoveryEffect[]) {
    super(recoveryEffectsRefusal(effects) ?? 'Blocking recovery effects remain unresolved');
    this.name = 'BlockingRecoveryEffectsError';
  }
}

type RecoveryEffectsOptions = {
  /**
   * The one internally authenticated enclosing operation to exclude
   * (Spec 012/317). Only `verifyEnclosingOperation`/`verifyEnclosingOperationMatching`
   * can produce this value, so a raw id can never suppress an effect.
   */
  enclosing?: VerifiedEnclosingOperation;
  /** Restrict per-run effects (publication, delivery, continuation) to one run. */
  runId?: string | null;
  /** Restrict the projection to these kinds. */
  kinds?: readonly RecoveryEffectKind[];
  /** Notice kinds whose unresolved delivery is an effect. Defaults to attention notices. */
  noticeKinds?: 'attention' | 'all';
};

/**
 * True for a state that genuinely blocks dependent lifecycle work. A
 * `superseded` publication is history, not a blocker: a later reviewer run of
 * the same retained reviewer at the same head applied a verdict with a
 * positive publication ID, and that verdict answers for the exact head.
 */
export const isBlockingRecoveryEffect = (effect: RecoveryEffect): boolean =>
  effect.state === 'in-flight' || effect.state === 'uncertain' || effect.state === 'invalid';

/**
 * Earlier builds settled Queue's own read-only fence refusals as uncertain,
 * because the refusal's prose named an uncertain effect. Such a row sent
 * nothing, so it owes nothing, and blocking on it made each later control add
 * another one (2026-11-04, paseo-northstar-queue#666). These refusals now throw
 * `DurableFenceRefusal` and settle failed; this reads only the old rows.
 */
const HISTORICAL_FENCE_REFUSALS = [
  'Task execution participants or effects are not settled',
  'Task execution participants or effects changed during external merge proof',
];
const historicalFenceRefusal = (operation: { kind: string; state: string; diagnostic?: string | null; preSendBoundaryStartedAt?: string | null }): boolean =>
  operation.kind === 'task_control' && operation.state === 'needs_attention' && !operation.preSendBoundaryStartedAt
  && Boolean(operation.diagnostic) && (HISTORICAL_FENCE_REFUSALS.some(prefix => operation.diagnostic!.startsWith(prefix))
    || operation.diagnostic!.endsWith('no effect-specific observer can yet settle it'));

/** Every effect the task currently records, in a stable lifecycle order. */
export function recoveryEffects(store: Store, task: Task, options: RecoveryEffectsOptions = {}): RecoveryEffect[] {
  const wanted = options.kinds ? new Set(options.kinds) : null;
  const include = (kind: RecoveryEffectKind) => !wanted || wanted.has(kind);
  const scoped = (runId: string) => !options.runId || options.runId === runId;
  const effects: RecoveryEffect[] = [];
  const push = (effect: Omit<RecoveryEffect, 'version'>) => { effects.push({ version: RECOVERY_EFFECT_VERSION, ...effect }); };

  // Durable operations. A deterministic completed result is history; only a
  // pending, running or needs_attention row still owes work. The single
  // authenticated enclosing operation (Spec 012/317) is not a competing effect.
  if (include('operation')) {
    for (const operation of store.operations({ taskId: task.id, states: ['pending', 'running', 'needs_attention'], limit: 1000 })) {
      if (options.enclosing && operation.id === options.enclosing.operationId) continue;
      if (historicalFenceRefusal(operation)) continue;
      push({ kind: 'operation', identity: operation.id, taskId: task.id, runId: null,
        state: operation.state === 'needs_attention' ? 'uncertain' : 'in-flight',
        reason: `task operation ${operation.id} (${operation.kind}) is ${operation.state}${operation.state === 'needs_attention' && operation.diagnostic ? `: ${operation.diagnostic}` : ''}`, publication: null });
    }
  }

  // Repository hooks. A required terminal failure is a real blocker; a
  // contradictory terminal result is invalid; an open state is in flight.
  // One exception: an occurrence the base-advance renewal superseded is
  // history, not an open effect, once a newer occurrence of the same gate
  // exists — the renewal settles the old record as `failed` precisely so the
  // fresh emission answers for the new base (task 620's post-retry fence
  // must not re-hold the superseded record).
  if (include('hook')) {
    // One list: store.hookEvents re-parses on every call, so occurrences are
    // compared by their durable record id, never by object identity.
    const hooks = store.hookEvents(task.id);
    const latestGateOccurrence = new Map<string, string>();
    for (const hook of hooks) latestGateOccurrence.set(`${hook.event}:${hook.hookId}`, hook.id);
    for (const hook of hooks) {
      if (hook.baseAdvance && latestGateOccurrence.get(`${hook.event}:${hook.hookId}`) !== hook.id) continue;
      const state = hook.result?.outcome === 'ok' && ['result', 'published'].includes(hook.state) ? 'settled'
        : ['blocked', 'failed'].includes(hook.state) ? 'uncertain'
          : ['result', 'published'].includes(hook.state) ? 'invalid' : 'in-flight';
      if (state === 'settled') continue;
      push({ kind: 'hook', identity: hook.id, taskId: task.id, runId: null, state,
        reason: `repository hook ${hook.id} is ${hook.state}${hook.result?.outcome ? ` (${hook.result.outcome})` : ''}`, publication: null });
    }
  }

  // Merge response. A genuinely uncertain unlanded response and a still-pending
  // unlanded intent both owe external evidence; a settled merge is history.
  if (include('merge-response')) {
    const uncertain = !task.resolution.mergedCommit
      && (task.resolution.mergeResponseOutcome === 'uncertain' || task.resolution.mergeRetryOutcome === 'uncertain');
    const pendingUnlanded = Boolean(task.resolution.mergeIntent && !task.resolution.mergedCommit && task.resolution.mergeResponseOutcome === 'pending');
    if (uncertain || pendingUnlanded) {
      push({ kind: 'merge-response', identity: 'merge-response', taskId: task.id, runId: null,
        state: uncertain ? 'uncertain' : 'in-flight',
        reason: uncertain ? 'an unlanded merge intent is uncertain' : 'an unlanded merge intent awaits its response', publication: null });
    }
  }

  // Project validation. A recorded non-passed run still owes evidence.
  const projectValidation = task.resolution.projectValidation;
  if (include('project-validation') && projectValidation && projectValidation.state !== 'passed'
      && projectValidation.state !== 'superseded' && (!task.prHead || projectValidation.head === task.prHead)) {
    const state = projectValidation.state === 'running' ? 'in-flight' : 'uncertain';
    push({ kind: 'project-validation', identity: 'project-validation', taskId: task.id, runId: null, state,
      reason: `project validation is ${projectValidation.state}`, publication: null });
  }

  for (const run of store.runs(task.id)) {
    if (!scoped(run.id)) continue;
    // `run-delivery` is the CREATION occurrence only. A lagging `uncertain` flag
    // after the bound agent started and its OWN authenticated checkpoint arrived
    // does not erase delivered work: that checkpoint proves the creation reached
    // this run, so the run itself is not an unknown effect. A checkpoint array
    // entry is not evidence by itself: it must carry its own accepted receipt,
    // owner-only file, ordinal/progress digest and run/head/brief binding (the
    // same proof every other checkpoint gate uses), including for a released
    // historical run. Its individual sends are judged by their own
    // `review-delivery` rows below.
    if (include('run-delivery') && run.status === 'uncertain') {
      const checkpoint = run.reviewCheckpoints?.at(-1);
      const creationProven = Boolean(run.agentId) && Boolean(checkpoint)
        && reviewCheckpointRefusal(store, task, run, checkpoint!) === null;
      if (!creationProven)
        push({ kind: 'run-delivery', identity: run.id, taskId: task.id, runId: run.id, state: 'uncertain',
          reason: `run ${run.id} has an uncertain delivery`, publication: null });
    }
    const publication = include('publication') ? classifyReviewPublication(store, task, run) : null;
    if (publication && publication.state !== 'absent') {
      push({ kind: 'publication', identity: run.id, taskId: task.id, runId: run.id, state: publication.state,
        reason: publication.reason, publication });
    }
    if (include('review-delivery')) {
      for (const delivery of run.reviewDeliveries ?? []) {
        const state = delivery.status === 'reserved' ? 'in-flight' : delivery.status === 'uncertain' ? 'uncertain' : 'settled';
        if (state === 'settled') continue;
        push({ kind: 'review-delivery', identity: delivery.deliveryId, taskId: task.id, runId: run.id, state,
          reason: `review delivery ${delivery.deliveryId} on run ${run.id} is ${delivery.status}`, publication: null });
      }
    }
  }

  // A publication key can outlive the run row it names only as malformed or
  // legacy evidence. It can never be settled without the finished released
  // task-bound reviewer run, so an unbacked record stays uncertain or invalid.
  if (include('publication')) {
    const known = new Set(store.runs(task.id).map(run => run.id));
    for (const identity of [task.runId, task.completion?.runId]) {
      if (!identity || known.has(identity) || !scoped(identity)) continue;
      const value = store.getMeta<unknown>(reviewPublicationKey(identity));
      if (value === undefined || value === null) continue;
      const object = typeof value === 'object' && !Array.isArray(value);
      push({ kind: 'publication', identity, taskId: task.id, runId: identity,
        state: object ? 'uncertain' : 'invalid',
        reason: object ? 'a retained publication record names no reviewer run for this task' : 'retained publication record is not an object',
        publication: null });
    }
  }

  // Attention notices. Only an intent or uncertain delivery still owes an
  // effect; pending notices are ordinary queue state owned elsewhere.
  if (include('attention-notice')) {
    for (const notice of store.notices(task.id)) {
      if ((options.noticeKinds ?? 'attention') !== 'all' && notice.kind !== 'attention') continue;
      const state = notice.status === 'intent' ? 'in-flight' : notice.status === 'uncertain' ? 'uncertain' : 'settled';
      if (state === 'settled') continue;
      push({ kind: 'attention-notice', identity: notice.id, taskId: task.id, runId: null, state,
        reason: `attention notice ${notice.id} delivery is ${notice.status}`, publication: null });
    }
  }

  const settled = new Set(task.resolution.ownerSettlements.flatMap(record => record.recoveryKeys));
  return effects.map(effect => settled.has(recoverySettlementKey(task, effect))
    ? { ...effect, state: 'superseded' as const, reason: `Owner settled: ${effect.reason}` } : effect);
}

/** Stable occurrence identity; fixed-key effects carry the current attempt's identity. */
export function recoverySettlementKey(task: Task, effect: RecoveryEffect): string {
  const validation = task.resolution.projectValidation;
  const occurrence = effect.kind === 'merge-response' ? task.resolution.mergeRequestedAt ?? ''
    : effect.kind === 'project-validation' && validation
      ? JSON.stringify([validation.hostRunId ?? null, validation.submittedAt ?? null, validation.head, validation.digest]) : '';
  return JSON.stringify([effect.kind, effect.identity, occurrence]);
}

/** Every blocking effect, in the same stable order. */
export function blockingRecoveryEffects(store: Store, task: Task, options: RecoveryEffectsOptions = {}): RecoveryEffect[] {
  return recoveryEffects(store, task, options).filter(isBlockingRecoveryEffect);
}

/** Refusal text for the complete blocking set, in projection order. */
export function blockingRecoveryEffectsRefusal(store: Store, task: Task, options: RecoveryEffectsOptions = {}): string | null {
  const effects = blockingRecoveryEffects(store, task, options);
  const relevant = options.runId ? effects.filter(effect => effect.runId === options.runId) : effects;
  return recoveryEffectsRefusal(relevant);
}

/** Format a selected blocking set without hiding secondary identities. */
export function recoveryEffectsRefusal(effects: readonly RecoveryEffect[]): string | null {
  return effects.length ? effects.map(recoveryEffectRefusal).join('; ') : null;
}

/** A precise refusal line naming the effect, identity, state and reason. */
function recoveryEffectRefusal(effect: RecoveryEffect): string {
  return `${effect.kind} ${effect.identity} is ${effect.state}: ${effect.reason}`;
}
