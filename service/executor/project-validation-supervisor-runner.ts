import { executeHookProgram, minimalHookEnvironment } from "../../core/hooks/hooks";
import { defaultHostRunStateDir } from "../../core/host-runs/host-run-files";
import { HOST_RUN_TOKEN_GRACE_MS } from "../../core/host-runs/host-run-endpoint-types";
import { hostRunLaunchEnvironment } from "../../core/host-runs/host-run-wire";
import { issueHostRunToken, redactHostRunToken } from "../../core/host-runs/host-run-token";
import { ProcessTreeCpuSampler } from "../../core/machine/process-group";
import { hostRunProcessStartIdentity } from "../../core/machine/start-identity";
import { hostRunCpuCoverageSidecar } from "../../core/host-runs/host-run-cpu-coverage";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  readProjectValidationCancellation, readProjectValidationPlan, projectValidationCpuCoveragePath,
  writeProjectValidationCpuCoverage, writeProjectValidationPlan, writeProjectValidationResult, writeProjectValidationSupervisorState,
  projectValidationLiveOutputPath,
  type ProjectValidationSupervisorState,
} from "../../core/qa/project-validation-supervisor";
import { openLiveOutputLog } from "../../core/machine/live-output";
import { hostRunResultSchema } from "../../shared/contracts";
import { streamTruncation, headTailWithMarker, tailWithTruncationMarker } from "../../core/machine/output-retention";

const HEARTBEAT_MS = 2_000;

