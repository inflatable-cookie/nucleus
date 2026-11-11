import { z } from "zod";
import { workDispositionSchema } from "./disposition";
import { taskSchema } from "./tasks";

export const bulkDispositionRequestSchema = z.object({
  operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
  tasks: z.array(z.object({ taskId: z.string().min(1).max(160), version: z.number().int().positive() }).strict()).min(1).max(256),
  action: z.enum(["cancel", "supersede"]),
  reason: z.string().trim().min(1).max(4000),
  replacementTaskId: z.string().min(1).max(160).optional(),
  workDisposition: workDispositionSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.tasks.map(task => task.taskId)).size !== input.tasks.length)
    ctx.addIssue({ code: "custom", path: ["tasks"], message: "Bulk disposition task IDs must be unique" });
  if (input.action === "supersede" && !input.replacementTaskId)
    ctx.addIssue({ code: "custom", path: ["replacementTaskId"], message: "Supersession requires the retained replacement task ID" });
  if (input.action !== "supersede" && input.replacementTaskId)
    ctx.addIssue({ code: "custom", path: ["replacementTaskId"], message: "A replacement task is only valid for supersession" });
  if (input.workDisposition === "retained_by_replacement" && input.action !== "supersede")
    ctx.addIssue({ code: "custom", path: ["workDisposition"], message: "Retained-by-replacement disposition is only valid for supersession" });
});

export type BulkDispositionRequest = z.infer<typeof bulkDispositionRequestSchema>;

export const bulkDispositionItemSchema = z.object({
  taskId: z.string(), initialVersion: z.number().int().positive(), currentVersion: z.number().int().positive(),
  phase: taskSchema.shape.phase, status: z.enum(["pending", "running", "complete", "attention"]),
  attempts: z.number().int().nonnegative(), error: z.string(),
}).strict();

export const bulkDispositionSchema = z.object({
  operationId: z.string(), inputHash: z.string(), status: z.enum(["pending", "running", "complete", "attention"]),
  action: z.enum(["cancel", "supersede"]), reason: z.string(), replacementTaskId: z.string().nullable(),
  workDisposition: workDispositionSchema, requestedBy: z.string(), createdAt: z.string(), updatedAt: z.string(),
  items: z.array(bulkDispositionItemSchema),
}).strict();

export type BulkDisposition = z.infer<typeof bulkDispositionSchema>;
