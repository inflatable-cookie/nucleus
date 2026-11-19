import { realpathSync } from "node:fs";
import { redactTokenBuffer } from "../machine/token-redactor";
import { writeQaJsonAsync } from "./project-qa-async-io";
import {
  PROJECT_QA_DETAIL_BYTES,
  readHostRunResult,
} from "./project-qa-supervision-files";
import { tailWithTruncationMarker } from "../machine/output-retention";
import type { ExecutionOutcome } from "../machine/process-exec";
import { executeHookProgram } from "../machine/process-exec";
import { minimalHookEnvironment } from "../hooks/hook-result";
import { withRunTemporaryDirectory } from "../workspaces/run-scratch";
import {
  ProcessTreeCpuSampler,
  type ProcessTreeCpu,
} from "../machine/process-tree-cpu";
import type { ProcessTreeCpuReads } from "../machine/process-host-reads";
import { defaultHostRunStateDir } from "../host-runs/host-run-files";
import { HOST_RUN_TOKEN_GRACE_MS } from "../host-runs/host-run-endpoint-types";
import { hostRunLaunchEnvironment } from "../host-runs/host-run-wire";
import { issueHostRunToken } from "../host-runs/host-run-token";
import {
  qaSupervisionPaths,
  readQaCancelRequest,
  QA_STEP_EXIT_SCHEMA,
  QA_SUPERVISION_SCHEMA_VERSION,
  type QaSupervisionPlan,
  type QaSupervisionState,
  type QaStepExit,
} from "./project-qa-supervision-files";
import type { QaPipelineIo, QaSpawnedProcess } from "./project-qa-pipeline";
import type { ChildExitFacts } from "../machine/process-exec";

/** How often a live supervisor refreshes its independent heartbeat file. */
export const SUPERVISOR_HEARTBEAT_MS = 2_000;

/** The real executors and durable file recording used by the detached supervisor. */
/**
 * Task 590: the pipeline's view of the run's host-run token. The supervisor
 * issues the token lazily in `environment`, after the pipeline's run object
 * is built, so the supervisor reports it back here: the streaming failure
 * collector, the step redaction and the live-output log all read the token
 * from the pipeline run, and without this sync they would keep an undefined
 * token in production and record the secret unredacted.
 */
