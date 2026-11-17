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
  readCheckedHostRunFileRead,
  type HostRunFileRead,
} from "./host-run-files";
import type { HostRunScheduler } from "./host-run-scheduler";
import {
  hostRunSupervisorPlanSchema,
  hostRunSupervisorStateSchema,
  type HostRunSupervisorPlan,
  type HostRunSupervisorState,
} from "./host-run-wire";
import { qualificationSubjectDigest } from "./qualification-binding";
import { readQualificationObservation } from "./qualification-observation";
import { acknowledgeQualificationCapture, readQualificationAck } from "./qualification-acceptance";
import {
  qualificationSettlement,
  qualificationSettlementReference,
  readQualificationSettlement,
  recordQualificationSettlementReference,
  writeQualificationSettlement,
} from "./qualification-settlement";
import {
  QualificationLedgerMonitor,
  qualificationLedgerEntry,
  qualificationRunProvider,
  qualificationRunReserve,
  qualificationServiceFootprints,
} from "./qualification-ledger";
import type { HostRunQualificationLedger } from "../../shared/schema/host-runs";
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

type HostRunRecordRead<T> =
  | { state: "present"; value: T }
  | Exclude<HostRunFileRead, { state: "present" }>;

function readRecord<T>(read: HostRunFileRead, parse: (value: unknown) => T): HostRunRecordRead<T> {
  if (read.state !== "present") return read;
  try { return { state: "present", value: parse(JSON.parse(read.bytes.toString("utf8"))) }; }
  catch (error) { return { state: "unreadable", reason: error instanceof Error ? error.message : String(error) }; }
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
    const stateRead = this.readSupervisorStateRead(runId);
    const state = stateRead.state === "present" ? stateRead.value : null;
    // Spec 064 P6: the endpoint acknowledges S's observation once it is durable,
    // before S exits. The publication order is finite and the ack is never inferred.
    this.acknowledgeQualification(runId);
    const resultRead = this.readSupervisorResultRead(runId);
    // A torn or refused result is not evidence that the supervisor never wrote
    // one. Keep watching until a verified read establishes presence or absence.
    if (resultRead.state === "unreadable") return;
    const result = resultRead.state === "present" ? resultRead.value : null;
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
    if (stateRead.state === "unreadable" || run.state !== "running" || !run.launchedAt) return;
    const supervisorProof = state ? await this.processMatchesRecordedIdentity(state.supervisorPid, state.supervisorStartIdentity) : false;
    if (this.context.stopping) return;
    // The identity proof awaited a child process: a result may have landed in
    // that window, and the next poll settles from it instead of this one
    // declaring the supervisor lost over a stale snapshot.
    if (this.readSupervisorResultRead(runId).state !== "absent") return;
    const current = this.context.scheduler.get(runId);
    if (!current || current.state === "settled") { this.stopWatch(runId); return; }
    const groupAlive = state?.commandPgid ? !processGroupEmpty(state.commandPgid) : false;
    if (state && supervisorProof === false && !groupAlive) {
      // The proof above may rest on the age-bound cache: re-prove fresh
      // before declaring the supervisor lost, then re-check the record after
      // the await so a result that landed meanwhile settles instead.
      if (await this.processMatchesRecordedIdentity(state.supervisorPid, state.supervisorStartIdentity, true) !== false) return;
      if (this.readSupervisorResultRead(runId).state !== "absent") return;
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
    const read = this.readSupervisorStateRead(runId);
    return read.state === "present" ? read.value : null;
  }

  private readSupervisorStateRead(runId: string): HostRunRecordRead<HostRunSupervisorState> {
    return readRecord(readCheckedHostRunFileRead(this.context.stateDir, ["runs", runId, "supervisor.state.json"]),
      value => hostRunSupervisorStateSchema.parse(value));
  }

  /** The run's CPU-reason sidecar, or null when missing or unreadable. */
  readCpuCoverageSidecar(runId: string): unknown {
    try { return parseCpuCoverageSidecar(readCheckedHostRunFile(this.context.stateDir, ["runs", runId, HOST_RUN_CPU_COVERAGE_FILE])); }
    catch { return null; }
  }

  readSupervisorResult(runId: string): HostRunResult | null {
    const read = this.readSupervisorResultRead(runId);
    return read.state === "present" ? read.value : null;
  }

  private readSupervisorResultRead(runId: string): HostRunRecordRead<HostRunResult> {
    return readRecord(readCheckedHostRunFileRead(this.context.stateDir, ["runs", runId, "result.json"]),
      value => hostRunResultSchema.parse(value));
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
    // Spec 064 P6/P7: settle the qualification evidence before the contract 010
    // row, so a spent attempt stays spent and a late result can never read as a pass.
    this.settleQualification(run, result, state, null);
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

  /** The private plan this run was launched with, or null when it has none. */
  readSupervisorPlan(runId: string): HostRunSupervisorPlan | null {
    const read = readCheckedHostRunFileRead(this.context.stateDir, ["runs", runId, "supervisor.plan.json"]);
    if (read.state !== "present") return null;
    try {
      const plan = hostRunSupervisorPlanSchema.parse(JSON.parse(read.bytes.toString("utf8")));
      return plan.runId === runId ? plan : null;
    } catch { return null; }
  }

  /**
   * Spec 064 P6: validate and durably acknowledge a qualification attempt's
   * capture as soon as S publishes its observation. A refusal writes nothing and is
   * recorded once, so a disputed artifact never acquires an acknowledgement.
   */
  acknowledgeQualification(runId: string): void {
    const plan = this.readSupervisorPlan(runId);
    const qualification = plan?.qualification;
    if (!plan || !qualification || !plan.firstEffectClock) return;
    const ack = readQualificationAck(this.context.stateDir, runId);
    if (ack.state !== "absent") return;
    const observation = readQualificationObservation(this.context.stateDir, runId);
    if (observation.state === "absent") return;
    if (observation.state === "unreadable") {
      this.recordQualificationEvent(runId, "qualification_ack_refused", `the observation is unreadable (${observation.reason})`);
      return;
    }
    const outcome = acknowledgeQualificationCapture({
      stateDir: this.context.stateDir, runId, epoch: plan.epoch,
      subjectDigest: qualificationSubjectDigest(qualification.subject),
      clock: plan.firstEffectClock, observation: observation.observation, nowMs: this.context.nowMs(),
    });
    if (outcome.state === "refused")
      this.recordQualificationEvent(runId, "qualification_ack_refused", outcome.refusals.join("; "));
  }

  /**
   * Spec 064 P6/P7: write the qualification settlement and record the reference the
   * intake consumes. `spend` carries a loss that was already observed — the service
   * →S parent or a Nucleus roll — so a later result cannot clear it.
   */
  settleQualification(
    run: HostRunInternalRecord,
    result: HostRunResult | null,
    _state: HostRunSupervisorState | null,
    spend: { reason: string; at: string } | null,
  ): void {
    const plan = this.readSupervisorPlan(run.id);
    const qualification = plan?.qualification;
    if (!plan || !qualification) return;
    const existing = readQualificationSettlement(this.context.stateDir, run.id);
    if (existing.state === "present" && spend === null) return; // already settled and not reopened
    const prior = existing.state === "present" ? existing.settlement : null;
    const observationRead = readQualificationObservation(this.context.stateDir, run.id);
    const ackRead = readQualificationAck(this.context.stateDir, run.id);
    const observation = observationRead.state === "present" ? observationRead.observation : null;
    const subjectDigest = qualificationSubjectDigest(qualification.subject);
    // Every footprint the service itself can charge, whole where attribution to one
    // run is not proven; the physical peak stays unclaimed.
    const monitor = new QualificationLedgerMonitor();
    const nowMs = this.context.nowMs();
    let ledger: HostRunQualificationLedger | null = null;
    try {
      for (const footprint of qualificationServiceFootprints({
        stateDir: this.context.stateDir,
        databasePath: this.context.scheduler.store.path ?? null,
        runId: run.id,
      })) {
        monitor.record(qualificationLedgerEntry(footprint, {
          nowMs, provider: qualificationRunProvider(footprint.root), owner: "nucleus service",
          writers: footprint.attributionProven ? ["host-run supervisor"] : "unknown",
          reserve: qualificationRunReserve(footprint.root),
        }));
      }
      ledger = monitor.reading().ledger;
    } catch { ledger = null; }
    const settlement = qualificationSettlement({
      runId: run.id, epoch: run.epoch, subjectDigest,
      clock: plan.firstEffectClock ?? null,
      nowMs,
      observation,
      observationUnreadable: observationRead.state === "unreadable" ? observationRead.reason : null,
      ackDigest: ackRead.state === "present" ? ackRead.ack.digest : null,
      ledger,
      evidence: observation ? {
        source: {
          outcome: "proved",
          detail: "The plan's binding and S's observation name the same subject digest; a fresh source recheck stays the intake's own gate",
          source: "supervisor.plan.json", digest: subjectDigest, observedAt: observation.writtenAt,
        },
      } : undefined,
      // The first fault is permanent: an earlier settlement's fault is carried, and
      // a loss the service observed is the spend reason.
      firstFault: prior?.disposition.firstFault ?? null,
      spent: spend ? { ...spend, disposition: "unknown_SPENT_retained" }
        : prior?.disposition.spent
          ? { reason: prior.disposition.spent.reason, at: prior.disposition.spent.spentAt, disposition: "unknown_SPENT_retained" }
          : null,
      unresolved: [
        ...(result === null ? ["the supervisor wrote no result record for this attempt"] : []),
        ...(ackRead.state === "absent" ? ["the endpoint acknowledged no capture"] : []),
        ...(observationRead.state === "absent" ? ["S published no observation"] : []),
      ],
    });
    try {
      const { settlement: written } = writeQualificationSettlement(this.context.stateDir, run.id, (() => {
        const { format: _format, version: _version, digest: _digest, ...body } = settlement;
        return body;
      })());
      recordQualificationSettlementReference(this.context.scheduler.store, qualificationSettlementReference(written, qualification.subject.participantRunId));
    } catch (error) {
      this.recordQualificationEvent(run.id, "qualification_settlement_refused", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Spec 064 P7: a Nucleus roll during a proof, or a lost service→S parent, spends
   * the attempt as unknown/SPENT/retained even if S survives and later writes a
   * result. Restart only reconciles this evidence; it never restores wait credit.
   */
  settleQualificationRoll(runId: string, reason: string): void {
    const run = this.context.scheduler.get(runId);
    if (!run || run.state === "settled") return;
    this.settleQualification(run, null, null, { reason, at: new Date(this.context.nowMs()).toISOString() });
  }

  private recordQualificationEvent(runId: string, code: string, detail: string): void {
    try { this.context.scheduler.recordEndpointEvent("qualification_evidence", undefined, { code, runId, detail: detail.slice(0, 2000) }); }
    catch { /* a refused event write never becomes a verdict */ }
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
