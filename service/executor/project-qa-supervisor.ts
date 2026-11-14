import { readFileSync } from "node:fs";
import { qaSupervisionPlanSchema, qaSupervisionPaths } from "../../core/qa/project-qa-supervision-files";
import { defaultHostRunStateDir } from "../../core/host-runs/host-run-files";
import { assertCheckoutAvailable } from "../../core/workspaces/checkout-volume";
import { detachedSupervisorIo } from "../../core/qa/project-qa-detached-io";
import { runProjectQaPipeline, type QaPipelineRun } from "../../core/qa/project-qa-pipeline";
import { runQaTeardownRetry } from "../../core/qa/project-qa-teardown";

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
): Promise<void> {
  const [planPath, identityToken] = argv;
  if (!planPath || !identityToken) throw new Error("QA supervisor needs the plan path and its identity token");
  const plan = qaSupervisionPlanSchema.parse(JSON.parse(readFileSync(planPath, "utf8")));
  if (plan.identityToken !== identityToken) throw new Error("QA supervisor identity token does not match its plan");
  const { statePath } = qaSupervisionPaths(plan.runRoot, plan.runId, plan.attempt);
  const run: QaPipelineRun = {
    runId: plan.runId, key: plan.key, caller: plan.caller, base: plan.base, baseBranch: plan.baseBranch,
    startedAt: plan.startedAt, startedAtMs: plan.startedAtMs,
    checkoutPath: plan.checkoutPath, registeredPath: plan.registeredPath, runRoot: plan.runRoot,
    argv: plan.argv, timeoutMs: plan.timeoutMs, maxOutputBytes: plan.maxOutputBytes,
    stages: plan.stages ?? [{ name: "qa", argv: plan.argv, timeoutMs: plan.timeoutMs, maxOutputBytes: plan.maxOutputBytes }],
    terminationGraceMs: plan.terminationGraceMs, epoch: plan.epoch, runClass: plan.runClass,
    hostRunStateDir: plan.hostRunStateDir ?? defaultHostRunStateDir(), hostRunToken: plan.hostRunToken, links: plan.links,
    ...(plan.temporaryDirectory ? { temporaryDirectory: plan.temporaryDirectory } : {}),
    ...(plan.externalCheckout ? { checkoutAdmission: () => fixtureAdmission ? fixtureAdmission(plan.checkoutPath) : assertCheckoutAvailable({ target: plan.checkoutPath }) } : {}),
  };
  const identity = { pid: process.pid, identityToken: plan.identityToken };
  if (plan.mode === "teardown_retry") {
    if (!plan.retry) throw new Error("QA teardown retry plan carries no retry payload");
    await runQaTeardownRetry(identity, run, detachedSupervisorIo(plan, statePath, run), {
      command: plan.retry.command, priorSteps: plan.retry.priorSteps, qaExitCode: plan.retry.qaExitCode,
      priorCancelReason: plan.retry.priorCancelReason, reason: plan.retry.reason, cleanupOnly: plan.retry.cleanupOnly,
      priorFailedStep: plan.retry.priorFailedStep,
    });
    return;
  }
  await runProjectQaPipeline(identity, run, detachedSupervisorIo(plan, statePath, run));
}
