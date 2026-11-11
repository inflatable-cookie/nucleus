/**
 * Frozen copies of Queue MAIN's private-record schemas (origin/main cf7d65d3,
 * before #618): the host-run supervisor state, the project-validation result
 * envelope and the milestone QA supervision state, with their step and
 * failure-index dependencies. Copied verbatim and renamed; never imported from
 * the new code. An older Queue reads these files with exactly these strict
 * schemas, so a new field here is a rollback break. The one later approved
 * main evolution is included rather than treated as a rollback break: the
 * milestone QA supervision result gained `checkoutCleanupPending` when project
 * QA checkouts moved to Builds (3d946e67, 2026-10-27). Every other shape stays
 * the baseline copy, so the CPU reason must still prove it adds nothing.
 */
import { z } from "zod";
import { frozenHostRunEscapedDescendantSchema, frozenHostRunResultSchema } from "./contract-010-frozen";

/** Every meta GLOB/LIKE scan in main (server/, shared/, bin/), verbatim; no other main code scans meta by pattern. */
export const MAIN_META_PATTERN_SCANS = [
  { op: "LIKE", pattern: "displacedDispatchWorkspace:%" }, // owner-verbs.ts (bound to one task id)
  { op: "GLOB", pattern: "projectQaRequest:*" }, // project-qa.ts, store.ts
  { op: "LIKE", pattern: "mcpReportIntent:%" }, // store.ts
  { op: "LIKE", pattern: "bulkDisposition:%" }, // store.ts
] as const;

export const MAIN_PROJECT_QA_STAGE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const mainPrivateProjectQaStateSchema = z.enum(["queued", "running", "passed", "failed", "hold", "timed_out", "cancelled", "lost"]);

