import { z } from "zod";

/**
 * Subscription usage pressure gauge, step 1 (Spec 059): the wire shapes for one
 * provider subscription's usage reading, its stored sample and the pressure
 * projection. The readers live in core; these shapes are the contract between
 * the readers, the stored samples and `usage.state`.
 */

/** The providers a v1 usage reader reads. Other subscriptions never gain a gauge. */
export const usageProviderSchema = z.enum(["codex", "claude", "grok"]);
export type UsageProvider = z.infer<typeof usageProviderSchema>;

/** The pressure states a subscription can project: the dial's three arcs plus no projection. */
export const usagePressureStateSchema = z.enum([
  "spare",
  "on_track",
  "will_run_out",
  "unknown",
]);
export type UsagePressureState = z.infer<typeof usagePressureStateSchema>;

export const usageReadingStatusSchema = z.enum([
  "ok",
  "unknown",
  "not_available",
]);
export type UsageReadingStatus = z.infer<typeof usageReadingStatusSchema>;

/**
 * One usage window's latest reading: `usedFraction` is 0..1, the reset instant
 * and window length ride along when the provider reports them, so the
 * projection can compute elapsed time. `null` lengths stay null: an unknown
 * shape never becomes 0.
 */
export const usageWindowSchema = z
  .object({
    windowId: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
    usedFraction: z.number().min(0).max(1),
    windowSeconds: z.number().int().positive().nullable(),
    windowStartsAt: z.string().nullable(),
    resetsAt: z.string().nullable(),
  })
  .strict();
export type UsageWindow = z.infer<typeof usageWindowSchema>;

/**
 * One provider read: `ok` carries windows; `unknown` (unreadable or unexpected
 * shape) and `not_available` (no usable source for this subscription) carry the
 * reason and never a zero.
 */
export const usageReadingSchema = z
  .object({
    status: usageReadingStatusSchema,
    reason: z.string().max(500).nullable(),
    asOf: z.string(),
    source: z.string().min(1).max(60),
    accountId: z.string().max(240).nullable(),
    windows: z.array(usageWindowSchema),
  })
  .strict();
export type UsageReading = z.infer<typeof usageReadingSchema>;

/** One stored usage sample row's shape (table `usage_samples`). */
export const usageSampleSchema = z
  .object({
    groupId: z.string().min(1).max(100),
    provider: usageProviderSchema,
    accountId: z.string().max(240).nullable(),
    windowId: z.string().min(1).max(120),
    usedFraction: z.number().min(0).max(1),
    windowSeconds: z.number().int().positive().nullable(),
    windowStartsAt: z.string().nullable(),
    resetsAt: z.string().nullable(),
    sampledAt: z.string(),
    source: z.string().min(1).max(60),
  })
  .strict();
export type UsageSample = z.infer<typeof usageSampleSchema>;

/** One window's projection: pace 1 lands exactly at 100% at the reset; the dial is `clamp(log2 pace, -1, 1)`. */
export const usageWindowProjectionSchema = z
  .object({
    windowId: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
    pace: z.number().nullable(),
    dial: z.number().min(-1).max(1).nullable(),
    exhaustsInMs: z.number().nullable(),
  })
  .strict();
export type UsageWindowProjection = z.infer<typeof usageWindowProjectionSchema>;

/**
 * The projection for one subscription: the binding window is whichever hits
 * 100% earliest before its own reset, and the dial names and shows it.
 * `projectedUseAtReset` keeps its over-projection (past 100% up to the cap, so a
 * label can say "+18% over"); a fully used window reads exactly 1.
 */
export const usageProjectionSchema = z
  .object({
    state: usagePressureStateSchema,
    bindingWindowId: z.string().max(120).nullable(),
    bindingWindowName: z.string().max(120).nullable(),
    projectedUseAtReset: z.number().min(0).max(2).nullable(),
    dial: z.number().min(-1).max(1).nullable(),
    windows: z.array(usageWindowProjectionSchema),
  })
  .strict();
export type UsageProjection = z.infer<typeof usageProjectionSchema>;

/** One subscription's gauge: its latest reading, the projection and the read freshness. */
export const usageSubscriptionSchema = z
  .object({
    group: z.string().min(1).max(100),
    provider: usageProviderSchema,
    profileIds: z.array(z.string().max(240)),
    sourcePath: z.string().max(1000).nullable(),
    reading: usageReadingSchema,
    projection: usageProjectionSchema,
    nextReadAt: z.string().nullable(),
    lastAttemptAt: z.string().nullable(),
    lastError: z.string().max(500).nullable(),
  })
  .strict();
export type UsageSubscription = z.infer<typeof usageSubscriptionSchema>;

export const usageStateOutputSchema = z
  .object({
    generatedAt: z.string(),
    subscriptions: z.array(usageSubscriptionSchema),
  })
  .strict();
export type UsageStateOutput = z.infer<typeof usageStateOutputSchema>;
