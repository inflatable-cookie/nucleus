import { randomUUID } from "node:crypto";
import { hostRunResultSchema } from "../../shared/contracts";
import {
  HOST_RUN_SUPERVISOR_PLAN_FORMAT,
  HOST_RUN_SUPERVISOR_STATE_FORMAT,
  hostRunSupervisorPlanSchema,
  hostRunSupervisorStateSchema,
  readHostRunCancelRequest,
  readHostRunLaunchEnv,
  removeHostRunLaunchEnv,
  type HostRunSupervisorPlan,
  type HostRunSupervisorState,
} from "../../core/host-runs/host-run-wire";
import {
  hostRunProcessStartIdentity,
  readCheckedHostRunFile,
  writeVerifiedOwnedFile,
} from "../../core/host-runs/host-run-files";
import { HOST_RUN_RETAINED_OUTPUT_BYTES } from "../../core/host-runs/host-run-endpoint-types";
import { HOST_RUN_CPU_COVERAGE_FILE, hostRunCpuCoverageSidecar } from "../../core/host-runs/host-run-cpu-coverage";
import { openHostRunRetainedOutput } from "../../core/host-runs/host-run-retained-output";
import { executeHookProgram, type DirectChildWait, type ExecutionOutcome } from "../../core/machine/process-exec";
import { qualificationProcessIdentity, qualificationSubjectDigest } from "../../core/host-runs/qualification-binding";
import { qualificationReadinessRefusal } from "../../core/host-runs/qualification-inputs";
import { firstEffectClockReading } from "../../core/host-runs/qualification-clock";
import {
  qualificationCaptureEvidence,
  qualificationWaitEvidence,
  writeQualificationObservation,
} from "../../core/host-runs/qualification-observation";
import { readQualificationAck } from "../../core/host-runs/qualification-acceptance";
import {
  QualificationLedgerMonitor,
  qualificationLedgerEntry,
  qualificationRunFootprints,
  qualificationRunProvider,
  qualificationRunReserve,
} from "../../core/host-runs/qualification-ledger";
import type {
  HostRunQualificationCapture,
  HostRunQualificationStreamEvidence,
  HostRunQualificationWait,
} from "../../shared/schema/host-runs";
import type { QualificationRawEvidence } from "../../core/host-runs/host-run-retained-output";
import type { StreamTerminals } from "../../core/machine/process-exec";
import { ProcessTreeCpuSampler } from "../../core/machine/process-tree-cpu";
/**
 * Detached supervisor for contract 010 client-protocol runs (Spec 035 part 3).
 *
 * The Queue service spawns this process detached and unref'd, so it outlives a
 * service roll. It reads the run's plan, runs the submitted command in its own
 * process group, streams stdout and stderr into the run's retained output files
 * under a byte cap, honours the run timeout and a durable cancel request, and
 * writes the `host.run.result` record atomically beside the run. A restarted
 * Queue endpoint reattaches every unsettled run to that record, so a roll loses
 * neither the run nor its result.
 *
 * The process custody is not this module's: `executeHookProgram` owns the spawn,
 * the process group, the timeout and cancel signals, output observation,
 * settle-on-empty-group and contract 010's second condition — the result is
 * written only once the group is empty *and* no known escaped descendant is
 * alive, with the stop stages still applied to descendants that left the group
 * while the run waits. What stays here is the host run's own durable wiring: the
 * state record, the retained output, and the result envelope.
 */
export const HOST_RUN_CPU_SAMPLE_MS = 250;
/** The process owner's in-memory copy is discarded here; the retained files carry the output. */
const IN_MEMORY_OUTPUT_BYTES = 64 * 1024;
const ESCAPE_POLL_MS = 100;

const sleep = (ms: number) => new Promise<void>(resolvePromise => setTimeout(resolvePromise, ms));

/** Read and validate the plan the endpoint wrote for this run. */
function readSupervisorPlan(stateDir: string, runId: string): HostRunSupervisorPlan {
  const raw = readCheckedHostRunFile(stateDir, ["runs", runId, "supervisor.plan.json"]);
  if (!raw) throw new Error("Host-run supervisor plan is missing or fails the owned-subtree checks");
  const parsed = JSON.parse(raw.toString("utf8")) as { format?: unknown };
  if (parsed.format !== HOST_RUN_SUPERVISOR_PLAN_FORMAT) throw new Error("Host-run supervisor plan has the wrong format");
  const plan: HostRunSupervisorPlan = hostRunSupervisorPlanSchema.parse(parsed);
  if (plan.stateDir !== stateDir || plan.runId !== runId) throw new Error("Host-run supervisor plan identity does not match its arguments");
  return plan;
}

