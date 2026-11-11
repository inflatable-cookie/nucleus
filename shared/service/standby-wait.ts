/** Shared standby readiness policy; process observations are supplied by its caller. */
/** Env var the bridge sets to the pid of the service this process replaces. */
export const STANDBY_ENV = "QUEUE_STANDBY_FOR_PID";
/** The standby gives up (and exits) if the old service never goes away. */
export const STANDBY_WAIT_MS = 90_000;
/**
 * The bridge's wait for a standby's readiness marker is bounded by progress,
 * not wall-clock time (2026-10-22 milestone QA b3a1c6d1: a standby still
 * loading under host load passed the old fixed 20 s bound and the drain left a
 * 3.3 s endpoint gap). While the exact spawned standby is alive and its CPU
 * time advances it is loading, so the bridge keeps waiting; it drains past the
 * live standby when its CPU time has not advanced for the stall
 * window, or at the hard cap, which never re-arms: CPU activity is not proof the
 * standby will ever report. An exited standby aborts the roll without draining. When CPU time cannot be measured at all, the old
 * wall-clock budget applies unchanged.
 */
export const STANDBY_READY_STALL_MS = 5_000;
/** Hard cap on the readiness wait, whatever the standby's CPU activity. */
export const STANDBY_READY_CAP_MS = 120_000;
/** Wall-clock readiness budget used only when the standby's CPU time is never measurable. */
export const STANDBY_READY_BUDGET_MS = 20_000;
/** Why the readiness wait ended. */
export type StandbyWaitCause = "ready" | "exited" | "old_exited" | "stalled" | "cap" | "unmeasured_budget";
export interface StandbyWaitProbe {
  /** The standby wrote its readiness marker. */
  ready(): boolean;
  /** The exact spawned standby is still running (its own child handle, so a reused pid never counts). */
  alive(): boolean;
  /**
   * The service the standby replaces has already exited (another bridge drained
   * it, or it died). The standby then stops being a standby and removes its
   * marker, so waiting longer is pointless.
   */
  replacedExited(): boolean;
  /** The standby's cumulative CPU in ms, or null when it cannot be measured. */
  cpuMs(): Promise<number | null>;
  /** Monotonic milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Runs on every CPU sample (at most every 250 ms), e.g. to keep a spawn claim fresh. */
  tick?(): void;
}
export interface StandbyWaitBounds { stallMs: number; capMs: number; budgetMs: number; pollMs: number }
export interface StandbyWaitResult { warm: boolean; cause: StandbyWaitCause; waitedMs: number; cpuMs: number | null }

export interface ForeignReplacementProbe<T> {
  /** A compatible replacement service, never the one being replaced; null while none answers. */
  replacement(): Promise<T | null>;
  /** The owning bridge's spawn claim is still live and fresh. */
  claimFresh(): boolean;
  /** Monotonic milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
}
/**
 * Wait for another bridge's replacement (papercut a6c9a2ac). The hard cap is
 * fixed at entry and never re-armed, whatever the owner's claim does; a stale or
 * released claim with no replacement returns at once, leaving recovery to the
 * caller's next attempt.
 */
export async function awaitForeignReplacement<T>(probe: ForeignReplacementProbe<T>, capMs: number, pollMs: number): Promise<{ client: T | null; cause: "replaced" | "claim_released" | "cap" }> {
  const deadline = probe.now() + capMs;
  while (probe.now() < deadline) {
    await probe.sleep(pollMs);
    const client = await probe.replacement();
    if (client) return { client, cause: "replaced" };
    if (!probe.claimFresh()) {
      const last = await probe.replacement();
      return { client: last, cause: last ? "replaced" : "claim_released" };
    }
  }
  return { client: null, cause: "cap" };
}

/**
 * Wait for a standby's readiness marker, bounded by its progress. Progress is
 * an increase in measured CPU time; a first reading is only a baseline, and an
 * unmeasurable reading is never progress. Elapsed time is monotonic.
 */
export async function awaitStandbyProgress(probe: StandbyWaitProbe, bounds: StandbyWaitBounds): Promise<StandbyWaitResult> {
  const start = probe.now();
  const sampleMs = Math.min(250, Math.max(bounds.pollMs, Math.floor(bounds.stallMs / 4)));
  let lastProgress = start, lastSample = Number.NEGATIVE_INFINITY, lastCpu: number | null = null;
  const done = (warm: boolean, cause: StandbyWaitCause): StandbyWaitResult => ({ warm, cause, waitedMs: Math.round(probe.now() - start), cpuMs: lastCpu });
  for (;;) {
    if (probe.ready()) return done(true, "ready");
    if (!probe.alive()) return done(false, "exited");
    if (probe.replacedExited()) return done(false, "old_exited");
    let at = probe.now();
    if (at - start >= bounds.capMs) return done(false, "cap");
    if (at - lastSample >= sampleMs) {
      lastSample = at;
      probe.tick?.();
      const cpu = await probe.cpuMs();
      // A reading taken as the standby exits says nothing about loading.
      if (!probe.alive()) return done(false, "exited");
      at = probe.now();
      if (cpu !== null) {
        if (lastCpu !== null && cpu > lastCpu) lastProgress = at;
        lastCpu = lastCpu === null ? cpu : Math.max(lastCpu, cpu);
      }
    }
    if (lastCpu !== null ? at - lastProgress >= bounds.stallMs : at - start >= bounds.budgetMs)
      return done(false, lastCpu !== null ? "stalled" : "unmeasured_budget");
    await probe.sleep(bounds.pollMs);
  }
}

/** Env var naming one bridge spawn. */
export const SPAWN_TOKEN_ENV = "QUEUE_SPAWN_TOKEN";
