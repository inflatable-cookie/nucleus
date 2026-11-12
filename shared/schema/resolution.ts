import { z } from "zod";
import { recoveryActionSchema } from "./task-common";
import { completionSchema, coordinatorActionSchema, externalOwnerRevisionReceiptSchema, mechanicalVerificationSchema, ownerAcceptanceRecordSchema, reviewRecordSchema, reviewSupersessionSchema } from "./review";
import { taskStopRecordSchema } from "../task-stop";
import { budgetClockSchema } from "../task-budget";
import { taskPhaseSchema } from "../schema/task-primitives";
import { incidentSchema } from "../incident";
import { buildOutputCleanupSchema, externalWorkspaceArchiveSchema, runtimeRetirementSchema, sharedWorkspaceStateSchema, stalledTurnStopSchema, workspaceArchiveRetrySchema } from "./workspace";
import { projectValidationResultSchema } from "./validation";
import { profileSchema } from "./settings";

/** Durable bind of an accepted coordinator recovery report, consumed at most once. */
export const recoveryActionBindingSchema = z.object({
  eventId: z.string(),
  runId: z.string(),
  reportStatus: z.enum(["recovered", "escalate", "blocked", "error"]),
  /** Retired (Spec 050): stored bindings keep it readable; nothing writes or reads it. */
  recoveryAction: recoveryActionSchema.nullable().optional(),
  coordinatorAction: coordinatorActionSchema.nullable().optional(),
  summary: z.string(),
  status: z.enum(["pending", "applied", "refused"]),
  reason: z.string().max(4000).optional(),
}).strict();

export type RecoveryActionBinding = z.infer<typeof recoveryActionBindingSchema>;