/**
 * The supervisor's own record (`supervisor.state.json`). The endpoint's watch
 * reads it for the command identity and the termination cause, so every write
 * is the whole record and keeps the contract's shape.
 */
class SupervisorState {
  private state: HostRunSupervisorState;

  constructor(private readonly plan: HostRunSupervisorPlan, startedAt: string) {
    this.state = hostRunSupervisorStateSchema.parse({
      format: HOST_RUN_SUPERVISOR_STATE_FORMAT, version: 1, runId: plan.runId, epoch: plan.epoch,
      supervisorPid: process.pid, supervisorStartIdentity: hostRunProcessStartIdentity(process.pid),
      commandPid: null, commandPgid: null, commandStartIdentity: null,
      termination: null, startedAt, updatedAt: startedAt, endedAt: null,
    });
    this.persist({});
  }

  /** The cause already recorded for the run's stop, if any. */
  get termination(): "timeout" | "cancel" | null {
    return this.state.termination;
  }

  persist(patch: Partial<HostRunSupervisorState>): void {
    this.state = hostRunSupervisorStateSchema.parse({ ...this.state, ...patch, updatedAt: new Date().toISOString() });
    writeVerifiedOwnedFile(this.plan.stateDir, ["runs", this.plan.runId, "supervisor.state.json"], JSON.stringify(this.state), 0o600);
  }
}

/**
 * Run one host run: read its plan and launch env, hand the command to the
 * process owner, keep the run reserved until the escaped-descendant proof holds,
 * and write the durable result. An unreadable cancel request is unknown, never
 * absent: the run is stopped and the reason is recorded beside it.
 *
 * Spec 064 P1–P7: the private qualification mode is bound to one plan whose
 * subject, command identity and cumulative clock were resolved before any effect.
 * This entry admits such a plan only when every external input is present and
 * qualified; otherwise it refuses before its first write or spawn and names the
 * missing inputs (tranche 3 replaced the staged "foundation incomplete" refusal).
 * Authentication alone never starts a real proof.
 */
/**
 * Spec 064 P1/P2: the process-start identity this plan's direct command inherits.
 * A qualification plan derives it from the immutable subject, so the marker the
 * binding's environment digest covers is exactly the one the command receives; an
 * ordinary plan keeps a fresh random identity.
 */
export function supervisorSpawnIdentity(plan: Pick<HostRunSupervisorPlan, "qualification">): string {
  return plan.qualification ? qualificationProcessIdentity(plan.qualification.subject) : randomUUID();
}

export interface HostRunSupervisorHooks {
  /** Spec 064 P2: the supervisor's own direct-command exit observation, as it is made. */
  onDirectChildWait?: (wait: DirectChildWait) => void;
  /** Spec 064 P5: the ledger sample cadence (a test seam; production uses the constant below). */
  ledgerSampleMs?: number;
}

/** Spec 064 P5: how often S charges the footprints it can see while the command runs. */
export const QUALIFICATION_LEDGER_SAMPLE_MS = 1_000;
/** Spec 064 P6: S's acknowledgement wait is bounded by the attempt's own remaining target. */
const QUALIFICATION_ACK_POLL_MS = 50;

/**
 * Spec 064 P5: charge the footprints S can see, on the ledger's own cadence, so a
 * breach is detected while the command still runs and requests the P3 stop.
 */
