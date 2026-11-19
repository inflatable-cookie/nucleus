import { z } from "zod";

/** Legacy coordinator recovery report actions. Historical records stay readable; nothing applies them. */
export const recoveryActions = [
  "retry",
  "revise",
  "resume_worker",
  "reassign_origin",
  "reconcile",
] as const;

export const recoveryActionSchema = z.enum(recoveryActions);

export type RecoveryAction = z.infer<typeof recoveryActionSchema>;

/**
 * The four narrow task controls folded into the owner verbs (Tom, 2026-10-19).
 * They are parse-only history on a stored coordinator report: intake refuses a
 * new report naming one, and the recovery pass refuses the stored one as retired
 * with the owner verb that replaced it (nucleus#1388).
 */
export const retiredNarrowCoordinatorActions = [
  "continue_review",
  "retry_resolution",
  "resolve_escalation",
  "repin_instruction",
] as const;

/** Every retired narrow action and the owner verb that does its work now. */
const retiredNarrowInstead: Record<string, string> = {
  // Spec 049 coordinator recovery actions, kept readable on old completions and
  // bindings (`completion.recoveryAction`); nothing applies them.
  retry: "restart",
  revise: "move to=work",
  resume_worker: "restart role=worker",
  reassign_origin: "restart role=coordinator",
  reconcile: "restart",
  continue_review: "restart role=reviewer",
  retry_resolution: "restart",
  resolve_escalation: "restart",
  repin_instruction: "amend_brief with no text",
};

/** The owner verb that replaced a retired narrow action, or null when the name is current. */
export function retiredNarrowActionInstead(name: string): string | null {
  return Object.hasOwn(retiredNarrowInstead, name)
    ? retiredNarrowInstead[name]!
    : null;
}

/** Paseo agent and workspace titles accept at most 200 characters. */
export const MAX_TITLE_LENGTH = 200;

export const taskTitleSchema = z
  .string()
  .min(1)
  .max(MAX_TITLE_LENGTH, "Title must be 200 characters or fewer");

// Bounded deliberate worker checkpoints per task. The counter is durable and
// survives restart; a fourth receipt enters ordinary needs-attention handling.
export const CHECKPOINT_BUDGET = 3;
