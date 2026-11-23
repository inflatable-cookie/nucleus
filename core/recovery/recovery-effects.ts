import type { Run, Task } from "../../shared/contracts";
import { operationOccurrenceSettlement, type QueueOperation } from "../../shared/operations";
import {
  classifyReviewPublication,
  reviewPublicationKey,
  type ReviewPublicationClassification,
} from "../review/review-publication";
import type { Store } from "../store/store";

/** Read the task’s recorded effects without inferring their delivery from host history. */
const RECOVERY_EFFECT_VERSION = 2;

type RecoveryEffectState =
  | "absent"
  | "settled"
  | "in-flight"
  | "uncertain"
  | "invalid"
  | "superseded";
type RecoveryEffectKind =
  | "publication"
  | "operation"
  | "hook"
  | "review-delivery"
  | "run-delivery"
  | "merge-response"
  | "project-validation"
  | "attention-notice";

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

type RecoveryEffectsOptions = {
  /** Restrict per-run effects (publication, delivery, continuation) to one run. */
  runId?: string | null;
  /** Restrict the projection to these kinds. */
  kinds?: readonly RecoveryEffectKind[];
  /** Notice kinds whose unresolved delivery is an effect. Defaults to attention notices. */
  noticeKinds?: "attention" | "all";
};

/**
 * True for a state that genuinely blocks dependent lifecycle work. A
 * `superseded` publication is history, not a blocker: a later reviewer run of
 * the same retained reviewer at the same head applied a verdict with a
 * positive publication ID, and that verdict answers for the exact head.
 */
export const isBlockingRecoveryEffect = (effect: RecoveryEffect): boolean =>
  effect.state === "in-flight" ||
  effect.state === "uncertain" ||
  effect.state === "invalid";

