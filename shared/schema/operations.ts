import { z } from "zod";
import { briefDigestSchema, draftApprovalSchema, gitBranchNameSchema } from "./briefs";
import { capabilityLevelSchema, submissionRecordFromLegacy } from "./settings";
import { parseHoldUntil } from "./task-holds";
import { repositoryRekeyInputSchema } from "../repository-rekey";
import { reviewEntryInputSchema, submissionSchema } from "./review";
import { taskControlInputSchema } from "./task-control";

/**
 * Strict generic durable operation surface. Start accepts a caller key and a
 * kind-tagged payload; status reads the same stable record so a lost response
 * reconciles by caller key or operation ID.
 */
export const sourcePromotionInputSchema = z.object({
  hostId: z.string().trim().min(1).max(240).optional(),
  id: z.string().min(1), repository: z.string().optional(), agent: z.string().trim().min(1).optional(),
  baseBranch: gitBranchNameSchema.optional(),
  note: z.string().trim().default(""), board: z.boolean().default(false),
  hold: z.object({ reason: z.string().trim().min(1).max(4000), until: z.string().trim().min(1).max(200).optional() }).strict().optional(),
  /** Spec 053: a papercut's generated brief takes its complexity from here; a lead names it in its own brief. */
  complexity: capabilityLevelSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.hold?.until !== undefined && !parseHoldUntil(input.hold.until))
    ctx.addIssue({ code: "custom", path: ["hold", "until"], message: "A promotion hold's until must be a task ID or an offset timestamp" });
});

export const sourcePromotionOperationPayloadSchema = z.object({
  type: z.literal("source_promote"),
  source: z.object({ kind: z.enum(["lead", "papercut"]), id: z.string().min(1), repository: z.string().min(1),
    version: z.number().int().positive().nullable(), digest: z.string().regex(/^[a-f0-9]{64}$/),
    approval: draftApprovalSchema.nullable().optional() }).strict(),
  request: sourcePromotionInputSchema,
}).strict();

export const leadCheckOperationPayloadSchema = z.object({
  type: z.literal("lead_check"), id: z.string().min(1), version: z.number().int().positive(),
  digest: briefDigestSchema, repository: z.string().min(1), baseBranch: gitBranchNameSchema.default("main"),
}).strict();

export const operationPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("submit"), submission: z.preprocess(raw => submissionRecordFromLegacy(raw), submissionSchema), requirePushedPlanning: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("task_control"), control: taskControlInputSchema }).strict(),
  z.object({ type:z.literal("review_entry"), input:reviewEntryInputSchema }).strict(),
  leadCheckOperationPayloadSchema,
  sourcePromotionOperationPayloadSchema,
  z.object({ type:z.literal("task_remove"), taskId:z.string().min(1).max(160), version:z.number().int().positive() }).strict(),
  z.object({ type: z.literal("repository_rekey"), input: repositoryRekeyInputSchema }).strict(),
]);