export function detachedSupervisorIo(
  plan: QaSupervisionPlan,
  statePath: string,
  tokenHolder?: { hostRunToken?: string },
  cpuReads?: ProcessTreeCpuReads,
): QaPipelineIo {
  const supervisorEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const { resultPath, cancelPath, planPath, cpuCoveragePath, heartbeatPath, stepExitPath } =
    qaSupervisionPaths(plan.runRoot, plan.runId, plan.attempt);
  let current: QaSupervisionState | null = null;
  let timer: NodeJS.Timeout | null = null;
  let cpuSampler: ProcessTreeCpuSampler | null = null;
  let finalCpu: ProcessTreeCpu | null = null;
  let writes = Promise.resolve();
  let heartbeatWrite = Promise.resolve();
  let heartbeatWriting = false;
  const persist = (state: QaSupervisionState) => {
    const snapshot = structuredClone({
      ...state,
      detail: tailWithTruncationMarker(state.detail, PROJECT_QA_DETAIL_BYTES),
    });
    const write = writes.then(() => writeQaJsonAsync(statePath, snapshot));
    writes = write.catch(() => {});
    return write;
  };
  const redactExecution = async (
    execution: Promise<ExecutionOutcome>,
  ): Promise<ExecutionOutcome> => {
    const outcome = await execution;
    if (!plan.hostRunToken) return outcome;
    return {
      ...outcome,
      stdout: redactTokenBuffer(outcome.stdout, plan.hostRunToken),
      stderr: redactTokenBuffer(outcome.stderr, plan.hostRunToken),
    };
  };
  const executeOptions = (
    cancelable: boolean,
    onSpawn?: (process: QaSpawnedProcess) => void,
  ) => ({
    processStartIdentity: plan.identityToken,
    settleOnProcessGroup: true,
    cancelReason: cancelable
      ? () => readQaCancelRequest(cancelPath, plan.runId)?.reason ?? null
      : undefined,
    /**
     * #1393: publish the direct child's exit the moment the executor sees it, on
     * its own small record ahead of the step log, the lifecycle state and the
     * result. The step is the one this pipeline has in flight, so the record
     * always names the command it belongs to. A write that cannot land is not
     * retried here: the step's own settlement and the service's inspection both
     * fall back to what they can observe.
     */
    onChildExit: (exit: ChildExitFacts) => {
      const active = current?.activeProcess;
      if (!active) return;
      const record: QaStepExit = {
        schema: QA_STEP_EXIT_SCHEMA, schema_version: QA_SUPERVISION_SCHEMA_VERSION,
        runId: plan.runId, step: active.step, pid: exit.pid, processGroupId: active.processGroupId,
        exitCode: exit.exitCode, signal: exit.signal, exitedAt: exit.exitedAt,
      };
      void writeQaJsonAsync(stepExitPath, record, { durable: false })
        .catch(() => { /* the exit facts are best effort; settlement never waits on them */ });
    },
    onSpawn: (
      pid: number,
      processGroupId?: number,
      leaderStartIdentity?: string,
      startIdentity?: string,
    ) => {
      // Steps run one at a time, each in its own group: CPU samples follow the current one.
      if (processGroupId && startIdentity)
        cpuSampler?.attachGroup({
          pgid: processGroupId,
          leaderStartIdentity: startIdentity,
        });
      if (pid && processGroupId && leaderStartIdentity && startIdentity)
        onSpawn?.({ pid, processGroupId, leaderStartIdentity, startIdentity });
    },
  });
  return {
    environment: async (eventId, root) => {
      if (!plan.hostRunToken) {
        const launchedAt = Date.parse(plan.startedAt);
        plan.hostRunToken = issueHostRunToken(
          plan.hostRunStateDir ?? defaultHostRunStateDir(),
          {
            runId: plan.runId,
            epoch: plan.epoch,
            class: plan.runClass,
            root: realpathSync(root),
            exp: launchedAt + plan.timeoutMs + HOST_RUN_TOKEN_GRACE_MS,
          },
        );
        await writeQaJsonAsync(planPath, plan);
      }
      if (tokenHolder && plan.hostRunToken)
        tokenHolder.hostRunToken = plan.hostRunToken;
      return hostRunLaunchEnvironment(
        withRunTemporaryDirectory(
          minimalHookEnvironment(eventId),
          plan.temporaryDirectory,
        ),
        {
          runId: plan.runId,
          token: plan.hostRunToken,
          env: supervisorEnv,
        },
      );
    },
    hook: (script, root, onSpawn, cancelable = true, stepEnv) =>
      redactExecution(
        executeHookProgram({
          root,
          executable: "/bin/sh",
          argv: ["-lc", script],
          stdin: Buffer.alloc(0),
          timeoutMs: plan.hookTimeoutMs,
          maxOutputBytes: plan.hookMaxOutputBytes,
          overflow: "tail",
          terminationGraceMs: plan.terminationGraceMs,
          env:
            stepEnv ??
            withRunTemporaryDirectory(supervisorEnv, plan.temporaryDirectory),
          ...executeOptions(cancelable, onSpawn),
        }),
      ),
    command: (stage, root, onSpawn, cancelable = true, stepEnv, onOutput) =>
      redactExecution(
        executeHookProgram({
          root,
          executable: stage.argv[0],
          argv: stage.argv.slice(1),
          stdin: Buffer.alloc(0),
          timeoutMs: stage.timeoutMs,
          maxOutputBytes: stage.maxOutputBytes ?? plan.maxOutputBytes,
          overflow: "tail",
          // Task 590: passing test lines go before failure lines when the stage
          // output exceeds its cap, so the retained log keeps what failed.
          trimPassingFirst: true,
          terminationGraceMs: plan.terminationGraceMs,
          env:
            stepEnv ??
            withRunTemporaryDirectory(
              minimalHookEnvironment(`project-qa:${plan.runId}`),
              plan.temporaryDirectory,
            ),
          ...executeOptions(cancelable, onSpawn),
          ...(onOutput ? { onOutput } : {}),
        }),
      ),
    cancellation: () => readQaCancelRequest(cancelPath, plan.runId),
    writeHostResult: async (result) => {
      if (!readHostRunResult(resultPath, result.runId))
        await writeQaJsonAsync(resultPath, result, {
          requireDirectorySync: true,
        });
    },
    writeCpuCoverage: (sidecar) => writeQaJsonAsync(cpuCoveragePath, sidecar),
    persist,
    cpu: () => cpuSampler?.read() ?? finalCpu,
    begin: (state) => {
      current = state;
      cpuSampler = new ProcessTreeCpuSampler(
        plan.identityToken,
        undefined,
        cpuReads,
      );
      cpuSampler.start();
      timer = setInterval(() => {
        if (!current || heartbeatWriting) return;
        current.heartbeatAt = new Date().toISOString();
        heartbeatWriting = true;
        heartbeatWrite = writeQaJsonAsync(
          heartbeatPath,
          {
            runId: current.runId,
            pid: current.pid,
            identityToken: current.identityToken,
            heartbeatAt: current.heartbeatAt,
          },
          { durable: false },
        )
          .catch(() => {
            /* retry next tick; a failed write never invents freshness */
          })
          .finally(() => {
            heartbeatWriting = false;
          });
      }, SUPERVISOR_HEARTBEAT_MS);
      timer.unref?.();
      return async () => {
        if (timer) clearInterval(timer);
        timer = null;
        finalCpu = cpuSampler?.stop() ?? null;
        await heartbeatWrite;
        await writes;
      };
    },
    now: Date.now,
  };
}
