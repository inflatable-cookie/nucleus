import { z } from "zod";

/** Legacy coordinator recovery report actions. Historical records stay readable; nothing applies them. */
export const recoveryActions = ["retry", "revise", "resume_worker", "reassign_origin", "reconcile"] as const;

export const recoveryActionSchema = z.enum(recoveryActions);

export type RecoveryAction = z.infer<typeof recoveryActionSchema>;

/** Paseo agent and workspace titles accept at most 200 characters. */
export const MAX_TITLE_LENGTH = 200;

export const taskTitleSchema = z.string().min(1).max(MAX_TITLE_LENGTH, "Title must be 200 characters or fewer");

// Bounded deliberate worker checkpoints per task. The counter is durable and
// survives restart; a fourth receipt enters ordinary needs-attention handling.
export const CHECKPOINT_BUDGET = 3;
