import { z } from "zod";
import { laneKeySchema } from "../schema/task-primitives";
import { planningTriageSchema } from "./triage";
import { laneViewSchema } from "./lanes";

/** Preserve stored text so a planner can read and correct an older step. */
export const planEntrySchema = z.object({ lane: laneKeySchema, note: z.string().default(""), horizon: z.enum(["now", "next", "later"]).default("now"), doneWhen: z.string().optional() }).strict();

/** A plan entry whose lane is now done or abandoned, as read from the plan's history (Spec 041 Done band). */
export const planDoneEntrySchema = planEntrySchema.extend({ status: z.enum(["done", "abandoned"]), closedAt: z.string().nullable() }).strict();

function orderedEntries(entry: typeof planEntrySchema) {
  return z.array(entry).max(200)
    .refine(entries => new Set(entries.map(step => step.lane)).size === entries.length, "Duplicate lane key");
}

export const planEntriesSchema = orderedEntries(planEntrySchema.extend({
  doneWhen: z.string().max(300).regex(/^[^\r\n]*$/, "doneWhen must fit on one line").optional(),
}));

/** A project's plan as read: the saved order, then any listing lane it does not name yet. `version` is 0 before the first save. */
export const projectPlanSchema = z.object({
  project: z.string(), version: z.number().int().nonnegative(), entries: z.array(planEntrySchema), done: z.array(planDoneEntrySchema).optional(),
  author: z.string().nullable(), createdAt: z.string().nullable(),
  /** The owner's acknowledgement that the board is idle on purpose (Tom, 2026-10-15): it answers the drained-board prompt until the plan changes or new work finishes. */
  idle: z.object({ reason: z.string().trim().min(1).max(300), at: z.string() }).strict().nullable().optional(),
}).strict();

export type ProjectPlan = z.infer<typeof projectPlanSchema>;

/** Batched board read includes the immutable saved membership alongside the current lane projection. */
export const planningPlanSnapshotSchema = projectPlanSchema.extend({
  savedEntries: orderedEntries(planEntrySchema),
  triage: planningTriageSchema.optional(),
  laneViews: z.array(laneViewSchema).optional(),
}).strict();

export type PlanningPlanSnapshot = z.infer<typeof planningPlanSnapshotSchema>;
