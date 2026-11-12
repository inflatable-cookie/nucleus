import { z } from "zod";

export const DEFAULT_PROJECT_LIMIT = 5;

export const DEFAULT_PAPERCUT_PROJECT_LIMIT = 2;

export const DEFAULT_GLOBAL_LIMIT = 32;

/** Host-local dispatch limit overrides, indexed by Queue project key. */
export const projectDispatchLimitOverridesSchema = z.record(z.string().min(1), z.number().int().min(0).max(64));

/** Time a complete GitHub non-merge proof must stay stable before one guarded re-issue. */
export const DEFAULT_UNCERTAIN_MERGE_RETRY_MS = 2 * 60 * 1000;

/** The proof/reconciliation window cannot be configured beyond this operator-attention bound. */
export const UNCERTAIN_MERGE_PROOF_TIMEOUT_MS = 30 * 60 * 1000;

// The Paseo-call bound is an operator setting beside the dispatch limits (Spec 012):
// the total concurrent calls Queue makes to the Paseo daemon. There is no global lane cap.
export const DEFAULT_PASEO_CALL_LIMIT = 6;

export const MAX_PASEO_CALL_LIMIT = 32;

// Mid-turn stall threshold (Queue reliability): minutes of no agent activity
// while Paseo still reports the run running before Queue routes it to recovery.
export const DEFAULT_STALL_THRESHOLD_MINUTES = 30;

export const MAX_STALL_THRESHOLD_MINUTES = 240;

export const DEFAULT_HOLD_REMINDER_MINUTES = 120;

export const DEFAULT_HOLD_ESCALATION_MINUTES = 240;

export const MAX_HOLD_MINUTES = 10080;

// Spec 041: how long a plan lane or a drained board sits before Queue prompts the plan
// owner, and how long it waits for an answer before the operator's decisions view.
export const DEFAULT_LANE_DRAIN_MINUTES = 120;

export const DEFAULT_LANE_DRAIN_ESCALATION_MINUTES = 1440;

/**
 * The three task-type values, under their final name `scope` (Tom 2026-10-12:
 * the scalar task field and the pool list were named `capability`/`capabilities`;
 * that name now belongs to the five-level ordinal rating below). Current writes
 * use `scope`/`scopes`; the legacy spellings parse only at the wire boundary
 * through `submissionRecordFromLegacy` (submissions and stored tasks) and
 * `poolRecordFromLegacy` (`queue.pool` and `queue.profile` inputs).
 */
export const scopeSchema = z.enum(["general", "mechanical", "complex"]);

export type Scope = z.infer<typeof scopeSchema>;

/**
 * The five-level ordinal scale a task's optional `complexity` and a pool entry's
 * `cost` use. Unset stays neutral: selection never infers a rating from a model
 * name, cost or notes (Tom 2026-10-12).
 */
export const capabilityLevelSchema = z.enum(["very_low", "low", "medium", "high", "very_high"]);

/**
 * A pool entry's capability rating (Spec 052, Tom 2026-11-09): `very_low` gave
 * way to `frontier` at the top. A frontier profile is request-only below the
 * Maximum usage level. A stored `very_low` reads as `low`.
 */
export const profileCapabilityLevels = ["low", "medium", "high", "very_high", "frontier"] as const;

export const profileCapabilitySchema = z.preprocess(value => value === "very_low" ? "low" : value, z.enum(profileCapabilityLevels));

export type ProfileCapability = (typeof profileCapabilityLevels)[number];

/** A run's demand: a task complexity moved by role and usage; only Maximum may reach `frontier` (Spec 053). */
export type DemandLevel = z.infer<typeof capabilityLevelSchema> | "frontier";

/**
 * Spec 052: the operator's overall usage level, a five-stop slider. `normal` is
 * the selection Queue always made; higher levels let automatic selection use
 * and prefer costlier profiles, lower levels hold it to cheaper ones.
 */
export const usageLevels = ["minimal", "low", "normal", "high", "maximum"] as const;

export const usageLevelSchema = z.enum(usageLevels);

export type UsageLevel = z.infer<typeof usageLevelSchema>;

/** The stored setting; `until` returns the level to `normal` when it passes. */
export const usageSettingSchema = z.object({
  level: usageLevelSchema,
  until: z.string().datetime({ offset: true }).nullable().default(null),
  setAt: z.string().datetime({ offset: true }),
}).strict();

export type UsageSetting = z.infer<typeof usageSettingSchema>;

