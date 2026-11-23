import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isReviewerVerdict, VERDICT_ONLY_CREDENTIAL } from "./store-auth";
import {
  completionMembership,
  holdsOf,
  isOperatorOrigin,
  noticeTaskLine,
  resolutionSchema,
  retiredSubmissionRefusal,
  syncHoldProjection,
  TASK_OWNER_HOLD,
  taskOwner,
  type Completion,
  type Lane,
  type Notice,
  type Outcome,
  type Papercut,
  type Project,
  type Run,
  type RuntimeRetirement,
  type Submission,
  type Task,
  type TaskHolds,
} from "../../shared/contracts";
import { hookStateIsTerminal, type HookRecord } from "../../shared/hooks";
import { externalWorkspace } from "../../shared/workspace-ownership";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import {
  operationIsSettled,
  type QueueOperation,
} from "../../shared/operations";
import { telemetryStageForTask } from "../../shared/telemetry";
import {
  DISPATCH_WAIT_REASON,
  endsStopOnReason,
  taskDecisionFact,
} from "../../shared/task-stop";
import { EMPTY_RUN_USAGE } from "../telemetry/run-usage";
import { TaskChangedRefusal } from "../../shared/task-version";
import { restartSlotObsolete } from "../dispatch/capacity";
import {
  plainProfileRequest,
  workerThinkingConflict,
} from "../dispatch/routing";
import { submissionNeedsPermission } from "../../shared/pool";
import { runBuildOutputIntent } from "../hooks/build-output-records";
import { initialBriefVersion } from "../planning/brief";
import { laneSnapshot } from "../planning/lanes";
import { STEPS_RETIRED_REASON } from "../recovery/retired-steps";
import { runtimeRetirementFailure } from "../../shared/contracts";
import { stageDeclarationFromBrief } from "../stages";
import { digest, now } from "./store-core";
import type { BudgetClock } from "../../shared/task-budget";
import { buildOutcomeRecord } from "./store-outcomes";
import { submissionHash } from "./store-submissions";
import { STORED_OBSERVATION_FIELDS } from "./store-task-writes";
import type { UsageLevel } from "../../shared/contracts";
import { repositoryIdentity, type StoreTasks } from "./store-tasks";

// One lifecycle writer owns the store. An opaque process identity cannot be
// mistaken for the previous writer after a service roll or PID reuse.
export const creationProducerId = randomUUID();
const creationReserved = "creation_attempt_reserved";
const creationSettled = "creation_attempt_settled";
export type CreationBinding = Pick<Run, "id" | "taskId" | "hostId"> & {
  workspaceId: string | null;
  role: Run["role"] | "worker";
};
type CreationReservation = CreationBinding & {
  producerId: string;
  attemptId: string;
};
type CreationOutcome = "returned" | "threw";
type CreationSettlement = { attemptId: string; outcome: CreationOutcome };
export type CreationAttempt = CreationReservation & {
  reservedAt: string;
  settlement: (CreationSettlement & { at: string }) | null;
};
type CreationJournal = Pick<TaskFunnelServices, "db" | "event" | "transaction">;

function reserveCreation(store: CreationJournal, binding: CreationBinding) {
  const reservation: CreationReservation = {
    ...binding,
    producerId: creationProducerId,
    attemptId: randomUUID(),
  };
  store.event(binding.taskId, creationReserved, JSON.stringify(reservation));
}

function creationAttemptSettlement(
  store: Pick<CreationJournal, "db">,
  taskId: string,
  attemptId: string,
): CreationAttempt["settlement"] {
  const settled = store.db
    .prepare(
      `
    SELECT detail, at FROM events WHERE taskId=? AND kind=?
    AND CASE WHEN json_valid(detail) THEN json_extract(detail,'$.attemptId') END=?
    ORDER BY id DESC LIMIT 1
  `,
    )
    .get(taskId, creationSettled, attemptId);
  return settled
    ? {
        ...(JSON.parse(String(settled.detail)) as CreationSettlement),
        at: String(settled.at),
      }
    : null;
}

/** The task's indexed event journal retains both sides of each creation attempt. */
export function readCreationAttempt(
  store: Pick<CreationJournal, "db">,
  binding: CreationBinding,
): CreationAttempt | null {
  const reserved = store.db
    .prepare(
      `
    SELECT detail, at FROM events WHERE taskId=? AND kind=?
    AND CASE WHEN json_valid(detail) THEN json_extract(detail,'$.id') END=?
    ORDER BY id DESC LIMIT 1
  `,
    )
    .get(binding.taskId, creationReserved, binding.id);
  if (!reserved) return null;
  const reservation: CreationReservation = JSON.parse(String(reserved.detail));
  if (
    !reservation.producerId ||
    !reservation.attemptId ||
    reservation.taskId !== binding.taskId ||
    reservation.hostId !== binding.hostId ||
    reservation.workspaceId !== binding.workspaceId ||
    reservation.role !== binding.role
  )
    return null;
  return {
    ...reservation,
    reservedAt: String(reserved.at),
    settlement: creationAttemptSettlement(
      store,
      binding.taskId,
      reservation.attemptId,
    ),
  };
}

/** Capture termination before starting the inventory read that can prove absence. */
export function creationTermination(
  store: Pick<CreationJournal, "db">,
  binding: CreationBinding,
  graceMs: number,
) {
  const attempt = readCreationAttempt(store, binding);
  if (!attempt) return null;
  const terminatedBy = attempt.settlement
    ? "call_settled"
    : attempt.producerId !== creationProducerId
      ? "service_replaced"
      : null;
  const since = Date.parse(attempt.settlement?.at ?? attempt.reservedAt);
  return terminatedBy && Date.now() - since >= graceMs
    ? { attemptId: attempt.attemptId, terminatedBy }
    : null;
}

export function settleCreationAttempt(
  store: CreationJournal,
  attempt: CreationAttempt,
  outcome: CreationOutcome,
): void {
  store.transaction(() => {
    const reserved = store.db
      .prepare(
        `
      SELECT 1 FROM events WHERE taskId=? AND kind=?
      AND CASE WHEN json_valid(detail) THEN json_extract(detail,'$.attemptId') END=? LIMIT 1
    `,
      )
      .get(attempt.taskId, creationReserved, attempt.attemptId);
    if (
      !reserved ||
      creationAttemptSettlement(store, attempt.taskId, attempt.attemptId)
    )
      return;
    const settlement: CreationSettlement = {
      attemptId: attempt.attemptId,
      outcome,
    };
    store.event(attempt.taskId, creationSettled, JSON.stringify(settlement));
  });
}

