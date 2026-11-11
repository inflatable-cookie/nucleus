import { z } from "zod";

/**
 * Lifetime cap on reviewer-to-worker revision rounds. Tom (2026-10-13): escalate the
 * author after three rounds if a higher model is available, cap at six, then the
 * project owner considers a different approach.
 */
export const REVISION_BUDGET = 6;
/** The incident causes Queue names itself; free-text classification remains only for external error text. */
export const incidentCauses = ["provider_unavailable", "workspace_state", "uncertain_delivery", "missing_callback", "repository_identity", "hook_failure", "scheduling", "stalled_turn", "other"] as const;
export type IncidentCause = typeof incidentCauses[number];
export const incidentRoleSchema = z.enum(["worker", "reviewer", "coordinator", "closeout", "recovery", "unknown"]);
export const incidentActionSchema = z.enum(["", "exact_lookup", "callback_reminder", "replacement", "stall_continuation"]);
/** One deduplicated fault identity: repeated observations update this record instead of appending escalations. */
export const incidentSchema = z.object({
  id: z.string(), role: incidentRoleSchema, runId: z.string().nullable().default(null),
  /** Active Paseo turn observed when a stalled-turn incident was detected. */
  turnId: z.string().nullable().optional(),
  fingerprint: z.string().default(""),
  attempt: z.number().int().nonnegative().default(0), cause: z.string().default("other"),
  detail: z.string().default(""), action: incidentActionSchema.default(""),
  status: z.enum(["reconciling", "escalated", "resolved"]).default("reconciling"),
  createdAt: z.string(), updatedAt: z.string(),
});
export type Incident = z.infer<typeof incidentSchema>;
