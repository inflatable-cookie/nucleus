import { legacyWeightStop } from "./capability";

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

/** Pool entries with legacy ratings or weights parse through here. */
export function poolRecordFromLegacy(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return retiredCostAndNumericWeight(withoutRetiredPoolFields(raw as Record<string, unknown>));
}

/**
 * Nucleus#1488 (Tom, 2026-11-21): the Cost rating is retired and the integer
 * weight became the five-stop rotation weight. A stored or wire record read here
 * drops `cost` (never used for migration or routing) and maps a numeric weight
 * through `legacyWeightStop`; every other field is kept as it came. Stored bytes
 * never change here: the next profile write emits the canonical form.
 */
export function retiredCostAndNumericWeight(record: Record<string, unknown>): Record<string, unknown> {
  const hasCost = "cost" in record;
  const mapped = legacyWeightStop(record.weight);
  if (!hasCost && mapped === record.weight) return record;
  const { cost: _retired, ...rest } = record;
  return "weight" in rest ? { ...rest, weight: mapped } : rest;
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
