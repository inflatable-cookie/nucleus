/**
 * Milestone QA runs (task 104): a repository's full QA on current `main` on request.
 *
 * Full QA no longer runs per task. The operator or a planner asks Queue to run a
 * repository's full QA on the current integration head at a milestone and sees the
 * result on the board. Per-task validation commands stay off by default (null);
 * this action runs the repository's `qa` setting, falling back to `effigy qa`.
 *
 * Each run happens in a Queue-owned linked worktree of the repository's
 * registered checkout, exactly as a Paseo task worktree is: its `.git`
 * resolves to the registered repository's common directory, so repository
 * setup that derives its primary checkout from the worktree's Git pointer sees
 * the same primary a task worktree sees. Live Queue places new worktrees on
 * the checkout volume; private stores keep them under their data directory. The registered
 * working tree is neither switched nor written.
 * Queue prepares the relative sibling layout before setup. It runs the
 * repository's Paseo worktree setup and teardown without using task worktrees.
 * Queue schedules each run against its host budget; launched commands still
 * take one Effigy lease, and the host-run journal records class, capacity,
 * process identity, duration and settlement.
 * They grant no merge authority and gate no task.
 *
 * Since task 114 the pipeline itself runs in a detached supervisor process
 * that outlives the service, so a Queue roll mid-run neither loses the run nor
 * the steps it had recorded.
 *
 * This module is the runner's public surface and its composition: which owner
 * answers each question. Each mechanism below has exactly one owner module —
 * placement (`project-qa-placement`), admission and request identity
 * (`project-qa-admission`), the scheduler envelope (`project-qa-scheduler`),
 * supervisor handoff (`project-qa-launch`), observation and re-attachment
 * (`project-qa-reconcile`), lost-run recovery (`project-qa-recovery`),
 * settlement (`project-qa-settle`), teardown retry
 * (`project-qa-teardown-retry`) and retention (`project-qa-retention`).
 * The members marked internal below are that assembly surface: the owners call
 * them through this instance so a subclass — or a fixture — still sees its own
 * override.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { repositoryOrigin } from "../planning/lanes";
import { HostRunScheduler } from "../host-runs/host-run-scheduler";
import type { ProjectQaRun } from "../../shared/contracts";
import type {
  HostRunEscapedDescendant, HostRunInternalRecord, HostRunResult, ProjectQaLogWriteError, ProjectQaRunInput,
  ProjectQaStep, ProjectQaStepName,
} from "../../shared/contracts";
import { now, type Store } from "../store/store";
import { gitText, type ConfiguredCheckout } from "../workspaces/worktree-links";
import { queueGitFetch } from "../git/git-fetch";
import { withSpawnSlot } from "../dispatch/spawn-gate";
import { qaCallerIdentity as canonicalQaCallerIdentity } from "./qa-caller";
import { ProjectQaInspection, projectQaRunReads, type SupervisorInspection } from "./project-qa-inspection";
import { projectQaEscapees } from "./project-qa-escapees";
import { qaSupervisionPaths, writeQaCancelRequest, type QaSupervisionPlan, type QaSupervisionState } from "./project-qa-supervision-files";
import type { QaPipelineOutcome } from "./project-qa-pipeline";
import { ProjectQaRetention } from "./project-qa-retention";
import { qaLaunchGates } from "./project-qa-gates";
import { projectQaPlacement } from "./project-qa-placement";
import { projectQaAdmission } from "./project-qa-admission";
import { projectQaScheduler } from "./project-qa-scheduler";
import { projectQaLaunch } from "./project-qa-launch";
import { projectQaReconcile } from "./project-qa-reconcile";
import { projectQaRecovery } from "./project-qa-recovery";
import { projectQaSettlement } from "./project-qa-settle";
import { projectQaTeardownRetry } from "./project-qa-teardown-retry";
import type { ProjectQaLaunch, ProjectQaOptions } from "./project-qa-context";

export * from "./project-qa-defaults";
export type { ProjectQaLaunch, ProjectQaOptions, ResolvedRepository } from "./project-qa-context";

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" };

export class ProjectQaRunner {
  readonly hostRuns: HostRunScheduler;
  /** Internal to the QA owners: the checkout/file retention sweep. */
  readonly retention: ProjectQaRetention;
  constructor(readonly store: Store, readonly options: ProjectQaOptions = {}) {
    this.hostRuns = options.hostRuns ?? HostRunScheduler.forStore(store);
    this.retention = new ProjectQaRetention(this);
  }

  /** The owner identity this runner writes on its requests: the writer lease when the runtime supplies it. */
  get ownerInstance(): string { return this.options.ownerInstance ?? QA_REQUEST_OWNER_INSTANCE; }

  /** Internal to the QA owners: the store's isolation data directory. */
  isolationDataDir(): string { return projectQaPlacement.isolationDataDir(this); }
  /** Internal to the QA owners: where host-run journals live. */
  hostRunStateDir(): string { return projectQaPlacement.hostRunStateDir(this); }
  /** Internal to the QA owners: the placement a checkout and scratch leaf are proved against. */
  qaPlacement() { return projectQaPlacement.qaPlacement(this); }
  /** Internal to the QA owners: the layout the detached supervisor derives too. */
  qaRepositoryRootPath(key: string): string { return projectQaPlacement.qaRepositoryRootPath(this, key); }
  /** Internal to the QA owners: the recorded external checkout, or the one this run would allocate. */
  checkoutForRun(run: ProjectQaRun): string { return projectQaPlacement.checkoutForRun(this, run); }
  /** Internal to the QA owners: prove a recorded checkout is exactly this run's own allocation. */
  admitCheckout(run: ProjectQaRun): void { projectQaPlacement.admitCheckout(this, run); }
  /** Internal to the QA owners: create or re-prove the run's temporary leaf. */
  ensureRunScratch(run: ProjectQaRun): string | undefined { return projectQaPlacement.ensureRunScratch(this, run); }
  /** Internal to the QA owners: remove the run's temporary leaf once nothing owns it. */
  releaseRunScratch(run: ProjectQaRun, checkoutRetained: boolean): void { projectQaPlacement.releaseRunScratch(this, run, checkoutRetained); }

  /**
   * Caller identity for one Queue-owned milestone host run. The canonical string
   * lives in `qa-caller` so the retained-output sweep can verify this producer's
   * ownership from durable records instead of trusting a prefix (task 444).
   */
  qaCallerIdentity(key: string, runId: string): string { return canonicalQaCallerIdentity(key, runId); }

  /** Resolve a repository name (absolute checkout path or `owner/name` origin) to its one-run key and a local checkout to fetch from. */
  async resolveRepository(input: string, baseBranch: string): Promise<import("./project-qa-context").ResolvedRepository> {
    void baseBranch;
    if (isAbsolute(input)) {
      const real = await realpath(input).catch(() => null);
      if (!real || !existsSync(real)) throw new Error(`Project QA repository path does not exist: ${input}`);
      const origin = await repositoryOrigin(real).catch(() => null);
      return { key: origin ?? real, origin, path: real, checkoutPath: real };
    }
    const origin = normalizeRepositoryOrigin(input);
    if (!origin) throw new Error("Repository must be an absolute checkout path or a normalised owner/name origin");
    const row = this.store.repositoryFor(origin);
    const hinted = row?.repository.path || this.store.projects().flatMap(project => project.repositories).find(repo => repo.origin === origin)?.path || "";
    if (hinted && existsSync(hinted)) {
      const real = await realpath(hinted).catch(() => hinted);
      return { key: origin, origin, path: real, checkoutPath: real };
    }
    // Fall back to any known checkout whose remote reports this origin.
    for (const project of this.store.projects()) {
      for (const repo of project.repositories) {
        if (!repo.path || !existsSync(repo.path)) continue;
        const seen = await repositoryOrigin(repo.path).catch(() => null);
        if (seen === origin) {
          const real = await realpath(repo.path).catch(() => repo.path);
          return { key: origin, origin, path: real, checkoutPath: real };
        }
      }
    }
    throw new Error(`Project QA has no local checkout for ${origin}: set the repository path with repository.set first`);
  }

  /** Read one recorded run by ID or the latest run for a repository. */
  get(input: { id: string } | { repository: string }): Promise<ProjectQaRun | null> {
    return projectQaRunReads.get.call(this, input);
  }

  /**
   * Latest run per repository, re-attaching to or healing running rows so the
   * board never shows a stuck run. Retention is not read-path work: the service's
   * hourly retention pass calls `sweepRetention`.
   */
  async list(): Promise<ProjectQaRun[]> {
    this.settleInterruptedPreparations();
    // QA history outlives host-run accounting, so it remains the sweep source
    // for escaped descendants even after the host-run row is pruned.
    for (const run of this.store.qaRunsAwaitingEscapedDescendants()) this.watchEscapedDescendants(run.id);
    for (const run of this.store.latestQaRuns()) {
      if (run.state === "queued") { this.attachQueued(run); continue; }
      if (run.state === "running") await this.reconcile(run.key, run.id).catch(() => { /* reconciliation is best-effort on reads */ });
    }
    return this.store.latestQaRuns();
  }

  /** Settle requests a predecessor writer left preparing; only the writer lease holder may do this. */
  settleInterruptedPreparations(): number { return projectQaAdmission.settleInterruptedPreparations.call(this); }
  /** One page of request and run records for the board's request-status read. */
  requestStatus(input: { requestId: string } | { repository: string; since: string; expectedHead: string }) {
    return projectQaAdmission.requestStatus.call(this, input);
  }
  /** Start a milestone QA run, or return the running one when a second request arrives. */
  run(input: ProjectQaRunInput | { repository: string; baseBranch?: string; requestId?: string; expectedHead?: string; wait?: boolean },
    admissionGuard?: (proposed: ProjectQaRun, selected: ProjectQaRun) => void): Promise<ProjectQaRun> {
    return projectQaAdmission.run.call(this, input, admissionGuard);
  }
  /** Internal to the QA owners: write the request identity, then admit it. */
  requestRun(input: ProjectQaRunInput, admissionGuard?: (proposed: ProjectQaRun, selected: ProjectQaRun) => void): Promise<ProjectQaRun> {
    return projectQaAdmission.requestRun.call(this, input, admissionGuard);
  }
  /** Internal to the QA owners: claim one admission in a single transaction. */
  admitRequest(input: ProjectQaRunInput, request: import("../../shared/contracts").ProjectQaRequest,
    admissionGuard?: (proposed: ProjectQaRun, selected: ProjectQaRun) => void): Promise<ProjectQaRun> {
    return projectQaAdmission.admitRequest.call(this, input, request, admissionGuard);
  }
  /** Re-attach to or heal one running row this process is not driving. */
  reconcile(key: string, requestedId?: string): Promise<void> {
    return projectQaReconcile.reconcile.call(this, key, requestedId);
  }

  /** Internal to the QA owners: apply one durable result to the record and the host-run envelope. */
  settle(run: ProjectQaRun, outcome: QaPipelineOutcome & { interruptedStep: ProjectQaStepName | null }): Promise<ProjectQaRun> {
    return projectQaSettlement.settle.call(this, run, outcome);
  }
  /** Internal to the QA owners: apply a settled supervisor's result. */
  settleFromSupervisor(run: ProjectQaRun, state: QaSupervisionState | null, hostResult: HostRunResult | null, closeInterrupted?: boolean): Promise<ProjectQaRun> {
    return projectQaSettlement.settleFromSupervisor.call(this, run, state, hostResult, closeInterrupted);
  }
  /** Internal to the QA owners: settle a launch that never reached a supervisor step. */
  settleLaunchFailure(runId: string, error: unknown): Promise<ProjectQaRun | null> {
    return projectQaSettlement.settleLaunchFailure.call(this, runId, error);
  }
  /** Internal to the QA owners: tell the planner and submitter that the run settled. */
  notifySettled(saved: ProjectQaRun): Promise<ProjectQaRun> { return projectQaSettlement.notifySettled.call(this, saved); }
  /** Internal to the QA owners: prove a retained checkout is exactly this run's own. */
  retainedCheckoutIdentity(run: ProjectQaRun, checkoutPath: string): Promise<void> {
    return projectQaRecovery.retainedCheckoutIdentity.call(this, run, checkoutPath);
  }
  /** Internal to the QA owners: publish the running command's process identity. */
  publishCommandLaunchIdentity(run: ProjectQaRun, state: QaSupervisionState | null, hostResult: HostRunResult | null): void {
    projectQaReconcile.publishCommandLaunchIdentity.call(this, run, state, hostResult);
  }
  /** Internal to the QA owners: show a running supervisor's settled steps on the record. */
  mirrorSupervisorProgress(run: ProjectQaRun, state: QaSupervisionState): void {
    projectQaReconcile.mirrorSupervisorProgress.call(this, run, state);
  }
  /** Internal to the QA owners: attach to a live supervisor and wait for it to settle. */
  attachSupervisor(runId: string, key: string, unstartedResumes = 0): Promise<ProjectQaRun> {
    return projectQaReconcile.attachSupervisor.call(this, runId, key, unstartedResumes);
  }
  /** Internal to the QA owners: poll one run's supervision file until it settles. */
  watchSupervisor(runId: string, key: string, unstartedResumes = 0): Promise<void> {
    return projectQaReconcile.watchSupervisor.call(this, runId, key, unstartedResumes);
  }
  /** Internal to the QA owners: settle a run whose supervisor is proven dead. */
  reconcileLostRun(run: ProjectQaRun, state: QaSupervisionState | null, reason: string, escapedDescendants: HostRunEscapedDescendant[] = []): Promise<void> {
    return projectQaRecovery.reconcileLostRun.call(this, run, state, reason, escapedDescendants);
  }
  /** Internal to the QA owners: settle a run whose step's group ended and whose supervisor never settled. */
  settleEndedStep(run: ProjectQaRun, inspection: Extract<SupervisorInspection, { kind: "step_ended" }>): Promise<void> {
    return projectQaRecovery.settleEndedStep.call(this, run, inspection);
  }
  /** Internal to the QA owners: teardown, checkout release and settlement for an abandoned run. */
  settleAbandoned(run: ProjectQaRun, state: QaSupervisionState | null,
    settlement: import("./project-qa-recovery").QaAbandonedSettlement, escapedDescendants: HostRunEscapedDescendant[] = []): Promise<void> {
    return projectQaRecovery.settleAbandoned.call(this, run, state, settlement, escapedDescendants);
  }
  /** Internal to the QA owners: keep an output pointer on the settled record. */
  appendSettledOutputPointer(run: ProjectQaRun, output: string): Promise<void> {
    return projectQaRecovery.appendSettledOutputPointer.call(this, run, output);
  }
  /** Internal to the QA owners: true while any recorded supervisor for the run is still alive. */
  liveSupervisorFor(run: ProjectQaRun): boolean { return projectQaRecovery.liveSupervisorFor.call(this, run); }
  /** Internal to the QA owners: re-attach to an escaped-descendant watcher. */
  watchEscapedDescendants(runId: string): void { projectQaEscapees.watchEscapedDescendants.call(this, runId); }
  /** Internal to the QA owners: read a run's supervisor evidence. */
  inspectSupervisor(run: ProjectQaRun): Promise<SupervisorInspection> { return this.inspection.inspectSupervisor(run); }

  /** Internal to the QA owners: hand a claimed run to the scheduler and its detached supervisor. */
  submitToHostScheduler(run: ProjectQaRun, launch: ProjectQaLaunch): void { projectQaScheduler.submitToHostScheduler.call(this, run, launch); }
  handlerFor(run: ProjectQaRun, launch: ProjectQaLaunch) { return projectQaScheduler.handlerFor.call(this, run, launch); }
  /** Internal to the QA owners: re-attach or resubmit a queued row. */
  attachQueued(run: ProjectQaRun): void { projectQaScheduler.attachQueued.call(this, run); }
  /** Internal to the QA owners: record the scheduler's launch as the run's start. */
  markLaunched(launch: ProjectQaLaunch): ProjectQaLaunch | null { return projectQaScheduler.markLaunched.call(this, launch); }
  /** Internal to the QA owners: the ordered stages a stored run executes. */
  stagesForRun(run: ProjectQaRun) { return projectQaScheduler.stagesForRun(run); }
  /** Internal to the QA owners: apply a scheduler settlement reached before any step. */
  onSchedulerTerminal(id: string, hostRun: HostRunInternalRecord): Promise<void> { return projectQaScheduler.onSchedulerTerminal.call(this, id, hostRun); }
  /** Internal to the QA owners: the detached supervisor entry shipped beside the service. */
  supervisorEntry(): string { return projectQaLaunch.supervisorEntry.call(this); }
  /** Internal to the QA owners: Queue-configured checkouts a sibling source may resolve through. */
  configuredCheckouts(): ConfiguredCheckout[] { return projectQaLaunch.configuredCheckouts.call(this); }
  /** Internal to the QA owners: spawn the detached supervisor for one plan. */
  spawnQaSupervisor(planPath: string, identityToken: string, temporaryDirectory?: string): number {
    return projectQaLaunch.spawnQaSupervisor.call(this, planPath, identityToken, temporaryDirectory);
  }
  /** Internal to the QA owners: the worktree hooks at the run's exact integration head. */
  worktreeHooksAt(repositoryPath: string, ref: string) { return projectQaLaunch.worktreeHooksAt.call(this, repositoryPath, ref); }
  /** Internal to the QA owners: resolve the sibling links the checkout needs. */
  resolveQaLinks(resolved: import("./project-qa-context").ResolvedRepository, setup: string | null) { return projectQaLaunch.resolveQaLinks.call(this, resolved, setup); }
  /** Internal to the QA owners: run one worktree hook through the shared executor. */
  runWorktreeHook(root: string, script: string, terminationGraceMs?: number,
    options?: { env?: Record<string, string>; identityToken?: string; onSpawn?: (pid: number, processGroupId?: number, leaderStartIdentity?: string, startIdentity?: string) => void; cancelReason?: () => string | null }) {
    return projectQaLaunch.runWorktreeHook.call(this, root, script, terminationGraceMs, options);
  }
  /** Internal to the QA owners: settle a run cancelled before its supervisor started. */
  settleBeforeLaunch(runId: string, reason: string): Promise<ProjectQaRun> { return projectQaLaunch.settleBeforeLaunch.call(this, runId, reason); }
  /** Internal to the QA owners: hand one claimed run to its detached supervisor. */
  startSupervised(launch: ProjectQaLaunch): Promise<ProjectQaRun> { return projectQaLaunch.startSupervised.call(this, launch); }
  /** Internal to the QA owners: resume the admission of a supervisor that never began. */
  resumeUnstartedSupervisor(run: ProjectQaRun, plan: QaSupervisionPlan): Promise<void> {
    return projectQaReconcile.resumeUnstartedSupervisor.call(this, run, plan);
  }
  /** Internal to the QA owners: note a checkout that is not yet reconcilable. */
  noteCheckoutWait(run: ProjectQaRun, error: unknown): void { projectQaReconcile.noteCheckoutWait.call(this, run, error); }

  /** Internal to the QA owners: apply one teardown retry attempt to the record. */
  applyTeardownRetry(run: ProjectQaRun, outcome: {
    state: ProjectQaRun["state"]; exitCode: number | null; detail: string; finishedAt: string;
    steps: ProjectQaStep[]; failedStep: ProjectQaStepName | null; escapedDescendants: HostRunEscapedDescendant[];
    logWriteErrors?: ProjectQaLogWriteError[];
    checkoutCleanupPending?: boolean;
  }): ProjectQaRun { return projectQaTeardownRetry.applyTeardownRetry.call(this, run, outcome); }
  /** Internal to the QA owners: apply a settled teardown retry supervisor's result. */
  settleTeardownRetry(run: ProjectQaRun, state: QaSupervisionState | null): ProjectQaRun {
    return projectQaTeardownRetry.settleTeardownRetry.call(this, run, state);
  }
  /** Internal to the QA owners: spawn the detached supervisor for one teardown retry. */
  startTeardownRetry(run: ProjectQaRun, command: string, qaExitCode: number | null, reason: string, cleanupOnly: boolean): Promise<ProjectQaRun> {
    return projectQaTeardownRetry.startTeardownRetry.call(this, run, command, qaExitCode, reason, cleanupOnly);
  }
  /** Task 134: rerun only a settled run's failed teardown. */
  retryTeardown(input: { id: string; reason: string }): Promise<ProjectQaRun> {
    return projectQaTeardownRetry.retryTeardown.call(this, input);
  }

  /**
   * Tom, 2026-11-01: a board operator dismisses a finished run that is not passing. The record stays
   * and records who dismissed it and why; a live run is cancelled instead and a passing run fades.
   */
  dismiss(input: { id: string; reason: string; caller: string }): ProjectQaRun {
    const reason = input.reason.trim(), caller = input.caller.trim();
    if (!input.id.trim() || !reason || !caller) throw new Error("Project QA dismiss requires a run id, reason and caller");
    const run = this.store.qaRun(input.id);
    if (!run) throw new Error(`Project QA run not found: ${input.id}`);
    if (run.state === "queued" || run.state === "running") throw new Error("A queued or running milestone QA run is cancelled, not dismissed");
    if (run.state === "passed") throw new Error("A passed milestone QA run leaves the board on its own; nothing to dismiss");
    if (run.dismissal) return run;
    return this.store.putQaRun({ ...run, dismissal: { at: now(), by: caller, reason } });
  }

  /** Request a durable, idempotent cancellation; the detached supervisor owns stopping and teardown. */
  async cancel(input: { id: string; reason: string }): Promise<ProjectQaRun> {
    const reason = input.reason.trim();
    if (!input.id.trim() || !reason) throw new Error("Project QA cancel requires a run id and reason");
    const run = this.store.qaRun(input.id);
    if (!run) throw new Error(`Project QA run not found: ${input.id}`);
    if (run.state !== "running" && run.state !== "queued") return run;
    if ((run.teardownRetryAttempt ?? 0) > 0) throw new Error("A milestone QA teardown retry is not cancelable");
    const scheduled = this.hostRuns.get(run.id);
    if (scheduled && (scheduled.state === "queued" || scheduled.state === "admitted")) {
      const launchInFlight = qaLaunchGates.has(run.key);
      if (run.cancelReason !== reason) this.store.putQaRun({ ...run, cancelReason: reason });
      const cancelled = this.hostRuns.cancelQueued(run.id, reason, scheduled.epoch);
      if (launchInFlight) await this.writeCancelRequest(run, reason);
      await this.onSchedulerTerminal(run.id, cancelled);
      return this.store.qaRun(run.id)!;
    }
    if (run.state !== "running") return run;
    if (scheduled) this.hostRuns.cancelQueued(run.id, reason, scheduled.epoch); // journal the request before the stop side effect
    await this.reconcile(run.key, run.id);
    const current = this.store.qaRun(run.id);
    if (!current || current.state !== "running") return current ?? run;
    const request = await this.writeCancelRequest(current, reason);
    if (current.cancelReason !== request.reason) this.store.putQaRun({ ...current, cancelReason: request.reason });
    return this.store.qaRun(current.id)!;
  }

  /** One durable cancel request file for the detached supervisor to observe. */
  private async writeCancelRequest(run: ProjectQaRun, reason: string) {
    const runRoot = this.qaRepositoryRootPath(run.key);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const { cancelPath } = qaSupervisionPaths(runRoot, run.id);
    return writeQaCancelRequest(cancelPath, { runId: run.id, reason, requestedAt: now() });
  }

  /** Fetch `origin` and read the current integration head. The registered checkout is never written. */
  async integrationHead(checkoutPath: string, baseBranch: string): Promise<string> {
    const timeoutMs = this.options.fetchTimeoutMs ?? 60_000;
    const commonGitDir = await realpath(await gitText(checkoutPath, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    try {
      await queueGitFetch(commonGitDir, () => withSpawnSlot(async () => {
        const { spawn } = await import("node:child_process");
        return new Promise<{ code: number; stderr: string }>((resolvePromise, reject) => {
          const child = spawn("git", ["fetch", "origin"], { cwd: checkoutPath, env: { ...process.env, ...GIT_ENV } });
          let stderr = "";
          const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("git fetch origin timed out")); }, timeoutMs);
          child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
          child.on("error", error => { clearTimeout(timer); reject(error); });
          child.on("close", code => {
            clearTimeout(timer);
            const result = { code: code ?? -1, stderr };
            if (result.code !== 0) reject(new Error(result.stderr.trim() || `exit ${result.code}`));
            else resolvePromise(result);
          });
        });
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "git fetch origin timed out") throw error;
      throw new Error(`Project QA could not fetch the integration head: ${error instanceof Error ? error.message : String(error)}`);
    }
    try { return await gitText(checkoutPath, "rev-parse", `origin/${baseBranch}`); }
    catch { throw new Error(`Project QA could not read origin/${baseBranch} after fetch`); }
  }

  /** Remove settled checkouts and expire per-run files; the service's hourly retention pass calls this. */
  sweepRetention(): Promise<void> { return this.retention.sweep(); }
  /** Same sweep under its historical name, for a caller that wants it on demand. */
  pruneSettledCheckouts(): Promise<void> { return this.retention.sweep(); }

  private readonly inspection = new ProjectQaInspection({ get: id => this.hostRuns.get(id) }, key => this.qaRepositoryRootPath(key), this.store);
}

const QA_REQUEST_OWNER_INSTANCE = randomUUID();