/** Run one prospective-merge validation outside the Queue service process. */
export async function runProjectValidationSupervisorMain(argv = process.argv.slice(2)): Promise<void> {
  const [planPath, identityToken] = argv;
  if (!planPath || !identityToken) throw new Error("Project-validation supervisor needs its plan path and identity token");
  const plan = readProjectValidationPlan(planPath);
  if (!plan || plan.identityToken !== identityToken || !plan.launchedAt)
    throw new Error("Project-validation supervisor plan is missing, invalid or belongs to another run");
  if (!plan.hostRunToken) {
    const launchedAt = Date.parse(plan.launchedAt);
    plan.hostRunToken = issueHostRunToken(plan.hostRunStateDir ?? defaultHostRunStateDir(), {
      runId: plan.runId, epoch: plan.epoch, class: plan.runClass, root: realpathSync(plan.root),
      exp: launchedAt + plan.timeoutMs + HOST_RUN_TOKEN_GRACE_MS,
    });
    writeProjectValidationPlan(planPath, plan);
  }
  const cancellationPath = join(dirname(planPath), "cancel.json");
  // The operator's live view of this run: every output chunk as it arrives, and
  // a file that stops growing when the run settles. Best effort by construction.
  const liveOutput = openLiveOutputLog(projectValidationLiveOutputPath(dirname(planPath)), plan.hostRunToken);

  const startedAt = new Date().toISOString();
  let state: ProjectValidationSupervisorState = {
    format: "queue.project-validation.supervisor", version: 1, runId: plan.runId, epoch: plan.epoch,
    identityToken, supervisorPid: process.pid, supervisorStartIdentity: hostRunProcessStartIdentity(process.pid),
    startedAt, heartbeatAt: startedAt, activeProcess: null,
  };
  const persist = () => writeProjectValidationSupervisorState(plan.statePath, { ...state, heartbeatAt: new Date().toISOString() });
  persist();
  const heartbeat = setInterval(() => { try { persist(); } catch { /* The result remains the terminal record. */ } }, HEARTBEAT_MS);
  heartbeat.unref?.();
  const cpu = new ProcessTreeCpuSampler(identityToken);
  const commandStarted = Date.now();
  try {
    let execution: Awaited<ReturnType<typeof executeHookProgram>>;
    try {
      execution = await executeHookProgram({
      root: plan.root, executable: plan.argv[0], argv: plan.argv.slice(1), stdin: Buffer.alloc(0),
      timeoutMs: plan.timeoutMs, maxOutputBytes: plan.maxOutputBytes, overflow: "tail",
      terminationGraceMs: plan.terminationGraceMs,
      processStartIdentity: identityToken, settleOnProcessGroup: true,
      cancelReason: () => {
        const cancellation = readProjectValidationCancellation(cancellationPath, plan.runId);
        return cancellation && cancellation.epoch === plan.epoch && cancellation.identityToken === plan.identityToken
          ? cancellation.reason : null;
      },
      env: hostRunLaunchEnvironment(minimalHookEnvironment(`project-validation:${plan.runId}`), {
        runId: plan.runId, token: plan.hostRunToken,
      }),
      ...(liveOutput ? { onOutput: (_stream, chunk) => liveOutput.write(chunk) } : {}),
      onSpawn: (pid, processGroupId, leaderStartIdentity, startIdentity) => {
        try { cpu.start(processGroupId && startIdentity ? { pgid: processGroupId, leaderStartIdentity: startIdentity } : undefined); }
        catch { /* CPU sampling never fails the validation it measures. */ }
        if (!pid || !processGroupId || !leaderStartIdentity || !startIdentity) return;
        state = { ...state, activeProcess: { pid, processGroupId, leaderStartIdentity, startIdentity } };
        try { persist(); } catch { /* Keep supervising; the result still records the terminal identity. */ }
      },
    });
    } catch (error) {
      // A command that never starts (a missing executable, say) settles as an
      // operational hold that names the failure, not as a lost run.
      const endedAt = new Date().toISOString();
      cpu.stop();
      writeProjectValidationResult(plan.resultPath, {
        format: "queue.project-validation.result", version: 1, runId: plan.runId, epoch: plan.epoch,
        identityToken, state: "hold", exitCode: null, durationMs: Math.max(0, Date.now() - commandStarted),
        outputTail: tailWithTruncationMarker(`Validation launch failed: ${String(error)}`, 2000),
        timedOut: false, signal: null, pid: null, processGroupId: null, leaderStartIdentity: null, processGroupEmpty: true,
        terminationError: null, hostResult: null, startedAt: plan.launchedAt, endedAt,
      });
      return;
    }
    const endedAt = execution.endedAt ?? new Date().toISOString();
    const measuredCpu = cpu.stop();
    const active = state.activeProcess;
    const processGroupId = execution.processGroupId ?? active?.processGroupId ?? null;
    const leaderStartIdentity = execution.leaderStartIdentity ?? active?.leaderStartIdentity ?? null;
    const processStartIdentity = execution.startIdentity ?? active?.startIdentity ?? null;
    const exitCode = execution.signal || execution.terminationSignal ? null : execution.code;
    const signal = exitCode === null ? execution.signal ?? execution.terminationSignal ?? "unknown" : null;
    const hostResult = processGroupId && processStartIdentity ? hostRunResultSchema.parse({
      format: "host.run.result", version: 1, runId: plan.runId, epoch: plan.epoch,
      pgid: processGroupId, startIdentity: processStartIdentity, exitCode, signal,
      startedAt: execution.startedAt ?? plan.launchedAt, endedAt,
      wallMs: Math.max(0, execution.durationMs), cpuMs: measuredCpu.cpuMs,
      escapedDescendants: execution.escapedDescendants ?? [],
    }) : null;
    // The CPU reason is a private sidecar written ahead of the result envelope;
    // a failed write never blocks the result.
    if (hostResult) {
      try {
        writeProjectValidationCpuCoverage(projectValidationCpuCoveragePath(plan.resultPath),
          hostRunCpuCoverageSidecar({ runId: plan.runId, epoch: plan.epoch }, hostResult.cpuMs, measuredCpu.cpuCoverage));
      } catch { /* the reason stays unknown */ }
    }
    const status = execution.timedOut || execution.signal || execution.terminationSignal
      || execution.terminationError || execution.processGroupEmpty === false || execution.code === null
      ? "hold" : execution.code === 0 ? "passed" : "refused";
    // Task 388: this result's bounded tail is the only durable finding a
    // validation refusal carries. When the executor's byte cap cut a stream, the
    // finding keeps a beginning and an end around the marker instead of a tail
    // slice, so the beginning of a long failure is not lost here as well.
    const validationOutput = redactHostRunToken(Buffer.concat([execution.stdout, execution.stderr]).toString("utf8"), plan.hostRunToken);
    const truncation = streamTruncation((execution.stdoutObservedBytes ?? execution.stdout.length) + (execution.stderrObservedBytes ?? execution.stderr.length),
      (execution.stdoutOmittedBytes ?? 0) + (execution.stderrOmittedBytes ?? 0));
    writeProjectValidationResult(plan.resultPath, {
      format: "queue.project-validation.result", version: 1, runId: plan.runId, epoch: plan.epoch,
      identityToken, state: status, exitCode: execution.code, durationMs: Math.max(0, execution.durationMs || Date.now() - commandStarted),
      outputTail: truncation ? headTailWithMarker(validationOutput, 2000, truncation) : tailWithTruncationMarker(validationOutput, 2000),
      timedOut: execution.timedOut, signal: execution.signal ?? execution.terminationSignal ?? null,
      pid: execution.pid ?? active?.pid ?? null, processGroupId, leaderStartIdentity, processGroupEmpty: execution.processGroupEmpty ?? null,
      terminationError: execution.terminationError ?? null, hostResult,
      startedAt: plan.launchedAt, endedAt,
    });
  } finally {
    clearInterval(heartbeat);
    cpu.stop();
    liveOutput?.close();
  }
}