/**
 * The store services the task and run funnels call. The funnel is the single writer of task
 * and run rows; everything here is a service it reads or records into, never another write
 * funnel, so a write has exactly one path to the tables.
 */
export interface TaskFunnelServices {
  readonly db: DatabaseSync;
  readonly tasksStore: StoreTasks;
  /** Spec 052 (Tom, 2026-11-17): the usage level in force at admission, read once for the Low submission gate. */
  usageLevel(): UsageLevel;
  transaction<T>(fn: () => T): T;
  task(id: string): Task;
  event(taskId: string, kind: string, detail: string): void;
  advanceRevision(): void;
  taskChanged(taskId: string | null): void;
  taskCountChanged(): void;
  taskRow(task: Task, before?: Task | null): string;
  syncTaskObservation(taskId: string, task: Task): void;
  resolveReviewRows(
    rows: Array<{ seq: number; data: string }>,
  ): Pick<Task["resolution"], "review" | "reviews">;
  runObservationOnly(run: Run): boolean;
  run(id: string): Run | null;
  queueRunCleanup(run: {
    id: string;
    taskId: string;
    hostId?: string;
    agentId?: string | null;
    temporaryDirectory?: string;
  }): void;
  queueRunReportingCleanup(runId: string, taskId: string): void;
  get path(): string;
  dependencyWait(task: Pick<Task, "dependsOn">): string;
  taskReference(
    id: string,
  ): { title: string; phase: string; removedAt?: string | null } & Record<
    string,
    unknown
  >;
  existing(input: Submission): Task | null;
  validateDependencies(input: Submission): void;
  requireAttachableLanes(
    keys: string[],
    repoPath: string,
    origin?: string | null,
  ): Lane[];
  requireLaneDocuments(
    keys: string[],
    repoPath: string,
    origin?: string | null,
  ): void;
  ensureProject(repoPath: string, origin?: string | null): Project;
  assignNumber(
    taskId: string,
    repository: string,
  ): { number: number; reference: string };
  setCredential(run: string, token: string): void;
  putNotice(notice: Notice): void;
  notices(taskId?: string): Notice[];
  runs(taskId?: string): Run[];
  hookEvents(taskId?: string): HookRecord[];
  operations(filter: {
    states?: QueueOperation["state"][];
    taskId?: string;
    limit?: number;
  }): QueueOperation[];
  operation(id: string): QueueOperation | null;
  putOutcome(record: Outcome): Outcome;
  completePapercutsForTask(task: Task): Papercut[];
  receipt(
    input: Completion,
    token: string,
    credentialRunId?: string,
  ): { accepted: true; eventId: string } | null;
  setCompletionReceipt(
    id: string,
    task: string,
    run: string,
    hash: string,
    response: string,
  ): void;
  threadArchiveEffect(
    agentId: string,
    hostId?: string | null,
  ): { status?: string } | undefined;
}

/**
 * The task and run write funnels: the one path that produces a task row or a run row, and
 * every rule that belongs to that write (the optimistic version, the observation-only split,
 * the hold and stop reconciliation, completion notices, papercut closure, run host pinning
 * and credential revocation on release). Rules that only *derive* a fact live beside it in
 * `task-write-facts.ts`.
 */
