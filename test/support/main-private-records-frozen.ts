/** Frozen main-branch host-run and validation records used to prove rollback compatibility. */
import { z } from "zod";
import { frozenHostRunEscapedDescendantSchema, frozenHostRunResultSchema } from "./contract-010-frozen";

/** Every meta GLOB/LIKE scan in main (server/, shared/, bin/), verbatim; no other main code scans meta by pattern. */
export const MAIN_META_PATTERN_SCANS = [
  { op: "LIKE", pattern: "displacedDispatchWorkspace:%" }, // owner-verbs.ts (bound to one task id)
  { op: "GLOB", pattern: "projectQaRequest:*" }, // project-qa.ts, store.ts
  { op: "LIKE", pattern: "mcpReportIntent:%" }, // store.ts
  { op: "LIKE", pattern: "bulkDisposition:%" }, // store.ts
] as const;

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
