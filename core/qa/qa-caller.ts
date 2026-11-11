/**
 * The canonical caller identity Queue gives a host run it owns for milestone
 * Project QA, and its exact inverse check.
 *
 * `ProjectQa` submits every QA host run with `queue:milestone:<digest(key)
 * [0..24]>:<qaRunId>`, and the QA run row shares the host run's id. That gives
 * the retained-output sweep a durable ownership relation it can verify from
 * stored records alone (task 444): an exact host-run id, the QA record for that
 * id, its one-run key, and this canonical caller. A caller that merely starts
 * with `queue:milestone:` proves nothing; the digest of the recorded key and the
 * exact run id must both agree.
 *
 * One owner decides the string, so the producer and the verifier cannot drift.
 */
import { createHash } from "node:crypto";

export function qaCallerIdentity(key: string, runId: string): string {
  return `queue:milestone:${createHash("sha256").update(key).digest("hex").slice(0, 24)}:${runId}`;
}

/**
 * The QA run id this caller names, but only when `caller` is exactly the
 * canonical identity for `key` and `runId`. Anything else is null: a forged
 * prefix, a foreign key digest or a caller naming another run.
 */
export function qaCallerRunId(caller: string, key: string, runId: string): string | null {
  return caller === qaCallerIdentity(key, runId) ? runId : null;
}