export class StoreTaskFunnel {
  constructor(private readonly services: TaskFunnelServices) {}
  insert(
    input: Submission,
    hostId: string,
    handoffText: string,
    planningBase: string,
    initial: Partial<Task> = {},
    credential?: {
      runId: string;
      token: string;
      prepare?: (task: Task) => void;
    },
    origin?: string | null,
  ): Task {
    const insert = () => {
      this.services.tasksStore.syncProjectionForWrite();
      if (input.proofOnly && !input.proofExecution)
        throw new Error("queue.proofOnly requires queue.proofExecution");
      if (input.requiresOperatorGo && !input.proofOnly)
        throw new Error(
          "queue.requiresOperatorGo is only valid with queue.proofOnly",
        );
      const existing = this.services.existing(input);
      if (existing) return existing;
      this.services.validateDependencies(input);
      // Every task row is created here, so no intake path can create a staged task (Spec 043);
      // a replay of an existing historical submission still returns its task above.
      if (input.brief && stageDeclarationFromBrief(input.brief.text))
        throw new Error(STEPS_RETIRED_REASON);
      // Spec 058: a responsible task merges on reviewer approval plus Queue's
      // mechanical gates. The manual evidence-only oracle is a verification
      // coordinator, so it cannot select a different lifecycle.
      // Spec 058 cutover 2: a brief states its outcome and acceptance in prose;
      // the structured verdict opt-in, pass gate and manual verification are
      // retired. Their shapes and this refusal are one owner's
      // (`shared/schema/review/retired-submission.ts`), and the optional
      // persisted fields stay readable for stored rows.
      const retiredRefusal = retiredSubmissionRefusal({
        manualVerification: input.manualVerification,
        reviewVerdicts: input.reviewVerdicts,
        reviewPassGate: input.reviewPassGate,
      });
      if (retiredRefusal) throw new Error(retiredRefusal);
      // Every new task runs the responsible lifecycle.
      const responsible = input.responsible ?? true;
      // Task 1109: a task's planner is a thread that answers its planning questions;
      // the operator answers no delegated question, so a named planner cannot be it.
      if (input.plannerAgentId && isOperatorOrigin(input.plannerAgentId))
        throw new Error(
          "The operator is not a thread; name a planner thread or leave the task to its owner",
        );
      const thinkingConflict = workerThinkingConflict(
        input.thinkingOptionId,
        input.profileRequests?.worker,
      );
      if (thinkingConflict) throw new Error(thinkingConflict);
      const id = randomUUID();
      if (initial.hostSelection && initial.hostSelection.hostId !== hostId)
        throw new Error("Task host selection does not match host");
      const pinnedAt = now();
      const briefVersions = initialBriefVersion(input, pinnedAt);
      const attached = input.lanes.length
        ? this.services.requireAttachableLanes(
            input.lanes,
            input.repoPath,
            origin,
          )
        : [];
      if (input.laneDocuments?.length)
        this.services.requireLaneDocuments(
          input.laneDocuments,
          input.repoPath,
          origin,
        );
      const repository = repositoryIdentity(input.repoPath, origin);
      this.services.ensureProject(
        input.repoPath,
        normalizeRepositoryOrigin(origin ?? repository),
      );
      const assigned = this.services.assignNumber(id, repository);
      // Spec 052 (Tom, 2026-11-17): the Low submission gate is decided at
      // admission, not by the level that happens to be in force later. The
      // reconciler opens its one decision and fence from this record.
      const usageLevel = this.services.usageLevel();
      const usageGate =
        submissionNeedsPermission(usageLevel, input.complexity) &&
        input.complexity
          ? {
              decisionId: null,
              status: "pending" as const,
              level: usageLevel,
              complexity: input.complexity,
              holdAt: null,
              at: now(),
              note: "",
            }
          : null;
      const task: Task = {
        ...input,
        ...(usageGate ? { usageGate } : {}),
        critical: input.critical ?? false,
        ...(responsible === undefined ? {} : { responsible }),
        repository,
        ...assigned,
        brief: input.brief
          ? { ...input.brief, digest: briefVersions[0].digest }
          : null,
        id,
        createdAt: now(),
        updatedAt: now(),
        version: 1,
        papercutTask: input.planningSource?.kind === "papercut",
        entrypoint: input.proofOnly ? "proof" : "worker",
        reviewEntry: null,
        originWorkspaceId: null,
        notificationAgentId: isOperatorOrigin(input.originAgentId)
          ? null
          : input.originAgentId,
        originError: "",
        originLookupError: "",
        presentationDetached: null,
        presentationParent: null,
        creatorCompletionRecipients: [],
        completionSubscriptionOverrides: [],
        completionNotificationCohort: null,
        removedAt: null,
        finishedAt: null,
        queuePriority: 0,
        prerequisiteWait: null,
        phase: "queued",
        reason: DISPATCH_WAIT_REASON,
        reasonFact: { code: "dispatch" },
        held: false,
        mergeHold: false,
        budgetSince: null,
        holdOwner: null,
        holdReason: null,
        holdAt: null,
        holdGeneration: 0,
        holdBlocking: null,
        holdUntil: null,
        holds: {},
        lastSubstantiveVersion: 1,
        handoffText,
        planningBase,
        proofExecutions: [],
        proofFiles: [],
        proofExecutionRetired: false,
        proofOnlyResult: null,
        proofReceiptAcceptance: null,
        workspaceId: null,
        directory: null,
        branch: input.proofOnly ? "" : `ns-${id}`,
        workspaceAllocation: null,
        workspaceOwnership: "queue",
        agentId: null,
        runId: null,
        profile: null,
        profileGroup: null,
        failoverReason: "",
        replacementProfile: null,
        workerExclusions: [],
        resumePrNumber: null,
        retiredWorkers: [],
        workspaceIntent: false,
        agentIntent: false,
        lastAgentStatus: null,
        idleSince: null,
        completion: null,
        agentActive: null,
        lastObservedAt: null,
        prUrl: null,
        prHead: null,
        coordinatorGeneration: 1,
        resolution: resolutionSchema.parse({}),
        checkpoints: { records: [], intent: null },
        workerModel: null,
        workerModels: [],
        briefVersions,
        briefRuns: [],
        siblingPins: [],
        siblingFindings: [],
        siblingIntent: false,
        checkoutSiblingFindings: [],
        stashBaseline: null,
        ...laneSnapshot(attached),
        ...initial,
        hostId,
        ...(hostId
          ? {
              hostSelection: initial.hostSelection ?? {
                hostId,
                basis:
                  input.hostId === hostId ? "explicit" : "sole_online_host",
              },
            }
          : {}),
        originHostId: Object.prototype.hasOwnProperty.call(
          initial,
          "originHostId",
        )
          ? initial.originHostId
          : hostId || undefined,
        disposition: initial.disposition ?? null,
        prLookup: initial.prLookup ?? null,
      };
      // Spec 050: the `ownerRoute` marker is route-only. A submission never
      // carries it, so strip it here rather than trusting the input record.
      for (const role of ["worker", "reviewer", "coordinator"] as const) {
        if (task.profileRequests?.[role])
          task.profileRequests = {
            ...task.profileRequests,
            [role]: {
              ...plainProfileRequest(task.profileRequests[role]!),
              requestedBy: input.originAgentId,
            },
          };
      }
      const composedHolds: TaskHolds = { ...(initial.holds ?? {}) };
      if (input.mergeHold === true && !composedHolds.merge) {
        composedHolds.merge = {
          owner: TASK_OWNER_HOLD,
          reason: input.mergeHoldReason ?? "not recorded",
          at: now(),
          generation: 1,
          until: null,
          plannerAnswer: null,
        };
      }
      Object.assign(task, syncHoldProjection(composedHolds));
      if (credential) {
        credential.prepare?.(task);
        this.services.setCredential(credential.runId, credential.token);
      }
      const validated = this.services.tasksStore.validatedTask(task);
      this.services.db
        .prepare("INSERT INTO tasks VALUES(?,?,?,?)")
        .run(
          id,
          input.submissionId,
          submissionHash(input),
          this.services.taskRow(task),
        );
      if (this.services.tasksStore.taskProjection) {
        this.services.tasksStore.setProjectedTask(validated);
        this.services.tasksStore.integrationTaskIndex = null;
        this.services.tasksStore.taskProjectionOrder.unshift(id);
      }
      this.services.taskCountChanged();
      this.services.advanceRevision();
      this.services.event(
        id,
        "submitted",
        `Origin: ${input.originAgentId}; planning ${input.planningCommit}; PR review: ${input.skipPRReview ? "skipped by submission" : "required"}${briefVersions.length ? `; Queue-held brief v1 ${briefVersions[0].digest}` : ""}${attached.length ? `; lanes ${attached.map((lane) => lane.key).join(", ")}` : ""}`,
      );
      this.services.event(id, "telemetry_stage", telemetryStageForTask(task));
      return task;
    };
    return this.services.db.isTransaction
      ? insert()
      : this.services.transaction(insert);
  }

