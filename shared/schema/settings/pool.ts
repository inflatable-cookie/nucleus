import { z } from "zod";
import { costSchema, profileCapabilitySchema, scopeSchema } from "./capability";

/**
 * The pool: the profiles the operator enabled and the host catalog makes
 * available, each with its cost, capability, weight and scopes. A profile is
 * decoded strictly: a host or store row that carries a field the contract does
 * not declare is refused rather than silently dropped.
 */

export const profileSchema = z.object({
  id: z.string(), name: z.string(), provider: z.string(), model: z.string(),
  modeId: z.string().optional(), thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(), notes: z.string(),
  available: z.boolean(), problem: z.string(), supportedThinking: z.array(z.string()),
  /** The fields this host's table spells differently from the canonical profile (task 1158). */
  translated: z.array(z.string()).optional(),
}).strict();

export type Profile = z.infer<typeof profileSchema>;

export const poolSchema = z.object({
  profileId: z.string(), enabled: z.boolean(), group: z.string().min(1).max(100),
  roles: z.array(z.enum(["worker", "reviewer", "coordinator"])).min(1).default(["worker"]),
  cost: costSchema.nullable().optional(),
  /** The profile capability bracket (mechanical..frontier) used to satisfy task demand. */
  capability: profileCapabilitySchema.nullable().optional(),
  weight: z.number().int().min(1).max(10), scopes: z.array(scopeSchema).min(1),
}).strict();

export type PoolEntry = z.infer<typeof poolSchema>;

/** The threads a completion notification may reach, as recorded task history. */
export const completionAgentIdsSchema = z.array(z.string().trim().min(1).max(240)).max(32)
  .transform(ids => [...new Set(ids)].sort());

export const completionRecipientSchema = z.object({
  agentId: z.string().min(1).max(240), workspaceId: z.string().min(1),
}).strict();

export const completionSubscriptionSchema = completionRecipientSchema.extend({ subscribed: z.boolean() }).strict();

export const completionCohortMemberSchema = completionRecipientSchema.extend({
  sources: z.array(z.enum(["origin", "creator", "self"])).min(1), originEntry: z.boolean(),
}).strict();

export type CompletionMembership = z.infer<typeof completionCohortMemberSchema>;
