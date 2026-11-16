/**
 * The two field renames the stored and wire records still carry, applied at the
 * one read or import boundary that needs them. A record carrying both spellings
 * is refused rather than guessed, and stored bytes never change here.
 */

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