/** What the board shows: the level in force, and the stored setting behind it. */
export const usageViewSchema = z.object({
  level: usageLevelSchema, setLevel: usageLevelSchema, until: z.string().nullable(), expired: z.boolean(),
}).strict();

export type UsageView = z.infer<typeof usageViewSchema>;

/**
 * Spec 052 planner grant (Tom, 2026-11-06): standing permission for one planner
 * to use frontier and above-ceiling profiles for a block of work. Stored in meta.
 */
export const routingGrantStatuses = ["pending", "active", "ended", "revoked", "expired", "archived", "declined"] as const;

export const routingGrantSchema = z.object({
  id: z.string().min(1),
  planner: z.string().min(1).max(300),
  reason: z.string().min(1).max(4000),
  /** Empty: every profile that needs sign-off. Named: only those ids. */
  profiles: z.array(z.string().trim().min(1)).default([]),
  until: z.string().datetime({ offset: true }).nullable().default(null),
  status: z.enum(routingGrantStatuses),
  requestedAt: z.string().datetime({ offset: true }),
  requestedBy: z.string().min(1).max(300),
  decisionId: z.string().nullable().default(null),
  activatedAt: z.string().datetime({ offset: true }).nullable().default(null),
  activatedBy: z.string().nullable().default(null),
  endedAt: z.string().datetime({ offset: true }).nullable().default(null),
  endedBy: z.string().nullable().default(null),
  endReason: z.string().max(400).nullable().default(null),
  runCount: z.number().int().nonnegative().default(0),
}).strict();

export type RoutingGrant = z.infer<typeof routingGrantSchema>;

/** What the board lists: live grants, newest first. */
export const routingGrantViewSchema = routingGrantSchema;

export type RoutingGrantView = RoutingGrant;

export type CapabilityLevel = z.infer<typeof capabilityLevelSchema>;

/**
 * Spec 052 diagnostics: one profile a task's routing names, read against the
 * usage level in force. `source` says why it is shown: an explicit request
 * (used at every level), a worker preference (still needs a request when
 * `automatic` requires one), or the profile a recorded run used (history, not
 * relabelled by today's level). `gates` lists pool gates beyond the usage
 * policy; catalog availability is checked at dispatch.
 */
export const routePolicySchema = z.object({
  role: z.enum(["worker", "reviewer", "coordinator"]),
  profileId: z.string(),
  source: z.enum(["request", "preference", "dispatched"]),
  inPool: z.boolean(),
  cost: capabilityLevelSchema.nullable(),
  /** The pool entry's capability; a frontier profile is request-only below Maximum. */
  capability: profileCapabilitySchema.nullable().optional(),
  /** Null when the profile is not in the pool: automatic selection never reaches it. */
  automatic: z.enum(["allowed", "request_ceiling", "request_frontier"]).nullable(),
  explanation: z.string(),
  gates: z.array(z.string()),
  /** Spec 052: a request row's board sign-off; absent for other rows and requests that need none. `grantId` when a planner grant covered it. */
  signoff: z.object({ status: z.enum(["pending", "approved", "declined"]), decisionId: z.string().nullable(), note: z.string(), grantId: z.string().optional(), endedGrantId: z.string().optional() }).strict().nullable().optional(),
}).strict();

export type RoutePolicy = z.infer<typeof routePolicySchema>;

/**
 * One enabled pool profile the task's host rules out or runs with mapped values
 * (nucleus#1151), so "why did this get Luna?" has an answer on the task.
 */
export const hostEffectSchema = z.object({
  profileId: z.string(),
  name: z.string(),
  effect: z.enum(["excluded", "unavailable", "mapped"]),
  /** The host's reason for a ruled-out profile, or the mapped fields. */
  reason: z.string(),
}).strict();
export type HostEffect = z.infer<typeof hostEffectSchema>;

export const routingPolicySchema = z.object({ usage: usageViewSchema, scope: scopeSchema, profiles: z.array(routePolicySchema),
  /** The task's host and the pool profiles it rules out or maps; absent when no host snapshot was read. */
  host: z.object({ hostId: z.string(), effects: z.array(hostEffectSchema) }).strict().optional(),
}).strict();

export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

/**
 * Rename one legacy record key to its current spelling at a read or import
 * boundary. A record carrying both spellings is refused rather than guessed, and
 * the returned record is a shallow copy: stored bytes never change here.
 */
