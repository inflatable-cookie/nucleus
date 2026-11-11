import { z } from "zod";
import { taskPhaseSchema, dependencyIdsSchema, laneKeyListSchema, holdKindSchema, dispositionStatusSchema } from "./task-primitives";
import { taskStopKindSchema, taskStopRecordSchema } from "../task-stop";
import { REPORT_HEADLINE_MAX } from "../task-detail-summary";
import { taskBudgetBoardViewSchema } from "../task-budget";
import { waitStateViewSchema } from "../wait-state";

export const heavyRunViewSchema = z.object({
  selector: z.string(), state: z.enum(["queued", "admitted", "running"]), position: z.number().int().positive().nullable(),
  submittedAt: z.string().datetime(), launchedAt: z.string().datetime().nullable(), holder: z.string().nullable(),
}).strict();

export type HeavyRunView = z.infer<typeof heavyRunViewSchema>;

export const taskSummarySchema = z.object({
  id: z.string(), title: z.string(), repoPath: z.string(), repository: z.string().optional(), version: z.number(), hostId: z.string().optional(),
  number: z.number().int().positive().nullable(), reference: z.string().nullable(),
  entrypoint:z.enum(["worker","review","proof"]),
  questionAgentIds: z.array(z.string()).optional(),
  interactive: z.literal(true).optional(),
  phase: taskPhaseSchema, reason: z.string(), held: z.boolean(), holdKind: holdKindSchema.optional(),
  parked: z.boolean().optional(),
  dependsOn: dependencyIdsSchema, queuePriority: z.number().int().nonnegative(),
  // Null and empty defaults are omitted rather than shipped: a compact board
  // card only shows a field when the task has one, and at 260 tasks the
  // always-present null keys cost more than the 128 KiB transfer budget allows.
  profile: z.object({ name: z.string() }).nullable().optional(), prUrl: z.string().nullable().optional(),
  resumePrNumber: z.number().nullable().optional(), completionPrNumber: z.number().int().positive().nullable().optional(),
  originError: z.string().optional(), originLookupError: z.string().optional(),
  lanes: laneKeyListSchema.default([]),
  disposition: z.object({ kind: z.enum(["cancel", "supersede"]), status: dispositionStatusSchema, reason: z.string() }).nullable().optional(),
  // Spec 036: an operator reassignment names the current worker and reviewer
  // requests by profile, so the Pipeline shows them beside the assignment.
  // Present only when set: as always-null keys they cost ~13 KB at 260 tasks
  // and pushed the board transfer past its 128 KiB budget.
  workerRequest: z.string().optional(),
  reviewerRequest: z.string().optional(),
  // Spec 032: an escalated incident or recovery marks the task Queue-raised on
  // the decisions view. Optional so existing board fixtures keep their shape.
  resolution: z.object({
    // False is the common case and has no board meaning; omit it to keep each
    // card small. Task detail still carries the full durable resolution state.
    attention: z.boolean().optional(), mergedCommit: z.string().nullable().optional(), escalated: z.boolean().optional(),
    archiveRetry: z.object({ workspaceId: z.string().max(80), attempts: z.number().int().positive(), error: z.string().max(240), nextAttemptAt: z.string() }).strict().optional(),
  }),
  // Spec 040: who holds the task, why, and since when; `holdEscalated` marks the Decisions item.
  hold: z.object({ owner: z.string(), reason: z.string(), since: z.string().nullable(), blockingSince: z.string().nullable().optional() }).optional(),
  holdEscalated: z.boolean().optional(),
  // Spec 050: the task.next stop or wait category, on stopped tasks only, so a
  // board card can badge why the task is stopped. Optional so existing board
  // fixtures keep their shape and progressing tasks add no transfer weight.
  stop: taskStopKindSchema.optional(),
  stopRecord: taskStopRecordSchema.optional(),
  // Task 538: the newest accepted report's headline, so a card snippet reads as a
  // report rather than the stored reason. Bounded and absent when no report exists.
  headline: z.string().max(REPORT_HEADLINE_MAX).optional(),
  // Spec 058: a responsible task's effective-token and wall-time budget, used over limit. Absent on other tasks and finished ones.
  budget: taskBudgetBoardViewSchema.optional(),
  // Independent fences when either is present. Omitted when the task is unheld so
  // empty objects do not inflate the 128 KiB board transfer.
  holds: z.object({
    dispatch: z.object({ owner: z.string(), reason: z.string(), since: z.string() }).strict().optional(),
    merge: z.object({ owner: z.string(), reason: z.string(), since: z.string() }).strict().optional(),
  }).strict().optional(),
  holdDisplayOwner: z.string().optional(),
  /** Plain name for the holder in a responsible-task blocker escalation. */
  stopDisplayOwner: z.string().optional(),
  // Spec 043 (a): the explicit wait, its owner and next action. Optional so a
  // task in no declared wait and existing board fixtures keep their shape.
  waitState: waitStateViewSchema.optional(),
  /** Compact linked-task target used by status labels for deliberate waits. */
  waitingOn: z.string().max(200).optional(),
  /** Queue #650: a thread of this task was stopped while Queue was paused and has not resumed yet. */
  pausedStop: z.literal(true).optional(),
  heavyRun: heavyRunViewSchema.optional(),
}).strict();

export type TaskSummary = z.infer<typeof taskSummarySchema>;