  update(
    id: string,
    change: Partial<Task> & { attention?: never },
    kind?: string,
    detail = "",
    expected?: number,
  ): Task {
    if (!this.services.db.isTransaction)
      return this.services.transaction(() =>
        this.update(id, change, kind, detail, expected),
      );
    this.services.tasksStore.syncProjectionForWrite();
    const task = this.services.task(id);
    if (expected !== undefined && task.version !== expected)
      throw new TaskChangedRefusal(
        "Task changed; refresh before retrying",
        expected,
        task.version,
      );
    // First dispatch binds the chosen worker host together with its workspace intent.
    // Once any run or workspace intent exists, no ordinary update can move it.
    const bindsWorkerHost =
      kind === "dispatch_intent" &&
      task.phase === "queued" &&
      task.hostSelection?.basis !== "worker_profile" &&
      !task.profile &&
      change.phase === "dispatching" &&
      !task.workspaceId &&
      !task.workspaceIntent &&
      !task.directory &&
      !task.agentIntent &&
      !task.agentId &&
      !task.runId &&
      !task.completion &&
      !task.prUrl &&
      !task.prHead &&
      !task.resumePrNumber &&
      !task.retiredWorkers.length &&
      !task.resolution.currentRunId &&
      this.services.db
        .prepare("SELECT 1 FROM runs WHERE taskId=? LIMIT 1")
        .get(id) === undefined &&
      change.hostSelection?.basis === "worker_profile" &&
      change.hostSelection.hostId === change.hostId;
    const movesWorkerHost =
      kind === "worker_host_moved" &&
      Boolean(change.hostId) &&
      change.hostId !== task.hostId &&
      change.hostSelection?.basis === "worker_profile" &&
      change.hostSelection.hostId === change.hostId &&
      !change.agentId &&
      !change.agentIntent &&
      !change.workspaceId &&
      !change.workspaceIntent &&
      (
        this.services.db
          .prepare("SELECT data FROM runs WHERE taskId=?")
          .all(id) as Array<{ data: string }>
      ).every((row) => {
        try {
          return JSON.parse(row.data).released === true;
        } catch {
          return false;
        }
      });
    const allowHostChange = bindsWorkerHost || movesWorkerHost;
    if (
      change.hostId !== undefined &&
      change.hostId !== task.hostId &&
      !allowHostChange
    )
      throw new Error("Task host cannot be changed by an update");
    if (
      change.hostSelection !== undefined &&
      JSON.stringify(change.hostSelection) !==
        JSON.stringify(task.hostSelection) &&
      !allowHostChange
    )
      throw new Error("Task host selection cannot be changed by an update");
    if (!allowHostChange) {
      const { hostSelection: _selection, ...remainingChange } = change;
      change = remainingChange;
    }
    if (
      change.originHostId !== undefined &&
      change.originHostId !== task.originHostId &&
      kind !== "owner_changed"
    )
      throw new Error("Origin host cannot be changed by an ordinary update");
    // Spec 069 §3, one owner per field: a stop belongs to its writer, which
    // records and clears it explicitly. A write that changes only `reason` never
    // clears it (two writers alternating made a stop oscillate on 22 Nov). A
    // lifecycle write, one that names `phase`, still ends the stop's episode when
    // it moves the phase or the reason (an owner move to the phase the task is
    // already in included), unless it names a new stop. A write that re-asserts
    // the same phase and reason changes nothing, as before.
    const lifecycleChanged =
      change.phase !== undefined &&
      (change.phase !== task.phase ||
        (change.reason !== undefined && change.reason !== task.reason));
    const hasExplicitStop =
      change.resolution !== undefined &&
      Object.prototype.hasOwnProperty.call(change.resolution, "stop");
    const stopRepeatsCurrent =
      hasExplicitStop &&
      JSON.stringify(change.resolution!.stop) ===
        JSON.stringify(task.resolution.stop);
    if (
      lifecycleChanged &&
      kind !== "owner_resolution" &&
      (!hasExplicitStop || stopRepeatsCurrent)
    ) {
      change = {
        ...change,
        resolution: {
          ...task.resolution,
          ...(change.resolution ?? {}),
          stop: null,
        },
      };
    }
    const terminal = ["done", "cancelled"].includes(change.phase ?? task.phase);
    const finishedAt =
      change.phase && change.phase !== task.phase
        ? terminal
          ? now()
          : null
        : task.finishedAt;
    const observationFields = new Set<string>(STORED_OBSERVATION_FIELDS);
    const observationStateFields = new Set<string>([
      "agentActive",
      "lastAgentStatus",
      "idleSince",
    ]);
    const changedFields = Object.keys(change);
    const observationOnly =
      changedFields.length > 0 &&
      changedFields.every((field) => observationFields.has(field));
    const observationStateChanged =
      observationOnly &&
      changedFields.some(
        (field) =>
          observationStateFields.has(field) &&
          !Object.is(task[field as keyof Task], change[field as keyof Task]),
      );
    const bumpVersion = !observationOnly || observationStateChanged;
    let next = {
      ...task,
      ...change,
      ...(change.reason !== undefined &&
      change.reason !== task.reason &&
      change.reasonFact === undefined
        ? { reasonFact: taskDecisionFact(change.reason) }
        : {}),
      ...(terminal ? { queuePriority: 0 } : {}),
      finishedAt,
      id: task.id,
      originAgentId: task.originAgentId,
      notifyOriginOnCloseout: task.notifyOriginOnCloseout,
      completionNotificationAgentIds: task.completionNotificationAgentIds,
      creatorCompletionRecipients: task.creatorCompletionRecipients,
      version: task.version + (bumpVersion ? 1 : 0),
      lastSubstantiveVersion: observationOnly
        ? (task.lastSubstantiveVersion ?? task.version)
        : task.version + 1,
      updatedAt: now(),
    };
    // Audit B6: an observation that changes no board fact writes only `task_observations`.
    // The task row, its version, its substantive-version marker and the board revision all
    // stay where they were, and every reader still sees the values the parent write produced:
    // the moved observation time, the moved write time and the same hold projection.
    if (observationOnly && !observationStateChanged) {
      // The substantive-version marker stays exactly as the row holds it, so the row this
      // write does not touch and the projected copy a reader gets stay the same record.
      const observed = {
        ...next,
        lastSubstantiveVersion: task.lastSubstantiveVersion,
      };
      const validated = this.services.tasksStore.validatedTask(observed);
      this.services.syncTaskObservation(id, observed);
      if (this.services.tasksStore.taskProjection) {
        this.services.tasksStore.setProjectedTask(validated);
        this.services.tasksStore.integrationTaskIndex = null;
        // The observation row write advanced the projection's `writes` clock. The maps
        // already hold this write, so acknowledge that clock here — after they are
        // consistent and before any synchronous observer below reads the task. An
        // unacknowledged clock makes that read discard the warm projection and re-parse
        // every task row, which is the audit's observation hot path. This is the same
        // ordering as this funnel's substantive branch and `putRun()`.
        this.services.tasksStore.projectionClock =
          this.services.tasksStore.readProjectionClock();
      }
      const previousStage = telemetryStageForTask(task),
        observedStage = telemetryStageForTask(observed);
      const hasStage = Boolean(
        this.services.db
          .prepare(
            "SELECT 1 FROM events WHERE taskId=? AND kind='telemetry_stage' LIMIT 1",
          )
          .get(id),
      );
      if (!hasStage || previousStage !== observedStage)
        this.services.event(id, "telemetry_stage", observedStage);
      this.services.tasksStore.projectionClock =
        this.services.tasksStore.readProjectionClock();
      this.services.taskChanged(id);
      return observed;
    }
    if (change.holds) Object.assign(next, syncHoldProjection(change.holds));
    else if (change.held === false && change.holds === undefined)
      Object.assign(next, syncHoldProjection({}));
    else if (change.holds === undefined) {
      const fences: TaskHolds = { ...(next.holds ?? {}) };
      const primary = fences.merge
        ? ("merge" as const)
        : fences.dispatch
          ? ("dispatch" as const)
          : null;
      const holdFieldChanged =
        change.holdUntil !== undefined ||
        change.holdOwner !== undefined ||
        change.holdReason !== undefined ||
        change.holdAt !== undefined ||
        change.holdGeneration !== undefined ||
        change.holdBlocking !== undefined;
      if (primary && holdFieldChanged) {
        const fence = fences[primary]!;
        fences[primary] = {
          ...fence,
          ...(change.holdUntil !== undefined
            ? { until: change.holdUntil }
            : {}),
          ...(change.holdOwner ? { owner: change.holdOwner } : {}),
          ...(change.holdReason ? { reason: change.holdReason } : {}),
          ...(change.holdAt ? { at: change.holdAt } : {}),
          ...(change.holdGeneration !== undefined
            ? { generation: change.holdGeneration }
            : {}),
        };
        if (change.holdBlocking !== undefined && fences.merge)
          fences.merge = { ...fences.merge, blocking: change.holdBlocking };
        Object.assign(next, syncHoldProjection(fences));
      }
    }
    // A hold's stop belongs to its fences: the write that removes the last one
    // retires it, so the read is true at once, paused or terminal, rather than
    // after the next quantum. A queued task's hold text goes with it.
    // Likewise a stop recorded from Queue's origin error goes when that error clears.
    if (
      task.originError &&
      !next.originError &&
      next.resolution.stop?.fact?.code === "origin_error"
    )
      next = { ...next, resolution: { ...next.resolution, stop: null } };
    const fenced = (fields: Task) => {
      const holds = holdsOf(fields);
      return Boolean(holds.dispatch || holds.merge);
    };
    if (fenced(task) && !fenced(next)) {
      if (next.resolution.stop?.reason === "held")
        next = { ...next, resolution: { ...next.resolution, stop: null } };
      if (
        next.phase === "queued" &&
        change.reason === undefined &&
        (task.resolution.stop?.reason === "held" ||
          next.reasonFact?.code === "dispatch_hold")
      )
        next = {
          ...next,
          reason: this.services.dependencyWait(next) || DISPATCH_WAIT_REASON,
          reasonFact: {
            code: this.services.dependencyWait(next)
              ? "prerequisite"
              : "dispatch",
          },
        };
    }
    const restartSlot = task.resolution.restartSlotHold;
    if (
      restartSlot &&
      next.resolution.restartSlotHold?.fromRunId === restartSlot.fromRunId &&
      (restartSlotObsolete(next) || restartSlotObsolete(task))
    ) {
      next = {
        ...next,
        resolution: { ...next.resolution, restartSlotHold: null },
      };
      this.services.event(
        id,
        "restart_slot_released",
        JSON.stringify(restartSlot),
      );
    }
    const freezesCompletion = change.phase === "done" && task.phase !== "done";
    if (freezesCompletion) {
      // The membership a done transition freezes is one derived fact (shared with
      // the recovery preflight and the completion receipt), never restated here.
      const cohort = completionMembership(task);
      next = { ...next, completionNotificationCohort: cohort };
      const completedAt = finishedAt ?? now();
      for (const member of cohort) {
        const notice: Notice = {
          id: digest(`${task.id}:completion:${member.agentId}`),
          taskId: task.id,
          agentId: member.agentId,
          recipientAgentId: member.agentId,
          workspaceId: member.workspaceId,
          sources: member.sources,
          originEntry: member.originEntry,
          kind: "completion",
          status: "pending",
          error: "",
          text: `Nucleus completion\n${noticeTaskLine(task)}\nRepository: ${task.repoPath}\nState: done\nCompleted: ${completedAt}\nPR: ${next.prUrl ?? "none"}${next.reportAcceptance ? `\n${next.reportAcceptance.artifact ? `Owner accepted report: ${next.reportAcceptance.artifact.key} v${next.reportAcceptance.artifact.version} (${next.reportAcceptance.artifact.digest})` : "Owner completed this task with no PR"}\nAccepted by: ${next.reportAcceptance.acceptedBy}\nReason: ${next.reportAcceptance.reason}` : ""}\nInspect queue detail for full state. Completion membership grants no task authority.`,
        };
        if (
          !this.services
            .notices(task.id)
            .some((existing) => existing.id === notice.id)
        )
          this.services.putNotice(notice);
      }
    }
    const previousTelemetryStage = telemetryStageForTask(task),
      nextTelemetryStage = telemetryStageForTask(next);
    const hasTelemetry = Boolean(
      this.services.db
        .prepare(
          "SELECT 1 FROM events WHERE taskId=? AND kind='telemetry_stage' LIMIT 1",
        )
        .get(id),
    );
    const validated = this.services.tasksStore.validatedTask(next);
    this.services.db
      .prepare("UPDATE tasks SET data=? WHERE id=?")
      .run(this.services.taskRow(next, task), id);
    // Persist process cleanup before a terminal transition or worker replacement
    // loses its binding. Scratch is removed only after the owned tools stop.
    if (
      (terminal && task.phase !== next.phase) ||
      (!task.removedAt && Boolean(next.removedAt))
    )
      for (const run of this.services.runs(id))
        this.services.queueRunCleanup(run);
    if (
      task.runId &&
      (task.runId !== next.runId ||
        (terminal && task.phase !== next.phase) ||
        (!task.completion && next.completion))
    )
      this.services.queueRunCleanup({
        id: task.runId,
        taskId: id,
        hostId: task.hostId,
        agentId: task.agentId,
        temporaryDirectory: task.temporaryDirectory,
      });
    if (this.services.tasksStore.taskProjection) {
      this.services.tasksStore.setProjectedTask(validated);
      this.services.tasksStore.integrationTaskIndex = null;
      // A removed task keeps its run rows but leaves every retained-task list.
      if ((task.removedAt == null) !== (next.removedAt == null))
        this.services.tasksStore.refreshPendingRunsForTask(
          id,
          next.removedAt != null,
        );
      // Synchronous observers may read before advanceRevision below. The maps
      // already include this write; acknowledge its trigger clock before those
      // reads so they do not discard the completed incremental update.
      this.services.tasksStore.projectionClock =
        this.services.tasksStore.readProjectionClock();
    }
    if (!hasTelemetry || previousTelemetryStage !== nextTelemetryStage)
      this.services.event(id, "telemetry_stage", nextTelemetryStage);
    if (task.removedAt !== next.removedAt) this.services.taskCountChanged();
    // The initial worker owns its run on the task row. A retained worker
    // continuation has no creation reservation.
    if (
      kind === "agent_intent" &&
      next.agentIntent &&
      !next.agentId &&
      next.runId
    )
      reserveCreation(this.services, {
        id: next.runId,
        taskId: id,
        hostId: next.hostId,
        workspaceId: next.workspaceId,
        role: "worker",
      });
    if (kind) this.services.event(id, kind, detail);
    const becameTerminal = Boolean(terminal && task.phase !== next.phase);
    const becameRemovedFinished =
      !task.removedAt &&
      Boolean(next.removedAt) &&
      ["done", "cancelled"].includes(next.phase);
    if (becameTerminal || becameRemovedFinished)
      this.services.putOutcome(
        buildOutcomeRecord(
          next,
          this.services.runs(id),
          this.services.hookEvents(id),
          false,
        ),
      );
    // A merged papercut-sourced lead closes with the task that completed it; the planning
    // owner holds that rule and the funnel records the audit events it returns.
    if (next.phase === "done" && next.prUrl && next.resolution.mergedCommit)
      for (const cut of this.services.completePapercutsForTask(next))
        this.services.event(id, "papercut_completed", cut.id);
    // Every other write is a board fact, observation state included: a status change
    // still spends a version so a hold or control holding the old one sees it as stale.
    this.services.advanceRevision();
    this.services.taskChanged(id);
    return next;
  }

