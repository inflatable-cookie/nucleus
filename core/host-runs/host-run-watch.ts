import {
  hostRunResultSchema,
  hostRunSettlementSchema,
  type HostRunInternalRecord,
  type HostRunResult,
  type HostRunSettlement,
} from "../../shared/contracts";
import {
  HOST_RUN_CPU_COVERAGE_FILE,
  boundSidecarCoverage,
  parseCpuCoverageSidecar,
} from "./host-run-cpu-coverage";
import {
  HOST_RUN_SUPERVISOR_STATE_GRACE_MS,
} from "./host-run-endpoint-types";
import {
  readCheckedHostRunFile,
} from "./host-run-files";
import type { HostRunScheduler } from "./host-run-scheduler";
import {
  hostRunSupervisorStateSchema,
  type HostRunSupervisorState,
} from "./host-run-wire";
import {
  processGroupEmpty,
} from "../machine/process-group";
import {
  pidAlive,
} from "../machine/process-identity";
import {
  HOST_RUN_IDENTITY_PROOF_CACHE_MS,
  RecordedIdentityProofs,
  hostRunProcessStartIdentity,
  readHostRunStartIdentity,
  startIdentityMatches,
} from "../machine/start-identity";

interface HostRunWatchContext {
  stopping: boolean;
  supervisorPollMs: number;
  scheduler: HostRunScheduler;
  nowMs: () => number;
  stateDir: string;
}

export class HostRunWatch {
  constructor(private readonly context: HostRunWatchContext) {
    this.identityProofs = new RecordedIdentityProofs({ read: readHostRunStartIdentity, alive: pidAlive, now: () => context.nowMs(), cacheMs: HOST_RUN_IDENTITY_PROOF_CACHE_MS });
  }

  watchRun(runId: string): void {
    if (this.context.stopping || this.watches.has(runId)) return;
    const timer = setInterval(() => this.pollRun(runId), this.context.supervisorPollMs);
    timer.unref?.();
    this.watches.set(runId, timer);
    this.pollRun(runId);
  }

  stopWatch(runId: string): void {
    const timer = this.watches.get(runId);
    if (timer) clearInterval(timer);
    this.watches.delete(runId);
  }

  /**
   * One watch tick. The identity proofs below used to run as synchronous child
   * processes (`spawnSync("ps")`) on this same event loop — ten times per
   * second for every unsettled run, straight through a roll — and one slow `ps`
   * under host contention outlasts the kernel accept backlog, so the live
   * contract-010 socket refused connects while this endpoint was perfectly
   * healthy (2026-10-20 milestone QA). The proofs now run as spawned children
   * on the same poll cadence; a poll still in flight skips the next tick
   * instead of stacking, and decisions re-read the record after every await so
   * a result that landed during a proof settles from the next poll, never on a
   * stale snapshot.
   */
  pollRun(runId: string): void {
    if (this.pollsInFlight.has(runId)) return;
    this.pollsInFlight.add(runId);
    void this.pollRunOnce(runId).finally(() => this.pollsInFlight.delete(runId));
  }

  async pollRunOnce(runId: string): Promise<void> {
    const run = this.context.scheduler.get(runId);
    if (!run || run.state === "settled") { this.stopWatch(runId); return; }
    const state = this.readSupervisorState(runId);
    const result = this.readSupervisorResult(runId);
    if (state?.commandPid && state.commandPgid && state.commandStartIdentity
        && (run.pid !== state.commandPid || run.processGroupId !== state.commandPgid || !startIdentityMatches(run.startIdentity ?? "", state.commandStartIdentity))) {
      try { this.context.scheduler.updateProcess(runId, { pid: state.commandPid, processGroupId: state.commandPgid, startIdentity: state.commandStartIdentity }); }
      catch { /* a fenced or settled run cannot be updated */ }
    }
    if (result) {
      // A result records a settled command, but a process group or a recorded
      // escaped descendant can outlive its leader; capacity is released only
      // once both are proven gone. The escapee proof may await a child process,
      // so settle from a re-read record: the next poll would reach the same
      // result, and a run settled meanwhile must not be touched again.
      if (result.pgid && !processGroupEmpty(result.pgid)) return;
      if (await this.escapedDescendantAliveAsync(result)) return;
      // The proof above may rest on the age-bound cache: re-prove fresh
      // before the settlement decision, so a cached proof never releases
      // capacity on its own.
      if (await this.escapedDescendantAliveAsync(result, true)) return;
      const settledRun = this.context.scheduler.get(runId);
      if (!settledRun || settledRun.state === "settled") { this.stopWatch(runId); return; }
      this.settleFromResult(settledRun, result, state);
      this.stopWatch(runId);
      return;
    }
    if (run.state !== "running" || !run.launchedAt) return;
    const supervisorProof = state ? await this.processMatchesRecordedIdentity(state.supervisorPid, state.supervisorStartIdentity) : false;
    if (this.context.stopping) return;
    // The identity proof awaited a child process: a result may have landed in
    // that window, and the next poll settles from it instead of this one
    // declaring the supervisor lost over a stale snapshot.
    if (this.readSupervisorResult(runId)) return;
    const current = this.context.scheduler.get(runId);
    if (!current || current.state === "settled") { this.stopWatch(runId); return; }
    const groupAlive = state?.commandPgid ? !processGroupEmpty(state.commandPgid) : false;
    if (state && supervisorProof === false && !groupAlive) {
      // The proof above may rest on the age-bound cache: re-prove fresh
      // before declaring the supervisor lost, then re-check the record after
      // the await so a result that landed meanwhile settles instead.
      if (await this.processMatchesRecordedIdentity(state.supervisorPid, state.supervisorStartIdentity, true) !== false) return;
      if (this.readSupervisorResult(runId)) return;
      const latest = this.context.scheduler.get(runId);
      if (!latest || latest.state === "settled") { this.stopWatch(runId); return; }
      this.settleLost(runId, "supervisor ended without a result record"); this.stopWatch(runId); return;
    }
    if (!state && this.context.nowMs() - Date.parse(run.launchedAt) > HOST_RUN_SUPERVISOR_STATE_GRACE_MS) {
      this.settleLost(runId, "supervisor never recorded a command for this run");
      this.stopWatch(runId);
    }
  }