export const resolutionSchema = z.object({
  forcedChecks: z.array(z.object({ head: z.string(), runId: z.string(), reason: z.string(), checks: z.array(z.object({ name: z.string(), jobUrl: z.string() }).strict()) }).strict()).default([]),
  criticalReviewFallbacks: z.array(z.object({ at: z.string(), workerProfileId: z.string().nullable(), reviewerProfileId: z.string(), reason: z.string() }).strict()).default([]),
  // Owner settlement is a decision about one recorded occurrence, not proof
  // that the external effect happened. Keep the original record and history.
  ownerSettlements: z.array(z.object({
    effect: z.string(), occurrence: z.string(), summary: z.string(), recoveryKeys: z.array(z.string()),
    caller: z.string(), source: z.enum(['operator_board', 'project_planner', 'queue_planner', 'task_worker', 'task_reviewer', 'task_recovery']), reason: z.string(), at: z.string(),
  }).strict()).default([]),
  // Explicitly superseded participant identities for the forced merged closeout.
  ownerCloseoutParticipants: z.array(z.object({ agentId: z.string(), workspaceId: z.string() }).strict()).default([]),
  // Later cleanup authority is separate from the completed cancellation disposition.
  workspaceRetirement: z.object({
    workspaceId: z.string(), directory: z.string(), branch: z.string(), head: z.string().nullable(),
    authorization: z.object({ caller: z.string(), kind: z.enum(['project_owner', 'operator', 'relayed_note']), note: z.string().nullable(), reason: z.string(), at: z.string() }).strict(),
    state: z.enum(['authorized', 'held', 'intent', 'uncertain', 'archived']),
    detail: z.string(), intentAt: z.string().nullable(), archivedAt: z.string().nullable(),
  }).strict().nullable().default(null),
  closeoutWorkspaceIntent: z.boolean().default(false), closeoutWorkspaceId: z.string().nullable().default(null), closeoutDirectory: z.string().nullable().default(null), closeoutWorkspaceHead: z.string().nullable().default(null),
  archivedWorkspaceIds: z.array(z.string()).default([]), archiveIntentWorkspaceId: z.string().nullable().default(null),
  // The exact source head the archive intent bound; an uncertain retry never rederives it.
  archiveIntentHead: z.string().nullable().default(null), cleanupReason: z.string().default(""),
  buildOutputCleanups: z.array(buildOutputCleanupSchema).default([]),
  workspaceArchiveRetries: z.array(workspaceArchiveRetrySchema).default([]),
  runtimeRetirements: z.array(runtimeRetirementSchema).default([]),
  // Spec 017: preserved external workspaces whose Paseo sidebar entry is archived
  // while their folder is kept. Never an archive of the workspace's files.
  externalWorkspaceArchives: z.array(externalWorkspaceArchiveSchema).default([]),
  // Advisory task.finished durable intent for a terminal task: present while the
  // repository's finished-task runtime stop still owes one evaluation. A crash
  // after the terminal transition is recovered by the lifecycle scan even when
  // the task's phase is no longer one the ordinary scan visits.
  finishedHook: z.object({ phase: z.enum(["done", "cancelled"]), at: z.string() }).strict().nullable().default(null),
  // Advisory host-process sweep for a terminal task: present until Queue has
  // signalled leftovers in the retained worktree or the task's recorded run
  // process groups. Same restart shape as finishedHook; a crash cannot skip it.
  hostProcessSweep: z.object({ phase: z.enum(["done", "cancelled"]), at: z.string() }).strict().nullable().default(null),
  // Spec 050: the one current stop or wait. Repeated observations preserve `since`;
  // a cleared condition removes the record and a later stop starts a new one.
  stop: taskStopRecordSchema.nullable().default(null),
  // Spec 058 budgets: operator extensions granted to this responsible task, one default increment each.
  budgetExtensions: z.number().int().min(0).default(0),
  // Spec 058 budgets (nucleus#1153): wall-clock time discounted because the task was
  // held on a Nucleus-side cause. The task quantum is its one writer.
  budgetClock: budgetClockSchema.nullable().default(null),
  externalMerge: z.boolean().default(false),
  // A verified merge with no applied ready_to_merge verdict and no operator
  // source acceptance at that head. Closeout uses the merge commit anyway.
  mergedWithNone: z.boolean().default(false),
  // Project-a #1837: a transient `External merge check:` fault sets attention and can
  // leave the task in `needs_attention` with no run. The phase and reason it held
  // before the check are recorded so recovery resumes that state instead of
  // clearing only the flag onto a phase nothing advances.
  externalMergePreAttention: z.object({ phase: taskPhaseSchema, reason: z.string() }).strict().nullable().default(null),
  recoveryActive: z.boolean().default(false),
  recoveryPhase:z.enum(["implementation","closeout"]).default("implementation"),
  // (the retired author-escalation and mechanical-carry records went with schema 54,
  // task 989; the store strips retired copies from stored rows on every open.)
  recoveryAttempts: z.number().default(0),
  recovery: z.object({
    id:z.string(),key:z.string(),generation:z.number(),runId:z.string().nullable(),agentId:z.string().nullable(),
    status:z.enum(["pending","running","nudged","resolved","escalated","uncertain"]),summary:z.string(),idleSince:z.string().nullable(),incidentId:z.string().nullable().default(null),
    // Project-a #2016 / d48bb1c3: an accepted coordinator report is bound here before
    // the recovery run is released, then consumed at most once.
    action: recoveryActionBindingSchema.nullable().optional(),
    /** Round 4 (consumer-b #639): the task-progress digest when the episode opened; a report binds to it. */
    progress: z.string().nullable().optional(),
  }).nullable().default(null),
  // One explicit stop request owns a detected stalled worker/reviewer turn until
  // inactivity or an authentic callback settles it. Event history keeps prior stops.
  stalledTurnStop: stalledTurnStopSchema.nullable().default(null),
  incident: incidentSchema.nullable().default(null),
  mechanicalVerification: mechanicalVerificationSchema.nullable().default(null),
  projectValidation: projectValidationResultSchema.nullable().default(null),
  revisionRuns: z.number().int().nonnegative().default(0),
  /** Task 576: the review event id that last parked the task at the revision cap, if any. */
  capParkedReviewEventId: z.string().nullable().default(null),
  /** Task 576: the review round already counted in revisionRuns, by its review event id. Later dispatches for the same round continue it without consuming another round. */
  countedReviewEventId: z.string().nullable().default(null),
  /** Spec 058: the one alternate-provider retry is armed after two non-deliveries. */
  nonDeliveryRoutePending: z.boolean().default(false),
  /** Explicit owner rule: automatic worker retry/revision is forbidden for this instruction. */
  noAutomaticRetry: z.boolean().default(false),
  /** An owner control explicitly set or lifted the rule (structured or text-derived).
   * While true the gate trusts this flag alone; the brief-text and old-run fallbacks
   * below serve only rows with no durable owner decision, so an explicit lift can
   * never be re-forbidden by the run it superseded. */
  noAutomaticRetryDecided: z.boolean().default(false),
  /** Which owner control recorded the rule, so an owner can see why automatic retry stays off. */
  noAutomaticRetryProvenance: z.string().nullable().default(null),
  // The cause of the next ordinary revision when it is already known durably:
  // a reviewed-head repository refusal consumes the semantic budget like a
  // reviewer finding without overwriting the accepted review evidence.
  pendingRevisionCause: z.enum(["review", "pre_merge", "continuation", "non_delivery", "unfinished", "consult"]).nullable().default(null),
  roleReplacements: z.number().default(0), coordinatorWorkspaceId: z.string().nullable().default(null),
  currentRunId: z.string().nullable().default(null),
  reviewerAgentId: z.string().nullable().default(null), reviewerProfile: profileSchema.nullable().default(null),
  // `verification`: retired with the verification run role (nucleus#765). Nothing
  // writes it; it stays so one finished task's stored row keeps parsing.
  review: completionSchema.nullable().default(null), verification: completionSchema.nullable().default(null),
  // Spec 037: append-only review records, each with its verdicts and reviewer identity.
  reviews: z.array(reviewRecordSchema).default([]),
  // Qualified owner acceptance (2026-10-17): append-only owner decisions recorded
  // through `move to=merge`, kept separately from the immutable reviewer verdict.
  ownerAcceptances: z.array(ownerAcceptanceRecordSchema).default([]),
  // Spec 043 goal gate: set at closeout when a declared goal is not met. A done
  // task that carries this never satisfies a dependent.
  goalUnmet: z.string().trim().min(1).max(4000).nullable().optional(),
  // Spec 039: accepted reviews and their downstream checks remain immutable history after re-review.
  reviewSupersessions: z.array(reviewSupersessionSchema).default([]),
  // Legacy Spec 039 receipts remain parseable; current controls do not create them.
  externalOwnerRevisions: z.array(externalOwnerRevisionReceiptSchema).optional(),
  pendingReviewReason: z.string().trim().min(1).max(4000).nullable().default(null),
  /**
   * Spec 058 (task 533): the reviewer's one clean-environment retry of checks
   * that faulted before any assertion. The intent names the reporting run, its
   * head and the checks; the reviewer launch consumes it onto the run.
   */
  proofRetry: z.object({
    runId: z.string().min(1).max(160), head: z.string().regex(/^[a-f0-9]{40}$/),
    proofs: z.array(z.string().trim().min(1).max(2000)).min(1).max(40), at: z.string(),
  }).strict().nullable().default(null),
  mergeIntent: z.boolean().default(false), mergeHead: z.string().nullable().default(null), mergeBase: z.string().nullable().default(null),
  mergeRequestedAt: z.string().nullable().default(null),
  mergeResponseOutcome: z.enum(["pending", "accepted", "uncertain"]).default("pending"),
  mergeProofSince: z.string().nullable().default(null),
  mergeRetryAt: z.string().nullable().default(null),
  mergeRetryOutcome: z.enum(["pending", "accepted", "uncertain"]).nullable().default(null),
  mergeAutoRetryExhausted: z.boolean().default(false),
  mergedCommit: z.string().nullable().default(null), syncedCommit: z.string().nullable().default(null),
  integrationTurn: z.object({ sequence: z.number().int().positive(), acceptedAt: z.string() }).nullable().default(null),
  // Retained so older task rows parse without rewriting live data. New review
  // intake never creates or acts on shared-checkout branch-switch state.
  sharedWorkspace:sharedWorkspaceStateSchema.nullable().default(null),
  revisionPrRepair: z.boolean().default(false), revisionResumeUnpublished: z.boolean().default(false),
  revisionInstruction: z.object({ id: z.string().min(1).max(160), text: z.string().min(1).max(12000), createdAt: z.string(), runId: z.string().nullable().default(null) }).nullable().default(null),
  // The next worker action is independent of `Task.reason`, which also carries
  // transient status and capacity waits. Resolution dispatch copies it onto
  // the immutable run before clearing this pending value.
  pendingWorkerInstruction: z.string().trim().min(1).max(12000).nullable().default(null),
  /**
   * Round 4 (Tom, 2026-10-19): an owner verb whose effect is an immediate
   * delivery (a reviewer continuation, a same-run re-creation), recorded while
   * Queue is paused or the task held and applied once that clears.
   */
  deferredVerb: z.object({ input: z.record(z.string(), z.unknown()), at: z.string(), why: z.enum(["paused", "held"]),
    /** The exact run (and checkpoint) the recorded verb was for; replay refuses if it changed. */
    target: z.object({ runId: z.string(), checkpointOrdinal: z.number().int().positive().optional(), head: z.string().optional() }).strict().nullable().default(null) }).strict().nullable().default(null),
  prePrResumeInstruction: z.string().trim().min(1).max(12000).nullable().default(null),
  attention: z.boolean().default(false),
});
