import { z } from "zod";
import { repoRelativePathSchema } from "../hooks";
import { laneKeySchema } from "../schema/task-primitives";
import { taskSchema } from "./tasks";
import { taskControlFields } from "./task-control-fields";
import { checkTaskControlRules } from "./task-control-rules";

export { TASK_CONTROL_RELAYED_NOTE_ACTIONS } from "./task-control-rules";
export { taskControlFields, type TaskControlFields } from "./task-control-fields";
export * from "./task-next";

export const owningDocumentPathsSchema = z.array(repoRelativePathSchema.refine(path => path.startsWith("docs/") && path.endsWith(".md") && path === path.trim() && !/[\u0000-\u001f\u007f]/.test(path), "Owning-document paths must be normalized Markdown files under docs/"))
    .min(1).max(8).superRefine((paths, ctx) => {
      if (new Set(paths).size !== paths.length) ctx.addIssue({ code: "custom", message: "Owning-document paths must be unique" });
    });

/**
 * Tom 2026-10-12: `set_routing` names the task type `scope` and takes an optional
 * nullable `complexity` for capability-weighted selection. The legacy
 * `capability` spelling is refused on this operator write, never silently
 * accepted or guessed.
 */
const refuseLegacyRoutingCapability = (raw: unknown): unknown => {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "capability" in (raw as Record<string, unknown>))
    throw new Error('Routing task type is "scope"; the legacy "capability" field is refused on routing writes');
  return raw;
};

/** Task controls whose engine paths may carry an operator ruling in `note`. */

const taskControlSchema = <T extends z.ZodType<number | undefined>>(version: T) => z.preprocess(
  refuseLegacyRoutingCapability,
  taskControlFields(version).superRefine(checkTaskControlRules),
);


/** Persisted and internal controls always carry a concrete admission version. */
export const taskControlInputSchema = taskControlSchema(z.number());
export const taskControlRequestSchema = z.preprocess(raw => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { reference, ...input } = raw as Record<string, unknown>;
  if (reference === undefined) return input;
  if (input.taskId !== undefined) throw Error("taskId: pass exactly one of taskId or reference");
  return { ...input, taskId: reference };
}, taskControlSchema(z.number().optional()));
export type TaskControlRequest = z.infer<typeof taskControlRequestSchema>;
export type TaskControlInput = z.infer<typeof taskControlInputSchema>;

/** A task control response is the updated task (the 23 narrow-action aliases and their deprecation notes were deleted on 2026-10-15). */
export const taskControlTaskSchema = taskSchema.extend({
  changes: z.array(z.string()).optional(),
});

export type TaskControlTask = z.infer<typeof taskControlTaskSchema>;
