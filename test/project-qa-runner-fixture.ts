import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ProjectQaRun } from "../shared/contracts";
import { projectQaRunSchema, DEFAULT_PROCESS_TERMINATION_GRACE_MS } from "../shared/contracts";
import { ProjectQaRunner as DetachedProjectQaRunner, DEFAULT_PROJECT_QA_TIMEOUT_MS, DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES, type ProjectQaLaunch, type ProjectQaOptions } from "../core/qa/project-qa";
export * from "../core/qa/project-qa";
import { now } from "../core/store/store";
import { executeHookProgram, minimalHookEnvironment } from "../core/hooks/hooks";
import { withRunTemporaryDirectory } from "../core/workspaces/run-scratch";
import { HOST_RUN_TOKEN_GRACE_MS, hostRunLaunchEnvironment, issueHostRunToken, redactHostRunToken } from "../service/callbacks/host-run-endpoint";
import { qaSupervisionPaths, readQaCancelRequest, runProjectQaPipeline, runQaTeardownRetry, writeHostRunResult, type QaPipelineRun, type QaPipelineIo, type QaPipelineOutcome } from "../core/qa/project-qa-supervisor";

/** Inline execution belongs to fixtures; service QA always uses its detached supervisor. */
export class ProjectQaRunner extends DetachedProjectQaRunner {
  declare readonly options: ProjectQaOptions & { run?: typeof executeHookProgram };
  constructor(store: ConstructorParameters<typeof DetachedProjectQaRunner>[0], options: ProjectQaOptions & { run?: typeof executeHookProgram } = {}) {
    super(store, options);
  }
  /**
   * Run the pipeline in this process. Used when a fixture injected executors;
   * production uses the detached supervisor so a roll cannot lose a step.
   */
  protected override async startSupervised(launch: ProjectQaLaunch): Promise<ProjectQaRun> {
    if (!this.options.run && !this.options.worktreeHookRun) return super.startSupervised(launch);
    const record = this.store.qaRun(launch.id);
    if (!record) throw new Error("Project QA run disappeared before launch");
    this.admitCheckout(record);
    const temporaryDirectory = this.ensureRunScratch(record);
    const hooks = await this.worktreeHooksAt(launch.checkoutPath, launch.base);
    const links = await this.resolveQaLinks(launch, hooks.setup);
    if (links.skippedProjectMembers.length) {
      const latest = this.store.qaRun(launch.id);
      if (!latest) throw new Error("Project QA run disappeared while recording skipped project members");
      this.store.putQaRun(projectQaRunSchema.parse({ ...latest, skippedProjectMembers: links.skippedProjectMembers }));
    }
    const activeLaunch = this.markLaunched(launch);
    if (!activeLaunch) {
      const current = this.store.qaRun(launch.id)!;
      this.releaseRunScratch(current, Boolean(current.checkoutCleanupPending));
      return current;
    }
    const run: QaPipelineRun = {
      runId: activeLaunch.id, key: activeLaunch.key, caller: activeLaunch.caller, base: activeLaunch.base, baseBranch: activeLaunch.baseBranch,
      startedAt: activeLaunch.startedAt, startedAtMs: activeLaunch.startedAtMs,
      checkoutPath: this.checkoutForRun(record), registeredPath: activeLaunch.checkoutPath,
      runRoot: this.qaRepositoryRootPath(activeLaunch.key),
      ...(record.checkoutPath ? { checkoutAdmission: () => this.admitCheckout(record) } : {}),
      argv: activeLaunch.argv, stages: activeLaunch.stages, timeoutMs: activeLaunch.timeoutMs, maxOutputBytes: activeLaunch.maxOutputBytes,
      terminationGraceMs: activeLaunch.terminationGraceMs, epoch: activeLaunch.epoch,
      runClass: activeLaunch.runClass, hostRunStateDir: this.hostRunStateDir(), links: links.links,
      ...(temporaryDirectory ? { temporaryDirectory } : {}),
    };
    const outcome = await runProjectQaPipeline({ pid: process.pid, identityToken: activeLaunch.identityToken }, run, this.inProcessIo(run, activeLaunch.identityToken));
    return this.settleFromPipeline(activeLaunch.id, outcome);
  }

