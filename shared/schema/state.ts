import { z } from "zod";
import { holdKindSchema, laneKeyListSchema } from "../schema/task-primitives";
import { taskSchema } from "./tasks";
import { projectSchema } from "./projects";
import { operationSummarySchema } from "../operations";
import { DEFAULT_HOLD_ESCALATION_MINUTES, DEFAULT_HOLD_REMINDER_MINUTES, DEFAULT_LANE_DRAIN_ESCALATION_MINUTES, DEFAULT_LANE_DRAIN_MINUTES, DEFAULT_PAPERCUT_PROJECT_LIMIT, DEFAULT_PASEO_CALL_LIMIT, DEFAULT_STALL_THRESHOLD_MINUTES, MAX_HOLD_MINUTES, MAX_PASEO_CALL_LIMIT, MAX_STALL_THRESHOLD_MINUTES, poolSchema, profileSchema, projectDispatchLimitOverridesSchema, routingGrantViewSchema, usageViewSchema } from "./settings";
import { qaFenceViewSchema } from "./qa-fence";
import { backupHealthSchema } from "./backup";
import { taskSummarySchema } from "../schema/task-view";
import { laneViewSchema } from "./lanes";
import { boardQaRunSchema } from "./qa";

export const eventSchema = z.object({ id: z.number(), taskId: z.string(), at: z.string(), kind: z.string(), detail: z.string() });

export const availabilitySchema = z.object({ group: z.string(), unavailable: z.boolean(), reason: z.string(), retryAt: z.string().nullable() });

/** The compatibility snapshot carries live tasks only; history is addressed by ID. */
export const liveTaskSchema = taskSchema.omit({ handoffText: true, brief: true, briefVersions: true, laneContext: true, laneDocumentPins: true })
  .extend({ holdKind: holdKindSchema.optional() }).refine(task => task.phase !== "done" && task.phase !== "cancelled", "Snapshot tasks must be live");

export type LiveTask = z.infer<typeof liveTaskSchema>;

/** Default page keeps a compact live read inside the 16 MiB frame; raise per call up to `SNAPSHOT_MAX_LIMIT`. */
export const SNAPSHOT_DEFAULT_LIMIT = 100;

export const SNAPSHOT_MAX_LIMIT = 250;

export const snapshotInputSchema = z.object({
  repository: z.string().min(1).optional(),
  project: projectSchema.shape.key.optional(),
  limit: z.number().int().positive().max(SNAPSHOT_MAX_LIMIT).optional(),
  cursor: z.string().min(1).optional(),
}).strict();

export type SnapshotInput = z.infer<typeof snapshotInputSchema>;

/**
 * Spec 026: an accepted submission whose operation has not created its task yet.
 * The card is the durable operation, so it appears on the board before the task
 * exists and is replaced by the task when the submission settles.
 */
export const pendingSubmissionSchema = z.object({
  id: z.string().min(1), submissionId: z.string().min(1), title: z.string(),
  repoPath: z.string().min(1), repository: z.string().nullable().default(null),
  lanes: laneKeyListSchema.default([]),
  state: z.enum(["pending", "running"]), createdAt: z.string(),
}).strict();

export type PendingSubmission = z.infer<typeof pendingSubmissionSchema>;

export const boundRunSchema = z.object({
  taskId: z.string(),
  runId: z.string(),
  role: z.string(),
  reference: z.string().nullable(),
}).strict();

export type BoundRun = z.infer<typeof boundRunSchema>;