export const mainPrivateProjectQaStepNameSchema = z.string().trim().min(1).max(80).regex(MAIN_PROJECT_QA_STAGE_NAME_PATTERN, "QA step name must be slug-shaped");
export type MainPrivateProjectQaStepName = z.infer<typeof mainPrivateProjectQaStepNameSchema>;
export const mainPrivateProjectQaStepSchema = z.object({
  name: mainPrivateProjectQaStepNameSchema,
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
  escapedDescendants: z.array(frozenHostRunEscapedDescendantSchema).optional(),
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
export type MainPrivateProjectQaStep = z.infer<typeof mainPrivateProjectQaStepSchema>;
/**
 * #136: one full-output log that could not be written. It is kept apart from
 * `outputTail` so a later step's output can never truncate the diagnostic, and
 * the list is bounded so a broken log writer cannot grow the row without limit.
 */
export const MAIN_PROJECT_QA_LOG_WRITE_ERRORS_MAX = 16;
export const mainPrivateProjectQaLogWriteErrorSchema = z.object({
  step: mainPrivateProjectQaStepNameSchema,
  stream: z.enum(["stdout", "stderr"]),
  error: z.string().min(1),
}).strict();
export type MainPrivateProjectQaLogWriteError = z.infer<typeof mainPrivateProjectQaLogWriteErrorSchema>;
/** A compact identity for a TAP failure, independent of its verbose diagnostic block. */
export const MAIN_PROJECT_QA_FAILURE_IDENTITIES_MAX = 128;
export const MAIN_PROJECT_QA_FAILURE_INDEXES_MAX = 8;
export const mainPrivateProjectQaFailureIdentitySchema = z.object({
  id: z.number().int().positive().nullable(),
  // Task 1064: failure titles are retained in full; locations have a larger
  // bounded wire representation with an explicit truncation flag.
  title: z.string(),
  location: z.string().max(4000).nullable(),
  locationTrimmed: z.boolean().optional(),
  status: z.enum(["failed", "cancelled"]),
}).strict();
export const mainPrivateProjectQaFailureIndexSchema = z.object({
  stage: mainPrivateProjectQaStepNameSchema,
  tests: z.number().int().nonnegative().nullable(),
  failed: z.number().int().nonnegative().nullable(),
  cancelled: z.number().int().nonnegative().nullable(),
  skipped: z.number().int().nonnegative().nullable(),
  identities: z.array(mainPrivateProjectQaFailureIdentitySchema),
  omittedIdentities: z.number().int().nonnegative(),
  truncated: z.boolean(),
  diagnosticsTruncated: z.boolean(),
}).strict();
export type MainPrivateProjectQaFailureIndex = z.infer<typeof mainPrivateProjectQaFailureIndexSchema>;

export const MAIN_HOST_RUN_SUPERVISOR_STATE_FORMAT = "host.run.supervisor.state";

export const mainPrivateHostRunSupervisorStateSchema = z.object({
  format: z.literal(MAIN_HOST_RUN_SUPERVISOR_STATE_FORMAT),
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  epoch: z.number().int().positive(),
  supervisorPid: z.number().int().positive(),
  supervisorStartIdentity: z.string().min(1),
  commandPid: z.number().int().positive().nullable().default(null),
  commandPgid: z.number().int().positive().nullable().default(null),
  commandStartIdentity: z.string().min(1).nullable().default(null),
  termination: z.enum(["timeout", "cancel"]).nullable().default(null),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().default(null),
}).strict();
export type MainPrivateHostRunSupervisorState = z.infer<typeof mainPrivateHostRunSupervisorStateSchema>;

export const MAIN_PROJECT_VALIDATION_RESULT_FORMAT = "queue.project-validation.result";

export const mainPrivateProjectValidationSupervisorResultSchema = z.object({
  format: z.literal(MAIN_PROJECT_VALIDATION_RESULT_FORMAT),
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  epoch: z.number().int().positive(),
  identityToken: z.string().min(16).max(128),
  state: z.enum(["passed", "refused", "hold"]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  outputTail: z.string().max(2000),
  timedOut: z.boolean(),
  signal: z.string().min(1).nullable(),
  pid: z.number().int().positive().nullable(),
  processGroupId: z.number().int().positive().nullable(),
  leaderStartIdentity: z.string().min(1).nullable(),
  processGroupEmpty: z.boolean().nullable(),
  terminationError: z.string().nullable(),
  hostResult: frozenHostRunResultSchema.nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
}).strict();
export type MainPrivateProjectValidationSupervisorResult = z.infer<typeof mainPrivateProjectValidationSupervisorResultSchema>;

export const MAIN_QA_SUPERVISION_SCHEMA = "queue.project-qa.supervisor.v1";

export const MAIN_QA_SUPERVISION_SCHEMA_VERSION = 1;

export const mainPrivateQaSupervisionResultSchema = z.object({
  state: mainPrivateProjectQaStateSchema,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  detail: z.string(),
  failureIndexes: z.array(mainPrivateProjectQaFailureIndexSchema).optional(),
  finishedAt: z.string(),
  hostResult: frozenHostRunResultSchema.nullable().default(null),
  /** Approved main evolution (3d946e67, 2026-10-27): the Builds checkout's cleanup is still outstanding. */
  checkoutCleanupPending: z.boolean().optional(),
}).strict();
export type MainPrivateQaSupervisionResult = z.infer<typeof mainPrivateQaSupervisionResultSchema>;

export const mainPrivateQaActiveProcessSchema = z.object({
  step: mainPrivateProjectQaStepNameSchema,
  pid: z.number().int().positive(),
  processGroupId: z.number().int().positive(),
  startIdentity: z.string().min(1),
  /** Private environment identity used to prove the group before signaling. */
  leaderStartIdentity: z.string().min(16).max(128),
  startedAt: z.string().datetime(),
}).strict();

export const mainPrivateQaCancelRequestSchema = z.object({
  runId: z.string().min(1).max(160),
  reason: z.string().trim().min(1).max(4000),
  requestedAt: z.string().datetime(),
}).strict();
export type MainPrivateQaCancelRequest = z.infer<typeof mainPrivateQaCancelRequestSchema>;

export const mainPrivateQaSupervisionStateSchema = z.object({
  schema: z.literal(MAIN_QA_SUPERVISION_SCHEMA),
  schema_version: z.literal(MAIN_QA_SUPERVISION_SCHEMA_VERSION),
  runId: z.string().min(1).max(160),
  key: z.string().min(1).max(320),
  /** The detached supervisor's own pid. */
  pid: z.number().int().positive(),
  /** PR 851: OS birth identity used to stop only this detached supervisor group. */
  supervisorStartIdentity: z.string().min(1).optional(),
  /** The run's random identity token; the live pid must run with this token. */
  identityToken: z.string().min(16).max(128),
  startedAt: z.string().min(1),
  heartbeatAt: z.string().min(1),
  /** The step currently running, so a proven-dead supervisor names what was in flight. */
  inFlight: mainPrivateProjectQaStepNameSchema.nullable(),
  /** Published synchronously from the child's spawn event, before the step can run. */
  activeProcess: mainPrivateQaActiveProcessSchema.nullable().default(null),
  /** Published before spawn so a restart can prove whether launch happened. */
  pendingProcessIdentity: z.string().min(16).max(128).nullable().default(null),
  steps: z.array(mainPrivateProjectQaStepSchema),
  failedStep: mainPrivateProjectQaStepNameSchema.nullable(),
  /** #136: full-output log-write failures, bounded and kept apart from the run's output detail. */
  logWriteErrors: z.array(mainPrivateProjectQaLogWriteErrorSchema).max(MAIN_PROJECT_QA_LOG_WRITE_ERRORS_MAX).default([]),
  /** The run's aggregate output detail, bounded. */
  detail: z.string(),
  /**
   * Task 191: every `not ok` block with its diagnostics plus the TAP summary
   * from the QA stages, bounded separately from `detail` so later output can
   * never evict it. Absent on supervision files written before this field and
   * empty when no QA stage reported a TAP failure.
   */
  failuresLog: z.string().optional(),
  /** Compact per-stage TAP identities, bounded independently from diagnostics. */
  failureIndexes: z.array(mainPrivateProjectQaFailureIndexSchema).optional(),
  escapedDescendants: z.array(frozenHostRunResultSchema.shape.escapedDescendants.element).default([]),
  cancelReason: z.string().nullable().default(null),
  result: mainPrivateQaSupervisionResultSchema.nullable(),
}).strict();
export type MainPrivateQaSupervisionState = z.infer<typeof mainPrivateQaSupervisionStateSchema>;
