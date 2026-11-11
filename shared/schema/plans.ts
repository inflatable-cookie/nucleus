import { z } from "zod";
import { laneKeySchema } from "../schema/task-primitives";

/** Spec 041: `doneWhen` is one line saying what finishes the step; entries saved before it have none. */
export const planEntrySchema = z.object({ lane: laneKeySchema, note: z.string().max(200).default(""), horizon: z.enum(["now", "next", "later"]).default("now"), doneWhen: z.string().max(300).regex(/^[^\r\n]*$/, "doneWhen is one line: no CR or LF (Spec 041, contract 008)").optional() }).strict();

/** A plan entry whose lane is now done or abandoned, as read from the plan's history (Spec 041 Done band). */
export const planDoneEntrySchema = planEntrySchema.extend({ status: z.enum(["done", "abandoned"]), closedAt: z.string().nullable() }).strict();

export const planEntriesSchema = z.array(planEntrySchema).max(200)
  .refine(entries => new Set(entries.map(entry => entry.lane)).size === entries.length, "Duplicate lane key");

/** A project's plan as read: the saved order, then any listing lane it does not name yet. `version` is 0 before the first save. */
export const projectPlanSchema = z.object({
  project: z.string(), version: z.number().int().nonnegative(), entries: z.array(planEntrySchema), done: z.array(planDoneEntrySchema).optional(),
  author: z.string().nullable(), createdAt: z.string().nullable(),
  /** The owner's acknowledgement that the board is idle on purpose (Tom, 2026-10-15): it answers the drained-board prompt until the plan changes or new work finishes. */
  idle: z.object({ reason: z.string().trim().min(1).max(300), at: z.string() }).strict().nullable().optional(),
}).strict();

export type ProjectPlan = z.infer<typeof projectPlanSchema>;

/** Batched board read includes the immutable saved membership alongside the current lane projection. */
export const planningPlanSnapshotSchema = projectPlanSchema.extend({ savedEntries: planEntriesSchema }).strict();

export type PlanningPlanSnapshot = z.infer<typeof planningPlanSnapshotSchema>;
