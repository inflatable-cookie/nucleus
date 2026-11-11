/**
 * Settings-only capacity writes (service-boundary contract, "Settings-only
 * capacity writes").
 *
 * The write route is the operator's Settings screen, which reaches the service
 * through the Paseo plugin bridge or the local web board with a token;
 * `server/service/dispatch.ts` refuses `queue.capacity` for every other surface
 * before a handler runs, so this module
 * only ever sees an authorized surface. It does not authenticate anything: the
 * accident prevention is the refusal on the other routes, and what this module
 * adds is that an applied change is never silent.
 *
 * One write is one transaction:
 *
 *  1. The whole effective state is read first, so the record's `before` is the
 *     state the change replaced, not a re-derived default.
 *  2. An unchanged write is a **no-op**: no meta key is written, no version is
 *     spent, no record is added and the revision does not advance. Saving the
 *     values that are already in force is not a change and must not look like
 *     one; the call still answers `{ok: true}`.
 *  3. Otherwise every capacity key and its record entry commit together. A fault
 *     rolls the whole thing back, so there is never a limit change without its
 *     record or a record without its change.
 *
 * There is no projection to reconcile and no document to derive from. Live
 * readers read the same meta keys this writes, and nothing re-asserts over a
 * later authorized change.
 */
import {
  CAPACITY_CHANGE_LOG_LIMIT, DEFAULT_GLOBAL_LIMIT, DEFAULT_HOLD_ESCALATION_MINUTES, DEFAULT_HOLD_REMINDER_MINUTES,
  DEFAULT_LANE_DRAIN_ESCALATION_MINUTES, DEFAULT_LANE_DRAIN_MINUTES, DEFAULT_PAPERCUT_PROJECT_LIMIT,
  DEFAULT_PROJECT_LIMIT, DEFAULT_STALL_THRESHOLD_MINUTES,
  capacityAuthorityValuesSchema, capacityChangeSchema,
  type CapacityAuthorityState, type CapacityAuthorityValues, type CapacityChange,
} from "../../shared/contracts";
import { CAPACITY_WRITE_SURFACE, type CapacityWriteSurface } from "../../shared/capacity-authority";
import type { Store } from "../store/store";

/** The durable record of applied changes; Queue-internal meta, never exported. */
export const CAPACITY_CHANGE_LOG_META_KEY = "capacityChanges";

/** The capacity meta keys, in the order every reader and record names them. */
export const CAPACITY_AUTHORITY_KEYS = [
  "globalLimit", "projectLimit", "papercutProjectLimit", "paseoCallLimit", "stallThresholdMinutes",
  "holdReminderMinutes", "holdEscalationMinutes", "laneDrainMinutes", "laneDrainEscalationMinutes",
] as const satisfies readonly (keyof CapacityAuthorityValues)[];

/** The current state, with the defaults every live reader uses on a store that never set one. */
export function capacityAuthorityEffective(store: Store): CapacityAuthorityValues {
  return {
    globalLimit: store.getMeta<number>("globalLimit") ?? DEFAULT_GLOBAL_LIMIT,
    projectLimit: store.getMeta<number>("projectLimit") ?? DEFAULT_PROJECT_LIMIT,
    papercutProjectLimit: store.getMeta<number>("papercutProjectLimit") ?? DEFAULT_PAPERCUT_PROJECT_LIMIT,
    paseoCallLimit: store.configuredPaseoCallLimit(),
    stallThresholdMinutes: store.getMeta<number>("stallThresholdMinutes") ?? DEFAULT_STALL_THRESHOLD_MINUTES,
    holdReminderMinutes: store.getMeta<number>("holdReminderMinutes") ?? DEFAULT_HOLD_REMINDER_MINUTES,
    holdEscalationMinutes: store.getMeta<number>("holdEscalationMinutes") ?? DEFAULT_HOLD_ESCALATION_MINUTES,
    laneDrainMinutes: store.getMeta<number>("laneDrainMinutes") ?? DEFAULT_LANE_DRAIN_MINUTES,
    laneDrainEscalationMinutes: store.getMeta<number>("laneDrainEscalationMinutes") ?? DEFAULT_LANE_DRAIN_ESCALATION_MINUTES,
  };
}

export interface CapacityWriteResult {
  /** A new state was committed with its record entry. */
  changed: boolean;
  /** The record's version when a change committed; `null` for a no-op. */
  version: number | null;
  /** The fields the change moved, in record order. Empty for a no-op. */
  fields: readonly (keyof CapacityAuthorityValues)[];
}

/** The applied-change journal: one store, one record, one transaction per write. */
export class CapacityChangeJournal {
  private readonly clock: () => string;

  constructor(private readonly store: Store, options: { clock?: () => string } = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  /**
   * Apply one Settings write. `surface` is the surface the transport derived, not
   * a field the caller supplied; an omitted field keeps the value in force, so an
   * older caller never resets a limit it does not know about.
   */
  apply(input: Partial<CapacityAuthorityValues>, surface: CapacityWriteSurface = CAPACITY_WRITE_SURFACE): CapacityWriteResult {
    const supplied = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    for (const key of Object.keys(supplied)) {
      if (!(CAPACITY_AUTHORITY_KEYS as readonly string[]).includes(key))
        throw new Error(`Unknown capacity field ${key}; a change names only the limits`);
    }
    const at = this.clock();
    const before = capacityAuthorityEffective(this.store);
    const after = capacityAuthorityValuesSchema.parse({ ...before, ...supplied });
    const fields = CAPACITY_AUTHORITY_KEYS.filter(key => after[key] !== before[key]);
    // No-op: the values in force were saved again. Nothing durable changes, and
    // nothing pretends it did.
    if (!fields.length) return { changed: false, version: null, fields: [] };
    let version = 0;
    this.store.transaction(() => {
      const log = this.readLog();
      version = (log.at(-1)?.version ?? 0) + 1;
      const change = capacityChangeSchema.parse({ version, at, surface, before, after });
      for (const key of CAPACITY_AUTHORITY_KEYS) this.store.setMeta(key, after[key]);
      this.store.setMeta(CAPACITY_CHANGE_LOG_META_KEY, [...log, change].slice(-CAPACITY_CHANGE_LOG_LIMIT));
      this.store.advanceRevision();
    });
    return { changed: true, version, fields };
  }

  /** The `queue.capacity-state` read: the values in force and the applied changes. */
  state(): CapacityAuthorityState {
    return { effective: capacityAuthorityEffective(this.store), changes: this.readLog() };
  }

  /**
   * The record, oldest first. An entry that no longer parses is dropped rather
   * than thrown: the record is evidence, and a damaged one must not take the
   * settings read or the write route down with it.
   */
  private readLog(): CapacityChange[] {
    const raw = this.store.getMeta<unknown>(CAPACITY_CHANGE_LOG_META_KEY);
    if (!Array.isArray(raw)) return [];
    const changes: CapacityChange[] = [];
    for (const entry of raw) {
      const parsed = capacityChangeSchema.safeParse(entry);
      if (parsed.success) changes.push(parsed.data);
    }
    return changes.slice(-CAPACITY_CHANGE_LOG_LIMIT);
  }
}
