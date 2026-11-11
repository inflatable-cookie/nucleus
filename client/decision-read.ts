import type { DecisionView } from "../shared/contracts";

// The board and composer contributions live outside the same React tree. Share
// their read here, including an in-flight request, rather than a second query.
let generation = 0;
let cached: { revision: number; data: DecisionView[] } | undefined;
let pending: { revision: number; read: Promise<DecisionView[]> } | undefined;
export function readDecisions(revision: number | undefined, read: () => Promise<DecisionView[]>): Promise<DecisionView[]> {
  if (revision !== undefined && cached?.revision === revision) return Promise.resolve(cached.data);
  if (revision !== undefined && pending?.revision === revision) return pending.read;
  const started = generation;
  const promise = read().then(data => {
    if (revision !== undefined && started === generation) cached = { revision, data };
    return data;
  }).finally(() => { if (pending?.read === promise) pending = undefined; });
  if (revision !== undefined) pending = { revision, read: promise };
  return promise;
}
export function clearDecisionRead() { generation++; cached = undefined; pending = undefined; }