class QualificationLedgerSampler {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly stateDir: string,
    private readonly runId: string,
    private readonly monitor: QualificationLedgerMonitor,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    const sample = () => {
      const footprints = qualificationRunFootprints(this.stateDir, this.runId);
      for (const footprint of footprints) {
        try {
          this.monitor.record(qualificationLedgerEntry(footprint, {
            nowMs: Date.now(), provider: qualificationRunProvider(footprint.root), owner: "host-run supervisor",
            writers: ["host-run supervisor"], reserve: qualificationRunReserve(footprint.root),
          }));
        } catch { /* a sample that cannot be taken is disclosed by the next one, never guessed */ }
      }
    };
    sample();
    this.timer = setInterval(sample, Math.max(1, this.intervalMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Spec 064 P6: S publishes the one observation it alone can write. */
function publishQualificationObservation(input: {
  plan: HostRunSupervisorPlan;
  qualification: NonNullable<HostRunSupervisorPlan["qualification"]>;
  execution: ExecutionOutcome;
  closed: { qualification: QualificationRawEvidence | null; faults: { kind: string; detail: string; at: string }[] };
  ledger: QualificationLedgerMonitor;
  directChildWait: DirectChildWait | null;
}): { digest: string } {
  const { plan, qualification, execution, closed, ledger, directChildWait } = input;
  const clock = plan.firstEffectClock!;
  const readings = ledger.reading();
  const raw = closed.qualification;
  if (!raw) throw new Error("The qualification capture produced no artifact evidence; there is nothing to observe");
  const terminals: StreamTerminals = execution.streamTerminals ?? {
    stdout: { eof: "unknown", drained: "unknown", eofAt: null, drainedAt: null },
    stderr: { eof: "unknown", drained: "unknown", eofAt: null, drainedAt: null },
  };
  const faults = [
    ...closed.faults.map(fault => ({ kind: fault.kind, detail: fault.detail, at: fault.at })),
    ...(execution.eofWaitTimedOut
      ? [{ kind: "eof_wait_bound", detail: `Real EOF was not observed inside the ${clock.targetMs} ms first-effect bound; the terminal markers are unknown, never manufactured`, at: new Date().toISOString() }]
      : []),
    ...(execution.captureFault ? [{ kind: "capture", detail: execution.captureFault, at: new Date().toISOString() }] : []),
    ...(ledger.firstFault() ? [{ kind: "storage", detail: ledger.firstFault()!.reason, at: ledger.firstFault()!.at }] : []),
  ];
  const body = {
    runId: plan.runId, epoch: plan.epoch,
    subjectDigest: qualificationSubjectDigest(qualification.subject),
    clock, writtenAt: new Date().toISOString(),
    supervisor: { pid: process.pid, startIdentity: hostRunProcessStartIdentity(process.pid) },
    command: {
      pid: execution.pid ?? null, pgid: execution.processGroupId ?? null,
      startIdentity: execution.startIdentity ?? null,
      exitCode: execution.signal ? null : execution.code, signal: execution.signal ?? null,
      timedOut: execution.timedOut,
      terminalObservation: (execution.processGroupEmpty ? "observed" : "unknown") as "observed" | "unknown",
    },
    directChildWait: qualificationWaitEvidence(directChildWait),
    // S holds no creator receipts for A, C, M, the leaves or the publisher: those
    // are their own parents' evidence and are never synthesized here.
    parentWaits: [] as HostRunQualificationWait[],
    streamTerminals: {
      stdout: { eof: terminals.stdout.eof, drained: terminals.stdout.drained },
      stderr: { eof: terminals.stderr.eof, drained: terminals.stderr.drained },
    },
    capture: qualificationCaptureEvidence(raw, closed.faults),
    ledger: readings.ledger,
    faults,
  };
  const written = writeQualificationObservation(plan.stateDir, plan.runId, body);
  return { digest: written.record.digest };
}

/**
 * Spec 064 P6/P7: S observes the endpoint's exact acknowledgement and exits; if it
 * does not land inside the attempt's remaining target, S exits without one and the
 * endpoint settles the delivery gate unknown. Nothing is published or copied twice.
 */
async function waitForQualificationAck(plan: HostRunSupervisorPlan, observationDigest: string): Promise<void> {
  const clock = plan.firstEffectClock;
  if (!clock) return;
  const deadline = clock.originTick + clock.targetMs;
  while (Date.now() < deadline) {
    const read = readQualificationAck(plan.stateDir, plan.runId);
    if (read.state === "present" && read.ack.observationDigest === observationDigest) return;
    if (read.state === "unreadable") return;
    await sleep(QUALIFICATION_ACK_POLL_MS);
  }
}

export async function runHostRunSupervisorMain(argv: string[] = process.argv.slice(2), hooks: HostRunSupervisorHooks = {}): Promise<void> {
  const [stateDir, runId] = argv;
  if (!stateDir || !runId) throw new Error("Host-run supervisor needs its state directory and run id");
  const plan = readSupervisorPlan(stateDir, runId);
  // Spec 064 P5/P6: a qualification plan is admitted only when every external
  // input is present and qualified, and only with the attempt's one clock. Both
  // refusals happen before this supervisor's first write or spawn.
  const qualification = plan.qualification ?? null;
  if (qualification) {
    const readinessRefusal = qualificationReadinessRefusal(qualification.readiness, `the qualification plan for ${plan.runId}`);
    if (readinessRefusal) throw new Error(`${readinessRefusal} (this supervisor refuses the plan before its first write or spawn)`);
    if (!plan.firstEffectClock)
      throw new Error(`The qualification plan for ${plan.runId} carries no first-effect clock; the cumulative target cannot be counted and the plan is refused before its first effect`);
  } else if (plan.stopMode === "qualification_direct") {
    throw new Error(`A qualification_direct stop without a qualification binding is refused before this supervisor's first effect`);
  }
  // The plan holds env key names only; the values come from the run's ephemeral launch file.
  const launchEnv = readHostRunLaunchEnv(plan.stateDir, plan.runId);
  if (!launchEnv) throw new Error("Host-run launch env is missing; the run was never launched");
  const state = new SupervisorState(plan, new Date().toISOString());
  // Spec 064 P4/P5: a qualification plan keeps exactly one combined artifact and
  // charges it in the ledger; an ordinary plan keeps the two capped streams.
  const output = openHostRunRetainedOutput(plan.stateDir, plan.runId, HOST_RUN_RETAINED_OUTPUT_BYTES, launchEnv.HOST_RUN_TOKEN,
    qualification ? { qualification: true } : {});
  const ledger = qualification ? new QualificationLedgerMonitor() : null;
  const sampler = qualification && ledger && plan.firstEffectClock
    ? new QualificationLedgerSampler(plan.stateDir, plan.runId, ledger, hooks.ledgerSampleMs ?? QUALIFICATION_LEDGER_SAMPLE_MS)
    : null;
  // A private identity marker inherited by the command and every descendant, so
  // the process owner can inventory an escaped `setsid` descendant. A
  // qualification plan's marker is the subject-derived one its binding digested.
  const identity = supervisorSpawnIdentity(plan);
  const cpu = new ProcessTreeCpuSampler(identity, HOST_RUN_CPU_SAMPLE_MS);
  const recordedFaults = new Set<string>();
  let cancelRecorded = false;
  /** Spec 064 P2: S's own direct-command exit observation, retained for the whole attempt. */
  let directChildWait: DirectChildWait | null = null;
  let execution: ExecutionOutcome;
  sampler?.start();
  try {
    execution = await executeHookProgram({
      root: plan.cwd,
      executable: plan.argv[0],
      argv: plan.argv.slice(1),
      stdin: Buffer.alloc(0),
      timeoutMs: plan.runTimeoutMs,
      // Spec 064 P4 (amended): qualification wiring has no output cap and no
      // overflow-triggered group stop; the artifact is the uncapped raw capture.
      // An ordinary plan keeps its diagnostic cap below.
      maxOutputBytes: qualification ? Number.MAX_SAFE_INTEGER : IN_MEMORY_OUTPUT_BYTES,
      // The command's exit code is the result; its output is the diagnostic, so a
      // long stream is capped and marked rather than killed.
      overflow: "tail",
      terminationGraceMs: plan.graceMs,
      processStartIdentity: identity,
      settleOnProcessGroup: true,
      // Contract 010: the run stays reserved, its pipes open and its cancel
      // request polled until no escaped descendant is proven alive.
      settleOnEscapedDescendants: true,
      // Spec 064 P2/P3: S records its own direct-command exit (the parent's child
      // exit event) and, only for a qualification plan, would use the direct-command
      // stop. An ordinary plan keeps the group stop it has always used.
      directChildWait: true,
      ...(plan.stopMode ? { stopMode: plan.stopMode } : {}),
      // Spec 064 P4 (amended): the strict capture owns this step's result, and its
      // EOF wait is bounded by the first-effect target instead of lasting until a
      // pipe held open outside the group closes.
      ...(qualification ? {
        qualificationCapture: true,
        eofWaitBoundMs: Math.max(1, plan.firstEffectClock!.targetMs),
        onStreamEof: (stream: "stdout" | "stderr") => output.markEof(stream),
        onStreamDrained: (stream: "stdout" | "stderr") => output.markDrained(stream),
      } : {}),
      onChildExit: wait => { directChildWait = wait; hooks.onDirectChildWait?.(wait); },
      env: launchEnv,
      onOutput: (stream, chunk) => output.write(stream, chunk),
      cancelReason: () => {
        // Spec 064 P5: a latched storage breach requests the same P3 direct-command
        // stop a timeout or cancel does; the first fault is permanent.
        const breach = ledger?.firstFault();
        if (breach) return `${breach.reason} (storage breach latched at ${breach.at})`;
        const request = readHostRunCancelRequest(plan.stateDir, plan.runId);
        if (request.state === "absent") return null;
        if (request.state === "requested") {
          if (!cancelRecorded) { cancelRecorded = true; state.persist({ termination: "cancel" }); }
          return request.reason;
        }
        // Unreadable is unknown, not absent: the stop is honoured and the fault is
        // recorded beside the run once, so a cancel nobody can read never reads as
        // none and the operator can see why the run stopped.
        if (!recordedFaults.has(request.reason)) {
          recordedFaults.add(request.reason);
          state.persist({ termination: "cancel" });
          recordSupervisorFault(plan, "cancel_request_unreadable", request.reason);
          console.error(`Host-run cancel request for ${plan.runId} is unreadable; the run is stopped: ${request.reason}`);
        }
        return request.reason;
      },
      onSpawn: (pid, processGroupId, _identity, startIdentity) => {
        removeHostRunLaunchEnv(plan.stateDir, plan.runId);
        if (!pid || !processGroupId || !startIdentity) return;
        // `detached` makes the command its own group (and session) leader, so the
        // group id is its pid and the command's own OS start identity scopes the
        // CPU samples to this group.
        state.persist({ commandPid: pid, commandPgid: processGroupId, commandStartIdentity: startIdentity });
        try { cpu.start({ pgid: processGroupId, leaderStartIdentity: startIdentity }); }
        catch { /* CPU sampling never fails the run it measures. */ }
      },
    });
  } catch (error) {
    // A command that never spawned is not a result: the run settles lost, and the
    // supervisor's own exit code says the launch failed.
    sampler?.stop();
    output.close();
    cpu.stop();
    throw error;
  }
  sampler?.stop();

  if (execution.timedOut && state.termination === null) state.persist({ termination: "timeout" });
  // Spec 064 P2: the direct-command exit is this supervisor's own child exit, and
  // it must have been observed before the group settled. A missing observation is
  // recorded as a fault, never inferred from the census, EOF or a PID poll.
  if (directChildWait === null)
    recordSupervisorFault(plan, "direct_child_wait_unknown", "The direct command's exit was never observed as this supervisor's own child");
  // Every chunk arrived before the process owner settled; close the retained
  // streams (which writes any truncation marker) ahead of the result record.
  const closed = output.close();
  // Spec 064 P6: S alone publishes the observation, after real EOF/drain/fsync and
  // before it exits; the endpoint acknowledges that exact record.
  if (qualification && ledger) {
    const observation = publishQualificationObservation({ plan, qualification, execution, closed, ledger, directChildWait });
    await waitForQualificationAck(plan, observation.digest);
  }
  recordResult(plan, execution, cpu);
  state.persist({ endedAt: new Date().toISOString() });
}

/** Write the contract's durable result from what the process owner proved. */
function recordResult(
  plan: HostRunSupervisorPlan,
  execution: ExecutionOutcome,
  cpu: ProcessTreeCpuSampler,
): void {
  const { cpuMs, cpuCoverage } = cpu.stop();
  const pgid = execution.processGroupId ?? null;
  const startIdentity = execution.startIdentity ?? null;
  if (pgid && startIdentity) {
    // The CPU reason is Queue-internal: a private sidecar beside the run, written
    // ahead of the Contract 010 result; a failed write never blocks the result.
    try {
      writeVerifiedOwnedFile(plan.stateDir, ["runs", plan.runId, HOST_RUN_CPU_COVERAGE_FILE],
        JSON.stringify(hostRunCpuCoverageSidecar({ runId: plan.runId, epoch: plan.epoch }, cpuMs, cpuCoverage)), 0o600);
    } catch { /* the reason stays unknown */ }
    const exitCode = execution.signal ? null : execution.code;
    const endedAt = new Date().toISOString();
    writeVerifiedOwnedFile(plan.stateDir, ["runs", plan.runId, "result.json"], JSON.stringify(hostRunResultSchema.parse({
      format: "host.run.result", version: 1, runId: plan.runId, epoch: plan.epoch,
      pgid, startIdentity,
      exitCode, signal: execution.signal ?? (exitCode === null ? "unknown" : null),
      startedAt: plan.startedAt, endedAt, wallMs: Math.max(0, Date.now() - Date.parse(plan.startedAt)), cpuMs,
      escapedDescendants: execution.escapedDescendants ?? [],
    })), 0o600);
  }
  // A command whose identity was never proven writes no result; the endpoint's
  // watch settles it lost once the supervisor is gone, never from a guess.
}

/**
 * A private fault record beside the run (the CPU sidecar's precedent): why the
 * supervisor stopped or could not prove something. Never the contract's record,
 * and a failed write never blocks the result.
 */
function recordSupervisorFault(plan: HostRunSupervisorPlan, code: string, detail: string): void {
  try {
    writeVerifiedOwnedFile(plan.stateDir, ["runs", plan.runId, "supervisor.faults.json"], JSON.stringify({
      format: "host.run.supervisor.faults", version: 1, runId: plan.runId, epoch: plan.epoch,
      faults: [{ code, detail, at: new Date().toISOString() }],
    }), 0o600);
  } catch { /* the stop itself is what keeps the run honest */ }
}
