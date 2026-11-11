import { tokenRedactor } from "../../core/machine/token-redactor";
import { pidAlive } from "../../core/machine/pid";
/**
 * Detached supervisor for contract 010 client-protocol runs (Spec 035 part 3).
 *
 * The Queue service spawns this process detached and unref'd, so it outlives a
 * service roll. It runs the submitted command in its own process group, streams
 * stdout and stderr into the run's retained output files, honours the run
 * timeout and a durable cancel request, and writes the `host.run.result` record
 * atomically beside the run. A restarted Queue endpoint reattaches every
 * unsettled run to that record, so a roll loses neither the run nor its result.
 *
 * Settlement follows contract 010's process-group rule: the result is written
 * only once the group is proven empty, never when the leader's stdio closes, so
 * a same-group descendant cannot be settled over and an escaped `setsid`
 * descendant is inventoried and recorded as a fact.
 */
import { randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { hostRunResultSchema } from "../../shared/contracts";
import {
  HOST_RUN_SUPERVISOR_PLAN_FORMAT,
  HOST_RUN_SUPERVISOR_STATE_FORMAT,
  hostRunCancelRequestSchema,
  hostRunSupervisorPlanSchema,
  hostRunSupervisorStateSchema,
  readHostRunLaunchEnv,
  removeHostRunLaunchEnv,
  type HostRunSupervisorPlan,
  type HostRunSupervisorState,
} from "../../core/host-runs/host-run-wire";
import {
  hostRunProcessStartIdentity,
  openVerifiedOwnedFile,
  readCheckedHostRunFile,
  writeVerifiedOwnedFile,
} from "../../core/host-runs/host-run-files";
import { processStartIdentityEnvironment, ProcessTreeCpuSampler, processGroupEmpty, processesForStartIdentity, processesForStartIdentityInTree } from "../../core/machine/process-group";
import { startIdentityMatches } from "../../core/machine/start-identity";
import { HOST_RUN_CPU_COVERAGE_FILE, hostRunCpuCoverageSidecar } from "../../core/host-runs/host-run-cpu-coverage";

/** How often the endpoint's supervisor samples its command tree's CPU. */
export const HOST_RUN_CPU_SAMPLE_MS = 250;

const CANCEL_POLL_MS = 50;
const GROUP_POLL_MS = 25;

const sleep = (ms: number) => new Promise<void>(resolvePromise => setTimeout(resolvePromise, ms));

/** Preserve chunk boundaries while ensuring a run cannot persist its own token in output. */
function outputWriter(fd: number, secret: string | undefined): { write(chunk: Buffer): void; flush(): void } {
  return tokenRedactor(secret, bytes => { if (bytes.length) writeSync(fd, bytes); });
}

function readCancelRequest(stateDir: string, runId: string): string | null {
  const raw = readCheckedHostRunFile(stateDir, ["runs", runId, "cancel.json"]);
  if (!raw) return null;
  try {
    const parsed = hostRunCancelRequestSchema.parse(JSON.parse(raw.toString("utf8")));
    return parsed.runId === runId ? parsed.reason : null;
  } catch { return null; }
}

export async function runHostRunSupervisorMain(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [stateDir, runId] = argv;
  if (!stateDir || !runId) throw new Error("Host-run supervisor needs its state directory and run id");
  const raw = readCheckedHostRunFile(stateDir, ["runs", runId, "supervisor.plan.json"]);
  if (!raw) throw new Error("Host-run supervisor plan is missing or fails the owned-subtree checks");
  const parsed = JSON.parse(raw.toString("utf8")) as { format?: unknown };
  if (parsed.format !== HOST_RUN_SUPERVISOR_PLAN_FORMAT) throw new Error("Host-run supervisor plan has the wrong format");
  const plan: HostRunSupervisorPlan = hostRunSupervisorPlanSchema.parse(parsed);
  if (plan.stateDir !== stateDir || plan.runId !== runId) throw new Error("Host-run supervisor plan identity does not match its arguments");

  const startedAt = new Date().toISOString();
  const supervisorStartIdentity = hostRunProcessStartIdentity(process.pid);
  let state: HostRunSupervisorState = hostRunSupervisorStateSchema.parse({
    format: HOST_RUN_SUPERVISOR_STATE_FORMAT, version: 1, runId: plan.runId, epoch: plan.epoch,
    supervisorPid: process.pid, supervisorStartIdentity,
    commandPid: null, commandPgid: null, commandStartIdentity: null,
    termination: null, startedAt, updatedAt: startedAt, endedAt: null,
  });
  const persist = (patch: Partial<HostRunSupervisorState>) => {
    state = hostRunSupervisorStateSchema.parse({ ...state, ...patch, updatedAt: new Date().toISOString() });
    writeVerifiedOwnedFile(plan.stateDir, ["runs", plan.runId, "supervisor.state.json"], JSON.stringify(state), 0o600);
  };
  persist({});

  const stdoutFd = openVerifiedOwnedFile(plan.stateDir, ["runs", plan.runId, "stdout"], constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
  const stderrFd = openVerifiedOwnedFile(plan.stateDir, ["runs", plan.runId, "stderr"], constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
  // The plan holds env key names only; the values come from the run's ephemeral launch file.
  const launchEnv = readHostRunLaunchEnv(plan.stateDir, plan.runId);
  if (!launchEnv) throw new Error("Host-run launch env is missing; the run was never launched");
  const stdout = outputWriter(stdoutFd, launchEnv.HOST_RUN_TOKEN);
  const stderr = outputWriter(stderrFd, launchEnv.HOST_RUN_TOKEN);

  // A private identity marker inherited by the command and every descendant, so
  // the supervisor can inventory an escaped `setsid` descendant at settlement.
  const identity = randomUUID();
  const child = spawn(plan.argv[0], plan.argv.slice(1), {
    cwd: plan.cwd, env: { ...launchEnv, ...processStartIdentityEnvironment(identity) }, detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  removeHostRunLaunchEnv(plan.stateDir, plan.runId);
  // CPU used by the command's whole tree, as milestone QA measures it, so the
  // scheduler can budget this selector from history instead of the whole box.
  const cpu = new ProcessTreeCpuSampler(identity, HOST_RUN_CPU_SAMPLE_MS);
  let pgid: number | null = null;
  let commandStartIdentity: string | null = null;
  let termination: "timeout" | "cancel" | null = null;
  let stopStage: "none" | "term" | "kill" = "none";
  let graceTimer: NodeJS.Timeout | null = null;
  let leaderCode: number | null = null;
  let leaderSignal: NodeJS.Signals | null = null;
  let finishing = false;
  let resolveFinished!: () => void;
  const completion = new Promise<void>(resolvePromise => { resolveFinished = resolvePromise; });
  const escaped = new Map<string, { pid: number; startIdentity: string }>();
  let inventoryTimer: NodeJS.Timeout | null = null;

  /**
   * One marker scan: refresh the known escaped set and report whether any known
   * escaped descendant is still alive. Contract 010: the group is proven dead
   * only when it is empty *and* no known escaped descendant is alive. An
   * unreadable listing is never proof of absence — including when the escaped
   * set is still empty, which is how a short-lived `setsid` child was settled
   * over when Darwin `ps -E -A` timed out under host load.
   */
  const scanEscaped = (): boolean => {
    const knownPids = [...escaped.values()].map(entry => entry.pid);
    let found = processesForStartIdentityInTree(identity, { processGroupId: pgid, pids: knownPids });
    // Last-instant detach: the parent is gone, so the cheap tree walk has no
    // roots unless we already inventoried the child. Fall back to the full
    // identity listing once the group is empty.
    if (found.state === "absent" && escaped.size === 0 && (!pgid || processGroupEmpty(pgid)))
      found = processesForStartIdentity(identity);
    if (found.state === "found") {
      for (const entry of found.processes) {
        if (entry.processGroupId === pgid) continue;
        escaped.set(`${entry.pid}:${entry.startIdentity}`, { pid: entry.pid, startIdentity: entry.startIdentity });
      }
    }
    if (found.state === "unknown") {
      // Known pids the kernel says are gone do not occupy the run by themselves.
      // An empty escaped set plus an unreadable listing still cannot prove there
      // was never a descendant.
      const knownAlive = [...escaped.values()].some(entry => pidAlive(entry.pid));
      return knownAlive || escaped.size === 0;
    }
    const alive = found.state === "found" ? found.processes : [];
    return [...escaped.values()].some(entry => entry.startIdentity.endsWith("@unknown")
      || alive.some(process => process.pid === entry.pid && startIdentityMatches(entry.startIdentity, process.startIdentity)));
  };
  const signalEscaped = (signal: NodeJS.Signals) => {
    const found = processesForStartIdentity(identity);
    if (found.state !== "found") return;
    for (const entry of found.processes) {
      if (entry.processGroupId === pgid) continue;
      try { process.kill(entry.pid, signal); } catch { /* the descendant is already gone */ }
    }
  };
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!pgid) return;
    try { process.kill(-pgid, signal); } catch { /* the group is already gone */ }
  };
  const beginStop = () => {
    if (stopStage !== "none") return;
    stopStage = "term";
    signalGroup("SIGTERM");
    graceTimer = setTimeout(() => { stopStage = "kill"; signalGroup("SIGKILL"); }, plan.graceMs);
    graceTimer.unref?.();
  };
  const timeout = setTimeout(() => { termination = "timeout"; persist({ termination }); beginStop(); }, plan.runTimeoutMs);
  timeout.unref?.();
  const cancelPoll = setInterval(() => {
    if (termination) return;
    const reason = readCancelRequest(plan.stateDir, plan.runId);
    if (reason === null) return;
    termination = "cancel";
    persist({ termination });
    beginStop();
  }, CANCEL_POLL_MS);
  cancelPoll.unref?.();

  const closeOutputs = () => {
    try { stdout.flush(); } catch { /* output loss never fails a run */ }
    try { stderr.flush(); } catch { /* output loss never fails a run */ }
    for (const fd of [stdoutFd, stderrFd]) { try { fsyncSync(fd); } catch { /* closed */ } try { closeSync(fd); } catch { /* closed */ } }
  };

  /** Settle only when the run's process group is empty and no known escaped descendant lives. */
  const finish = async (): Promise<void> => {
    if (finishing) return;
    finishing = true;
    if (inventoryTimer) { clearInterval(inventoryTimer); inventoryTimer = null; }
    // Wait for the original process group to empty, sampling escaped
    // descendants while it runs.
    while (pgid && !processGroupEmpty(pgid)) {
      scanEscaped();
      if (stopStage === "term") signalEscaped("SIGTERM");
      if (stopStage === "kill") signalEscaped("SIGKILL");
      await sleep(GROUP_POLL_MS);
    }
    // Contract 010: the group is proven dead only when it is empty and no known
    // escaped descendant is alive. Two clean scans 150 ms apart prove that a
    // descendant detaching at the group's last instant is still inventoried.
    // An unreadable listing is occupied, including when the escaped set is still
    // empty: settlement stays unresolved until a readable scan proves absence.
    for (;;) {
      if (!scanEscaped()) {
        await sleep(150);
        if (!scanEscaped()) break;
      }
      if (stopStage === "term") signalEscaped("SIGTERM");
      if (stopStage === "kill") signalEscaped("SIGKILL");
      await sleep(GROUP_POLL_MS);
    }
    clearTimeout(timeout);
    clearInterval(cancelPoll);
    const { cpuMs, cpuCoverage } = cpu.stop();
    // The CPU reason is Queue-internal: a private sidecar beside the run, written
    // ahead of the Contract 010 result; a failed write never blocks the result.
    if (pgid && commandStartIdentity) {
      try {
        writeVerifiedOwnedFile(plan.stateDir, ["runs", plan.runId, HOST_RUN_CPU_COVERAGE_FILE],
          JSON.stringify(hostRunCpuCoverageSidecar({ runId: plan.runId, epoch: plan.epoch }, cpuMs, cpuCoverage)), 0o600);
      } catch { /* the reason stays unknown */ }
    }
    if (graceTimer) clearTimeout(graceTimer);
    child.stdout?.destroy();
    child.stderr?.destroy();
    closeOutputs();
    const endedAt = new Date().toISOString();
    if (pgid && commandStartIdentity) {
      const exitCode = leaderSignal ? null : leaderCode;
      const result = hostRunResultSchema.parse({
        format: "host.run.result", version: 1, runId: plan.runId, epoch: plan.epoch,
        pgid, startIdentity: commandStartIdentity,
        exitCode, signal: leaderSignal ?? (exitCode === null ? "unknown" : null),
        startedAt: plan.startedAt, endedAt, wallMs: Math.max(0, Date.now() - Date.parse(plan.startedAt)), cpuMs,
        escapedDescendants: [...escaped.values()],
      });
      writeVerifiedOwnedFile(plan.stateDir, ["runs", plan.runId, "result.json"], JSON.stringify(result), 0o600);
    }
    persist({ endedAt });
    resolveFinished();
  };

  child.on("spawn", () => {
    if (!child.pid) return;
    pgid = child.pid;
    // The command's real OS start identity, not the sampling time. It also
    // scopes CPU samples to this group: `detached` makes the child its own
    // group (and session) leader, so pgid = pid.
    const measured = hostRunProcessStartIdentity(child.pid);
    commandStartIdentity = measured;
    cpu.start({ pgid: child.pid, leaderStartIdentity: measured });
    persist({ commandPid: child.pid, commandPgid: child.pid, commandStartIdentity });
    // Inventory while the parent still lives: a `setsid` child leaves the
    // group, and Darwin's cheap tree walk finds it through ppid only until the
    // leader exits (after which launchd reparents it).
    scanEscaped();
    inventoryTimer = setInterval(() => { scanEscaped(); }, 100);
    inventoryTimer.unref?.();
  });
  child.stdout?.on("data", (chunk: Buffer) => { try { stdout.write(chunk); } catch { /* output loss never fails a run */ } });
  child.stderr?.on("data", (chunk: Buffer) => { try { stderr.write(chunk); } catch { /* output loss never fails a run */ } });
  child.on("error", () => { void finish(); });
  child.on("exit", (code, signal) => { leaderCode = code; leaderSignal = signal; void finish(); });

  await completion;
}
