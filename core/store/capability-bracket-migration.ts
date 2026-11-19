import {
  LEGACY_CAPABILITY_BRACKETS,
  profileCapabilityLevels,
  type ProfileCapability,
} from "../../shared/contracts";

/**
 * Profile capability moves to four brackets (Tom, 2026-11-19): `low` becomes
 * `mechanical`, `medium` and `high` become `worker`, `very_high` becomes
 * `heavyweight` and `frontier` stays. A value this table does not know is left
 * exactly as stored and listed, never dropped or guessed.
 */
export interface CapabilityBracketChange {
  /** A pool entry's profile ID, or a task ID for a recorded worker climb. */
  id: string;
  field: string;
  from: string;
  to: ProfileCapability;
}
export interface CapabilityBracketUnknown {
  id: string;
  field: string;
  value: unknown;
}
export interface CapabilityBracketMigration {
  at: string;
  changes: CapabilityBracketChange[];
  unknown: CapabilityBracketUnknown[];
  /**
   * The stored Settings role-demand offsets, which selection no longer reads
   * (Tom, 2026-11-19: "worker shouldn't have an offset at all"). Kept here as
   * the note of what was dropped; absent when none were stored.
   */
  droppedDemandRoleOffsets?: unknown;
}

const isBracket = (value: unknown): value is ProfileCapability =>
  typeof value === "string" &&
  (profileCapabilityLevels as readonly string[]).includes(value);

/**
 * One stored capability value: unchanged when it is already a bracket or unset,
 * the bracket a legacy spelling became, or `unknown` for anything else.
 */
export function bracketFor(
  value: unknown,
): { to: ProfileCapability } | "keep" | "unknown" {
  if (value === undefined || value === null || isBracket(value)) return "keep";
  if (typeof value === "string" && Object.hasOwn(LEGACY_CAPABILITY_BRACKETS, value))
    return { to: LEGACY_CAPABILITY_BRACKETS[value] };
  return "unknown";
}

/** The stored pool with every legacy capability moved to its bracket. Clean entries keep their identity. */
export function migratePoolCapabilities(pool: readonly unknown[]): {
  pool: unknown[];
  changes: CapabilityBracketChange[];
  unknown: CapabilityBracketUnknown[];
} {
  const changes: CapabilityBracketChange[] = [],
    unknown: CapabilityBracketUnknown[] = [];
  const next = pool.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.profileId === "string" ? raw.profileId : "";
    const result = bracketFor(raw.capability);
    if (result === "keep") return entry;
    if (result === "unknown") {
      unknown.push({ id, field: "capability", value: raw.capability });
      return entry;
    }
    changes.push({ id, field: "capability", from: String(raw.capability), to: result.to });
    return { ...raw, capability: result.to };
  });
  return { pool: next, changes, unknown };
}