  /**
   * Durable runtime-retirement records are a Queue-owned side effect, not a
   * versioned operator control: write them without advancing the task's
   * optimistic version, so an archive's `allowed` fence that compares the
   * version stays valid. The board still revision-refreshes.
   */
  setRuntimeRetirements(id: string, records: RuntimeRetirement[]) {
    return this.services.transaction(() => {
      this.services.tasksStore.syncProjectionForWrite();
      const task = this.services.task(id);
      const resolution = {
        ...task.resolution,
        runtimeRetirements: records,
        cleanupReason: runtimeRetirementFailure({
          resolution: { ...task.resolution, runtimeRetirements: records },
        }),
      };
      const next = { ...task, resolution, updatedAt: now() };
      const validated = this.services.tasksStore.validatedTask(next);
      this.services.db
        .prepare("UPDATE tasks SET data=? WHERE id=?")
        .run(this.services.taskRow(next, task), id);
      if (this.services.tasksStore.taskProjection) {
        this.services.tasksStore.setProjectedTask(validated);
        this.services.tasksStore.integrationTaskIndex = null;
      }
      this.services.advanceRevision();
      this.services.taskChanged(id);
      return next;
    });
  }

  /**
   * Spec 058 budgets (nucleus#1153): the wall-clock pause interval is a Queue-owned
   * bookkeeping record, like runtime retirements. A sweep or quantum that opens or
   * closes an interval spends no task version: an owner who read the task and sent a
   * control at that version must not be refused as stale because the Queue's own pass
   * saw the hold. The board still revision-refreshes, and the caller records the
   * interval's audit event in the same transaction.
   */
  setBudgetClock(id: string, budgetClock: BudgetClock): Task {
    if (!this.services.db.isTransaction)
      return this.services.transaction(() =>
        this.setBudgetClock(id, budgetClock),
      );
    this.services.tasksStore.syncProjectionForWrite();
    const task = this.services.task(id);
    const next = {
      ...task,
      resolution: { ...task.resolution, budgetClock },
      updatedAt: now(),
    };
    const validated = this.services.tasksStore.validatedTask(next);
    this.services.db
      .prepare("UPDATE tasks SET data=? WHERE id=?")
      .run(this.services.taskRow(next, task), id);
    if (this.services.tasksStore.taskProjection) {
      this.services.tasksStore.setProjectedTask(validated);
      this.services.tasksStore.integrationTaskIndex = null;
    }
    this.services.advanceRevision();
    this.services.taskChanged(id);
    return next;
  }

