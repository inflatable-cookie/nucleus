import { z } from "zod";
import { dispositionStatusSchema } from "../schema/task-primitives";

export const workDispositionSchema = z.enum(["preserve", "archive_if_empty", "retained_by_replacement"]);

export type WorkDisposition = z.infer<typeof workDispositionSchema>;

export const dispositionEffectSchema = z.object({
  kind: z.string().min(1).max(120), target: z.string().min(1).max(320),
  intentAt: z.string(), result: z.string().nullable().default(null), resultAt: z.string().nullable().default(null),
  uncertain: z.boolean().default(false),
}).strict();

export type DispositionEffect = z.infer<typeof dispositionEffectSchema>;

/** Origin ref identity at disposition fence time, or a later post-disposition observation. */
export const dispositionRefSchema = z.object({
  ref: z.string().min(1).max(320),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();

export type DispositionRef = z.infer<typeof dispositionRefSchema>;

export const postDispositionRefSchema = dispositionRefSchema.extend({
  observedAt: z.string(),
}).strict();

export type PostDispositionRef = z.infer<typeof postDispositionRefSchema>;

/** One attributed owner transition of a disposition's workspace proof policy. */
export const dispositionProofPolicySchema = z.object({
  policy: workDispositionSchema,
  previous: workDispositionSchema,
  at: z.string(),
  /** The owner thread or board identity that selected it. */
  by: z.string().trim().min(1).max(240),
  /** The recorded owner authority: operator board, project owner or relayed note. */
  authority: z.string().trim().min(1).max(60),
  note: z.string().trim().max(4000).nullable().default(null),
  reason: z.string().trim().min(1).max(4000),
}).strict();

export type DispositionProofPolicy = z.infer<typeof dispositionProofPolicySchema>;

export const dispositionSchema = z.object({
  kind: z.enum(["cancel", "supersede"]),
  status: dispositionStatusSchema,
  requestedAt: z.string(), requestedBy: z.string().min(1).max(240),
  reason: z.string().trim().min(1).max(4000),
  replacementTaskId: z.string().nullable().default(null),
  replacementBranch: z.string().nullable().default(null),
  replacementWorkspaceId: z.string().nullable().default(null),
  workDisposition: workDispositionSchema,
  workspaceId: z.string().nullable().default(null),
  workspaceArchived: z.boolean().default(false),
  workspaceEvidence: z.string().default(""),
  hookEmitted: z.boolean().default(false),
  effects: z.array(dispositionEffectSchema).default([]),
  completedAt: z.string().nullable().default(null),
  attention: z.string().default(""),
  /** Null until the first successful origin listing after the fence; empty means listed and none matched. */
  refSnapshot: z.array(dispositionRefSchema).nullable().default(null),
  /** Queue-branch or tag refs that appeared or moved on origin after the snapshot. */
  postDispositionRefs: z.array(postDispositionRefSchema).default([]),
  /**
   * Attributed owner transitions of the workspace proof policy, newest last.
   * The original `workDisposition` stays exactly as requested; a supersession
   * that can no longer prove retention by its retired replacement records the
   * existing safe `archive_if_empty` policy here instead of rewriting intent.
   */
  proofPolicies: z.array(dispositionProofPolicySchema).default([]),
}).strict();

export type Disposition = z.infer<typeof dispositionSchema>;