function renameLegacyKey(record: Record<string, unknown>, legacy: string, current: string, where: string): Record<string, unknown> {
  if (!(legacy in record)) return record;
  if (current in record) throw new Error(`${where} carries both the legacy "${legacy}" and the current "${current}" field; remove one`);
  const { [legacy]: value, ...rest } = record;
  return { ...rest, [current]: value };
}

/** Stored or wire submissions before the `capability` → `scope` rename parse through here. */
export function submissionRecordFromLegacy(raw: unknown, where = "submission"): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return renameLegacyKey(raw as Record<string, unknown>, "capability", "scope", where);
}

/** Stored or wire pool entries before the `capabilities` → `scopes` rename parse through here. */
export function poolRecordFromLegacy(raw: unknown, where = "pool entry"): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return withoutRetiredPoolFields(renameLegacyKey(raw as Record<string, unknown>, "capabilities", "scopes", where));
}

/**
 * Task 1002 (Tom, 2026-11-09: "Retire it"): the By request flag is gone, and a
 * stored `very_low` capability reads as `low`. The store step strips both from
 * the stored pool; an older client's write reads through here too.
 */
export function withoutRetiredPoolFields(record: Record<string, unknown>): Record<string, unknown> {
  if (!("byRequest" in record) && record.capability !== "very_low") return record;
  const { byRequest: _retired, ...rest } = record;
  return rest.capability === "very_low" ? { ...rest, capability: "low" } : rest;
}

export const profileRequestSchema=z.object({profileId:z.string().trim().min(1),reason:z.string().trim().min(1).max(4000),required:z.boolean().default(false),
/** Spec 050: route-only origin marker. Only the owner `route` verb writes `ownerRoute: true`; `set_routing` and submissions are stripped at their writers, so the reviewer independence waiver applies only to an owner route with a recorded `owner_control` event. */
ownerRoute:z.boolean().optional(),
/** When an owner `route` recorded this request. */
routedAt:z.string().optional(),
/** Spec 050: thinking override for this role's next run. */
thinkingOptionId:z.string().optional(),
/** Who recorded the request: the routing caller, or the submitting origin for a brief. Spec 052 sign-off decisions are asked on its behalf. */
requestedBy:z.string().max(300).optional(),
/**
 * Spec 052 (Tom, 2026-10-21): a request for a profile above the usage level's
 * cost ceiling, or rated frontier below Maximum, applies only once the operator
 * signs it off on the board.
 * Queue writes this; a submission or amendment never carries it.
 */
signoff:z.object({status:z.enum(["pending","approved","declined"]),decisionId:z.string().nullable(),by:z.string().nullable(),at:z.string(),note:z.string().max(400).default(""),
  /** Spec 052 planner grant: the standing grant that signed this request off. Absent for a per-task board answer. */
  grantId:z.string().optional(),
  /** The request was covered by this grant, which has ended; stay automatic until explicitly requested again. */
  endedGrantId:z.string().optional(),
  /** While pending: the option texts the question offered and the profile each names, fixed when it was asked. */
  options:z.object({approve:z.string(),choices:z.record(z.string(),z.string())}).strict().optional()}).strict().optional()}).strict();

export const profileRequestsSchema=z.object({worker:profileRequestSchema.optional(),reviewer:profileRequestSchema.optional(),coordinator:profileRequestSchema.optional()}).strict();

export const routingProfileRequestsSchema=z.object({worker:profileRequestSchema.nullable().optional(),reviewer:profileRequestSchema.nullable().optional(),coordinator:profileRequestSchema.nullable().optional()}).strict();

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

export const profileSchema = z.object({
  id: z.string(), name: z.string(), provider: z.string(), model: z.string(),
  modeId: z.string().optional(), thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(), notes: z.string(),
  available: z.boolean(), problem: z.string(), supportedThinking: z.array(z.string()),
  /** On a host-bound snapshot: the operator excluded this profile on that host (nucleus#1151). */
  excluded: z.boolean().optional(),
  /** On a host-bound snapshot: the fields the operator's per-host mapping replaces. */
  mapped: z.array(z.string()).optional(),
});

export type Profile = z.infer<typeof profileSchema>;

export const costSchema = z.enum(["very_high", "high", "medium", "low", "very_low"]);

export const poolSchema = z.object({
  profileId: z.string(), enabled: z.boolean(), group: z.string().min(1).max(100),
  roles: z.array(z.enum(["worker", "reviewer", "coordinator"])).min(1).default(["worker"]),
  cost: costSchema.nullable().optional(),
  /** The five-level profile rating (low..frontier) used to satisfy task demand. */
  capability: profileCapabilitySchema.nullable().optional(),
  weight: z.number().int().min(1).max(10), scopes: z.array(scopeSchema).min(1),
}).strict();

