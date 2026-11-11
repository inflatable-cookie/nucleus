import { z } from "zod";
import { LANE_KEY_PATTERN } from "../lanes";

export const dependencyIdsSchema = z.array(z.string().min(1).max(160)).max(100)
  .refine(ids => new Set(ids).size === ids.length, "Duplicate prerequisite task IDs")
  .transform(ids => [...ids].sort());

/** Spec 019: a lane key is a Queue-wide slug; never auto-created from a typo. */
export const laneKeySchema = z.string().regex(LANE_KEY_PATTERN).min(1).max(80);

/** Spec 019 revision: a task belongs to zero or more lanes, in the order given, with no duplicates. */
export const laneKeyListSchema = z.array(laneKeySchema).max(32)
  .refine(keys => new Set(keys).size === keys.length, "Duplicate lane key");

export const holdKindSchema = z.enum(["dispatch", "merge"]);

export type HoldKind = z.infer<typeof holdKindSchema>;

/** The task lifecycle phase, shared by the task row and the pre-attention record. */
export const taskPhaseSchema = z.enum(["queued", "dispatching", "working", "awaiting_review", "report_ready", "blocked", "error", "needs_attention", "cancelled", "reviewing", "changes_requested", "verifying", "merging", "syncing", "closing", "done"]);

export type TaskPhase = z.infer<typeof taskPhaseSchema>;

export const dispositionStatusSchema = z.enum(["intent", "draining", "preserving", "archiving", "complete", "needs_attention"]);
