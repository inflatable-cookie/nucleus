import { now, type Store } from "../store/store";

/** Durable facts waiting for a task lane, and their admission timings. */
export type PhaseLatencyRecord = {
  pending: { key: string; since: string; cause: string }[];
  samples: {
    key: string;
    since: string;
    admittedAt: string;
    cause: string;
    elapsedMs: number;
  }[];
};
const phaseLatencyKey = (taskId: string) => `phaseLatency:${taskId}`;
export function phaseLatency(store: Store, taskId: string): PhaseLatencyRecord {
  return (
    store.getMeta<PhaseLatencyRecord>(phaseLatencyKey(taskId)) ?? {
      pending: [],
      samples: [],
    }
  );
}
export function markPhaseFact(
  store: Store,
  taskId: string,
  key: string,
  cause: string,
  since = now(),
): void {
  const state = phaseLatency(store, taskId);
  if (
    state.pending.some((item) => item.key === key) ||
    state.samples.some((item) => item.key === key)
  )
    return;
  store.setMeta(phaseLatencyKey(taskId), {
    ...state,
    pending: [...state.pending, { key, since, cause }],
  });
}
export function admitPhaseFacts(store: Store, taskId: string): void {
  const state = phaseLatency(store, taskId);
  if (!state.pending.length) return;
  const admittedAt = now();
  const samples = state.pending.map((item) => ({
    ...item,
    admittedAt,
    elapsedMs: Math.max(0, Date.parse(admittedAt) - Date.parse(item.since)),
  }));
  store.setMeta(phaseLatencyKey(taskId), {
    pending: [],
    samples: [...state.samples, ...samples].slice(-100),
  });
  for (const sample of samples)
    store.event(taskId, "phase_latency", JSON.stringify(sample));
}
