import { z } from "zod";

/**
 * The ordinal scales a task and a pool entry are rated on, and the levels the
 * operator's usage slider sets. Each is one list: a scale nobody re-types.
 */

/**
 * The three task-type values, under their final name `scope` (Tom 2026-10-12:
 * the scalar task field and the pool list were named `capability`/`capabilities`;
 * that name now belongs to the profile capability brackets below). Current writes
 * use `scope`/`scopes`; the legacy spellings parse only at the wire boundary
 * through `submissionRecordFromLegacy` (submissions and stored tasks) and
 * `poolRecordFromLegacy` (`queue.pool` and `queue.profile` inputs).
 */
export const scopeSchema = z.enum(["general", "mechanical", "complex"]);

export type Scope = z.infer<typeof scopeSchema>;

/**
 * The five-level ordinal scale a task's `complexity` uses (a profile's
 * capability is the four brackets below). Unset stays neutral: selection never
 * infers a rating from a model name or notes (Tom 2026-10-12).
 */
export const capabilityLevels = ["very_low", "low", "medium", "high", "very_high"] as const;

export const capabilityLevelSchema = z.enum(capabilityLevels);

export type CapabilityLevel = z.infer<typeof capabilityLevelSchema>;

/**
 * A pool entry's rotation weight (Spec 053, Tom 2026-11-21): five named stops
 * with Default at the centre. Each stop moves the profile's relative rotation
 * share by one fixed additive step from Default (80%, 90%, 100%, 110%, 120%).
 * A share only orders rotation among profiles already eligible; it never
 * admits or excludes one, and it is not a percentage of all work. The retired
 * integer weight and the retired Cost rating read through `poolRecordFromLegacy`.
 */
export const profileWeightLevels = ["fewest", "fewer", "default", "more", "most"] as const;

export const profileWeightSchema = z.enum(profileWeightLevels);

export type ProfileWeight = z.infer<typeof profileWeightSchema>;

export const DEFAULT_PROFILE_WEIGHT: ProfileWeight = "default";

/** One notch moves the relative share by this much of Default's share. */
export const WEIGHT_SHARE_STEP = 0.1;

/** The relative rotation share of a weight stop: 0.8, 0.9, 1, 1.1, 1.2. */
export const weightShare = (weight: ProfileWeight): number => {
  const centre = Math.floor(profileWeightLevels.length / 2);
  // Round away float noise so equal stops compare equal and diagnostics read cleanly.
  return Math.round((1 + (profileWeightLevels.indexOf(weight) - centre) * WEIGHT_SHARE_STEP) * 100) / 100;
};

/**
 * The retired integer weight read as a stop (Tom, 2026-11-21): the old default 1
 * is Default, 2 is the first higher stop, and 3-10 the highest. Any other value
 * is returned unchanged so validation still refuses it.
 */
export const legacyWeightStop = (value: unknown): unknown =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10
    ? value === 1 ? "default" : value === 2 ? "more" : "most"
    : value;

/**
 * A pool entry's capability bracket (Spec 052, Tom 2026-11-19): four brackets
 * replace the five-point scale. Mechanical was `low`; Worker is one pool for
 * what were `medium` and `high`; Heavyweight was `very_high`; Frontier stays.
 * A Frontier profile is request-only below Extra high.
 */
export const profileCapabilityLevels = ["mechanical", "worker", "heavyweight", "frontier"] as const;

export type ProfileCapability = (typeof profileCapabilityLevels)[number];

/**
 * The five-point (and older six-point) capability spellings and the bracket
 * each became (Tom, 2026-11-19). The store migrates stored rows once; the
 * schemas read a stale writer's value the same way at the wire boundary.
 */
export const LEGACY_CAPABILITY_BRACKETS: Readonly<Record<string, ProfileCapability>> = {
  very_low: "mechanical", low: "mechanical", medium: "worker", high: "worker", very_high: "heavyweight",
};
export const legacyBracket = (value: unknown): unknown =>
  typeof value === "string" && Object.hasOwn(LEGACY_CAPABILITY_BRACKETS, value) ? LEGACY_CAPABILITY_BRACKETS[value] : value;

export const profileCapabilitySchema = z.preprocess(legacyBracket, z.enum(profileCapabilityLevels));

/** A run's demand is a bracket: the task's complexity moved by the usage level and the step-up (Spec 053). */
export type DemandLevel = ProfileCapability;

/** The demand scale, for the schemas that carry a bracket (Spec 052, Spec 053). */
export const demandLevelSchema = profileCapabilitySchema;

/**
 * Spec 052: the operator's overall usage level, a five-stop slider (Tom,
 * 2026-11-17). Each level says plainly where a task's worker starts on the
 * capability brackets, whether climbing back to the task's own requested tier is
 * allowed, and which runs need the operator's sign-off. `normal` is the default.
 */
export const usageLevels = ["low", "normal", "high", "extra_high", "maximum"] as const;

/**
 * Spec 052 naming migration (Tom, 2026-11-17): `minimal` is removed and its
 * stored value reads as `low`; `normal`, `high` and `maximum` keep their names,
 * and `extra_high` joins between `high` and `maximum`. The preprocess reads a
 * stale writer's value at the wire boundary exactly as a stored row reads it.
 */
export const usageLevelSchema = z.preprocess(value => value === "minimal" ? "low" : value, z.enum(usageLevels));

export type UsageLevel = z.infer<typeof usageLevelSchema>;
