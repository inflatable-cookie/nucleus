import { z } from "zod";

/**
 * Bounded bridge-to-service lifecycle hint (Contract 007 / Spec 013).
 *
 * The Paseo backend contribution forwards only these event names, only with the
 * bounded agent and workspace identity the event carries. A hint is a scheduling
 * signal, never delivery authority: durable Queue facts and exact observations
 * remain authoritative, an unknown identity schedules nothing, and no event
 * authorizes a fleet scan.
 */
export const lifecycleSignalKinds = [
  "agent.created", "agent.turn_started", "agent.turn_ended", "agent.permission_requested",
  "agent.permission_resolved", "agent.archived", "workspace.created", "workspace.archived",
] as const;
export const lifecycleSignalKindSchema = z.enum(lifecycleSignalKinds);
export type LifecycleSignalKind = (typeof lifecycleSignalKinds)[number];

export const lifecycleSignalSchema = z.object({
  kind: lifecycleSignalKindSchema,
  agentId: z.string().min(1).max(160).nullable().default(null),
  workspaceId: z.string().min(1).max(160).nullable().default(null),
  /** Event time recorded by the bridge; a hint carries no Queue authority. */
  at: z.string().datetime({ offset: true }),
}).strict();
export type LifecycleSignal = z.infer<typeof lifecycleSignalSchema>;

export const lifecycleSignalReceiptSchema = z.object({
  ok: z.literal(true),
  matched: z.number().int().nonnegative(),
}).strict();
export type LifecycleSignalReceipt = z.infer<typeof lifecycleSignalReceiptSchema>;
