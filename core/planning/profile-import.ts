import {
  normaliseProvider,
  nucleusProfileSchema,
  type NucleusProfile,
  type ProfileImportRecord,
  type ProviderMap,
} from "../../shared/profiles";
import type { Store } from "../store/store";

/**
 * The one-time copy of a host's own profile list into Nucleus's store (Tom,
 * 2026-11-07: the list set up in Nucleus is the one that is kept; Paseo's own
 * profiles stay only for its composer picker).
 *
 * Ids are copied unchanged, so the pool, routing requests, grants and stored
 * history keep matching. It runs once, records that it ran, and never
 * overwrites a Nucleus profile: an id the store already holds is kept as it is,
 * and a recorded run means a later host change imports nothing.
 */
export interface HostProfileImport {
  /** Names the host list this came from in the durable record. */
  source: string;
  hostProfiles: readonly unknown[];
  providerMap: ProviderMap;
  at?: string;
}

export interface HostProfileImportResult {
  record: ProfileImportRecord;
  /** Ids the host list carried that the store already held, so nothing was written for them. */
  kept: string[];
}

/**
 * Copy the host's profiles into the store once, or answer null when the store
 * already records the run. Invalid host entries are counted and left out; a
 * profile id already in the store is never rewritten.
 */
export function importHostProfiles(
  store: Store,
  input: HostProfileImport,
): HostProfileImportResult | null {
  if (store.profileImportRecord()) return null;
  const existing = new Map(
    store.profiles().map((profile) => [profile.id, profile]),
  );
  const kept: string[] = [];
  let imported = 0,
    skipped = 0;
  for (const raw of input.hostProfiles) {
    const parsed = nucleusProfileSchema.safeParse(raw);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const profile: NucleusProfile = {
      ...parsed.data,
      // The profile names the normalised key; a host's own spelling stays the host's.
      provider: normaliseProvider(input.providerMap, parsed.data.provider),
    };
    if (existing.has(profile.id)) {
      kept.push(profile.id);
      continue;
    }
    existing.set(profile.id, profile);
    imported++;
  }
  const record: ProfileImportRecord = {
    at: input.at ?? new Date().toISOString(),
    source: input.source,
    imported,
    kept: kept.length,
    skipped,
  };
  // One write: the copied list and the record that it ran land together.
  store.transaction(() => {
    store.setProfiles([...existing.values()]);
    store.recordProfileImport(record);
  });
  return { record, kept };
}