/** Every effect the task currently records, in a stable lifecycle order. */
export function recoveryEffects(
  store: Store,
  task: Task,
  options: RecoveryEffectsOptions = {},
): RecoveryEffect[] {
  const wanted = options.kinds ? new Set(options.kinds) : null;
  const include = (kind: RecoveryEffectKind) => !wanted || wanted.has(kind);
  const scoped = (runId: string) => !options.runId || options.runId === runId;
  const effects: RecoveryEffect[] = [];
  const push = (effect: Omit<RecoveryEffect, "version">) => {
    effects.push({ version: RECOVERY_EFFECT_VERSION, ...effect });
  };

  // Durable operations. A deterministic completed result is history; only a
  // pending, running or needs_attention row still owes work.
  if (include("operation")) {
    for (const operation of store.unfinishedTaskOperations(task.id)) {
      const settled =
        operationOccurrenceSettlement(operation) ||
        (!operation.preSendBoundaryStartedAt &&
          operation.effect?.status === "reconciled");
      push({
        kind: "operation",
        identity: operation.id,
        taskId: task.id,
        runId: null,
        state:
          settled
            ? "superseded"
            : operation.state === "needs_attention"
              ? "uncertain"
              : "in-flight",
        reason: `task operation ${operation.id} (${operation.kind}) is ${operation.state}${operation.state === "needs_attention" && operation.diagnostic ? `: ${operation.diagnostic}` : ""}`,
        publication: null,
      });
    }
  }

  // Repository hooks. A required terminal failure is a real blocker; a
  // contradictory terminal result is invalid; an open state is in flight.
  // One exception: an occurrence the base-advance renewal superseded is
  // history, not an open effect, once a newer occurrence of the same gate
  // exists — the renewal settles the old record as `failed` precisely so the
  // fresh emission answers for the new base (task 620's post-retry fence
  // must not re-hold the superseded record).
  if (include("hook")) {
    // One list: store.hookEvents re-parses on every call, so occurrences are
    // compared by their durable record id, never by object identity.
    const hooks = store.hookEvents(task.id);
    const latestGateOccurrence = new Map<string, string>();
    for (const hook of hooks)
      latestGateOccurrence.set(`${hook.event}:${hook.hookId}`, hook.id);
    for (const hook of hooks) {
      if (hook.state === "superseded") continue;
      if (
        hook.baseAdvance &&
        latestGateOccurrence.get(`${hook.event}:${hook.hookId}`) !== hook.id
      )
        continue;
      const settledFailure = hook.state === "intent" && Boolean(hook.error);
      const state =
        hook.result?.outcome === "ok" &&
        ["result", "published"].includes(hook.state)
          ? "settled"
          : ["blocked", "failed"].includes(hook.state) || settledFailure
            ? "uncertain"
            : ["result", "published"].includes(hook.state)
              ? "invalid"
              : "in-flight";
      if (state === "settled") continue;
      push({
        kind: "hook",
        identity: hook.id,
        taskId: task.id,
        runId: null,
        state,
        reason: `repository hook ${hook.id} is ${hook.state}${hook.result?.outcome ? ` (${hook.result.outcome})` : ""}`,
        publication: null,
      });
    }
  }

  // Merge response. A genuinely uncertain unlanded response and a still-pending
  // unlanded intent both owe external evidence; a settled merge is history.
  if (include("merge-response")) {
    const uncertain =
      !task.resolution.mergedCommit &&
      (task.resolution.mergeResponseOutcome === "uncertain" ||
        task.resolution.mergeRetryOutcome === "uncertain");
    const pendingUnlanded = Boolean(
      task.resolution.mergeIntent &&
        !task.resolution.mergedCommit &&
        task.resolution.mergeResponseOutcome === "pending",
    );
    if (uncertain || pendingUnlanded) {
      push({
        kind: "merge-response",
        identity: "merge-response",
        taskId: task.id,
        runId: null,
        state: uncertain ? "uncertain" : "in-flight",
        reason: uncertain
          ? "an unlanded merge intent is uncertain"
          : "an unlanded merge intent awaits its response",
        publication: null,
      });
    }
  }

  // Project validation. A recorded non-passed run still owes evidence.
  const projectValidation = task.resolution.projectValidation;
  if (
    include("project-validation") &&
    projectValidation &&
    projectValidation.state !== "passed" &&
    projectValidation.state !== "superseded" &&
    (!task.prHead || projectValidation.head === task.prHead)
  ) {
    const state =
      projectValidation.state === "running" ? "in-flight" : "uncertain";
    push({
      kind: "project-validation",
      identity: "project-validation",
      taskId: task.id,
      runId: null,
      state,
      reason: `project validation is ${projectValidation.state}`,
      publication: null,
    });
  }

  for (const run of store.runs(task.id)) {
    if (!scoped(run.id)) continue;
    if (include("run-delivery") && run.status === "uncertain") {
      push({
        kind: "run-delivery",
        identity: run.id,
        taskId: task.id,
        runId: run.id,
        state: run.released ? "superseded" : "uncertain",
        reason: `run ${run.id} has an uncertain delivery`,
        publication: null,
      });
    }
    const publication = include("publication")
      ? classifyReviewPublication(store, task, run)
      : null;
    if (publication && publication.state !== "absent") {
      push({
        kind: "publication",
        identity: run.id,
        taskId: task.id,
        runId: run.id,
        state: publication.state,
        reason: publication.reason,
        publication,
      });
    }
    if (include("review-delivery")) {
      for (const delivery of run.reviewDeliveries ?? []) {
        const state =
          delivery.status === "reserved"
            ? "in-flight"
            : delivery.status === "uncertain"
              ? "uncertain"
              : "settled";
        if (state === "settled") continue;
        push({
          kind: "review-delivery",
          identity: delivery.deliveryId,
          taskId: task.id,
          runId: run.id,
          state,
          reason: `review delivery ${delivery.deliveryId} on run ${run.id} is ${delivery.status}`,
          publication: null,
        });
      }
    }
  }

  // A publication key can outlive the run row it names only as malformed or
  // legacy evidence. It can never be settled without the finished released
  // task-bound reviewer run, so an unbacked record stays uncertain or invalid.
  if (include("publication")) {
    const known = new Set(store.runs(task.id).map((run) => run.id));
    for (const identity of [task.runId, task.completion?.runId]) {
      if (!identity || known.has(identity) || !scoped(identity)) continue;
      const value = store.getMeta<unknown>(reviewPublicationKey(identity));
      if (value === undefined || value === null) continue;
      const object = typeof value === "object" && !Array.isArray(value);
      push({
        kind: "publication",
        identity,
        taskId: task.id,
        runId: identity,
        state: object ? "uncertain" : "invalid",
        reason: object
          ? "a retained publication record names no reviewer run for this task"
          : "retained publication record is not an object",
        publication: null,
      });
    }
  }

  // Attention notices. Only an intent or uncertain delivery still owes an
  // effect; pending notices are ordinary queue state owned elsewhere.
  if (include("attention-notice")) {
    for (const notice of store.notices(task.id)) {
      if (
        (options.noticeKinds ?? "attention") !== "all" &&
        notice.kind !== "attention"
      )
        continue;
      const state =
        notice.status === "intent"
          ? "in-flight"
          : notice.status === "uncertain"
            ? "uncertain"
            : "settled";
      if (state === "settled") continue;
      push({
        kind: "attention-notice",
        identity: notice.id,
        taskId: task.id,
        runId: null,
        state,
        reason: `attention notice ${notice.id} delivery is ${notice.status}`,
        publication: null,
      });
    }
  }

  const settled = new Set(
    task.resolution.ownerSettlements.flatMap((record) => record.recoveryKeys),
  );
  return effects.map((effect) =>
    settled.has(recoverySettlementKey(task, effect))
      ? {
          ...effect,
          state: "superseded" as const,
          reason: `Owner settled: ${effect.reason}`,
        }
      : effect,
  );
}