  /**
   * Spec 058 slice 1: persist one run's observed usage. Writes only that field and never
   * restamps the run's dispatch-time pins; a no-op write touches nothing.
   */
  updateRunUsage(
    runId: string,
    apply: (usage: NonNullable<Run["usage"]>) => NonNullable<Run["usage"]>,
  ): boolean {
    const run = this.services.run(runId);
    if (!run) return false;
    const next = apply(run.usage ?? EMPTY_RUN_USAGE);
    if (JSON.stringify(next) === JSON.stringify(run.usage ?? null))
      return false;
    this.putRun({ ...run, usage: next }, { usageOnly: true });
    return true;
  }

  putRun(run: Run, options: { usageOnly?: boolean } = {}): void {
    // A release and its credential revocation are one durable state change.
    // Callers that already own a transaction keep their larger atomic boundary.
    if (!this.services.db.isTransaction) {
      this.services.transaction(() => this.putRun(run, options));
      return;
    }
    this.services.tasksStore.syncProjectionForWrite();
    const reviewRow = this.services.db
      .prepare(
        "SELECT data FROM task_reviews WHERE taskId=? AND seq=0 AND json_extract(data,'$.runId')=? AND json_type(data,'$.reviewTextDigest')='text'",
      )
      .get(run.taskId, run.id);
    if (reviewRow) {
      const resolved = this.services.resolveReviewRows([
        { seq: 0, data: String(reviewRow.data) },
      ]).review;
      if (resolved?.reviewText !== run.completion?.reviewText)
        this.services.db
          .prepare("UPDATE task_reviews SET data=? WHERE taskId=? AND seq=0")
          .run(JSON.stringify(resolved), run.taskId);
    }
    const existing = this.services.db
      .prepare("SELECT data FROM runs WHERE id=?")
      .get(run.id);
    const existed = Boolean(existing);
    const prior = existing
      ? (JSON.parse(String(existing.data)) as {
          taskId: string;
          hostId?: unknown;
          hostSelection?: Run["hostSelection"];
        })
      : undefined;
    if (prior && prior.taskId !== run.taskId)
      throw new Error("Run task cannot be changed");
    const recordedHost = prior?.hostId;
    if (prior?.hostSelection)
      run = { ...run, hostSelection: prior.hostSelection };
    else if (prior && run.hostSelection)
      throw new Error(
        "Run host selection cannot be assigned by an ordinary update",
      );
    if (
      typeof recordedHost === "string" &&
      recordedHost &&
      run.hostId !== recordedHost
    )
      run = { ...run, hostId: recordedHost };
    // Stamp only new runs. An existing legacy run must not acquire a host from
    // a later task state merely because an observation updated it.
    if (!existed) {
      const row = this.services.db
        .prepare(
          "SELECT json_extract(data,'$.hostId') AS hostId, json_extract(data,'$.hostSelection') AS selection FROM tasks WHERE id=?",
        )
        .get(run.taskId);
      const taskHost =
        typeof row?.hostId === "string" && row.hostId ? row.hostId : undefined;
      if (run.hostId !== undefined && run.hostId !== taskHost)
        throw new Error("Run host does not match task host");
      if (taskHost)
        run = {
          ...run,
          hostId: taskHost,
          hostSelection: row?.selection
            ? JSON.parse(String(row.selection))
            : {
                hostId: taskHost,
                basis: "migrated",
                reason: "Inherited from recorded task host",
              },
        };
    } else if (!recordedHost && run.hostId !== undefined) {
      const row = this.services.db
        .prepare(
          "SELECT json_extract(data,'$.hostId') AS hostId FROM tasks WHERE id=?",
        )
        .get(run.taskId);
      if (!row?.hostId || row.hostId !== run.hostId)
        throw new Error("Run host is not proved by its task");
    }
    // Each run records the brief version it was given; the stamp is taken once, at creation.
    // A usage-only write never stamps, so an older run keeps the pins it was dispatched with.
    if (run.briefVersion === undefined && !options.usageOnly) {
      const row = this.services.db
        .prepare(
          "SELECT MAX(version) AS version FROM task_brief_versions WHERE taskId=?",
        )
        .get(run.taskId);
      if (typeof row?.version === "number")
        run = { ...run, briefVersion: row.version };
    }
    // Spec 026: likewise the lane document versions pinned at dispatch.
    if (run.laneDocuments === undefined && !options.usageOnly) {
      const row = this.services.db
        .prepare(
          "SELECT json_extract(data,'$.laneDocumentPins') AS pins FROM tasks WHERE id=?",
        )
        .get(run.taskId);
      const pins = row?.pins
        ? (JSON.parse(String(row.pins)) as Array<{
            key: string;
            version: number;
            digest: string;
          }>)
        : [];
      if (pins.length)
        run = {
          ...run,
          laneDocuments: pins.map(({ key, version, digest }) => ({
            key,
            version,
            digest,
          })),
        };
    }
    // A lifecycle observation that only moves `lastObservedAt` records no new board
    // fact: the run's status, activity, release and completion are unchanged. The
    // board's unsettled counters read the observation time fresh from this row.
    const observationOnly = this.services.runObservationOnly(run);
    this.services.db
      .prepare(
        "INSERT INTO runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(run.id, run.taskId, JSON.stringify(run));
    // Release revokes general callback authority. A dispatched reviewer that
    // has not reported keeps a verdict-only ticket for its own head. Once that
    // ticket reports a verdict, it can still replay the receipt.
    if (run.released) {
      const canReportVerdict =
        run.role === "reviewer" &&
        run.agentId &&
        !run.exhaustionReason &&
        !run.completion &&
        ["running", "stopped", "superseded"].includes(run.status);
      const canReplayVerdict =
        run.role === "reviewer" &&
        run.completion &&
        isReviewerVerdict(run.completion.status);
      this.services.db
        .prepare(
          `UPDATE credentials SET revoked=CASE
            WHEN ? AND revoked IN (0, ?) THEN ?
            WHEN ? AND revoked=? THEN ?
            ELSE 1 END WHERE run=?`,
        )
        .run(
          Number(Boolean(canReportVerdict)),
          VERDICT_ONLY_CREDENTIAL,
          VERDICT_ONLY_CREDENTIAL,
          Number(Boolean(canReplayVerdict)),
          VERDICT_ONLY_CREDENTIAL,
          VERDICT_ONLY_CREDENTIAL,
          run.id,
        );
      if (this.services.path !== ":memory:")
        this.services.queueRunReportingCleanup(run.id, run.taskId);
    }
    if (!run.released)
      this.services.db
        .prepare("UPDATE credentials SET revoked=0 WHERE run=? AND revoked=1")
        .run(run.id);
    if (run.released || run.completion) this.services.queueRunCleanup(run);
    if (this.services.tasksStore.taskProjection) {
      this.services.tasksStore.rememberProjectedRun(run.id, run.taskId);
      const states = this.services.tasksStore.runState!;
      const unreleased = this.services.tasksStore.unreleasedByTask!;
      const pending = this.services.tasksStore.pendingRunProjection!;
      const rowids = this.services.tasksStore.pendingRunRowid!;
      const released = Boolean(run.released ?? false);
      const previous = states.get(run.id);
      if (
        previous &&
        !previous.released &&
        (released || previous.taskId !== run.taskId)
      ) {
        const key = previous.taskId;
        unreleased.set(key, Math.max(0, (unreleased.get(key) ?? 1) - 1));
      }
      if (
        !released &&
        (!previous || previous.released || previous.taskId !== run.taskId)
      )
        unreleased.set(run.taskId, (unreleased.get(run.taskId) ?? 0) + 1);
      states.set(run.id, { taskId: run.taskId, released });
      // A removed task keeps its run rows but leaves every retained-task list.
      const retained =
        this.services.tasksStore.taskProjection?.get(run.taskId)?.removedAt ==
        null;
      if ((!released || run.status === "superseded") && retained) {
        pending.set(run.id, Object.freeze({ ...run }) as Run);
        rowids.set(
          run.id,
          Number(
            this.services.db
              .prepare("SELECT rowid AS rid FROM runs WHERE id=?")
              .get(run.id)?.rid,
          ),
        );
      } else {
        pending.delete(run.id);
        rowids.delete(run.id);
      }
    }
    // The run write fired the `writes` trigger the in-memory projection keys on. A
    // substantive write acknowledges it through `advanceRevision`; an observation-only
    // write must acknowledge it here exactly as `update()` does, or the next task or run
    // read discards the whole projection and rebuilds it from every row — the audit's
    // observation hot path, where a lifecycle pass observes a still-busy run.
    if (observationOnly) {
      this.services.tasksStore.projectionClock =
        this.services.tasksStore.readProjectionClock();
    } else this.services.advanceRevision();
    // After the clock is acknowledged: a task read before that discards the whole projection.
    if (!existed && !options.usageOnly) {
      if (
        run.status === "intent" &&
        !run.agentId &&
        !run.released &&
        !run.completion
      ) {
        const { id, taskId, hostId, workspaceId, role } = run;
        reserveCreation(this.services, {
          id,
          taskId,
          hostId,
          workspaceId,
          role,
        });
      }
    }
    this.services.taskChanged(run.taskId);
  }
  /**
   * True when the write differs from the stored row only in `lastObservedAt`, so no
   * board fact moves and the projection need not rebuild (audit A1: observations were
   * about 0.93 of the rebuilds a second). Nested values compare by serialized bytes
   * because every read hands back freshly parsed objects.
   */
  private runObservationOnly(run: Run): boolean {
    return this.services.runObservationOnly(run);
  }

  appendProofFiles(taskId: string, records: Task["proofFiles"]): Task {
    if (!records.length) return this.services.task(taskId);
    const task = this.services.task(taskId);
    // A retried report (a fresh event ID for the same bytes) is the same evidence.
    const key = (record: Task["proofFiles"][number]) =>
      `${record.head}\0${record.label}\0${record.sha256}\0${record.bytes}\0${record.runId}`;
    const seen = new Set(task.proofFiles.map(key));
    const fresh = records.filter((record) => !seen.has(key(record)));
    if (!fresh.length) return task;
    return this.update(
      taskId,
      { proofFiles: [...task.proofFiles, ...fresh] },
      "proof_files",
      fresh
        .map(
          (record) =>
            `${record.label} ${record.sha256.slice(0, 12)} @ ${record.head}`,
        )
        .join("; "),
    );
  }

  acceptCompletion(
    input: Completion,
    token: string,
    pr: { url: string; head: string } | null,
    options: { armedReplacement?: boolean } = {},
  ) {
    return this.services.transaction(() => {
      const duplicate = this.services.receipt(input, token);
      if (duplicate) return duplicate;
      const task = this.services.task(input.taskId);
      // Spec 050 (task 483, review 5695764296 finding 1): an owner's armed worker
      // replacement that has not retired the worker yet does not make that
      // worker's own authenticated result stale. The result wins the race, the
      // armed replacement is abandoned in the same accepted write, and any extra
      // authorization stays unspent. The caller proves the armed state is the
      // owner's own replacement, never an automatic fault.
      const armed =
        options.armedReplacement === true &&
        task.phase === "changes_requested" &&
        Boolean(task.agentId) &&
        Boolean(task.failoverReason) &&
        Boolean(task.replacementProfile);
      if (
        task.runId !== input.runId ||
        task.completion ||
        !(
          armed ||
          ["working", "dispatching", "needs_attention"].includes(task.phase)
        )
      )
        throw new Error("Stale worker run");
      const response = { accepted: true as const, eventId: input.eventId };
      const stalledTurnStop =
        task.resolution.stalledTurnStop?.runId === input.runId
          ? {
              ...task.resolution.stalledTurnStop,
              status: "completed" as const,
              detail:
                "Authenticated completion received; stop reconciliation will retain the result",
            }
          : task.resolution.stalledTurnStop;
      const settled =
        task.resolution.pendingWorkerInstruction ||
        stalledTurnStop !== task.resolution.stalledTurnStop
          ? {
              ...task.resolution,
              pendingWorkerInstruction: null,
              stalledTurnStop,
            }
          : task.resolution;
      // Queue #342: the author's accepted result makes its own build output a settlement candidate.
      const queueOwnedWorkspace = !externalWorkspace(task);
      const buildOutputCleanups =
        task.workspaceId && task.directory && queueOwnedWorkspace
          ? runBuildOutputIntent(
              settled.buildOutputCleanups,
              {
                id: input.runId,
                workspaceId: task.workspaceId,
                agentId: task.agentId,
              },
              task.directory,
              new Date().toISOString(),
            )
          : settled.buildOutputCleanups;
      const received = armed
        ? "Completion received; the retained worker's own result superseded the pending replacement"
        : "Completion received; waiting for the worker to release the workspace";
      this.update(
        task.id,
        {
          completion: input,
          prUrl: pr?.url ?? null,
          prHead: pr?.head ?? null,
          resolution: {
            ...settled,
            // The worker's result ends the stop the task was in.
            ...endsStopOnReason(task, received),
            buildOutputCleanups,
            ...(armed ? { attention: false } : {}),
          },
          // The retained worker's own result ends the pending replacement: the
          // worker keeps running its accepted result and no new agent is created.
          ...(armed
            ? {
                phase: "working" as const,
                failoverReason: "",
                replacementProfile: null,
              }
            : {}),
          reason: received,
        },
        "completion_received",
        input.summary,
      );
      this.services.setCompletionReceipt(
        input.eventId,
        task.id,
        input.runId,
        digest(JSON.stringify(input)),
        JSON.stringify(response),
      );
      return response;
    });
  }
}
