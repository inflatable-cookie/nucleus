import { z } from "zod";
import { dependencyIdsSchema } from "../schema/task-primitives";

/** One `refs/stash` reflog entry: the stash commit and its reflog subject (`WIP on <branch>: ...`). */
export const stashEntrySchema = z.object({ sha: z.string(), subject: z.string() }).strict();

export type StashEntry = z.infer<typeof stashEntrySchema>;

/** Spec 040: the moment a merge hold became the only thing stopping a reviewed task, and what Queue has said since. */
export const holdBlockingSchema = z.object({
  since: z.string(), head: z.string(), generation: z.number().int().nonnegative(),
  notices: z.number().int().nonnegative().default(0), lastNoticeAt: z.string().nullable().default(null),
  escalatedAt: z.string().nullable().default(null),
}).strict();

export type HoldBlocking = z.infer<typeof holdBlockingSchema>;

/** Spec 046: what ends a self-lifting hold. `task` waits for a task to finish; `time` waits for an offset timestamp. */
export const holdUntilSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), taskId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("time"), at: z.string().datetime({ offset: true }) }).strict(),
]);

export type HoldUntil = z.infer<typeof holdUntilSchema>;

/** One independent hold fence: dispatch blocks promotion; merge blocks merge. */
export const holdFenceSchema = z.object({
  owner: z.string().min(1),
  reason: z.string().min(1),
  at: z.string(),
  generation: z.number().int().nonnegative(),
  until: holdUntilSchema.nullable().default(null),
  blocking: holdBlockingSchema.nullable().optional(),
}).strict();

export type HoldFence = z.infer<typeof holdFenceSchema>;

export const taskHoldsSchema = z.object({
  dispatch: holdFenceSchema.optional(),
  merge: holdFenceSchema.optional(),
}).strict();

export type TaskHolds = z.infer<typeof taskHoldsSchema>;

/**
 * Spec 046: read the `hold` control's `until` string, which is either a task ID or
 * an offset timestamp. Anything else returns null so the control schema refuses it.
 */
export function parseHoldUntil(raw: string): HoldUntil | null {
  const value = raw.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return { kind: "task", taskId: value };
  const at = z.string().datetime({ offset: true }).safeParse(value);
  return at.success ? { kind: "time", at: new Date(value).toISOString() } : null;
}

export const retainedPrerequisiteWaitSchema = z.object({
  id: z.string().uuid(), waitsFor: dependencyIdsSchema, reason: z.string().trim().min(1).max(4000),
  /** Present after release so Queue does not turn a completed wait into an automatic revision. */
  releasedAt: z.string().datetime({ offset: true }).nullable().default(null),
}).strict();

export type RetainedPrerequisiteWait = z.infer<typeof retainedPrerequisiteWaitSchema>;

/** A planner/operator decision that a particular worker agent or profile gets no further turns on this task. */
export const workerExclusionSchema = z.object({
  agentId: z.string().min(1).nullable(), profileId: z.string().min(1).nullable(),
  reason: z.string().trim().min(1).max(4000), createdAt: z.string(),
}).strict().refine(record => Number(Boolean(record.agentId)) + Number(Boolean(record.profileId)) === 1,
  "A worker exclusion names exactly one agent or profile");

export type WorkerExclusion = z.infer<typeof workerExclusionSchema>;

/** Spec 050: eight retirements is the worker replacement loop breaker. */
export const WORKER_REPLACEMENT_CEILING = 8;