export const stateSchema = z.object({
  prStates:z.record(z.string(),z.enum(["OPEN","CLOSED","MERGED"])).default({}),
  connected: z.boolean(), hostId: z.string(), paused: z.boolean(), dispatchHeld: z.boolean().default(false),
  drained: z.boolean().default(false), boundRuns: z.array(boundRunSchema).default([]),
  error: z.string(),
  quiet: z.boolean(), activeWorkers: z.number(), unsettled: z.number(),
  /** Queue #650: live threads the operator stopped while paused and still waiting to resume, and threads resumed since the last stop action. */
  stoppedThreads: z.number().int().nonnegative().default(0), resumedThreads: z.number().int().nonnegative().default(0),
  occupiedSlots: z.number().int().nonnegative().optional(),
  globalLimit: z.number(), projectLimit: z.number(),
  usage: usageViewSchema.default({ level: "normal", setLevel: "normal", until: null, expired: false }),
  routingGrants: z.array(routingGrantViewSchema).default([]),
  qaFence: qaFenceViewSchema.default({ revision: 0, fence: null, expired: null }),
  demandOffsets: z.object({ worker: z.number().int(), reviewer: z.number().int(), coordinator: z.number().int() }).strict().default({ worker: 0, reviewer: 0, coordinator: -2 }),
  papercutProjectLimit: z.number().int().min(1).max(32).default(DEFAULT_PAPERCUT_PROJECT_LIMIT),
  projectLimitOverrides: projectDispatchLimitOverridesSchema.default({}),
  projectCapacities: z.array(z.object({ projectKey: z.string(), projectName: z.string(), occupiedSlots: z.number().int().nonnegative(), slotLimit: z.number().int().nonnegative(), inFlightTasks: z.number().int().nonnegative(), inFlightLimit: z.number().int().nonnegative() }).strict()).default([]),
  paseoCallLimit: z.number().int().min(1).max(MAX_PASEO_CALL_LIMIT).default(DEFAULT_PASEO_CALL_LIMIT),
  stallThresholdMinutes: z.number().int().min(1).max(MAX_STALL_THRESHOLD_MINUTES).default(DEFAULT_STALL_THRESHOLD_MINUTES),
  // Spec 040: how often Queue re-prompts a merge hold's owner, and when it asks the operator.
  holdReminderMinutes: z.number().int().min(1).max(MAX_HOLD_MINUTES).default(DEFAULT_HOLD_REMINDER_MINUTES),
  holdEscalationMinutes: z.number().int().min(1).max(MAX_HOLD_MINUTES).default(DEFAULT_HOLD_ESCALATION_MINUTES),
  // Spec 041: the lane close-out and next-aim drain timers.
  laneDrainMinutes: z.number().int().min(1).max(MAX_HOLD_MINUTES).default(DEFAULT_LANE_DRAIN_MINUTES),
  laneDrainEscalationMinutes: z.number().int().min(1).max(MAX_HOLD_MINUTES).default(DEFAULT_LANE_DRAIN_ESCALATION_MINUTES),
  operationLimit: z.number().int().positive().default(64),
  operationBacklog: z.number().int().nonnegative().default(0),
  operations: z.array(operationSummarySchema).default([]),
  // Spec 028: snapshot health rides the board, so the stale warning on a Settings tab
  // is not a `backup.list` poll of its own.
  backup: backupHealthSchema.default({ newestSnapshotAt: null, localError: null }),
  tasks: z.array(liveTaskSchema), profiles: z.array(profileSchema), pool: z.array(poolSchema),
  availability: z.array(availabilitySchema), assignments: z.record(z.string(), z.number()), recentAssignments:z.record(z.string(),z.number()),
});

export type QueueState = z.infer<typeof stateSchema>;

export const snapshotStateSchema = stateSchema.extend({
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export type SnapshotState = z.infer<typeof snapshotStateSchema>;

export const uiStateSchema = stateSchema.omit({ tasks: true }).extend({ queuedCounts: z.array(z.object({ repoPath: z.string(), count: z.number().int().nonnegative() })).default([]), tasks: z.array(taskSummarySchema), lanes: z.array(laneViewSchema).default([]), projects: z.array(projectSchema).default([]), pendingSubmissions: z.array(pendingSubmissionSchema).default([]), qaRuns: z.lazy(() => z.array(boardQaRunSchema)).default([]) });

export type UiQueueState = z.infer<typeof uiStateSchema>;

/**
 * Bounded unchanged-board acknowledgement (Contract 007): when the caller sends
 * its last observed store revision and nothing changed, the service answers
 * with global counters only instead of another complete projection.
 */
export const boardAckSchema = z.object({
  unchanged: z.literal(true), revision: z.number().int().nonnegative(),
  connected: z.boolean(), paused: z.boolean(), dispatchHeld: z.boolean().default(false),
  drained: z.boolean().default(false), boundRuns: z.array(boundRunSchema).default([]),
  quiet: z.boolean(),
  activeWorkers: z.number(), unsettled: z.number(), error: z.string(),
  occupiedSlots: z.number().int().nonnegative().optional(),
  stoppedThreads: z.number().int().nonnegative(), resumedThreads: z.number().int().nonnegative(),
}).strict();

export type UnchangedBoard = z.infer<typeof boardAckSchema>;

/**
 * Per-domain read keys for the board's planning lists (task 1030). Each moves only when its
 * own records are written, and every such write also advances the board revision, so a full
 * projection always carries the current values and the bounded acknowledgement needs none.
 */
export const planningRevisionsSchema = z.object({
  leads: z.number().int().nonnegative(), decisions: z.number().int().nonnegative(), plans: z.number().int().nonnegative(),
}).strict();
export type PlanningRevisions = z.infer<typeof planningRevisionsSchema>;
/** The native board reads this: a full compact projection (with revision) or a bounded acknowledgement. */
export const uiBoardSchema = z.union([uiStateSchema.extend({ revision: z.number().int().nonnegative(), planning: planningRevisionsSchema.optional() }), boardAckSchema]);

export type UiBoard = z.infer<typeof uiBoardSchema>;

export const RETAINED_WORKER_PROFILE_REASON = "Retained worker profile is disabled or unavailable";

export const missingResultSchema = z.object({
  role: z.enum(["worker", "revision", "reviewer"]),
  runId: z.string(),
  prUrl: z.string().nullable(),
}).strict();

/**
 * A mark/reset payload keeps its historical shape: unknown keys are still
 * ignored, so older callers are unaffected. Only carrying an `action` key makes
 * it ambiguous with the removal payload, and that is refused.
 */
export const availabilityMarkSchema = availabilitySchema.extend({ action: z.undefined().optional() });