  /** The in-process pipeline's executors: the injected fixtures, or the real hook program. */
  private inProcessIo(run: QaPipelineRun, identityToken: string): QaPipelineIo {
    const { resultPath, cancelPath } = qaSupervisionPaths(run.runRoot, run.runId);
    const cancellation = () => readQaCancelRequest(cancelPath, run.runId);
    const redact = async (execution: ReturnType<typeof executeHookProgram>): Promise<Awaited<ReturnType<typeof executeHookProgram>>> => {
      const result = await execution;
      if (!run.hostRunToken) return result;
      const scrub = (output: Buffer) => {
        const text = output.toString("utf8");
        const redacted = redactHostRunToken(text, run.hostRunToken);
        return redacted === text ? output : Buffer.from(redacted);
      };
      return { ...result, stdout: scrub(result.stdout), stderr: scrub(result.stderr) };
    };
    return {
      environment: (eventId, root) => {
        if (!run.hostRunToken) run.hostRunToken = issueHostRunToken(run.hostRunStateDir ?? this.hostRunStateDir(), {
          runId: run.runId, epoch: run.epoch, class: run.runClass ?? "heavy", root: realpathSync(root),
          exp: run.startedAtMs + run.timeoutMs + HOST_RUN_TOKEN_GRACE_MS,
        });
        return hostRunLaunchEnvironment(withRunTemporaryDirectory(minimalHookEnvironment(eventId), run.temporaryDirectory), { runId: run.runId, token: run.hostRunToken });
      },
      hook: (script, root, onSpawn, cancelable = true, env) => redact(this.runWorktreeHook(root, script, run.terminationGraceMs, {
        env,
        identityToken, onSpawn: (pid, processGroupId, leaderStartIdentity, startIdentity) => {
          if (pid && processGroupId && leaderStartIdentity && startIdentity) onSpawn?.({ pid, processGroupId, leaderStartIdentity, startIdentity });
        }, cancelReason: cancelable ? () => cancellation()?.reason ?? null : undefined,
      })),
      command: (stage, root, onSpawn, cancelable = true, env, onOutput) => redact((this.options.run ?? executeHookProgram)({
        root, executable: stage.argv[0], argv: stage.argv.slice(1), stdin: Buffer.alloc(0),
        timeoutMs: stage.timeoutMs, maxOutputBytes: stage.maxOutputBytes ?? run.maxOutputBytes, overflow: "tail",
        // Task 590: passing test lines go before failure lines when the stage
        // output exceeds its cap, so the retained log keeps what failed.
        trimPassingFirst: true,
        terminationGraceMs: run.terminationGraceMs,
        ...(onOutput ? { onOutput } : {}),
        processStartIdentity: identityToken,
        settleOnProcessGroup: true,
        cancelReason: cancelable ? () => cancellation()?.reason ?? null : undefined,
        onSpawn: (pid, processGroupId, leaderStartIdentity, startIdentity) => {
          if (pid && processGroupId && leaderStartIdentity && startIdentity) onSpawn?.({ pid, processGroupId, leaderStartIdentity, startIdentity });
          const current = this.store.qaRun(run.runId);
          if (pid && current?.state === "running") this.store.putQaRun({ ...current, pid });
        },
        env: env ?? withRunTemporaryDirectory(minimalHookEnvironment(`project-qa:${run.runId}`), run.temporaryDirectory),
      })),
      cancellation,
      writeHostResult: result => { writeHostRunResult(resultPath, result); },
      log: this.options.logWrite,
      persist: () => { /* the inline path keeps steps in memory until it settles */ },
      now: Date.now,
    };
  }

  /** Settle a run from its pipeline outcome and name the head the run proved. */
  private async settleFromPipeline(runId: string, outcome: QaPipelineOutcome): Promise<ProjectQaRun> {
    const current = this.store.qaRun(runId);
    if (!current) throw new Error(`Project QA run ${runId} disappeared before it settled`);
    return this.settle(current, { ...outcome, interruptedStep: null });
  }

  /** Run the teardown retry in this process for fixtures that injected executors. */
  protected override async startTeardownRetry(run: ProjectQaRun, command: string, qaExitCode: number | null, reason: string, cleanupOnly: boolean): Promise<ProjectQaRun> {
    if (!this.options.run && !this.options.worktreeHookRun) return super.startTeardownRetry(run, command, qaExitCode, reason, cleanupOnly);
    const identityToken = randomUUID();
    const startedAt = now();
    const temporaryDirectory = this.ensureRunScratch(run);
    const runParams: QaPipelineRun = {
      runId: run.id, key: run.key, caller: this.qaCallerIdentity(run.key, run.id),
      base: run.base, baseBranch: run.baseBranch, startedAt, startedAtMs: Date.parse(startedAt),
      checkoutPath: this.checkoutForRun(run), registeredPath: run.repository.path,
      runRoot: this.qaRepositoryRootPath(run.key), argv: run.argv,
      ...(run.checkoutPath ? { checkoutAdmission: () => this.admitCheckout(run) } : {}),
      timeoutMs: run.runTimeoutMs ?? DEFAULT_PROJECT_QA_TIMEOUT_MS,
      maxOutputBytes: run.maxOutputBytes ?? DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES,
      terminationGraceMs: run.terminationGraceMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS,
      epoch: run.hostRunEpoch ?? 1, runClass: run.runClass ?? "heavy", hostRunStateDir: this.hostRunStateDir(),
      links: [], stages: this.stagesForRun(run),
      ...(temporaryDirectory ? { temporaryDirectory } : {}),
    };
    const current = this.store.qaRun(run.id) ?? run;
    const running = this.store.putQaRun({ ...current, state: "running", pid: null, finishedAt: null,
      teardownRetryAttempt: (current.teardownRetryAttempt ?? 0) + 1 });
    const outcome = await runQaTeardownRetry({ pid: process.pid, identityToken }, runParams,
      this.inProcessIo(runParams, identityToken),
      { command, priorSteps: run.steps, qaExitCode, priorCancelReason: run.cancelReason, reason, cleanupOnly, priorFailedStep: run.failedStep });
    return this.applyTeardownRetry(this.store.qaRun(run.id) ?? running, {
      state: outcome.state, exitCode: outcome.exitCode, detail: outcome.detail, finishedAt: outcome.finishedAt,
      steps: outcome.steps, failedStep: outcome.failedStep, escapedDescendants: outcome.escapedDescendants,
      logWriteErrors: outcome.logWriteErrors, checkoutCleanupPending: outcome.checkoutCleanupPending });
  }

}
