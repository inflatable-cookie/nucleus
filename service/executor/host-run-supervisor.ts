import { randomUUID } from "node:crypto";
import { hostRunResultSchema } from "../../shared/contracts";
import {
  HOST_RUN_SUPERVISOR_PLAN_FORMAT,
  HOST_RUN_SUPERVISOR_STATE_FORMAT,
  QUALIFICATION_FOUNDATION_INCOMPLETE,
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
 * Spec 064 P1–P3: the private qualification mode is bound to one plan whose
 * subject and command identity were resolved before any effect. Until the later
 * tranches land their named missing-input refusal, this entry refuses such a plan
 * before its first write or spawn (brief amendment, 2026-11-16): the mode is
 * inaccessible, and authentication alone never starts a real proof.
 */
export interface HostRunSupervisorHooks {
  /** Spec 064 P2: the supervisor's own direct-command exit observation, as it is made. */
  onDirectChildWait?: (wait: DirectChildWait) => void;
}

export async function runHostRunSupervisorMain(argv: string[] = process.argv.slice(2), hooks: HostRunSupervisorHooks = {}): Promise<void> {
  const [stateDir, runId] = argv;
  if (!stateDir || !runId) throw new Error("Host-run supervisor needs its state directory and run id");
  const plan = readSupervisorPlan(stateDir, runId);
  if (plan.qualification || plan.stopMode === "qualification_direct")
    throw new Error(`${QUALIFICATION_FOUNDATION_INCOMPLETE}: this supervisor refuses a qualification plan before its first effect; Spec 064 P4–P7 own the missing-input refusal`);
  // The plan holds env key names only; the values come from the run's ephemeral launch file.
  const launchEnv = readHostRunLaunchEnv(plan.stateDir, plan.runId);
  if (!launchEnv) throw new Error("Host-run launch env is missing; the run was never launched");
  const state = new SupervisorState(plan, new Date().toISOString());
  const output = openHostRunRetainedOutput(plan.stateDir, plan.runId, HOST_RUN_RETAINED_OUTPUT_BYTES, launchEnv.HOST_RUN_TOKEN);
  // A private identity marker inherited by the command and every descendant, so
  // the process owner can inventory an escaped `setsid` descendant.
  const identity = randomUUID();
  const cpu = new ProcessTreeCpuSampler(identity, HOST_RUN_CPU_SAMPLE_MS);
  const recordedFaults = new Set<string>();
  let cancelRecorded = false;
  /** Spec 064 P2: S's own direct-command exit observation, retained for the whole attempt. */
  let directChildWait: DirectChildWait | null = null;
  let execution: ExecutionOutcome;
  try {
    execution = await executeHookProgram({
      root: plan.cwd,
      executable: plan.argv[0],
      argv: plan.argv.slice(1),
      stdin: Buffer.alloc(0),
      timeoutMs: plan.runTimeoutMs,
      maxOutputBytes: IN_MEMORY_OUTPUT_BYTES,
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
      onChildExit: wait => { directChildWait = wait; hooks.onDirectChildWait?.(wait); },
      env: launchEnv,
      onOutput: (stream, chunk) => output.write(stream, chunk),
      cancelReason: () => {
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
    output.close();
    cpu.stop();
    throw error;
  }

  if (execution.timedOut && state.termination === null) state.persist({ termination: "timeout" });
  // Spec 064 P2: the direct-command exit is this supervisor's own child exit, and
  // it must have been observed before the group settled. A missing observation is
  // recorded as a fault, never inferred from the census, EOF or a PID poll.
  if (directChildWait === null)
    recordSupervisorFault(plan, "direct_child_wait_unknown", "The direct command's exit was never observed as this supervisor's own child");
  // Every chunk arrived before the process owner settled; close the retained
  // streams (which writes any truncation marker) ahead of the result record.
  output.close();
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
