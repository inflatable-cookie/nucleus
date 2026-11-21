import type { Run, Task } from "../../shared/contracts";
import type { QueueOperation } from "../../shared/operations";
import type { VerifiedEnclosingOperation } from "../planning/enclosing-operation";
import {
  classifyReviewPublication,
  reviewPublicationKey,
  type ReviewPublicationClassification,
} from "../review/review-publication";
import { reviewCheckpointRefusal } from "../review/review-continuation";
import {
  digest,
  operationIdForKey,
  operationInputHash,
  type Store,
} from "../store/store";
import { readCreationAttempt } from "../store/store-task-funnel";
import { provenAbsentCreation } from "./absent-creation/decisions";
import { isHostReadExhaustedReason } from "./host-read-transient";

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

/** Typed pre-send fence so an owner-settleable effect becomes a wait, not a recovery episode. */
export class BlockingRecoveryEffectsError extends Error {
  constructor(readonly effects: readonly RecoveryEffect[]) {
    super(
      recoveryEffectsRefusal(effects) ??
        "Blocking recovery effects remain unresolved",
    );
    this.name = "BlockingRecoveryEffectsError";
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

/**
 * Earlier builds settled Queue's own read-only fence refusals as uncertain,
 * because the refusal's prose named an uncertain effect. Such a row sent
 * nothing, so it owes nothing, and blocking on it made each later control add
 * another one (2026-11-04, paseo-northstar-queue#666). These refusals now throw
 * `DurableFenceRefusal` and settle failed; this reads only the old rows.
 */
const HISTORICAL_FENCE_REFUSALS = [
  "Task execution participants or effects are not settled",
  "Task execution participants or effects changed during external merge proof",
];
export const historicalFenceRefusal = (operation: {
  kind: string;
  state: string;
  diagnostic?: string | null;
  preSendBoundaryStartedAt?: string | null;
}): boolean =>
  operation.kind === "task_control" &&
  operation.state === "needs_attention" &&
  !operation.preSendBoundaryStartedAt &&
  Boolean(operation.diagnostic) &&
  (HISTORICAL_FENCE_REFUSALS.some((prefix) =>
    operation.diagnostic!.startsWith(prefix),
  ) ||
    operation.diagnostic!.endsWith(
      "no effect-specific observer can yet settle it",
    ));

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
  // pending, running or needs_attention row still owes work. The single
  // authenticated enclosing operation (Spec 012/317) is not a competing effect.
  if (include("operation")) {
    for (const operation of store.operations({
      taskId: task.id,
      states: ["pending", "running", "needs_attention"],
      limit: 1000,
    })) {
      if (options.enclosing && operation.id === options.enclosing.operationId)
        continue;
      if (historicalFenceRefusal(operation)) continue;
      if (
        !operation.preSendBoundaryStartedAt &&
        operation.effect?.status === "reconciled" &&
        isHostReadExhaustedReason(operation.diagnostic)
      )
        continue;
      // A control whose host effect later evidence has answered is history for
      // this projection: it gates no phase, so it cannot hold review or merge
      // behind an uncertainty the task itself has already settled
      // (nucleus#1159). The reconciler records the same settlement.
      const answered = observedHostEffectEvidence(store, task, operation);
      if (answered) {
        push({
          kind: "operation",
          identity: operation.id,
          taskId: task.id,
          runId: null,
          state: "superseded",
          reason: `task operation ${operation.id} was answered by later evidence: ${answered}`,
          publication: null,
        });
        continue;
      }
      push({
        kind: "operation",
        identity: operation.id,
        taskId: task.id,
        runId: null,
        state:
          operation.state === "needs_attention" ? "uncertain" : "in-flight",
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
    // `run-delivery` is the CREATION occurrence only. A lagging `uncertain` flag
    // after the bound agent started and its OWN authenticated checkpoint arrived
    // does not erase delivered work: that checkpoint proves the creation reached
    // this run, so the run itself is not an unknown effect. A checkpoint array
    // entry is not evidence by itself: it must carry its own accepted receipt,
    // owner-only file, ordinal/progress digest and run/head/brief binding (the
    // same proof every other checkpoint gate uses), including for a released
    // historical run. Its individual sends are judged by their own
    // `review-delivery` rows below.
    if (
      include("run-delivery") &&
      run.status === "uncertain" &&
      !provenAbsentCreation(run)
    ) {
      const checkpoint = run.reviewCheckpoints?.at(-1);
      const creationProven =
        Boolean(run.agentId) &&
        Boolean(checkpoint) &&
        reviewCheckpointRefusal(store, task, run, checkpoint!) === null;
      const evidence = releasedRunDeliveryEvidence(store, run);
      if (evidence)
        push({
          kind: "run-delivery",
          identity: run.id,
          taskId: task.id,
          runId: run.id,
          state: "superseded",
          reason: `run ${run.id} delivery was settled: ${evidence}`,
          publication: null,
        });
      else if (!creationProven)
        push({
          kind: "run-delivery",
          identity: run.id,
          taskId: task.id,
          runId: run.id,
          state: "uncertain",
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

/** A released callback is terminal only when its own accepted receipt binds it. */
export function authenticatedCompletion(store: Store, run: Run): boolean {
  const completion = run.completion;
  if (
    !completion ||
    completion.taskId !== run.taskId ||
    completion.runId !== run.id ||
    (run.role === "reviewer" && completion.head !== run.head)
  )
    return false;
  const receipt = store.db
    .prepare(
      "SELECT hash,response FROM receipts WHERE id=? AND task=? AND run=?",
    )
    .get(completion.eventId, run.taskId, run.id) as
    | { hash?: string; response?: string }
    | undefined;
  try {
    if (!receipt || JSON.parse(receipt.response ?? "").accepted !== true)
      return false;
    const withoutReview = { ...completion };
    delete withoutReview.reviewId;
    const withoutComment = { ...completion };
    delete withoutComment.reviewCommentId;
    const withoutBoth = { ...withoutReview };
    delete withoutBoth.reviewCommentId;
    return [completion, withoutReview, withoutComment, withoutBoth].some(
      (value) => digest(JSON.stringify(value)) === receipt.hash,
    );
  } catch {
    return false;
  }
}

/** Evidence written by the delivery observer for this exact released run. */
export function releasedRunDeliveryEvidence(
  store: Store,
  run: Run,
): string | null {
  if (
    !run.released ||
    run.status !== "uncertain" ||
    !run.agentId ||
    !run.workspaceId
  )
    return null;
  const created = Date.parse(run.createdAt);
  if (!Number.isFinite(created)) return null;
  const checkpoint = run.reviewCheckpoints?.at(-1);
  if (
    checkpoint &&
    reviewCheckpointRefusal(store, store.task(run.taskId), run, checkpoint) ===
      null
  )
    return `accepted checkpoint ${checkpoint.ordinal} proves this run's creation`;
  const found = store.eventsAll(run.taskId).find((event) => {
    if (!(Date.parse(event.at) >= created)) return false;
    if (event.kind === "run_delivery_reconciled")
      return event.detail === `${run.id}: exact creation message observed`;
    return (
      event.kind === "run_delivery_not_delivered" &&
      (event.detail ===
        `${run.id}: agent ${run.agentId} archived; complete readable timeline has no ns-run-${run.id}` ||
        event.detail ===
          `${run.id}: agent ${run.agentId} closed; complete readable timeline has no ns-run-${run.id}`)
    );
  });
  return found ? `${found.kind} at ${found.at}: ${found.detail}` : null;
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

/** The durable supersession belongs only to this attempt of this operation. */
export function hasRecordedOperationSettlement(
  store: Store,
  task: Task,
  operation: QueueOperation,
): boolean {
  const settlement = operation.settlement;
  if (
    settlement &&
    settlement.id === operation.id &&
    settlement.inputHash === operation.inputHash &&
    settlement.attempt === operation.attempts &&
    settlement.intentAt === (operation.effect?.intentAt ?? null) &&
    settlement.evidence
  )
    return true;
  return store.eventsAll(task.id).some((event) => {
    if (event.kind !== "operation_superseded") return false;
    try {
      const record = JSON.parse(event.detail) as {
        id?: string;
        inputHash?: string;
        attempt?: number;
        intentAt?: string;
        evidence?: string;
      };
      return (
        record.id === operation.id &&
        record.inputHash === operation.inputHash &&
        record.attempt === operation.attempts &&
        record.intentAt === operation.effect?.intentAt &&
        typeof record.evidence === "string"
      );
    } catch {
      return false;
    }
  });
}

/**
 * A run Queue released from its own authenticated completion after the send.
 * The release alone is not proof: the agent may still be open and able to take
 * a late restart. It is displaced once the host proves its thread archived,
 * which is the same per-agent archive proof the ordinary archive path accepts.
 */
function releasedAfterArchivedCompletion(
  store: Store,
  task: Task,
  run: Run,
  events: ReturnType<Store["eventsAll"]>,
  boundary: number,
): boolean {
  if (!run.agentId || run.status !== "finished" || !authenticatedCompletion(store, run))
    return false;
  if (store.threadArchiveEffect(run.agentId, task.hostId)?.status !== "archived")
    return false;
  return events.some(
    (event) =>
      Date.parse(event.at) > boundary &&
      event.kind === "run_released_from_recorded_completion" &&
      event.detail === `${run.role} ${run.id}`,
  );
}

/**
 * An uncertain historical restart send whose only remaining step is
 * observation. The sweep's observer owns it, and no owner retry or pre-send
 * reconciliation applies before later evidence answers it. Operations that are
 * not uncertain, already carry a result, carry an execution-authored pre-send
 * receipt, or do not match a settled historical restart send stay outside this
 * classification so executable reconciliation remains accurately represented.
 */
export function observationOnlyRestartOperation(
  store: Store,
  operationId: string,
): boolean {
  const operation = store.operation(operationId);
  if (
    !operation ||
    operation.kind !== "task_control" ||
    operation.state !== "needs_attention" ||
    !operation.taskId ||
    !operation.expectedVersion ||
    operation.attempts <= 0 ||
    operation.result !== null ||
    operation.preSendReceipt != null ||
    operation.effect?.kind !== "task_control" ||
    operation.effect.target !== "restart" ||
    operation.effect.status !== "uncertain"
  )
    return false;
  const accepted = Date.parse(operation.createdAt);
  const started = Date.parse(operation.startedAt ?? "");
  const boundary = Date.parse(operation.settledAt ?? "");
  if (
    !Number.isFinite(accepted) ||
    !Number.isFinite(started) ||
    !Number.isFinite(boundary) ||
    started < accepted ||
    boundary < started ||
    operation.id !== operationIdForKey(operation.key)
  )
    return false;
  const payload = store.operationPayload(operation.id) as {
    control?: {
      action?: string;
      taskId?: string;
      version?: number;
    };
  } | null;
  return Boolean(
    payload &&
      operation.inputHash === operationInputHash(payload) &&
      payload.control?.action === "restart" &&
      payload.control.taskId === operation.taskId &&
      payload.control.version === operation.expectedVersion,
  );
}

/** Positive task-bound evidence that a control no longer owns the current step. */
export function observedHostEffectEvidence(
  store: Store,
  task: Task,
  operation: QueueOperation,
): string | null {
  if (
    operation.taskId !== task.id ||
    operation.state !== "needs_attention" ||
    (operation.hostId && operation.hostId !== task.hostId)
  )
    return null;
  if (operation.kind === "submit")
    return hasRecordedOperationSettlement(store, task, operation)
      ? "the occurrence has a durable supersession"
      : null;
  if (
    operation.kind !== "task_control" ||
    operation.effect?.kind !== "task_control" ||
    operation.effect.target !== "restart"
  )
    return null;
  if (hasRecordedOperationSettlement(store, task, operation))
    return "the occurrence has a durable supersession";
  const owner = task.resolution.ownerSettlements.find((record) =>
    record.recoveryKeys.includes(
      JSON.stringify(["operation", operation.id, ""]),
    ),
  );
  if (owner) return `owner settlement at ${owner.at}: ${owner.reason}`;
  const accepted = Date.parse(operation.createdAt);
  const boundary = Date.parse(operation.settledAt ?? "");
  const started = Date.parse(operation.startedAt ?? "");
  const events = store.eventsAll(task.id);
  const payload = store.operationPayload(operation.id) as {
    control?: {
      action?: string;
      taskId?: string;
      version?: number;
      role?: string;
      instruction?: string;
    };
  } | null;
  const control = payload?.control;
  if (
    Number.isFinite(accepted) &&
    Number.isFinite(started) &&
    Number.isFinite(boundary) &&
    started >= accepted &&
    boundary >= started &&
    operation.expectedVersion &&
    task.version > operation.expectedVersion &&
    control?.action === "restart" &&
    control.taskId === task.id &&
    control.version === operation.expectedVersion &&
    operation.id === operationIdForKey(operation.key) &&
    operation.inputHash === operationInputHash(payload) &&
    operation.attempts > 0 &&
    operation.effect.status === "uncertain"
  ) {
    // A terminal task answers a restart only once every possible participant
    // has been released. An untracked worker needs a direct archive
    // observation; a report or terminal phase cannot prove the target stopped.
    if (
      ["done", "cancelled"].includes(task.phase) &&
      (!operation.hostId || operation.hostId === task.hostId)
    ) {
      const runs = store.runs(task.id);
      const initial = task.runId
        ? runs.find((run) => run.id === task.runId)
        : null;
      if (
        runs.every((run) => run.released) &&
        ((!task.runId && !task.agentId) ||
          (initial?.released &&
            (!task.agentId || initial.agentId === task.agentId)) ||
          (task.agentId &&
            store.threadArchiveEffect(task.agentId, task.hostId)?.status ===
              "archived"))
      )
        return `terminal task ${task.phase} has no unreleased restart participant`;
    }
    // The initial worker has no Run row. Its durable pre-send intent names
    // the exact target; replacement records that identity before launching the
    // new worker and retains cleanup of the old thread.
    if (
      (!control.role || control.role === "worker") &&
      (!operation.hostId || operation.hostId === task.hostId)
    ) {
      for (const event of events) {
        if (
          event.kind !== "owner_restart_instruction_intent" ||
          !(Date.parse(event.at) >= started && Date.parse(event.at) <= boundary)
        )
          continue;
        try {
          const target = JSON.parse(event.detail) as {
            runId?: string;
            agentId?: string;
            messageId?: string;
          };
          if (!target.runId || !target.agentId) continue;
          const instruction =
            control.instruction?.trim() ||
            "Continue the existing task under its current approved instruction source and within its approved scope.";
          const messageId = `ns-owner-restart-${digest(`${task.id}:${target.runId}:${digest(instruction)}`).slice(0, 32)}`;
          if (target.messageId !== messageId) continue;
          const retired = task.retiredWorkers.some(
            (worker) =>
              worker.runId === target.runId &&
              worker.agentId === target.agentId,
          );
          const replacement = events.some(
            (item) =>
              item.kind === "worker_replacement" &&
              Date.parse(item.at) >= boundary &&
              item.id > event.id,
          );
          const isolated =
            task.runId &&
            task.agentId &&
            task.runId !== target.runId &&
            task.agentId !== target.agentId &&
            !store
              .runs(task.id)
              .some((run) => !run.released && run.agentId === target.agentId);
          if (retired && replacement && isolated)
            return `restart target ${target.runId} on ${target.agentId} was retired by worker replacement; its cleanup remains owed`;
        } catch {
          /* malformed intent is not target evidence */
        }
      }
    }
    const roles: Record<string, Run["role"][]> = {
      worker: ["revision"],
      reviewer: ["reviewer"],
      coordinator: ["recovery", "closeout"],
      executor: ["executor"],
    };
    const role = control.role
      ? roles[control.role]
      : ([
          "reviewer",
          "revision",
          "verification",
          "closeout",
          "recovery",
          "executor",
        ] as Run["role"][]);
    if (role) {
      const runs = store.runs(task.id);
      const roleRuns = runs.filter((run) => role.includes(run.role));
      const incompleteHistory = roleRuns.some(
        (run) => !Number.isFinite(Date.parse(run.createdAt)),
      );
      // A run positively released before acceptance was no longer a possible
      // target; it must not need a second release after this attempt.
      const releasedBefore = (run: Run) =>
        run.released &&
        events.some(
          (event) =>
            Date.parse(event.at) < accepted &&
            ((event.kind === "run_released_from_recorded_completion" &&
              event.detail === `${run.role} ${run.id}`) ||
              (event.kind === "run_released_from_observed_liveness" &&
                event.detail.startsWith(`${run.role} ${run.id}: `)) ||
              (run.role === "reviewer" &&
                run.status === "finished" &&
                Boolean(run.head) &&
                ["changes_required", "ready_to_merge"].includes(
                  run.completion?.status ?? "",
                ) &&
                (event.kind === "review_result_applied" ||
                  event.kind === "review_reapplied") &&
                event.detail === run.id &&
                authenticatedCompletion(store, run))),
        );
      const candidates = roleRuns.filter(
        (run) => Date.parse(run.createdAt) <= boundary && !releasedBefore(run),
      );
      const untrackedWorker =
        (!control.role || control.role === "worker") &&
        task.runId &&
        !runs.some((run) => run.id === task.runId);
      const absentRecoveryReleased = (run: Run): boolean => {
        if (
          run.role !== "recovery" ||
          run.agentId ||
          !run.released ||
          run.status !== "superseded" ||
          !(Date.parse(run.absentProvenAt ?? "") > boundary)
        )
          return false;
        const attempt = readCreationAttempt(store, run);
        return Boolean(
          attempt &&
            events.some((event) => {
              if (
                event.kind !== "absent_recovery_released" ||
                !(Date.parse(event.at) > boundary)
              )
                return false;
              try {
                const proof = JSON.parse(event.detail);
                return (
                  proof.runId === run.id &&
                  proof.attemptId === attempt.attemptId
                );
              } catch {
                return false;
              }
            }),
        );
      };
      const released = (run: Run) =>
        run.released &&
        Boolean(run.agentId) &&
        ["finished", "superseded"].includes(run.status) &&
        !(
          task.checkpoints.intent?.status === "pending" &&
          task.checkpoints.intent.runId === run.id
        ) &&
        !(
          task.resolution.stalledTurnStop?.runId === run.id &&
          task.resolution.stalledTurnStop.status !== "completed"
        ) &&
        !(run.reviewDeliveries ?? []).some(
          (delivery) =>
            delivery.status === "reserved" || delivery.status === "uncertain",
        ) &&
        !runs.some(
          (other) => !other.released && other.agentId === run.agentId,
        ) &&
        (events.some(
          (event) =>
            Date.parse(event.at) > boundary &&
            event.kind === "run_released_from_observed_liveness" &&
            event.detail.startsWith(`${run.role} ${run.id}: `),
        ) ||
          releasedAfterArchivedCompletion(store, task, run, events, boundary));
      const laterMove = events.some((event) => {
        if (event.kind !== "owner_control" || Date.parse(event.at) <= boundary)
          return false;
        try {
          const value = JSON.parse(event.detail) as {
            verb?: string;
            identities?: { taskId?: string; version?: number };
          };
          return (
            value.verb === "move" &&
            value.identities?.taskId === task.id &&
            typeof value.identities.version === "number" &&
            value.identities.version > operation.expectedVersion!
          );
        } catch {
          return false;
        }
      });
      const laterBinding = runs.some(
        (run) =>
          role.includes(run.role) &&
          Date.parse(run.createdAt) > boundary &&
          Boolean(run.agentId) &&
          candidates.every((old) => old.agentId !== run.agentId),
      );
      if (
        !untrackedWorker &&
        !incompleteHistory &&
        candidates.length &&
        candidates.every(
          (run) => absentRecoveryReleased(run) || released(run),
        ) &&
        (laterMove || laterBinding)
      )
        return `restart role ${control.role ?? "implicit"} targets ${candidates.map((run) => run.id).join(", ")} were released; ${laterMove ? "a later owner move" : "a later isolated run binding"} advanced the task`;
    }
  }
  const { mergedCommit, mergeHead } = task.resolution;
  if (
    !Number.isFinite(accepted) ||
    !Number.isFinite(boundary) ||
    boundary < accepted ||
    !task.prUrl ||
    !task.prHead ||
    mergeHead !== task.prHead ||
    !mergedCommit ||
    !["merging", "syncing", "closing", "done"].includes(task.phase) ||
    store.runs(task.id).some((run) => !run.released)
  )
    return null;
  const merge = events.find(
    (event) =>
      (event.kind === "merge_verified" ||
        event.kind === "external_merge_observed") &&
      Date.parse(event.at) > boundary,
  );
  return merge
    ? `exact PR head ${mergeHead} merged as ${mergedCommit} (${merge.kind} at ${merge.at})`
    : null;
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
    .operations({
      taskId: task.id,
      states: ["pending", "running", "needs_attention"],
      limit: 1000,
    })
    .filter(
      (operation) =>
        operation.id !== options.excludeId && blocking.has(operation.id),
    );
}

/** The two labels the review-dispatch wait records for itself, in that writer's terms. */
const REVIEW_EFFECT_WAIT =
  /^(?:Ordinary review|Review-entry) waits for (.+); settle it with retry_effect before continuing$/;

/**
 * The review-dispatch wait this task still records: the first moment it was
 * written, and the text it was written with. It is Queue's own sentence on both
 * sides — the writer is `RunLaunchDeliver`, the reader is the blocked-effect
 * bound — so a reworded writer cannot silently stop the bound from counting.
 * `since` is the lifecycle wait's own start, which a later lifecycle wait
 * inherits: that errs toward telling the owner sooner, never toward silence.
 */
export function reviewEffectWait(
  task: Task,
): { since: string; detail: string } | null {
  const stop = task.resolution.stop;
  if (
    !stop ||
    stop.reason !== "lifecycle" ||
    !REVIEW_EFFECT_WAIT.test(stop.detail)
  )
    return null;
  return { since: stop.since, detail: stop.detail };
}

/**
 * The blocking set a recorded review-dispatch wait names, for the lifecycle pass
 * that decides whether this phase still waits on exactly that set. The writer is
 * `RunLaunchDeliver`; decoding its sentence here is what keeps the reader from
 * rebuilding the writer's words.
 */
export function reviewEffectWaitRefusal(task: Task): string | null {
  const wait = reviewEffectWait(task);
  return wait ? (REVIEW_EFFECT_WAIT.exec(wait.detail)?.[1] ?? null) : null;
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

/** A still-current uncertain control cannot be replayed by a new owner action. */
export function unsettledControlRefusal(
  store: Store,
  task: Task,
  observingOperationId?: string,
): string | null {
  return recoveryEffectsRefusal(
    blockingRecoveryEffects(store, task, { kinds: ["operation"] }).filter(
      (effect) => {
        if (
          effect.state !== "uncertain" ||
          effect.identity === observingOperationId
        )
          return false;
        const operation = store.operation(effect.identity);
        return (
          operation?.kind === "task_control" &&
          ["restart", "route"].includes(operation.effect?.target ?? "")
        );
      },
    ),
  );
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
