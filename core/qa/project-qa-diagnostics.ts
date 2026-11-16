import type { Store } from "../store/store";
import type { QaSupervisionState } from "./project-qa-supervision-files";

const KEY = "qaServiceLifecycle";
type Lifecycle = { since: string; events: { at: string; kind: "start" | "roll" }[] };

/** Keep enough service history to distinguish a restart in a heartbeat gap from no restart. */
export function recordQaServiceLifecycle(store: Pick<Store, "getMeta" | "setMeta">, kind: "start" | "roll", at = new Date().toISOString()): void {
  const prior = store.getMeta<Lifecycle>(KEY);
  const events = [...(prior?.events ?? []), { at, kind }].slice(-64);
  store.setMeta(KEY, { since: prior && prior.events.length < 64 ? prior.since : events[0].at, events });
}

export function qaServiceWindow(store: Pick<Store, "getMeta">, since: string, through: string) {
  const history = store.getMeta<Lifecycle>(KEY);
  const events = history?.events.filter(event => event.at >= since && event.at <= through) ?? [];
  return {
    since, through,
    roll: events.some(event => event.kind === "roll") ? "observed" : history && history.since <= since ? "not_observed" : "unknown",
    restart: events.some(event => event.kind === "start") ? "observed" : history && history.since <= since ? "not_observed" : "unknown",
    events,
  };
}

/** Kept at the end of the lost run's detail so output retention cannot evict the cause. */
export function qaLostDiagnosticDetail(state: QaSupervisionState | null, liveness: string, groupEmpty: boolean | null,
  serviceWindow: ReturnType<typeof qaServiceWindow>) {
  return `Supervisor diagnostics: ${JSON.stringify({
    lastHeartbeatAt: state?.heartbeatAt ?? null,
    supervisor: { pid: state?.pid ?? null, liveness },
    stepInFlight: state?.inFlight ?? null,
    processGroup: { id: state?.activeProcess?.processGroupId ?? null, state: groupEmpty === null ? "unrecorded" : groupEmpty ? "empty" : "not_empty" },
    serviceWindow,
  })}`;
}
