/** A missed heartbeat is tolerated for three minutes to absorb host load. */
export const SUPERVISOR_HEARTBEAT_STALE_MS = 180_000;
/** A second observation must confirm the same stale heartbeat at least this far apart. */
export const SUPERVISOR_STUCK_CONFIRMATION_MS = 5_000;

type StaleObservation = { heartbeatAt: string; firstObservedAt: number };

/** Return stale age only after an unchanged stale heartbeat survives two checks. */
export function confirmStaleSupervisorHeartbeat(
  observations: Map<string, StaleObservation>, key: string, heartbeatAt: string, now = Date.now(),
): number | null {
  const staleAgeMs = now - Date.parse(heartbeatAt);
  if (!Number.isFinite(staleAgeMs) || staleAgeMs <= SUPERVISOR_HEARTBEAT_STALE_MS) {
    observations.delete(key);
    return null;
  }
  const previous = observations.get(key);
  if (!previous || previous.heartbeatAt !== heartbeatAt) {
    observations.set(key, { heartbeatAt, firstObservedAt: now });
    return null;
  }
  if (now - previous.firstObservedAt < SUPERVISOR_STUCK_CONFIRMATION_MS) return null;
  return staleAgeMs;
}
