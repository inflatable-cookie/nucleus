import { z } from "zod";
import { PROJECT_QA_STAGE_NAME_PATTERN, projectQaStageSchema } from "./qa-config";
import { hostRunClassSchema, hostRunEscapedDescendantSchema, hostRunPrioritySchema, hostRunSettlementSchema } from "./host-runs";
import { projectRepositorySchema } from "./projects";
import { projectQaStateSchema } from "./project-settings";
import { PROCESS_TERMINATION_GRACE_MAX_MS, projectValidationAdmissionSchema, projectValidationCapacityWaitSchema } from "./validation";
import { QA_FENCE_MAX_MINUTES } from "./qa-fence";

/** One setup, stage or teardown step of a milestone run, with its own bounded output. */
export const projectQaStepNameSchema = z.string().trim().min(1).max(80).regex(PROJECT_QA_STAGE_NAME_PATTERN, "QA step name must be slug-shaped");

export type ProjectQaStepName = z.infer<typeof projectQaStepNameSchema>;

export const projectQaStepSchema = z.object({
  name: projectQaStepNameSchema,
  command: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  pid: z.number().int().positive().nullable().optional(),
  /** Contract 010's PID and observed process start time identity. */
  startIdentity: z.string().min(1).nullable().optional(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  wallMs: z.number().int().nonnegative().optional(),
  escapedDescendants: z.array(hostRunEscapedDescendantSchema).optional(),
  /** The detached process group and the random start identity Queue verified before signaling. */
  processGroupId: z.number().int().positive().nullable().optional(),
  leaderStartIdentity: z.string().min(1).nullable().optional(),
  terminationSignal: z.enum(["SIGTERM", "SIGKILL"]).nullable().optional(),
  processGroupEmpty: z.boolean().nullable().optional(),
  terminationError: z.string().nullable().optional(),
  /** The head and tail of this step's own stdout, so a later step's output cannot evict it. */
  stdoutHead: z.string(),
  stdoutTail: z.string(),
  /** The head and tail of this step's own stderr, where setup failures are reported. */
  stderrHead: z.string(),
  stderrTail: z.string(),
  /** #121: the full-output log beside the run under the QA root, mode 0600; null on rows written before logs. */
  stdoutLogPath: z.string().min(1).nullable().default(null),
  stderrLogPath: z.string().min(1).nullable().default(null),
  /** Bytes retained in each log: the stream capped at the step's maxOutputBytes, keeping the tail past the cap. */
  stdoutBytes: z.number().int().nonnegative().default(0),
  stderrBytes: z.number().int().nonnegative().default(0),
}).strict();

export type ProjectQaStep = z.infer<typeof projectQaStepSchema>;

/**
 * #136: one full-output log that could not be written. It is kept apart from
 * `outputTail` so a later step's output can never truncate the diagnostic, and
 * the list is bounded so a broken log writer cannot grow the row without limit.
 */
export const PROJECT_QA_LOG_WRITE_ERRORS_MAX = 16;

export const projectQaLogWriteErrorSchema = z.object({
  step: projectQaStepNameSchema,
  stream: z.enum(["stdout", "stderr"]),
  error: z.string().min(1),
}).strict();

export type ProjectQaLogWriteError = z.infer<typeof projectQaLogWriteErrorSchema>;

/** A compact identity for a TAP failure, independent of its verbose diagnostic block. */
export const PROJECT_QA_FAILURE_IDENTITIES_MAX = 128;

export const PROJECT_QA_FAILURE_INDEXES_MAX = 8;

export const PROJECT_QA_FAILURE_LOCATION_MAX = 4000;

export const projectQaFailureIdentitySchema = z.object({
  id: z.number().int().positive().nullable(),
  title: z.string(),
  location: z.string().max(PROJECT_QA_FAILURE_LOCATION_MAX).nullable(),
  locationTrimmed: z.boolean().optional(),
  status: z.enum(["failed", "cancelled"]),
}).strict();

export const projectQaFailureIndexSchema = z.object({
  stage: projectQaStepNameSchema,
  tests: z.number().int().nonnegative().nullable(),
  failed: z.number().int().nonnegative().nullable(),
  cancelled: z.number().int().nonnegative().nullable(),
  skipped: z.number().int().nonnegative().nullable(),
  identities: z.array(projectQaFailureIdentitySchema),
  omittedIdentities: z.number().int().nonnegative(),
  truncated: z.boolean(),
  diagnosticsTruncated: z.boolean(),
}).strict();

export type ProjectQaFailureIndex = z.infer<typeof projectQaFailureIndexSchema>;

/**
 * Operator dismissal of a finished run that is not passing, recorded from the board card.
 * The run record is never deleted; the board stops showing the card (Tom: "Pass fades, fail stays").
 */
export const projectQaDismissalSchema = z.object({
  at: z.string().datetime(),
  by: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(1).max(4000),
}).strict();

export type ProjectQaDismissal = z.infer<typeof projectQaDismissalSchema>;

export const projectQaRunSchema = z.object({
  id: z.string().min(1).max(160),
  /** Immutable allocation for runs created after the work-root cutover. */
  checkoutPath: z.string().min(1).optional(),
  /** Teardown completed; guarded checkout removal still needs observation or retry. */
  checkoutCleanupPending: z.boolean().optional(),
  /** Per-run temp leaf on the scratch volume; absent on rows launched before this field. */
  temporaryDirectory: z.string().max(2000).optional(),
  repository: projectRepositorySchema,
  /** One-run-per-repository key: the normalised origin when known, else the absolute checkout path. */
  key: z.string().min(1).max(320),
  /**
   * Task 445: the key this run was submitted under, recorded by the repository
   * re-key step in the same transaction that moves `key` and never rewritten
   * afterwards. Absent while the run's key has never moved. The host-run caller
   * is minted from the submitted key and contract-010 history is immutable, so
   * this is the durable per-run provenance the retained-output sweep verifies a
   * re-keyed run's caller against (the applied re-key receipts are the same
   * evidence for rows re-keyed before this field existed). Queue-private: QA runs
   * are operational history and are never part of a contract 008/009/010 export.
   */
  submittedKey: z.string().min(1).max(320).optional(),
  state: projectQaStateSchema,
  submittedAt: z.string().datetime().optional(),
  submitterAgentId: z.string().trim().min(1).max(160).optional(),
  queuePosition: z.number().int().positive().nullable().optional(),
  hostRunEpoch: z.number().int().positive().optional(),
  selector: z.string().min(1).optional(),
  runClass: hostRunClassSchema.optional(),
  classSource: z.enum(["manifest", "default"]).optional(),
  priority: hostRunPrioritySchema.optional(),
  runTimeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  baseBranch: z.string().min(1).max(200),
  /** The integration head the run checked out (`origin/<baseBranch>` after fetch). */
  base: z.string().regex(/^[a-f0-9]{40}$/),
  argv: z.array(z.string()),
  /** The ordered stages of a staged QA setting; absent for single-argv settings and rows written before #121. */
  stages: z.array(projectQaStageSchema).optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  terminationGraceMs: z.number().int().min(0).max(PROCESS_TERMINATION_GRACE_MAX_MS).optional(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  outputTail: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  pid: z.number().int().positive().nullable(),
  /** Historical Effigy admission telemetry; new runs omit it. */
  admission: projectValidationAdmissionSchema.nullable().optional(),
  capacityWait: projectValidationCapacityWaitSchema.nullable(),
  capacityUnavailable: z.boolean(),
  /** Setup, QA and teardown recorded separately; empty on rows written before this field. */
  steps: z.array(projectQaStepSchema).default([]),
  /** Optional project members skipped before launch because their recorded checkout is absent. */
  skippedProjectMembers: z.array(z.object({ origin: z.string().nullable(), path: z.string(), reason: z.string() }).strict()).optional(),
  /** The first step that failed, so the board can name it beside the result. */
  failedStep: projectQaStepNameSchema.nullable().default(null),
  /**
   * #136: full-output logs that could not be written, bounded and separate from
   * `outputTail`, so later output can never evict the diagnostic.
   */
  logWriteErrors: z.array(projectQaLogWriteErrorSchema).max(PROJECT_QA_LOG_WRITE_ERRORS_MAX).default([]),
  /**
   * Task 191: every `not ok` block with its diagnostics plus the TAP summary,
   * extracted from the QA stages' own output and kept apart from `outputTail`,
   * so a failure stays visible however much later output the byte cap keeps.
   * Absent on rows written before this field and empty when no QA stage
   * reported a TAP failure.
   */
  failuresLog: z.string().optional(),
  /** Consolidated failure diagnostics retained beside the run when waiting for settlement. */
  failuresLogPath: z.string().min(1).nullable().optional(),
  /** Compact streaming TAP identities and summary counts, kept apart from diagnostics. */
  failureIndexes: z.array(projectQaFailureIndexSchema).optional(),
  /**
   * A lost run's in-flight step (task 114): the step the detached supervisor was
   * running when it was proven dead. Null on every settled run and on lost runs
   * whose supervisor died before a step started. It tells "lost during setup"
   * apart from "lost during qa"; it never names a failure.
   */
  interruptedStep: projectQaStepNameSchema.nullable().default(null),
  /** Contract 010's settlement is durable with the run row; its result file is retained beside the run. */
  hostSettlement: hostRunSettlementSchema.nullable().default(null),
  escapedDescendants: z.array(hostRunEscapedDescendantSchema).default([]),
  cancelReason: z.string().nullable().default(null),
  /**
   * How many operator teardown retries this run has attempted (task 134). It
   * names the retry's per-run supervision files, so a retry attempt is durable
   * and a later retry never reuses the previous attempt's result record.
   */
  teardownRetryAttempt: z.number().int().nonnegative().optional(),
  /** Board dismissal (Tom, 2026-11-01): who dismissed this finished, non-passing run and why. Absent until dismissed. */
  dismissal: projectQaDismissalSchema.nullable().optional(),
}).strict();

export type ProjectQaRun = z.infer<typeof projectQaRunSchema>;

/** The output lines a board card carries: the last few of the run's output tail, each bounded. */
export const BOARD_QA_OUTPUT_LINES = 8;

export const BOARD_QA_OUTPUT_LINE_MAX = 400;

/**
 * One milestone QA run as a board card (Tom, 2026-11-01): the projection of a
 * repository's latest run, carrying what the card shows and nothing that only
 * the detail view needs. The card's state, placement and fade come from the
 * projection in `core/qa/qa-board.ts`.
 */
export const boardQaRunSchema = z.object({
  id: z.string().min(1).max(160),
  repository: projectRepositorySchema,
  key: z.string().min(1).max(320),
  selector: z.string().min(1),
  baseBranch: z.string().min(1).max(200),
  state: projectQaStateSchema,
  queuePosition: z.number().int().positive().nullable(),
  startedAt: z.string(),
  submittedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  currentStep: projectQaStepNameSchema.nullable(),
  failedStep: projectQaStepNameSchema.nullable(),
  exitCode: z.number().int().nullable(),
  outputLines: z.array(z.string().max(BOARD_QA_OUTPUT_LINE_MAX)).max(BOARD_QA_OUTPUT_LINES),
  cancelReason: z.string().nullable(),
  stale: z.object({ commitsSince: z.number().int().positive(), runAt: z.string().datetime() }).strict().nullable(),
}).strict();

export type BoardQaRun = z.infer<typeof boardQaRunSchema>;

export const projectQaRunInputSchema = z.object({
  /** Wait for this admitted run to settle; does not change request identity. */
  wait: z.boolean().optional(),
  requestId: z.string().trim().min(1).max(160).optional(),
  /** Informational origin for settlement notices; the CLI fills it from Paseo identity. */
  submitterAgentId: z.string().trim().min(1).max(160).optional(),
  expectedHead: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  repository: z.string().trim().min(1).max(1024),
  baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).default("main"),
}).strict();

export type ProjectQaRunInput = z.infer<typeof projectQaRunInputSchema>;

/** Durable delivery identity, written before repository lookup/fetch. */
export const projectQaRequestSchema = z.object({
  id: z.string().min(1).max(160),
  input: projectQaRunInputSchema,
  ownerInstance: z.string().uuid(),
  ownerPid: z.number().int().positive(),
  receivedAt: z.string().datetime(),
  state: z.enum(["preparing", "admitted", "refused"]),
  runId: z.string().nullable(),
  diagnostic: z.string(),
  /** When Queue settled a predecessor's interrupted preparation as refused. */
  settledAt: z.string().datetime().optional(),
}).strict();

export type ProjectQaRequest = z.infer<typeof projectQaRequestSchema>;

export const projectQaRequestStatusInputSchema = z.union([
  z.object({ requestId: z.string().trim().min(1).max(160) }).strict(),
  z.object({ repository: z.string().trim().min(1).max(1024), since: z.string().datetime(),
    expectedHead: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
]);

export const projectQaGetInputSchema = z.union([
  z.object({ id: z.string().trim().min(1).max(160) }).strict(),
  z.object({ repository: z.string().trim().min(1).max(1024) }).strict(),
]);

export const projectQaCancelInputSchema = z.object({
  id: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(1).max(4000),
}).strict();

export type ProjectQaCancelInput = z.infer<typeof projectQaCancelInputSchema>;

/**
 * Tom, 2026-11-01: a board operator dismisses a finished run that is not passing. Records who
 * dismissed which run and why; never deletes the record, and a passing or live run is not dismissible.
 */
export const projectQaDismissInputSchema = z.object({
  id: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(1).max(4000),
  caller: z.string().trim().min(1).max(160),
}).strict();

export type ProjectQaDismissInput = z.infer<typeof projectQaDismissInputSchema>;

/**
 * Task 134: an operator-only retry of the teardown step for a run that settled
 * whose latest teardown step failed or whose checkout cleanup is pending, even
 * when an earlier setup or QA step remains the run's primary failure.
 * It reruns only the recorded teardown command through the same supervisor,
 * termination and logging path, and never reruns setup or QA.
 */
export const projectQaRetryTeardownInputSchema = z.object({
  id: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(1).max(4000),
}).strict();

export type ProjectQaRetryTeardownInput = z.infer<typeof projectQaRetryTeardownInputSchema>;

/**
 * Papercut 26636095: set, replace or clear the QA admission fence. Only the
 * operator (`caller` "operator" or "operator (board)") or a relaying agent with
 * `relayed: true` and the operator's authorization `note` may write it.
 * `expectedRevision` must equal the stored revision, so a stale client cannot
 * clear or replace a newer fence and a retried write never renews the expiry.
 */
export const projectQaFenceInputSchema = z.object({
  action: z.enum(["set", "clear"]),
  expectedRevision: z.number().int().nonnegative(),
  minutes: z.number().int().min(1).max(QA_FENCE_MAX_MINUTES).optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
  caller: z.string().trim().min(1).max(160),
  relayed: z.boolean().optional(),
  note: z.string().trim().min(1).max(4000).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.action === "set" && !input.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "Setting the QA fence requires a reason" });
  if (input.action === "clear" && input.minutes !== undefined) ctx.addIssue({ code: "custom", path: ["minutes"], message: "minutes applies only to set" });
  if (input.relayed && !input.note) ctx.addIssue({ code: "custom", path: ["note"], message: "A relayed fence write requires the operator's authorization note" });
  if (!input.relayed && input.note !== undefined) ctx.addIssue({ code: "custom", path: ["note"], message: "A note records a relayed authorization; set relayed true" });
});

export type ProjectQaFenceInput = z.infer<typeof projectQaFenceInputSchema>;
