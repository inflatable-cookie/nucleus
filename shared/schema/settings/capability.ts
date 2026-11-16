import { z } from "zod";

/**
 * The two ordinal scales a task and a pool entry are rated on, and the levels the
 * operator's usage slider sets. Each is one list: a scale nobody re-types.
 */

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
export const capabilityLevels = ["very_low", "low", "medium", "high", "very_high"] as const;

export const capabilityLevelSchema = z.enum(capabilityLevels);

export type CapabilityLevel = z.infer<typeof capabilityLevelSchema>;

/**
 * A pool entry's cost is the same five-level ordinal scale, listed most
 * expensive first because the settings table reads it that way. Deriving it from
 * `capabilityLevels` is what keeps the two scales from drifting.
 */
const costLevels = [...capabilityLevels].reverse() as unknown as typeof capabilityLevels;

export const costSchema = z.enum(costLevels);

/**
 * A pool entry's capability rating (Spec 052, Tom 2026-11-09): `very_low` gave
 * way to `frontier` at the top. A frontier profile is request-only below the
 * Maximum usage level. A stored `very_low` reads as `low`.
 */
export const profileCapabilityLevels = ["low", "medium", "high", "very_high", "frontier"] as const;

export const profileCapabilitySchema = z.preprocess(value => value === "very_low" ? "low" : value, z.enum(profileCapabilityLevels));

export type ProfileCapability = (typeof profileCapabilityLevels)[number];

/** A run's demand: a task complexity moved by role and usage; only Maximum may reach `frontier` (Spec 053). */
export type DemandLevel = CapabilityLevel | "frontier";

/**
 * Spec 052: the operator's overall usage level, a five-stop slider. `normal` is
 * the selection Queue always made; higher levels let automatic selection use
 * and prefer costlier profiles, lower levels hold it to cheaper ones.
 */
export const usageLevels = ["minimal", "low", "normal", "high", "maximum"] as const;

export const usageLevelSchema = z.enum(usageLevels);

export type UsageLevel = z.infer<typeof usageLevelSchema>;
