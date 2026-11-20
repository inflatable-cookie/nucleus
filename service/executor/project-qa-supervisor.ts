import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { runtimeNodeArgs } from "../../shared/runtime.mjs";
import { writeQaJsonAsync } from "../../core/qa/project-qa-async-io";
import type { ProcessTreeCpuReads } from "../../core/machine/process-host-reads";
import {
  qaSupervisionPlanSchema,
  qaSupervisionPaths,
} from "../../core/qa/project-qa-supervision-files";
import { defaultHostRunStateDir } from "../../core/host-runs/host-run-files";
import { assertCheckoutAvailable } from "../../core/workspaces/checkout-volume";
import { detachedSupervisorIo } from "../../core/qa/project-qa-detached-io";
import {
  runProjectQaPipeline,
  type QaPipelineRun,
} from "../../core/qa/project-qa-pipeline";
import { runQaTeardownRetry } from "../../core/qa/project-qa-teardown";

/** A detached parent records how the supervisor ended, even across service rolls. */
export async function runQaSupervisorMonitor(argv: string[]): Promise<void> {
  const [entry, planPath, identityToken] = argv;
  if (!entry || !planPath || !identityToken) throw new Error("QA monitor needs the entry, plan and identity");
  const plan = qaSupervisionPlanSchema.parse(JSON.parse(readFileSync(planPath, "utf8")));
  if (plan.identityToken !== identityToken) throw new Error("QA monitor identity mismatch");
  const child = spawn(process.execPath, [...runtimeNodeArgs(), entry, planPath, identityToken], {
    detached: true, stdio: "ignore", env: process.env,
  });
  const exit = await new Promise<{ code: number | null; signal: string | null; error: string | null }>(resolve => {
    child.once("error", error => resolve({ code: null, signal: null, error: error.message }));
    child.once("exit", (code, signal) => resolve({ code, signal, error: null }));
  });
  await writeQaJsonAsync(qaSupervisionPaths(plan.runRoot, plan.runId, plan.attempt).supervisorExitPath,
    { runId: plan.runId, pid: child.pid ?? null, ...exit }, { durable: false });
}

/**
 * Detached supervisor entry: read the plan the service wrote, then run the
 * pipeline with the real executors. Invoked as `node --import tsx
 * bin/queue-qa-supervisor.mjs <planPath>` with the runner detached and unref'd,
 * so it outlives the service that started it. The exit code is advisory: the
 * durable supervision file is the record, so a roll can never lose a step.
 */
export async function runQaSupervisorMain(
  argv = process.argv.slice(2),
  fixtureAdmission?: (checkoutPath: string) => void,
  fixtureCpuReads?: ProcessTreeCpuReads,
): Promise<void> {
  const [planPath, identityToken] = argv;
  if (!planPath || !identityToken)
    throw new Error("QA supervisor needs the plan path and its identity token");
  const plan = qaSupervisionPlanSchema.parse(
    JSON.parse(readFileSync(planPath, "utf8")),
  );
  if (plan.identityToken !== identityToken)
    throw new Error("QA supervisor identity token does not match its plan");
  const { statePath } = qaSupervisionPaths(
    plan.runRoot,
    plan.runId,
    plan.attempt,
  );
  const run: QaPipelineRun = {
    runId: plan.runId,
    key: plan.key,
    caller: plan.caller,
    base: plan.base,
    baseBranch: plan.baseBranch,
    startedAt: plan.startedAt,
    startedAtMs: plan.startedAtMs,
    checkoutPath: plan.checkoutPath,
    registeredPath: plan.registeredPath,
    runRoot: plan.runRoot,
    argv: plan.argv,
    timeoutMs: plan.timeoutMs,
    maxOutputBytes: plan.maxOutputBytes,
    stages: plan.stages ?? [
      {
        name: "qa",
        argv: plan.argv,
        timeoutMs: plan.timeoutMs,
        maxOutputBytes: plan.maxOutputBytes,
      },
    ],
    terminationGraceMs: plan.terminationGraceMs,
    epoch: plan.epoch,
    runClass: plan.runClass,
    hostRunStateDir: plan.hostRunStateDir ?? defaultHostRunStateDir(),
    hostRunToken: plan.hostRunToken,
    links: plan.links,
    ...(plan.temporaryDirectory
      ? { temporaryDirectory: plan.temporaryDirectory }
      : {}),
    ...(plan.externalCheckout
      ? {
          checkoutAdmission: () =>
            fixtureAdmission
              ? fixtureAdmission(plan.checkoutPath)
              : assertCheckoutAvailable({ target: plan.checkoutPath }),
        }
      : {}),
  };
  const identity = { pid: process.pid, identityToken: plan.identityToken };
  if (plan.mode === "teardown_retry") {
    if (!plan.retry)
      throw new Error("QA teardown retry plan carries no retry payload");
    await runQaTeardownRetry(
      identity,
      run,
      detachedSupervisorIo(plan, statePath, run, fixtureCpuReads),
      {
        command: plan.retry.command,
        priorSteps: plan.retry.priorSteps,
        qaExitCode: plan.retry.qaExitCode,
        priorCancelReason: plan.retry.priorCancelReason,
        reason: plan.retry.reason,
        cleanupOnly: plan.retry.cleanupOnly,
        priorFailedStep: plan.retry.priorFailedStep,
        priorInterruptedStep: plan.retry.priorInterruptedStep,
      },
    );
    return;
  }
  await runProjectQaPipeline(
    identity,
    run,
    detachedSupervisorIo(plan, statePath, run, fixtureCpuReads),
  );
}
