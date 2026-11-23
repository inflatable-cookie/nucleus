import { z } from "zod";
import { hostKindSchema, DEFAULT_HOST_KIND } from "../../host-kind";

/**
 * The dispatch and timing limits: one bound and one default per field, read here
 * once. The settings write shape, its applied-change record and the board state
 * that shows them all take their numbers from this catalogue, so a limit cannot
 * be bounded differently in two places.
 */

export const DEFAULT_PROJECT_LIMIT = 5;

export const DEFAULT_PAPERCUT_PROJECT_LIMIT = 2;

export const DEFAULT_GLOBAL_LIMIT = 32;

/** Host-local dispatch limit overrides, indexed by Queue project key. */
export const projectDispatchLimitOverridesSchema = z.record(
  z.string().min(1),
  z.number().int().min(0).max(64),
);

/** Time a complete GitHub non-merge proof must stay stable before one guarded re-issue. */
export const DEFAULT_UNCERTAIN_MERGE_RETRY_MS = 2 * 60 * 1000;

/** The proof/reconciliation window cannot be configured beyond this operator-attention bound. */
export const UNCERTAIN_MERGE_PROOF_TIMEOUT_MS = 30 * 60 * 1000;

// The host-call bound is an operator setting beside the dispatch limits (Spec 012):
// the concurrent calls Queue makes to each host (Paseo, T3 Code, BB). It is a
// ceiling per host, not a total across hosts, and there is no global lane cap.
// Saved as `hostCallLimit`; the Paseo-era `paseoCallLimit` is a legacy alias read
// only at the write boundary and as a mirror for older readers (see the
// service-boundary contract, "Host-call limit").
export const DEFAULT_HOST_CALL_LIMIT = 6;

export const MAX_HOST_CALL_LIMIT = 32;

// Mid-turn stall threshold (Queue reliability): minutes of no agent activity
// while Paseo still reports the run running before Queue routes it to recovery.
export const DEFAULT_STALL_THRESHOLD_MINUTES = 30;

export const MAX_STALL_THRESHOLD_MINUTES = 240;

export const DEFAULT_HOLD_REMINDER_MINUTES = 120;

export const DEFAULT_HOLD_ESCALATION_MINUTES = 240;

// Tom, 2026-11-14 (T3 lane v18, host dropout option 1: wait): how long a host may
// stay unavailable before each affected project's planner hears once. A shorter
// outage stays a visible wait only.
export const DEFAULT_HOST_OUTAGE_NOTICE_MINUTES = 120;

export const MAX_HOST_OUTAGE_NOTICE_MINUTES = 10080;

export const MAX_HOLD_MINUTES = 10080;

// Spec 041: how long a plan lane or a drained board sits before Queue prompts the plan
// owner, and how long it waits for an answer before the operator's decisions view.
export const DEFAULT_LANE_DRAIN_MINUTES = 120;

export const DEFAULT_LANE_DRAIN_ESCALATION_MINUTES = 1440;

// Orchestration contract, "Archived thread retention": how long a finished task's
// archived threads stay on the host before the service's retention pass removes
// them (Tom, 2026-11-19: "Maybe three days?").
export const DEFAULT_THREAD_RETENTION_DAYS = 3;

export const MAX_THREAD_RETENTION_DAYS = 90;

// How often the archived-thread retention pass runs (Tom, 2026-11-22: "Pruning can
// read archived threads - it needs to know what's there, but that shouldn't be
// running regularly? Once or twice a day?"). Spec 069 batch 5.
export const DEFAULT_THREAD_RETENTION_INTERVAL_HOURS = 12;

export const MAX_THREAD_RETENTION_INTERVAL_HOURS = 168;

/** One bounded settings-only limit: its bounds and the default an absent field keeps. */
interface CapacityBound {
  min: number;
  max: number;
  fallback: number;
}

