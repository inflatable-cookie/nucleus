import { z } from "zod";
import { repoRelativePathSchema } from "../hooks";
import { laneKeySchema } from "../schema/task-primitives";
import { taskSchema } from "./tasks";
import { taskControlFields } from "./task-control-fields";
import { checkTaskControlRules } from "./task-control-rules";

export { TASK_CONTROL_RELAYED_NOTE_ACTIONS } from "./task-control-rules";
export {
  taskControlFields,
  type TaskControlFields,
} from "./task-control-fields";
export * from "./task-next";

export const owningDocumentPathsSchema = z
  .array(
    repoRelativePathSchema.refine(
      (path) =>
        path.startsWith("docs/") &&
        path.endsWith(".md") &&
        path === path.trim() &&
        !/[\u0000-\u001f\u007f]/.test(path),
      "Owning-document paths must be normalized Markdown files under docs/",
    ),
  )
  .min(1)
  .max(8)
  .superRefine((paths, ctx) => {
    if (new Set(paths).size !== paths.length)
      ctx.addIssue({
        code: "custom",
        message: "Owning-document paths must be unique",
      });
  });

/**
 * Tom 2026-10-12: `set_routing` names the task type `scope` and takes an optional
 * nullable `complexity` for capability-weighted selection. The legacy
 * `capability` spelling is refused on this operator write, never silently
 * accepted or guessed.
 */
const refuseLegacyRoutingCapability = (raw: unknown): unknown => {
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "capability" in (raw as Record<string, unknown>)
  )
    throw new Error(
      'Routing task type is "scope"; the legacy "capability" field is refused on routing writes',
    );
  // Retired Round 4 field: older clients still send it, so it is dropped here rather than refused.
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "profile" in (raw as Record<string, unknown>)
  ) {
    const { profile: _retired, ...rest } = raw as Record<string, unknown>;
    return rest;
  }
  return raw;
};

/** Task controls whose engine paths may carry an operator ruling in `note`. */

const taskControlSchema = <T extends z.ZodType<number | undefined>>(
  version: T,
) =>
  z.preprocess(
    refuseLegacyRoutingCapability,
    taskControlFields(version).superRefine(checkTaskControlRules),
  );

/** Persisted and internal controls always carry a concrete admission version. */
export const taskControlInputSchema = taskControlSchema(z.number());
export const taskControlRequestSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { reference, ...input } = raw as Record<string, unknown>;
  if (reference === undefined) return input;
  if (input.taskId !== undefined)
    throw Error("taskId: pass exactly one of taskId or reference");
  return { ...input, taskId: reference };
}, taskControlSchema(z.number().optional()));
export type TaskControlRequest = z.infer<typeof taskControlRequestSchema>;
export type TaskControlInput = z.infer<typeof taskControlInputSchema>;

const resolutionId = z.string().trim().min(1).max(240);
const resolutionWarningId = z.enum([
  "live_turn",
  "unreported_result",
  "hold_owner",
  "effect_may_land",
  "owned_tool",
  "duplicate_thread",
  "two_writers",
  "head_mismatch",
  "budget",
  "route_policy",
  "live_runs",
  "queued",
  "no_thread",
  "turn_held",
  "merge_in_flight",
  "checks",
  "holds",
  "unverified_merge",
  "no_verdict",
]);
const resolutionAcceptField = z
  .array(resolutionWarningId)
  .max(resolutionWarningId.options.length)
  .default([]);
const resolutionFields = {
  taskId: resolutionId,
  version: z.number().int().positive(),
  reason: z.string().trim().min(1).max(4000),
  accept: resolutionAcceptField,
  caller: resolutionId.optional(),
};
const explicitCommandFields = {
  version: z.number().int().positive().optional(),
  accept: resolutionAcceptField,
};
const explicitCommandVariants = <T extends Record<string, z.ZodTypeAny>>(
  base: T,
) =>
  z.discriminatedUnion("action", [
    z
      .object({
        ...base,
        action: z.literal("run.release"),
        run: resolutionId,
        archive: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("record.clear"),
        kind: z.enum([
          "stop",
          "wait",
          "hold",
          "escalation",
          "incident",
          "effect",
          "host_wait",
          "owner_stop",
          "deferred_verb",
        ]),
        id: resolutionId,
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("run.start"),
        role: z.enum(["worker", "reviewer", "coordinator"]),
        agent: z.enum(["retained", "fresh"]).optional(),
        head: z
          .string()
          .trim()
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
        instruction: z.string().trim().min(1).max(8000).optional(),
        replacing: resolutionId.optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("phase.set"),
        to: z.enum([
          "working",
          "changes_requested",
          "awaiting_review",
          "reviewing",
          "verifying",
          "needs_attention",
          "blocked",
        ]),
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("message.send"),
        role: z.enum(["worker", "reviewer", "coordinator", "planner"]),
        text: z.string().trim().min(1).max(8000),
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("turn.take"),
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("turn.release"),
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("merge.now"),
        head: z
          .string()
          .trim()
          .regex(/^[0-9a-f]{40}$/),
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("closeout.now"),
        mergedCommit: z
          .string()
          .trim()
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
      })
      .strict(),
  ]);
/** Explicit command payload carried inside an escalation answer (Spec 067 batch 4). */
export const explicitCommandSchema = explicitCommandVariants(
  explicitCommandFields,
);
export type ExplicitCommand = z.infer<typeof explicitCommandSchema>;
export const explicitResolutionSchema = z.preprocess((raw) => {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !("reference" in raw)
  )
    return raw;
  const { reference, ...input } = raw;
  return "taskId" in input ? raw : { ...input, taskId: reference };
}, explicitCommandVariants(resolutionFields));
export type ExplicitResolution = z.infer<typeof explicitResolutionSchema>;
export type ResolutionWarningId = z.infer<typeof resolutionWarningId>;
const resolutionResultSchema = z.object({
  status: z.enum(["applied", "warnings", "stale"]),
  warnings: z.array(z.object({ id: resolutionWarningId, text: z.string() })),
  next: z.string(),
  runId: z.string().optional(),
  delivery: z.enum(["delivered", "queued", "unknown"]).optional(),
});

/** A task control response is the updated task (the 23 narrow-action aliases and their deprecation notes were deleted on 2026-10-15). */
export const taskControlTaskSchema = taskSchema.extend({
  changes: z.array(z.string()).optional(),
  explicitResolution: resolutionResultSchema.optional(),
});

export type TaskControlTask = z.infer<typeof taskControlTaskSchema>;