export type PoolEntry = z.infer<typeof poolSchema>;

export const capacitySchema = z.object({
  globalLimit: z.number().int().min(1).max(64), projectLimit: z.number().int().min(1).max(32),
  // Omission preserves the current papercut allowance for older callers.
  papercutProjectLimit: z.number().int().min(1).max(32).optional(),
  // Optional so an older caller saving the dispatch limits never resets the Paseo-call bound.
  paseoCallLimit: z.number().int().min(1).max(MAX_PASEO_CALL_LIMIT).optional(),
  // Optional so an older caller never resets the mid-turn stall threshold.
  stallThresholdMinutes: z.number().int().min(1).max(MAX_STALL_THRESHOLD_MINUTES).optional(),
  holdReminderMinutes: z.number().int().min(1).max(MAX_HOLD_MINUTES).optional(),
  holdEscalationMinutes: z.number().int().min(1).max(MAX_HOLD_MINUTES).optional(),
  // Optional so an older caller saving the hold timers never resets the drain timers.
  laneDrainMinutes: z.number().int().min(1).max(MAX_HOLD_MINUTES).optional(),
  laneDrainEscalationMinutes: z.number().int().min(1).max(MAX_HOLD_MINUTES).optional(),
}).strict();

/**
 * Settings-only capacity writes (service-boundary contract, "Settings-only
 * capacity writes"): the whole capacity state one write carries. Every field is
 * required and bounded exactly like `capacitySchema`, because an applied change
 * is recorded as a whole before-and-after state, never as a patch.
 */
export const capacityAuthorityValuesSchema = capacitySchema.extend({
  papercutProjectLimit: z.number().int().min(1).max(32),
  paseoCallLimit: z.number().int().min(1).max(MAX_PASEO_CALL_LIMIT),
  stallThresholdMinutes: z.number().int().min(1).max(MAX_STALL_THRESHOLD_MINUTES),
  holdReminderMinutes: z.number().int().min(1).max(MAX_HOLD_MINUTES),
  holdEscalationMinutes: z.number().int().min(1).max(MAX_HOLD_MINUTES),
  laneDrainMinutes: z.number().int().min(1).max(MAX_HOLD_MINUTES),
  laneDrainEscalationMinutes: z.number().int().min(1).max(MAX_HOLD_MINUTES),
});

export type CapacityAuthorityValues = z.infer<typeof capacityAuthorityValuesSchema>;

/** How many applied changes stay in the durable record; older ones drop off the front. */
export const CAPACITY_CHANGE_LOG_LIMIT = 20;

/**
 * One applied capacity change: when it was applied, the surface it arrived from,
 * a monotonic version, and the full values before and after. It is Queue-internal
 * meta — never an export or a contract 010 shape — and it is written in the same
 * transaction as the capacity meta keys it describes.
 */
export const capacityChangeSchema = z.object({
  version: z.number().int().positive(),
  at: z.string().max(64),
  // The transport surface, derived from the request frame, never from the body.
  surface: z.enum(["paseo", "web"]),
  before: capacityAuthorityValuesSchema,
  after: capacityAuthorityValuesSchema,
}).strict();

export type CapacityChange = z.infer<typeof capacityChangeSchema>;

/**
 * `queue.capacity-state` is the operator's read of the Settings-only boundary: the
 * values every live reader sees and the bounded record of applied changes, newest
 * last. It takes no input and invents nothing: it reports what the store holds.
 */
export const capacityAuthorityStateSchema = z.object({
  effective: capacityAuthorityValuesSchema,
  changes: z.array(capacityChangeSchema).max(CAPACITY_CHANGE_LOG_LIMIT),
}).strict();

export type CapacityAuthorityState = z.infer<typeof capacityAuthorityStateSchema>;

/** Spec 052: set the usage level, optionally until a time when it returns to `normal`. */
/** Spec 053: how far each role's demand sits from the task's complexity, host-wide (Settings → Dispatch limits). */
const demandOffsetSchema = z.number().int().min(-4).max(4);

export const demandRoleOffsetsSchema = z.object({ worker: demandOffsetSchema, reviewer: demandOffsetSchema, coordinator: demandOffsetSchema }).strict();

export type DemandRoleOffsets = z.infer<typeof demandRoleOffsetsSchema>;