/** Spec 006/040/041: every limit Settings owns, bounded and defaulted once. */
export const capacityBounds = {
  papercutProjectLimit: {
    min: 1,
    max: 32,
    fallback: DEFAULT_PAPERCUT_PROJECT_LIMIT,
  },
  hostCallLimit: {
    min: 1,
    max: MAX_HOST_CALL_LIMIT,
    fallback: DEFAULT_HOST_CALL_LIMIT,
  },
  stallThresholdMinutes: {
    min: 1,
    max: MAX_STALL_THRESHOLD_MINUTES,
    fallback: DEFAULT_STALL_THRESHOLD_MINUTES,
  },
  holdReminderMinutes: {
    min: 1,
    max: MAX_HOLD_MINUTES,
    fallback: DEFAULT_HOLD_REMINDER_MINUTES,
  },
  holdEscalationMinutes: {
    min: 1,
    max: MAX_HOLD_MINUTES,
    fallback: DEFAULT_HOLD_ESCALATION_MINUTES,
  },
  laneDrainMinutes: {
    min: 1,
    max: MAX_HOLD_MINUTES,
    fallback: DEFAULT_LANE_DRAIN_MINUTES,
  },
  laneDrainEscalationMinutes: {
    min: 1,
    max: MAX_HOLD_MINUTES,
    fallback: DEFAULT_LANE_DRAIN_ESCALATION_MINUTES,
  },
  hostOutageNoticeMinutes: {
    min: 1,
    max: MAX_HOST_OUTAGE_NOTICE_MINUTES,
    fallback: DEFAULT_HOST_OUTAGE_NOTICE_MINUTES,
  },
  threadRetentionDays: {
    min: 1,
    max: MAX_THREAD_RETENTION_DAYS,
    fallback: DEFAULT_THREAD_RETENTION_DAYS,
  },
  threadRetentionIntervalHours: {
    min: 1,
    max: MAX_THREAD_RETENTION_INTERVAL_HOURS,
    fallback: DEFAULT_THREAD_RETENTION_INTERVAL_HOURS,
  },
} as const satisfies Record<string, CapacityBound>;

export type CapacityBoundField = keyof typeof capacityBounds;

/** One limit's value schema, under the bound the catalogue records. */
const capacityValue = (field: CapacityBoundField) =>
  z
    .number()
    .int()
    .min(capacityBounds[field].min)
    .max(capacityBounds[field].max);

export const capacitySchema = z
  .object({
    globalLimit: z.number().int().min(1).max(64),
    projectLimit: z.number().int().min(1).max(32),
    // Optional so an older caller saving one group never resets the others.
    papercutProjectLimit: capacityValue("papercutProjectLimit").optional(),
    hostCallLimit: capacityValue("hostCallLimit").optional(),
    // Legacy alias for `hostCallLimit`, from before the limit was host-neutral. An
    // older caller's write still lands; both names in one write must agree, and
    // the write boundary refuses a disagreement (see the journal's apply).
    paseoCallLimit: capacityValue("hostCallLimit").optional(),
    stallThresholdMinutes: capacityValue("stallThresholdMinutes").optional(),
    holdReminderMinutes: capacityValue("holdReminderMinutes").optional(),
    holdEscalationMinutes: capacityValue("holdEscalationMinutes").optional(),
    laneDrainMinutes: capacityValue("laneDrainMinutes").optional(),
    laneDrainEscalationMinutes: capacityValue(
      "laneDrainEscalationMinutes",
    ).optional(),
    hostOutageNoticeMinutes: capacityValue(
      "hostOutageNoticeMinutes",
    ).optional(),
    threadRetentionDays: capacityValue("threadRetentionDays").optional(),
    threadRetentionIntervalHours: capacityValue(
      "threadRetentionIntervalHours",
    ).optional(),
    operatorDefaultHostKind: hostKindSchema.nullable().optional(),
  })
  .strict();

/**
 * Settings-only capacity writes (service-boundary contract, "Settings-only
 * capacity writes"): the whole capacity state one write carries. Every field is
 * required and bounded exactly like `capacitySchema`, because an applied change
 * is recorded as a whole before-and-after state, never as a patch.
 */
