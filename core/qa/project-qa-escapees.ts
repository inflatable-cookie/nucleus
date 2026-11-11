import type { HostRunScheduler } from "../host-runs/host-run-scheduler";
import { processStartIdentityLiveness } from "../machine/process-group";

const sleep = (ms: number) => new Promise<void>(resolvePromise => { setTimeout(resolvePromise, ms); });
/** Capacity holds for escaped descendants resume from settled rows after service rolls. */
const qaEscapedDescendantWatchers = new Map<string, Promise<void>>();

export interface QaEscapeeContext {
  hostRuns: Pick<HostRunScheduler, "get" | "markEscapedDescendantsDead">;
  options: { supervisionPollMs?: number };
}

export const projectQaEscapees = {
  /** Retain settled capacity until every recorded escaped PID is proven to be the same dead process. */
  watchEscapedDescendants(this: QaEscapeeContext, runId: string): void {
    if (qaEscapedDescendantWatchers.has(runId)) return;
    const pollMs = Math.max(25, this.options.supervisionPollMs ?? 1_000);
    const watching = (async () => {
      for (;;) {
        const scheduled = this.hostRuns.get(runId);
        if (!scheduled || scheduled.state !== "settled" || scheduled.capacityReleasedAt) return;
        const escaped = scheduled.settlement?.result?.escapedDescendants ?? [];
        if (!escaped.length || scheduled.escapedDescendantsProvenDeadAt) return;
        if (escaped.every(descendant => processStartIdentityLiveness(descendant.pid, descendant.startIdentity) === "dead")) {
          this.hostRuns.markEscapedDescendantsDead(runId, escaped);
          return;
        }
        await sleep(pollMs);
      }
    })().finally(() => { qaEscapedDescendantWatchers.delete(runId); });
    qaEscapedDescendantWatchers.set(runId, watching);
    void watching.catch(() => { /* the next run-list sweep resumes the durable hold */ });
  }

};