/** Stable occurrence identity; fixed-key effects carry the current attempt's identity. */
export function recoverySettlementKey(
  task: Task,
  effect: RecoveryEffect,
): string {
  const validation = task.resolution.projectValidation;
  const occurrence =
    effect.kind === "merge-response"
      ? (task.resolution.mergeRequestedAt ?? "")
      : effect.kind === "project-validation" && validation
        ? JSON.stringify([
            validation.hostRunId ?? null,
            validation.submittedAt ?? null,
            validation.head,
            validation.digest,
          ])
        : "";
  return JSON.stringify([effect.kind, effect.identity, occurrence]);
}

/** Every blocking effect, in the same stable order. */
export function blockingRecoveryEffects(
  store: Store,
  task: Task,
  options: RecoveryEffectsOptions = {},
): RecoveryEffect[] {
  return recoveryEffects(store, task, options).filter(isBlockingRecoveryEffect);
}

/**
 * Every task operation that still owes work: one that is pending or running, or
 * one whose uncertainty no later evidence has answered. A phase gate uses this
 * rather than the raw operation rows, so a superseded control the task has moved
 * past cannot hold review or merge (nucleus#1159).
 */
export function blockingTaskOperations(
  store: Store,
  task: Task,
  options: { excludeId?: string | null } = {},
): QueueOperation[] {
  const blocking = new Set(
    blockingRecoveryEffects(store, task, { kinds: ["operation"] }).map(
      (effect) => effect.identity,
    ),
  );
  return store
    .unfinishedTaskOperations(task.id)
    .filter(
      (operation) =>
        operation.id !== options.excludeId && blocking.has(operation.id),
    );
}

/** Refusal text for the complete blocking set, in projection order. */
export function blockingRecoveryEffectsRefusal(
  store: Store,
  task: Task,
  options: RecoveryEffectsOptions = {},
): string | null {
  const effects = blockingRecoveryEffects(store, task, options);
  const relevant = options.runId
    ? effects.filter((effect) => effect.runId === options.runId)
    : effects;
  return recoveryEffectsRefusal(relevant);
}

/** Format a selected blocking set without hiding secondary identities. */
export function recoveryEffectsRefusal(
  effects: readonly RecoveryEffect[],
): string | null {
  return effects.length ? effects.map(recoveryEffectRefusal).join("; ") : null;
}

/** A precise refusal line naming the effect, identity, state and reason. */
function recoveryEffectRefusal(effect: RecoveryEffect): string {
  return `${effect.kind} ${effect.identity} is ${effect.state}: ${effect.reason}`;
}