// The applied state never carries the legacy alias: one name, one value.
export const capacityAuthorityValuesSchema = capacitySchema
  .omit({ paseoCallLimit: true })
  .extend({
    papercutProjectLimit: capacityValue("papercutProjectLimit"),
    hostCallLimit: capacityValue("hostCallLimit"),
    stallThresholdMinutes: capacityValue("stallThresholdMinutes"),
    holdReminderMinutes: capacityValue("holdReminderMinutes"),
    holdEscalationMinutes: capacityValue("holdEscalationMinutes"),
    laneDrainMinutes: capacityValue("laneDrainMinutes"),
    laneDrainEscalationMinutes: capacityValue("laneDrainEscalationMinutes"),
    hostOutageNoticeMinutes: capacityValue("hostOutageNoticeMinutes"),
    threadRetentionDays: capacityValue("threadRetentionDays"),
    threadRetentionIntervalHours: capacityValue("threadRetentionIntervalHours"),
    operatorDefaultHostKind: hostKindSchema.nullable(),
  });

export type CapacityAuthorityValues = z.infer<
  typeof capacityAuthorityValuesSchema
>;

/**
 * The capacity fields the board state carries, with the default an absent stored
 * setting reads as. The state schema spreads this group instead of restating the
 * bounds, so a limit has one answer wherever it is read.
 */
export const capacityStateFields = {
  papercutProjectLimit: capacityValue("papercutProjectLimit").default(
    capacityBounds.papercutProjectLimit.fallback,
  ),
  hostCallLimit: capacityValue("hostCallLimit").default(
    capacityBounds.hostCallLimit.fallback,
  ),
  stallThresholdMinutes: capacityValue("stallThresholdMinutes").default(
    capacityBounds.stallThresholdMinutes.fallback,
  ),
  holdReminderMinutes: capacityValue("holdReminderMinutes").default(
    capacityBounds.holdReminderMinutes.fallback,
  ),
  holdEscalationMinutes: capacityValue("holdEscalationMinutes").default(
    capacityBounds.holdEscalationMinutes.fallback,
  ),
  laneDrainMinutes: capacityValue("laneDrainMinutes").default(
    capacityBounds.laneDrainMinutes.fallback,
  ),
  laneDrainEscalationMinutes: capacityValue(
    "laneDrainEscalationMinutes",
  ).default(capacityBounds.laneDrainEscalationMinutes.fallback),
  hostOutageNoticeMinutes: capacityValue("hostOutageNoticeMinutes").default(
    capacityBounds.hostOutageNoticeMinutes.fallback,
  ),
  threadRetentionDays: capacityValue("threadRetentionDays").default(
    capacityBounds.threadRetentionDays.fallback,
  ),
  threadRetentionIntervalHours: capacityValue(
    "threadRetentionIntervalHours",
  ).default(capacityBounds.threadRetentionIntervalHours.fallback),
  operatorDefaultHostKind: hostKindSchema.nullable().default(DEFAULT_HOST_KIND),
};

/** How many applied changes stay in the durable record; older ones drop off the front. */
export const CAPACITY_CHANGE_LOG_LIMIT = 20;

/**
 * One applied capacity change: when it was applied, the surface it arrived from,
 * a monotonic version, and the full values before and after. It is Queue-internal
 * meta — never an export or a contract 010 shape — and it is written in the same
 * transaction as the capacity meta keys it describes.
 */
export const capacityChangeSchema = z
  .object({
    version: z.number().int().positive(),
    at: z.string().max(64),
    // The transport surface, derived from the request frame, never from the body.
    surface: z.enum(["paseo", "web", "bb"]),
    before: capacityAuthorityValuesSchema,
    after: capacityAuthorityValuesSchema,
  })
  .strict();

export type CapacityChange = z.infer<typeof capacityChangeSchema>;

/**
 * `queue.capacity-state` is the operator's read of the Settings-only boundary: the
 * values every live reader sees and the bounded record of applied changes, newest
 * last. It takes no input and invents nothing: it reports what the store holds.
 */
export const capacityAuthorityStateSchema = z
  .object({
    effective: capacityAuthorityValuesSchema,
    changes: z.array(capacityChangeSchema).max(CAPACITY_CHANGE_LOG_LIMIT),
  })
  .strict();

export type CapacityAuthorityState = z.infer<
  typeof capacityAuthorityStateSchema
>;
