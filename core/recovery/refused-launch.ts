import type { Store } from "../store/store";

/**
 * The event a launch writes when a creation provably never crossed the send
 * boundary: the host refused it, so nothing was delivered and nothing is owed.
 */
export const CREATION_REFUSED_BEFORE_SEND = "creation_refused_before_send";

/**
 * The profiles this task's own host refused before send since the owner last
 * re-armed recovery (nucleus#1364).
 *
 * A proven pre-send refusal settles that occurrence at once: the run is
 * released, its credential removed and its creation attempt settled, so exact
 * lookup has nothing to find. The *retry* of the same episode is what must not
 * repeat the identical launch — a host that refused a role on one profile is
 * asked for a different eligible one instead, and the recovery keeps acting
 * where it can. An owner `restart` re-arms recovery and clears the set with it,
 * because the operator's deliberate retry is the fresh attempt, not a repeat.
 *
 * The complete history matters: intervening events must not hide a refusal or
 * the owner re-arm that defines this episode.
 */
/**
 * The runs a proven pre-send creation refusal settled. The launch settlement
 * records the run id as the event detail; a recovery creation the coordinator
 * route refused records it with the reason beside it. Both shapes name the same
 * occurrence, so every reader parses them here.
 */
export function refusedRunIds(
  events: readonly { kind: string; detail: string }[],
): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind !== CREATION_REFUSED_BEFORE_SEND) continue;
    const detail = event.detail.trim();
    if (!detail) continue;
    if (detail.startsWith("{")) {
      try {
        const parsed = JSON.parse(detail) as { runId?: unknown };
        if (typeof parsed.runId === "string" && parsed.runId)
          ids.add(parsed.runId);
      } catch {
        /* an unparseable detail names no run */
      }
      continue;
    }
    ids.add(detail);
  }
  return ids;
}

export function refusedLaunchProfiles(
  store: Pick<Store, "eventsAll" | "runs">,
  taskId: string,
): Set<string> {
  const events = store.eventsAll(taskId);
  const rearm =
    events.filter((event) => event.kind === "coordinator_rearmed").at(-1)?.id ?? 0;
  const refused = refusedRunIds(events.filter((event) => event.id > rearm));
  const profiles = new Set(
    store.runs(taskId)
      .filter((run) => refused.has(run.id) && run.profile)
      .map((run) => run.profile!.id),
  );
  for (const event of events) {
    if (event.id <= rearm || event.kind !== "worker_creation_refused_before_send") continue;
    try {
      const detail = JSON.parse(event.detail) as { profileId?: unknown };
      if (typeof detail.profileId === "string" && detail.profileId) profiles.add(detail.profileId);
    } catch { /* older events contain only the reason */ }
  }
  return profiles;
}