  readSupervisorState(runId: string): HostRunSupervisorState | null {
    const raw = readCheckedHostRunFile(this.context.stateDir, ["runs", runId, "supervisor.state.json"]);
    if (!raw) return null;
    try { return hostRunSupervisorStateSchema.parse(JSON.parse(raw.toString("utf8"))); }
    catch { return null; }
  }

  /** The run's CPU-reason sidecar, or null when missing or unreadable. */
  readCpuCoverageSidecar(runId: string): unknown {
    try { return parseCpuCoverageSidecar(readCheckedHostRunFile(this.context.stateDir, ["runs", runId, HOST_RUN_CPU_COVERAGE_FILE])); }
    catch { return null; }
  }

  readSupervisorResult(runId: string): HostRunResult | null {
    const raw = readCheckedHostRunFile(this.context.stateDir, ["runs", runId, "result.json"]);
    if (!raw) return null;
    try { return hostRunResultSchema.parse(JSON.parse(raw.toString("utf8"))); }
    catch { return null; }
  }

  /**
   * Whether any recorded escaped descendant may still hold capacity: its pid
   * still carries the recorded identity, or its identity could not be observed
   * at all. The synchronous form is the one-shot adoption path only: it never
   * settles, releases, or relaunches over an unknown observation — the async
   * watch proves a real absence (a missing PID entry or kernel ESRCH) and
   * settles there. Only a successfully read different identity disproves the
   * recorded one.
   */
  escapedDescendantNeedsWatch(result: HostRunResult): boolean {
    return result.escapedDescendants.some(descendant => {
      const observed = hostRunProcessStartIdentity(descendant.pid);
      if (startIdentityMatches(observed, descendant.startIdentity)) return true;
      return observed.endsWith("@unknown");
    });
  }

  /**
   * The same proof without blocking the accepting loop; used by the run watch
   * and reattach. An unavailable observation is not absence while the pid
   * still answers liveness: it keeps the escapee unproven so capacity stays
   * reserved. Only a missing PID entry, kernel ESRCH behind an unreadable
   * read, or a successfully read different identity counts as dead. `fresh`
   * re-proves past the age-bound cache for the settlement decision.
   */
  async escapedDescendantAliveAsync(result: HostRunResult, fresh = false): Promise<boolean> {
    for (const descendant of result.escapedDescendants) {
      if (await this.processMatchesRecordedIdentity(descendant.pid, descendant.startIdentity, fresh) !== false) return true;
    }
    return false;
  }

  /**
   * Whether the pid is alive and still carries the recorded start identity.
   * The identity proof spawns a child process, and a watch polling ten times
   * a second kept the endpoint's accepting loop paying for `ps` process
   * creation across every roll (2026-10-20). Proofs are age-bounded and
   * liveness-checked so a reused pid number expires even when no poll observed
   * the death, shared while in flight, and taken fresh for identity-dependent
   * loss and settlement decisions. An unavailable observation is `unknown`:
   * never matched, never cached, never read as death.
   */
  processMatchesRecordedIdentity(pid: number, recorded: string, fresh = false): Promise<boolean | "unknown"> {
    return this.identityProofs.check(pid, recorded, fresh);
  }

  /** Turn a durable `host.run.result` into the settlement, using the supervisor's termination cause. */
  settleFromResult(run: HostRunInternalRecord, result: HostRunResult, state: HostRunSupervisorState | null): void {
    const outcome: HostRunSettlement["outcome"] = state?.termination === "timeout" ? "timed_out"
      : state?.termination === "cancel" ? "cancelled"
        : result.signal ? "failed"
          : result.exitCode === 0 ? "passed" : "failed";
    const settlement = hostRunSettlementSchema.parse({
      format: "host.run.settlement", version: 1, runId: run.id, outcome, launched: true,
      settledAt: result.endedAt, result, containers: [],
    });
    // The CPU reason is a sidecar the supervisor wrote before the result.
    const cpuCoverage = result.runId === run.id && result.epoch === run.epoch
      ? boundSidecarCoverage(this.readCpuCoverageSidecar(run.id), { runId: run.id, epoch: run.epoch, cpuMs: result.cpuMs }) : undefined;
    this.context.scheduler.settle(run.id, settlement, { wallMs: result.wallMs, cpuMs: result.cpuMs ?? null, cpuCoverage });
  }

  settleLost(runId: string, message: string): void {
    const run = this.context.scheduler.get(runId);
    if (!run || run.state === "settled") return;
    const settledAt = new Date(this.context.nowMs()).toISOString();
    const settlement = hostRunSettlementSchema.parse({
      format: "host.run.settlement", version: 1, runId, outcome: "lost", launched: true,
      settledAt, result: null, containers: [],
    });
    try { this.context.scheduler.note(runId, "launch_failure", { error: message.slice(0, 2000), launched: true }); } catch { /* journaling best effort */ }
    this.context.scheduler.settle(runId, settlement);
  }

  readonly watches = new Map<string, NodeJS.Timeout>();

  /** Run ids with a poll still in flight; a 100 ms watch never stacks blocking proofs. */
  readonly pollsInFlight = new Set<string>();

  /** Proven (pid, recorded identity) pairs; see `processMatchesRecordedIdentity`. */
  readonly identityProofs: RecordedIdentityProofs;
}
