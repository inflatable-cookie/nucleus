import { z } from "zod";
import { mergeCandidateSchema } from "../hooks";

/**
 * Upper bound for a repository's pre-merge validation timeout. A fresh-checkout
 * validation installs its own dependencies and runs the repository's full CI, which
 * already takes about ten minutes for project-k; the repository setting picks the
 * actual value, and a run holds that repository's integration turn while it lasts.
 */
export const VALIDATION_TIMEOUT_MAX_MS = 1_800_000;

/** Grace given to a timed-out validation process group before SIGKILL. */
export const DEFAULT_PROCESS_TERMINATION_GRACE_MS = 30_000;

export const PROCESS_TERMINATION_GRACE_MAX_MS = 300_000;

export const projectValidationSchema = z.object({
  argv: z.array(z.string().max(4096)).min(1).max(32).refine(argv => argv[0].length > 0, "Validation executable must not be empty"),
  timeoutMs: z.number().int().min(1).max(VALIDATION_TIMEOUT_MAX_MS),
  maxOutputBytes: z.number().int().min(1).max(1048576),
  terminationGraceMs: z.number().int().min(0).max(PROCESS_TERMINATION_GRACE_MAX_MS).default(DEFAULT_PROCESS_TERMINATION_GRACE_MS),
}).strict();

export type ProjectValidation = z.input<typeof projectValidationSchema>;

/** Historical Spec 031 telemetry, accepted only when reading older records. */
export const projectValidationAdmissionSchema = z.object({
  /** Opaque caller identity from the retired Effigy telemetry join. */
  caller: z.string().min(1).max(300),
  availability: z.enum(["joined", "unavailable"]),
  /** Effigy's legacy admission run ID, present only when an old record joined. */
  runId: z.string().min(1).max(200).nullable(),
  /** Effigy's terminal run state (succeeded, failed, capacity_timeout, ...). */
  state: z.string().min(1).max(80).nullable(),
  queueWaitMs: z.number().int().nonnegative().nullable(),
  wallMs: z.number().int().nonnegative().nullable(),
  cpuUserMs: z.number().int().nonnegative().nullable(),
  cpuSystemMs: z.number().int().nonnegative().nullable(),
  peakRssBytes: z.number().int().nonnegative().nullable().default(null),
}).strict();

export type ProjectValidationAdmission = z.infer<typeof projectValidationAdmissionSchema>;

export const projectValidationCapacityWaitSchema = z.object({
  /** One-based queue position from the scheduler that owns this validation. */
  position: z.number().int().positive(),
  /** When Queue recorded the position. */
  observedAt: z.string(),
}).strict();

export type ProjectValidationAdmissionWait = z.infer<typeof projectValidationCapacityWaitSchema>;

/** Scheduler-owned telemetry copied from the validation's host-run record at settlement. */
export const projectValidationSchedulerTelemetrySchema = z.object({
  queueWaitMs: z.number().int().nonnegative().nullable(),
  wallMs: z.number().int().nonnegative().nullable(),
  cpuMs: z.number().int().nonnegative().nullable(),
  outcome: z.enum(["passed", "failed", "timed_out", "cancelled", "lost", "capacity_timeout"]).nullable(),
}).strict();

export type ProjectValidationSchedulerTelemetry = z.infer<typeof projectValidationSchedulerTelemetrySchema>;

export const projectValidationResultSchema = z.object({
  argv: z.array(z.string()), digest: z.string(), exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(), outputTail: z.string(),
  terminationGraceMs: z.number().int().min(0).max(PROCESS_TERMINATION_GRACE_MAX_MS).optional(),
  base: z.string(), head: z.string(), candidate: mergeCandidateSchema.nullable().optional(), state: z.enum(["running", "passed", "refused", "hold", "superseded"]),
  /** Queue build identity that produced this result. A changed build reruns validation. */
  queueBuild: z.string().default(""),
  /** Repository settings revision that produced this result. A later settings write reruns validation. */
  settingsRevision: z.number().int().nonnegative().default(0),
  /** Contract 010 scheduler identity, present for Queue-admitted runs. */
  hostRunId: z.string().min(1).max(160).optional(),
  hostRunEpoch: z.number().int().positive().optional(),
  /** Queue's scheduler record and settlement; absent on legacy rows. */
  hostRunTelemetry: projectValidationSchedulerTelemetrySchema.optional(),
  submittedAt: z.string().datetime().optional(),
  selector: z.string().min(1).optional(),
  runTimeoutMs: z.number().int().positive().optional(),
  capacityDeadlineAt: z.string().datetime().optional(),
  /** Validation leader PID for display and diagnostics; it does not prove process-tree exit. */
  pid: z.number().int().positive().nullable().default(null),
  /** The validation step's detached process group and inherited leader identity. */
  processGroupId: z.number().int().positive().nullable().optional(),
  leaderStartIdentity: z.string().min(1).nullable().optional(),
  terminationSignal: z.enum(["SIGTERM", "SIGKILL"]).nullable().optional(),
  processGroupEmpty: z.boolean().nullable().optional(),
  terminationError: z.string().nullable().optional(),
  /** Historical Effigy admission telemetry; new validations omit it. */
  admission: projectValidationAdmissionSchema.nullable().optional(),
  /** Live capacity wait from Queue's scheduler. Cleared at settle. */
  capacityWait: projectValidationCapacityWaitSchema.nullable().default(null),
  /** True when the capacity deadline lapsed: a typed hold, never a validation failure. */
  capacityUnavailable: z.boolean().default(false),
  /** Lost and timed-out runs require an explicit retry; build or settings changes cannot replay them. */
  resubmissionRequired: z.boolean().optional(),
  /** The durable verdict is kept while interrupted removal of its disposable candidate is retried. */
  candidateCleanupPending: z.boolean().optional(),
}).strict();
