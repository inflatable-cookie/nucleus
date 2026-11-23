import type { BudgetHostOutage } from "../../shared/task-budget";
import type { Store } from "../store/store";

/**
 * Spec 068 Decision 1 (Tom, 2026-11-22): time while the Nucleus service is down
 * or rolling never spends a task's budget. The service's own lifetime is the
 * record: each owner stamps when it started and, while it runs, when it was last
 * alive. A drain (a roll or a stop) stamps its start as the last alive moment, so
 * the window from a drain or a crash to the next start is the downtime. The next
 * start closes that window into a bounded history, which every budget read
 * discounts beside the task's host outages. A machine that sleeps keeps the same
 * owner, so each beat also compares the wall clock with the monotonic clock, which
 * does not advance while the machine sleeps (mach_absolute_time on macOS,
 * CLOCK_MONOTONIC on Linux) but does through an event-loop stall: only the
 * difference is sleep. No task is written.
 */
export const SERVICE_LIVENESS_META_KEY = "serviceLiveness";
export const SERVICE_DOWNTIME_HISTORY_META_KEY = "serviceDowntimeHistory";
/**
 * How long a closed downtime is kept. A roll per merge and nightly sleep add a
 * few entries a day; no budget outlives this, since the largest budget is hours.
 */
export const SERVICE_DOWNTIME_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** A hard ceiling on entries, should something record far more often than expected. */
export const SERVICE_DOWNTIME_HISTORY_LIMIT = 2_000;
/** How often a running service stamps itself alive. A crash loses at most this much precision. */
export const SERVICE_ALIVE_INTERVAL_MS = 60_000;
/** Wall time past monotonic time beyond this, between two beats, is recorded as sleep. */
export const SERVICE_SLEEP_MIN_MS = SERVICE_ALIVE_INTERVAL_MS;

type Liveness = { owner: string; startedAt: string; aliveAt: string };
type MetaStore = Pick<Store, "getMeta" | "setMeta">;
/** The wall and monotonic readings of this process's last stamp, per owner. A monotonic reading means nothing in another process. */
const lastBeats = new Map<string, { wallMs: number; monotonicNs: bigint }>();
const monotonicNow = (): bigint => process.hrtime.bigint();

function readLiveness(store: Pick<Store, "getMeta">): Liveness | null {
  const raw = store.getMeta<Partial<Liveness> | undefined>(SERVICE_LIVENESS_META_KEY);
  return raw && typeof raw.owner === "string" && typeof raw.startedAt === "string" && typeof raw.aliveAt === "string"
    ? { owner: raw.owner, startedAt: raw.startedAt, aliveAt: raw.aliveAt }
    : null;
}

/**
 * A new service owner took the database. The previous owner's last alive moment to
 * this start was downtime (a roll, a stop or a crash), so it joins the history.
 */
export function recordServiceStart(store: MetaStore, owner: string, at = new Date().toISOString(),
  monotonicNs: bigint = monotonicNow()): void {
  const previous = readLiveness(store);
  if (previous && previous.owner !== owner && Date.parse(previous.aliveAt) < Date.parse(at))
    recordDowntime(store, previous.aliveAt, at);
  store.setMeta(SERVICE_LIVENESS_META_KEY, { owner, startedAt: at, aliveAt: at });
  lastBeats.set(owner, { wallMs: Date.parse(at), monotonicNs });
}

/**
 * The running owner is alive now (its heartbeat, or the start of its drain). Since
 * this process's last stamp, wall time that ran past monotonic time is time the
 * machine slept, so more than `SERVICE_SLEEP_MIN_MS` of it is recorded as downtime
 * ending now. A late beat whose clocks agree is an event-loop stall: the process
 * and its agents kept working, so it records nothing. Another owner's record is
 * never touched.
 */
export function recordServiceAlive(store: MetaStore, owner: string, at = new Date().toISOString(),
  monotonicNs: bigint = monotonicNow()): void {
  const current = readLiveness(store);
  if (current?.owner !== owner) return;
  const now = Date.parse(at);
  const last = lastBeats.get(owner);
  if (last) {
    const sleptMs = (now - last.wallMs) - Number(monotonicNs - last.monotonicNs) / 1e6;
    if (sleptMs > SERVICE_SLEEP_MIN_MS) recordDowntime(store, new Date(now - Math.round(sleptMs)).toISOString(), at);
  }
  lastBeats.set(owner, { wallMs: now, monotonicNs });
  store.setMeta(SERVICE_LIVENESS_META_KEY, { ...current, aliveAt: at });
}

/** Adds one closed downtime, keeping entries younger than the retention and under the ceiling. */
function recordDowntime(store: MetaStore, since: string, until: string): void {
  const cutoff = Date.parse(until) - SERVICE_DOWNTIME_RETENTION_MS;
  const kept = serviceDowntimeIntervals(store).filter(entry => Date.parse(entry.until ?? "") >= cutoff);
  store.setMeta(SERVICE_DOWNTIME_HISTORY_META_KEY,
    [...kept, { since, until }].slice(-SERVICE_DOWNTIME_HISTORY_LIMIT));
}

/**
 * Every closed service downtime the record holds, read structurally: every budget
 * read asks for it. A malformed entry discounts nothing.
 */
export function serviceDowntimeIntervals(store: Pick<Store, "getMeta">): BudgetHostOutage[] {
  const raw = store.getMeta<unknown>(SERVICE_DOWNTIME_HISTORY_META_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is { since: string; until: string } =>
    Boolean(entry) && typeof entry.since === "string" && typeof entry.until === "string")
    .map(entry => ({ since: entry.since, until: entry.until }));
}
