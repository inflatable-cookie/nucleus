import type { ProspectiveMerge } from "../merge/prospective-merge";
import { discoverManifest } from "../hooks/hook-manifest";
import { verifyMergeCandidate } from "../git/git-snapshot";
import { FileFacts } from "../machine/file-facts";
import { runtimeNodeArgs } from "../../shared/runtime.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestSupportsCloseoutSelection } from "../../shared/hooks";
import { DEFAULT_PROCESS_TERMINATION_GRACE_MS, hostRunSettlementSchema, isDispositionActive, type HostRunSettlement, type ProjectValidation, type ProjectValidationSchedulerTelemetry, type Task } from "../../shared/contracts";
import { Store, digest, now } from "../store/store";
import { currentServiceBuildId } from "../../shared/service/build";
import { repositoryOrigin } from "../planning/lanes";
import { qaCapacityWaitReason } from "../../shared/wait-state";
import { HOST_RUN_CAPACITY_DEADLINE_MS, HostRunScheduler, classifyHostRun, selectorForArgv } from "../host-runs/host-run-scheduler";
import type { HostRunHandler } from "../host-runs/host-run-scheduler";
import { HOST_RUN_TOKEN_GRACE_MS } from "../host-runs/host-run-endpoint-types";
import { issueHostRunToken } from "../host-runs/host-run-token";
import { processGroupEmpty, processStartIdentityLiveness, processesForStartIdentity, signalProcessGroup, signalProcessGroupByLeader } from "../machine/process-group";
import { SupervisorLivenessReader } from "../machine/supervisor-liveness";
import { findProcessByCommandTokenAsync, pidAlive, processCommandLine } from "../machine/process-identity";
import { projectValidationSupervisorPaths, readProjectValidationCancellation, readProjectValidationCpuCoverage, readProjectValidationPlan, readProjectValidationResult, readProjectValidationSupervisorState, writeProjectValidationCancellation, writeProjectValidationPlan, type ProjectValidationSupervisorPlan, type ProjectValidationSupervisorResult } from "./project-validation-supervisor";
import { projectValidationCallerIdentity, projectValidationSchedulerEvidence } from "./project-validation-caller";
import { boundSidecarCoverage } from "../host-runs/host-run-cpu-coverage";
import { confirmStaleSupervisorHeartbeat, SUPERVISOR_STUCK_CONFIRMATION_MS } from "../machine/supervisor-watchdog";
import { HookObservationMap, type RepositoryHooksOptions, type ProjectValidationOutcome } from "../hooks/hook-context";
type ProjectValidationObservation =
  | { kind: "result"; result: ProjectValidationSupervisorResult }
  | { kind: "lost"; detail: string }
  | { kind: "uncertain"; detail: string };
type ProjectValidationCompletion = ProjectValidationObservation
  | { kind: "prelaunch"; detail: string };

interface ProjectValidationRunnerContext {
  store: Pick<Store, "canonicalRepository" | "event" | "task" | "update">;
  options: Pick<RepositoryHooksOptions, "queueBuild" | "wakeTask" | "hostRunStateDir" | "validationPollMs" | "validationSupervisorEntry">;
  hostRunScheduler: () => HostRunScheduler;
  isolationDataDir: () => string;
  integrationBase: (task: Task) => Promise<string>;
  prospectiveCandidatePath: ProspectiveMerge["prospectiveCandidatePath"];
  buildProspectiveCandidate: ProspectiveMerge["buildProspectiveCandidate"];
  removeIsolatedCheckout: (task: Task, path: string, force: boolean) => Promise<void>;
}

export class ProjectValidationRunner {
  constructor(private readonly context: ProjectValidationRunnerContext) {}
  private get store() { return this.context.store; }
  private get options() { return this.context.options; }
  private get hostRunScheduler() { return this.context.hostRunScheduler(); }
  private get isolationDataDir() { return this.context.isolationDataDir; }
  private get integrationBase() { return this.context.integrationBase; }
  private get prospectiveCandidatePath() { return this.context.prospectiveCandidatePath; }
  private get buildProspectiveCandidate() { return this.context.buildProspectiveCandidate; }
  private get removeIsolatedCheckout() { return this.context.removeIsolatedCheckout; }
  private readonly staleSupervisorObservations = new HookObservationMap<{ heartbeatAt: string; firstObservedAt: number }>();

  /** One in-flight background project-validation run per task in this process. */
  private readonly projectValidationRuns = new Map<string, Promise<void>>();

  // A background gate can decide before it records a run (a merge conflict, a candidate
  // that cannot be built, a missing base). Its outcome is kept here for the next pass;
  // dropping it relaunched the same doomed candidate every few seconds with nothing
  // on the task (project-k #55, 2026-09-29: a conflict looped for 2.5 hours).
  private readonly projectValidationDecided = new HookObservationMap<{ key: string; outcome: ProjectValidationOutcome }>();

  /** Retry disposable candidate cleanup without changing an already durable verdict. */
  private async retryCandidateCleanup(task: Task, validation: NonNullable<Task["resolution"]["projectValidation"]>, knownPath?: string): Promise<void> {
    const candidate = validation.candidate;
    const legacySettledVerdict = validation.state === "passed" || validation.state === "refused";
    if (!candidate || !validation.candidateCleanupPending && !legacySettledVerdict) return;
    const report = (error: unknown) => {
      try { this.store.event(task.id, "project_validation_candidate_cleanup_deferred", String(error).slice(0, 2000)); }
      catch { /* Cleanup diagnostics never replace the durable validation result. */ }
    };
    try {
      let currentTask = this.store.task(task.id);
      let current = currentTask.resolution.projectValidation;
      if (!current || current.state === "running" || current.hostRunId !== validation.hostRunId || current.digest !== validation.digest) return;
      if (current.candidateCleanupPending !== true) {
        current = { ...current, candidateCleanupPending: true };
        this.store.update(task.id, { resolution: { ...currentTask.resolution, projectValidation: current } },
          "project_validation_candidate_cleanup_pending", current.digest);
      }
      const path = knownPath ?? await this.prospectiveCandidatePath(task, candidate);
      await this.removeIsolatedCheckout(task, path, true);
      currentTask = this.store.task(task.id);
      current = currentTask.resolution.projectValidation;
      if (!current || current.hostRunId !== validation.hostRunId || current.digest !== validation.digest || current.candidateCleanupPending !== true) return;
      this.store.update(task.id, { resolution: { ...currentTask.resolution,
        projectValidation: { ...current, candidateCleanupPending: false } } },
      "project_validation_candidate_cleanup_complete", current.digest);
    } catch (error) { report(error); }
  }

  /**
   * Start project validation off the delivery lanes (Spec 012).
   *
   * The prospective-merge quantum resolves the cheap verdicts - no v5 manifest,
   * a settled result reused by key, an uncertain run - and then hands the
   * program to a background execution, so a ten-minute fresh-checkout CI can
   * never hold a lane slot. Every delivery rule stays in `projectValidationGate`:
    * intent before spawn, the recorded process-group identity, one run per candidate and the stored
   * result. The detached supervisor records its result before Queue reconciles
   * it, so a service roll cannot lose a completed verdict or retry a lost run.
   */
  async startProjectValidation(task: Task, head: string, validation: ProjectValidation): Promise<ProjectValidationOutcome> {
    const argvDigest = digest(JSON.stringify(validation.argv));
    let base: string;
    try { base = await this.integrationBase(task); }
    catch (error) { return { kind: "hold", detail: `Project validation needs a clean synchronized base: ${String(error)}` }; }
    const discovery = await discoverManifest(task.repoPath, base);
    if (discovery && !manifestSupportsCloseoutSelection(discovery.manifest.schema)) return { kind: "none" };
    // One run per task in this process, even across repeated quanta.
    if (this.projectValidationRuns.has(task.id)) return { kind: "deferred" };
    const key = `${base} ${head} ${argvDigest}`;
    let prior = this.store.task(task.id).resolution.projectValidation;
    if (prior) {
      await this.retryCandidateCleanup(task, prior);
      prior = this.store.task(task.id).resolution.projectValidation;
    }
    const priorHostRun = prior?.hostRunId ? this.hostRunScheduler.get(prior.hostRunId) : null;
    const canReattachQueued = priorHostRun?.state === "queued" || priorHostRun?.state === "admitted";
    const decided = this.projectValidationDecided.get(task.id);
    this.projectValidationDecided.delete(task.id);
    if (prior?.state !== "running" && decided?.key === key) return decided.outcome;
    const queueBuild = this.queueBuild();
    const settingsRevision = this.store.canonicalRepository(task.repoPath, task.repository)?.revision ?? 0;
    if (prior?.base === base && prior.head === head && prior.digest === argvDigest
        && prior.queueBuild === queueBuild && prior.settingsRevision === settingsRevision) {
      if (prior.state === "passed") return { kind: "ok", base };
      if (prior.state === "refused") return { kind: "refused", detail: prior.outputTail };
      if (prior.state === "hold") return { kind: "hold", detail: prior.outputTail };
    }
    const chain = (async () => {
      try {
        const outcome = await this.projectValidationGate(this.store.task(task.id), head, validation);
        if (this.store.task(task.id).resolution.projectValidation?.state !== "running")
          this.projectValidationDecided.set(task.id, { key, outcome });
      }
      catch { /* the gate records its own fault on the task; the audit sweep recovers a lost wake */ }
      finally {
        this.projectValidationRuns.delete(task.id);
        try { this.options.wakeTask?.(task.id); } catch { /* a stopped engine has no quantum to wake */ }
      }
    })();
    this.projectValidationRuns.set(task.id, chain);
    return { kind: "deferred" };
  }

  private spawnValidationSupervisor(planPath: string, identityToken: string): number {
    const entry = this.options.validationSupervisorEntry ?? fileURLToPath(new URL("../../bin/queue-validation-supervisor.mjs", import.meta.url));
    const sourcePath = fileURLToPath(new URL("../..", import.meta.url));
    const child = spawn(process.execPath, [...runtimeNodeArgs(), entry, planPath, identityToken], {
      detached: true, stdio: "ignore", env: { ...process.env }, cwd: sourcePath,
    });
    child.on("error", () => { /* No result means reconciliation holds the run; it never relaunches blindly. */ });
    child.unref();
    if (!child.pid) throw new Error("Nucleus could not start the detached project-validation supervisor");
    return child.pid;
  }

  private recordValidationProcess(taskId: string, hostRunId: string, active: NonNullable<ReturnType<typeof readProjectValidationSupervisorState>>["activeProcess"]): void {
    if (!active) return;
    const scheduled = this.hostRunScheduler.get(hostRunId);
    if (scheduled?.state === "running" && (scheduled.pid !== active.pid || scheduled.processGroupId !== active.processGroupId || scheduled.startIdentity !== active.startIdentity)) {
      try { this.hostRunScheduler.updateProcess(hostRunId, { pid: active.pid, processGroupId: active.processGroupId, startIdentity: active.startIdentity }); }
      catch { /* A superseded authority cannot update this run. */ }
    }
    const task = this.store.task(taskId);
    const validation = task.resolution.projectValidation;
    if (!validation || validation.hostRunId !== hostRunId || validation.state !== "running") return;
    if (validation.pid === active.pid && validation.processGroupId === active.processGroupId && validation.leaderStartIdentity === active.leaderStartIdentity) return;
    this.store.update(taskId, { resolution: { ...task.resolution, projectValidation: { ...validation,
      pid: active.pid, processGroupId: active.processGroupId, leaderStartIdentity: active.leaderStartIdentity } } },
    "project_validation_spawned", String(active.pid));
  }

  private readonly supervisorLiveness = new SupervisorLivenessReader();

  private readonly validationStateFacts = new FileFacts(readProjectValidationSupervisorState);

  private async observeValidationSupervisor(taskId: string, hostRunId: string, plan: ProjectValidationSupervisorPlan): Promise<ProjectValidationObservation> {
    const paths = projectValidationSupervisorPaths(this.isolationDataDir(), hostRunId);
    const pollMs = Math.max(25, this.options.validationPollMs ?? 250);
    let recheckedPublication = false;
    let staleHeartbeatEvidence = "";
    const stopStaleSupervisor = async (state: NonNullable<ReturnType<typeof readProjectValidationSupervisorState>>): Promise<boolean> => {
      const staleAgeMs = confirmStaleSupervisorHeartbeat(this.staleSupervisorObservations, hostRunId, state.heartbeatAt);
      if (staleAgeMs === null) return false;
      staleHeartbeatEvidence = `heartbeat was stale for ${staleAgeMs}ms and unchanged across checks ${SUPERVISOR_STUCK_CONFIRMATION_MS}ms apart`;
      const signalSupervisor = (signal: NodeJS.Signals): void => {
        if (state.supervisorStartIdentity)
          signalProcessGroupByLeader(state.supervisorPid, state.supervisorPid, state.supervisorStartIdentity, signal);
        if (!pidAlive(state.supervisorPid) || !processCommandLine(state.supervisorPid)?.includes(plan.identityToken)) return;
        try { process.kill(state.supervisorPid, signal); } catch { /* the verified supervisor exited */ }
      };
      const signalActiveGroup = (signal: NodeJS.Signals): void => {
        const active = state.activeProcess;
        if (!active) return;
        signalProcessGroup(active.processGroupId, plan.identityToken, signal);
        signalProcessGroupByLeader(active.processGroupId, active.pid, active.startIdentity, signal);
        const owned = processesForStartIdentity(plan.identityToken);
        if (owned.state === "found") for (const item of owned.processes) {
          if (processStartIdentityLiveness(item.pid, item.startIdentity) === "alive") {
            try { process.kill(item.pid, signal); } catch { /* the identity-checked child exited */ }
          }
        }
      };
      if (state.activeProcess) signalActiveGroup("SIGTERM");
      signalSupervisor("SIGTERM");
      await new Promise(resolve => setTimeout(resolve, 250));
      if (state.activeProcess && !processGroupEmpty(state.activeProcess.processGroupId)) signalActiveGroup("SIGKILL");
      if (!processGroupEmpty(state.supervisorPid)) signalSupervisor("SIGKILL");
      const supervisorCommand = state.supervisorStartIdentity ? null : processCommandLine(state.supervisorPid);
      const supervisorDead = state.supervisorStartIdentity !== undefined
        ? processStartIdentityLiveness(state.supervisorPid, state.supervisorStartIdentity) === "dead"
        : !pidAlive(state.supervisorPid) || (supervisorCommand !== null && !supervisorCommand.includes(plan.identityToken));
      return supervisorDead && processGroupEmpty(state.supervisorPid)
        && (!state.activeProcess || processGroupEmpty(state.activeProcess.processGroupId))
        && processesForStartIdentity(plan.identityToken).state === "absent";
    };
    for (;;) {
      const result = readProjectValidationResult(paths.resultPath, hostRunId);
      if (result) {
        if (result.epoch !== plan.epoch || result.identityToken !== plan.identityToken)
          return { kind: "uncertain", detail: "Project-validation result identity does not match its durable plan" };
        const state = this.validationStateFacts.read(paths.statePath);
        const validState = state && state.runId === hostRunId && state.epoch === plan.epoch && state.identityToken === plan.identityToken ? state : null;
        let supervisor: "live" | "dead" | "unknown";
        if (validState) {
          supervisor = (await this.supervisorLiveness.read(validState.supervisorPid, plan.identityToken, validState.supervisorStartIdentity, true)).state;
        } else {
          const found = await findProcessByCommandTokenAsync(plan.identityToken);
          supervisor = found.state === "found" ? "live" : found.state === "absent" ? "dead" : "unknown";
        }
        const resultHeartbeatStale = Boolean(validState && confirmStaleSupervisorHeartbeat(this.staleSupervisorObservations, hostRunId, validState.heartbeatAt) !== null);
        if (resultHeartbeatStale) {
          if (await stopStaleSupervisor(validState!))
            return { kind: "lost", detail: `Project-validation supervisor ${staleHeartbeatEvidence}; its process groups were stopped and the run is held for explicit resubmission` };
          await new Promise(resolve => setTimeout(resolve, pollMs));
          continue;
        }
        if (supervisor === "live") {
          await new Promise(resolve => setTimeout(resolve, pollMs));
          continue;
        }
        if (supervisor === "unknown")
          return { kind: "uncertain", detail: "Project-validation result exists, but its supervisor identity could not be verified" };
        const remaining = processesForStartIdentity(plan.identityToken);
        if ((result.processGroupId !== null && !processGroupEmpty(result.processGroupId)) || remaining.state !== "absent")
          return { kind: "uncertain", detail: remaining.state === "found"
            ? "Project validation reported a result but its process tree is still live"
            : "Project validation result exists, but process-group exit is not proven" };
        if (result.hostResult) this.recordValidationProcess(taskId, hostRunId, {
          pid: result.pid ?? result.hostResult.pgid, processGroupId: result.hostResult.pgid,
          leaderStartIdentity: result.leaderStartIdentity ?? plan.identityToken, startIdentity: result.hostResult.startIdentity,
        });
        return { kind: "result", result };
      }

      const state = this.validationStateFacts.read(paths.statePath);
      const validState = state && state.runId === hostRunId && state.epoch === plan.epoch && state.identityToken === plan.identityToken ? state : null;
      if (validState?.activeProcess) this.recordValidationProcess(taskId, hostRunId, validState.activeProcess);
      let supervisor: "live" | "dead" | "unknown";
      if (validState) {
        supervisor = (await this.supervisorLiveness.read(validState.supervisorPid, plan.identityToken, validState.supervisorStartIdentity)).state;
      } else {
        const found = await findProcessByCommandTokenAsync(plan.identityToken);
        supervisor = found.state === "found" ? "live" : found.state === "absent" ? "dead" : "unknown";
      }
      const heartbeatStale = Boolean(validState && confirmStaleSupervisorHeartbeat(this.staleSupervisorObservations, hostRunId, validState.heartbeatAt) !== null);
      const identityAlive = heartbeatStale && validState?.supervisorStartIdentity
        ? processStartIdentityLiveness(validState.supervisorPid, validState.supervisorStartIdentity) === "alive" : false;
      if (heartbeatStale && (supervisor === "live" || identityAlive)) {
        if (await stopStaleSupervisor(validState!))
          return { kind: "lost", detail: `Project-validation supervisor ${staleHeartbeatEvidence}; its process groups were stopped and the run is held for explicit resubmission` };
        continue;
      }
      if (supervisor === "live") {
        await new Promise(resolve => setTimeout(resolve, pollMs));
        continue;
      }
      if (supervisor === "unknown")
        return { kind: "uncertain", detail: "Project-validation supervisor identity could not be read; operator reconciliation required" };

      const processes = processesForStartIdentity(plan.identityToken);
      if (processes.state === "unknown")
        return { kind: "uncertain", detail: "Project-validation process tree could not be inspected; operator reconciliation required" };
      if (processes.state === "found")
        return { kind: "uncertain", detail: "Project-validation supervisor exited while its process tree remains live" };
      if (!validState?.activeProcess)
        return { kind: "uncertain", detail: "Project-validation supervisor exited without a recorded process-group identity; operator reconciliation required" };
      if (!processGroupEmpty(validState.activeProcess.processGroupId))
        return { kind: "uncertain", detail: "Project-validation supervisor exited before its process group was proven empty" };
      // The supervisor publishes its result before it exits, so a proven exit means
      // every publication already landed - including one that arrived after this
      // iteration read no result. Re-read once and classify from the durable result;
      // a second proof of absence is still a genuinely lost run.
      if (!recheckedPublication) {
        recheckedPublication = true;
        if (readProjectValidationResult(paths.resultPath, hostRunId)) continue;
      }
      return { kind: "lost", detail: "Project validation ended without a durable result; it is held for explicit resubmission" };
    }
  }

  private async finishValidationObservation(task: Task, prior: NonNullable<Task["resolution"]["projectValidation"]>, observation: ProjectValidationObservation,
    extra: { queueBuild: string; settingsRevision: number } ): Promise<ProjectValidationOutcome> {
    if (observation.kind === "uncertain") return { kind: "hold", detail: observation.detail };
    const runId = prior.hostRunId;
    if (!runId) return { kind: "hold", detail: "Project-validation run identity is missing; operator reconciliation required" };
    const scheduler = this.hostRunScheduler;
    const scheduled = scheduler.get(runId);
    const result = observation.kind === "result" ? observation.result : null;
    const paths = projectValidationSupervisorPaths(this.isolationDataDir(), runId);
    const cancellation = readProjectValidationCancellation(paths.cancellationPath, runId);
    const latestTask = this.store.task(task.id);
    const cancelled = Boolean(cancellation && cancellation.epoch === prior.hostRunEpoch && cancellation.identityToken === readProjectValidationPlan(paths.planPath)?.identityToken)
      || isDispositionActive(latestTask) || latestTask.phase === "cancelled";
    const settledAt = result?.endedAt ?? now();
    const detail = result?.outputTail || (observation.kind === "lost" ? observation.detail : "");
    if (scheduled?.state === "running") {
      const hostOutcome: HostRunSettlement["outcome"] = !result?.hostResult ? "lost"
        : cancelled ? "cancelled" : result.timedOut ? "timed_out" : result.state === "passed" ? "passed" : "failed";
      const settlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1,
        runId, outcome: hostOutcome, launched: true, settledAt,
        result: result?.hostResult ?? null, containers: scheduled.settlement?.containers ?? [] });
      try { scheduler.settle(runId, settlement, { wallMs: result?.durationMs ?? null, cpuMs: result?.hostResult?.cpuMs ?? null,
        // The private sidecar beside the envelope, bound to this run, epoch and cpuMs.
        cpuCoverage: result?.hostResult && result.runId === runId && result.hostResult.runId === runId && result.hostResult.epoch === scheduled.epoch
          ? boundSidecarCoverage(readProjectValidationCpuCoverage(paths.cpuCoveragePath),
            { runId, epoch: scheduled.epoch, cpuMs: result.hostResult.cpuMs }) : undefined }); }
      catch (error) { return { kind: "hold", detail: `Project-validation settlement is fenced by the current authority: ${String(error)}` }; }
    }

    let state: "passed" | "refused" | "hold" = cancelled ? "hold" : result?.state ?? "hold";
    let outputTail = cancelled ? `Project validation was cancelled${detail ? `: ${detail}` : ""}` : detail;
    if (!result) outputTail = observation.kind === "lost" ? observation.detail : "Project validation requires operator reconciliation";
    else if (result.timedOut) { state = "hold"; outputTail = `Validation timed out: ${detail}`; }
    else if (result.signal) { state = "hold"; outputTail = `Validation terminated by ${result.signal}: ${detail}`; }
    else if (result.terminationError || result.processGroupEmpty !== true) {
      state = "hold"; outputTail = result.terminationError || "Project-validation process group was not proven empty";
    }
    const settledRun = scheduler.get(runId) ?? scheduled;
    const capacityUnavailable = !cancelled && settledRun?.settlement?.outcome === "capacity_timeout";
    if (capacityUnavailable) {
      state = "hold";
      outputTail = `QA capacity unavailable: ${outputTail || "Nucleus could not admit validation before its capacity deadline"}`;
    }

    let candidateClean = false;
    let candidatePath: string | null = null;
    if (prior.candidate) {
      candidatePath = await this.prospectiveCandidatePath(task, prior.candidate);
      try { await verifyMergeCandidate(candidatePath, prior.candidate); candidateClean = true; }
      catch (error) { state = "hold"; outputTail = `Validation changed the candidate: ${String(error)}`; }
    } else {
      state = "hold";
      outputTail = "Project-validation run has no pinned candidate identity; operator reconciliation required";
    }

    const current = this.store.task(task.id);
    const latest = current.resolution.projectValidation;
    if (!latest || latest.hostRunId !== runId) return { kind: "hold", detail: "Project-validation record changed during reconciliation" };
    const hostRunTelemetry: ProjectValidationSchedulerTelemetry | undefined = settledRun ? {
      queueWaitMs: (() => {
        const completedAt = settledRun.admittedAt ?? settledRun.settlement?.settledAt;
        return completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(settledRun.submittedAt)) : null;
      })(),
      wallMs: settledRun.wallMs,
      cpuMs: settledRun.cpuMs,
      outcome: settledRun.settlement?.outcome ?? null,
    } : undefined;
    const terminationSignal: "SIGTERM" | "SIGKILL" | null = result?.signal === "SIGTERM" || result?.signal === "SIGKILL" ? result.signal : null;
    const updated = { ...latest, queueBuild: extra.queueBuild, settingsRevision: extra.settingsRevision,
      exitCode: result?.exitCode ?? null, durationMs: result?.durationMs ?? 0, outputTail: outputTail.slice(-2000), state,
      ...(hostRunTelemetry ? { hostRunTelemetry } : {}), capacityWait: null, capacityUnavailable,
      pid: result?.pid ?? latest.pid,
      processGroupId: result?.processGroupId ?? latest.processGroupId,
      leaderStartIdentity: result?.leaderStartIdentity ?? latest.leaderStartIdentity,
      terminationSignal,
      processGroupEmpty: result?.processGroupEmpty ?? null, terminationError: result?.terminationError ?? null,
      resubmissionRequired: !cancelled && (observation.kind === "lost" || result?.timedOut === true) && !capacityUnavailable,
      candidateCleanupPending: candidateClean && candidatePath !== null };
    this.store.update(task.id, { resolution: { ...current.resolution, projectValidation: updated },
      reason: state === "passed" ? "Project validation passed" : state === "refused" ? outputTail || `Validation exited ${result?.exitCode}` : outputTail || "Project validation requires attention" },
    "project_validation_result", `${latest.digest} ${state}`);
    if (updated.candidateCleanupPending && candidatePath)
      await this.retryCandidateCleanup(task, updated, candidatePath);
    await rm(paths.root, { recursive: true, force: true }).catch(() => { /* Durable Queue result is already recorded. */ });
    if (state === "passed") return { kind: "ok", base: latest.base };
    if (state === "refused") return { kind: "refused", detail: outputTail || `Validation exited ${result?.exitCode}` };
    return { kind: "hold", detail: outputTail || "Project validation requires attention" };
  }

  /** Persist and reconcile cancellation of the task's owned host-validation run. */
  async cancelProjectValidation(task: Task, reason: string): Promise<void> {
    const currentTask = this.store.task(task.id);
    const prior = currentTask.resolution.projectValidation;
    if (!prior || prior.state !== "running" || !prior.hostRunId) return;
    const scheduler = this.hostRunScheduler;
    const run = scheduler.get(prior.hostRunId);
    if (!run || run.state === "settled") return;
    if (run.epoch !== prior.hostRunEpoch) throw new Error("Project-validation host run epoch does not match its durable task record");
    if (run.state === "queued" || run.state === "admitted") {
      scheduler.cancelQueued(run.id, reason, run.epoch);
      const latestTask = this.store.task(task.id);
      const latest = latestTask.resolution.projectValidation;
      if (latest?.hostRunId === run.id && latest.state === "running")
        this.store.update(task.id, { resolution: { ...latestTask.resolution, projectValidation: { ...latest, state: "hold",
          outputTail: "Project validation was cancelled before launch", capacityWait: null, capacityUnavailable: false } } },
        "project_validation_cancelled_before_launch", run.id);
      return;
    }

    const paths = projectValidationSupervisorPaths(this.isolationDataDir(), run.id);
    const plan = readProjectValidationPlan(paths.planPath);
    if (!plan || plan.runId !== run.id || plan.epoch !== run.epoch || plan.epoch !== prior.hostRunEpoch)
      throw new Error("Launched project validation has no matching supervisor plan; capacity remains reserved for reconciliation");
    scheduler.cancelQueued(run.id, reason, run.epoch); // journal and shadow the request before notifying the supervisor
    try {
      writeProjectValidationCancellation(paths.cancellationPath, {
        format: "queue.project-validation.cancel", version: 1, runId: run.id, epoch: run.epoch,
        identityToken: plan.identityToken, requestedAt: now(), reason: reason.slice(0, 2000) || "Task disposition requested",
      });
    } catch (error) {
      throw new Error(`Project-validation cancellation intent could not be recorded; capacity remains reserved: ${String(error)}`);
    }

    const observation = await this.observeValidationSupervisor(task.id, run.id, plan);
    if (observation.kind === "uncertain")
      throw new Error(`Project-validation cancellation is waiting for process-exit proof; capacity remains reserved: ${observation.detail}`);
    const latestTask = this.store.task(task.id);
    const latest = latestTask.resolution.projectValidation;
    if (latest?.hostRunId !== run.id || latest.state !== "running") {
      const settled = scheduler.get(run.id);
      if (settled?.state === "settled" && settled.settlement?.outcome === "cancelled") return;
      throw new Error("Project-validation task record changed before cancellation could settle its host run");
    }
    await this.finishValidationObservation(latestTask, latest, observation, {
      queueBuild: latest.queueBuild, settingsRevision: latest.settingsRevision,
    });
    const settled = scheduler.get(run.id);
    if (settled?.state !== "settled" || settled.settlement?.outcome !== "cancelled")
      throw new Error("Project-validation process exited without a durable cancelled host settlement");
  }

  /** Run the operator's literal command on the same exact candidate as a v4 prospective hook. */
  async projectValidationGate(task: Task, head: string, validation: ProjectValidation): Promise<ProjectValidationOutcome> {
    const argvDigest = digest(JSON.stringify(validation.argv));
    const terminationGraceMs = validation.terminationGraceMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS;
    let stale = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      let base: string;
      try { base = await this.integrationBase(task); }
      catch (error) { return { kind: "hold", detail: `Project validation needs a clean synchronized base: ${String(error)}` }; }
      const discovery = await discoverManifest(task.repoPath, base);
      if (discovery && !manifestSupportsCloseoutSelection(discovery.manifest.schema)) return { kind: "none" };
      let prior = this.store.task(task.id).resolution.projectValidation;
      if (prior) {
        await this.retryCandidateCleanup(task, prior);
        prior = this.store.task(task.id).resolution.projectValidation;
      }
      if (prior && prior.head !== head && prior.state !== "running" && prior.state !== "superseded") {
        this.store.update(task.id, { resolution: { ...this.store.task(task.id).resolution,
          projectValidation: { ...prior, state: "superseded" } } }, "project_validation_superseded",
        JSON.stringify({ result: prior, supersededBy: head }));
        prior = null;
      }
      const priorHostRun = prior?.hostRunId ? this.hostRunScheduler.get(prior.hostRunId) : null;
      const canReattachQueued = priorHostRun?.state === "queued" || priorHostRun?.state === "admitted";
      const queueBuild = this.queueBuild();
      const settingsRevision = this.store.canonicalRepository(task.repoPath, task.repository)?.revision ?? 0;
      if (prior?.state === "running" && !canReattachQueued) {
        if (!prior.hostRunId) return { kind: "hold", detail: "Project-validation run identity is missing; operator reconciliation required" };
        const paths = projectValidationSupervisorPaths(this.isolationDataDir(), prior.hostRunId);
        const plan = readProjectValidationPlan(paths.planPath);
        let observation: ProjectValidationObservation;
        if (priorHostRun?.settlement?.outcome === "capacity_timeout") {
          observation = { kind: "lost", detail: "Queue capacity deadline expired before project validation launched" };
        } else if (plan && plan.runId === prior.hostRunId && plan.epoch === prior.hostRunEpoch) {
          observation = await this.observeValidationSupervisor(task.id, prior.hostRunId, plan);
        } else {
          const token = prior.leaderStartIdentity;
          const processGroupId = prior.processGroupId ?? priorHostRun?.processGroupId;
          if (!token || !processGroupId)
            return { kind: "hold", detail: "Project validation has no process-group identity; operator reconciliation required" };
          const processes = processesForStartIdentity(token);
          if (processes.state !== "absent" || !processGroupEmpty(processGroupId))
            return { kind: "hold", detail: "Project validation process group and descendants are not proven dead; operator reconciliation required" };
          observation = { kind: "lost", detail: "Project validation ended without a durable result; it is held for explicit resubmission" };
        }
        const outcome = await this.finishValidationObservation(task, prior, observation, { queueBuild, settingsRevision });
        if (observation.kind !== "result") return outcome;
        let after: string | null = null;
        try { after = await this.integrationBase(task); } catch { /* Unknown base is operational. */ }
        if (after !== base) {
          stale = `Project validation base moved from ${base} to ${after ?? "an unknown state"}`;
          this.store.event(task.id, "project_validation_candidate_stale", stale);
          continue;
        }
        return outcome;
      }
      if (prior?.state === "hold" && prior.resubmissionRequired && prior.base === base && prior.head === head)
        return { kind: "hold", detail: prior.outputTail || "This lost validation requires explicit resubmission" };
      if (prior?.base === base && prior.head === head && prior.digest === argvDigest
          && prior.queueBuild === queueBuild && prior.settingsRevision === settingsRevision) {
        if (prior.state === "passed") return { kind: "ok", base };
        if (prior.state === "refused") return { kind: "refused", detail: prior.outputTail };
        if (prior.state === "hold") return { kind: "hold", detail: prior.outputTail };
      }
      const path = await this.prospectiveCandidatePath(task, { integrationBase: base, reviewedHead: head });
      this.store.event(task.id, "project_validation_candidate_intent", `${base} ${head} ${path}`);
      const built = await this.buildProspectiveCandidate(task, path, base, head);
      if (built.kind === "conflict") return { kind: "conflict", detail: built.detail };
      if (built.kind !== "built") return { kind: "hold", detail: `Project validation candidate could not be built: ${built.detail}` };
      const scheduler = this.hostRunScheduler;
      const selector = selectorForArgv(validation.argv, "validation");
      const classification = classifyHostRun(task.repoPath, selector, selector === "test" && validation.argv.length > 2);
      let authority;
      try { authority = scheduler.authority(); }
      catch (error) { return { kind: "hold", detail: `Project validation scheduler is unavailable: ${String(error)}` }; }
      const hostRunId = canReattachQueued && prior?.hostRunId ? prior.hostRunId : randomUUID();
      const submittedAt = canReattachQueued && prior?.submittedAt ? prior.submittedAt : now();
      const caller = projectValidationCallerIdentity(task.id, head);
      const hostRunEpoch = priorHostRun?.epoch ?? authority.epoch;
      const repository = { origin: await repositoryOrigin(task.repoPath).catch(() => null), path: task.repoPath };
      const paths = projectValidationSupervisorPaths(this.isolationDataDir(), hostRunId);
      await mkdir(paths.root, { recursive: true, mode: 0o700 });
      const existingPlan = readProjectValidationPlan(paths.planPath);
      if (existingPlan && (existingPlan.runId !== hostRunId || existingPlan.epoch !== hostRunEpoch || existingPlan.root !== path
          || JSON.stringify(existingPlan.argv) !== JSON.stringify(validation.argv)))
        return { kind: "hold", detail: "Project-validation supervisor plan does not match the queued run" };
      const identityToken = existingPlan?.identityToken ?? randomUUID();
      const plan: ProjectValidationSupervisorPlan = {
        format: "queue.project-validation.plan", version: 1, runId: hostRunId, epoch: hostRunEpoch,
        runClass: classification.runClass, hostRunStateDir: this.hostRunStateDir(),
        ...(existingPlan?.hostRunToken ? { hostRunToken: existingPlan.hostRunToken } : {}),
        identityToken, root: path, argv: validation.argv, timeoutMs: validation.timeoutMs,
        maxOutputBytes: validation.maxOutputBytes, terminationGraceMs,
        launchedAt: existingPlan?.launchedAt ?? null, statePath: paths.statePath, resultPath: paths.resultPath,
      };
      if (existingPlan?.launchedAt && canReattachQueued)
        return { kind: "hold", detail: "Queued project validation has a launch timestamp but no running scheduler record" };
      try { writeProjectValidationPlan(paths.planPath, plan); }
      catch (error) { return { kind: "hold", detail: `Project-validation supervisor intent could not be recorded: ${String(error)}` }; }
      const result: NonNullable<Task["resolution"]["projectValidation"]> = { argv: validation.argv, digest: argvDigest, exitCode: null, durationMs: 0, outputTail: "", base, head,
        candidate: built.candidate, state: "running", queueBuild, settingsRevision, pid: null,
        hostRunId, hostRunEpoch, submittedAt, selector, runTimeoutMs: validation.timeoutMs,
        capacityDeadlineAt: new Date(Date.parse(submittedAt) + HOST_RUN_CAPACITY_DEADLINE_MS).toISOString(),
        terminationGraceMs, capacityWait: null,
        capacityUnavailable: false, resubmissionRequired: false };
      this.store.update(task.id, { resolution: { ...this.store.task(task.id).resolution, projectValidation: result } }, "project_validation_intent", argvDigest);
      let resolveCompletion!: (value: ProjectValidationCompletion) => void;
      let completion: ProjectValidationCompletion | null = null;
      const completed = new Promise<ProjectValidationCompletion>(resolve => { resolveCompletion = resolve; });
      const finish = (value: ProjectValidationCompletion) => {
        if (completion) return;
        completion = value; resolveCompletion(value);
      };
      const handler: HostRunHandler = {
        position: position => {
          const current = this.store.task(task.id).resolution.projectValidation;
          if (!current || current.hostRunId !== hostRunId || current.state !== "running") return;
          this.store.update(task.id, { resolution: { ...this.store.task(task.id).resolution,
            projectValidation: { ...current, capacityWait: { position, observedAt: now() } } },
            reason: qaCapacityWaitReason(position) }, "project_validation_capacity_wait", String(position));
        },
        terminal: run => {
          if (completion) return;
          if (run.settlement?.outcome === "capacity_timeout")
            finish({ kind: "prelaunch", detail: "Queue capacity deadline expired before project validation launched" });
          else if (run.settlement?.outcome === "cancelled") {
            const latestTask = this.store.task(task.id);
            const latest = latestTask.resolution.projectValidation;
            if (latest?.hostRunId === hostRunId && latest.state === "running")
              this.store.update(task.id, { resolution: { ...latestTask.resolution,
                projectValidation: { ...latest, state: "hold", outputTail: "Project validation was cancelled before launch",
                  capacityWait: null, capacityUnavailable: false } } }, "project_validation_cancelled_before_launch", hostRunId);
            finish({ kind: "prelaunch", detail: "Project validation was cancelled before launch" });
          } else finish({ kind: "prelaunch", detail: "Project validation host run ended before launch" });
        },
        launch: async () => {
          try {
            const launched = scheduler.markLaunched(hostRunId, () => {
              const latestTask = this.store.task(task.id);
              const latest = latestTask.resolution.projectValidation;
              return !isDispositionActive(latestTask) && latestTask.phase !== "cancelled"
                && latest?.hostRunId === hostRunId && latest.state === "running"
                && latest.base === base && latest.head === head && latest.digest === argvDigest;
            });
            if (launched.state !== "running") return;
            const hostRunToken = plan.hostRunToken ?? issueHostRunToken(this.hostRunStateDir(), {
              runId: launched.id, epoch: launched.epoch, class: plan.runClass,
              root: realpathSync(plan.root),
              exp: Date.parse(launched.launchedAt!) + launched.runTimeoutMs + HOST_RUN_TOKEN_GRACE_MS,
            });
            const activePlan = { ...plan, launchedAt: launched.launchedAt, timeoutMs: launched.runTimeoutMs, hostRunToken };
            writeProjectValidationPlan(paths.planPath, activePlan);
            const current = this.store.task(task.id).resolution.projectValidation;
            if (current?.hostRunId === hostRunId && current.state === "running")
              this.store.update(task.id, { resolution: { ...this.store.task(task.id).resolution,
                projectValidation: { ...current, capacityWait: null, runTimeoutMs: launched.runTimeoutMs,
                  capacityDeadlineAt: launched.capacityDeadlineAt } }, reason: "Project validation is running under Queue supervision" },
              "project_validation_admitted", "");
            this.spawnValidationSupervisor(paths.planPath, identityToken);
            finish(await this.observeValidationSupervisor(task.id, hostRunId, activePlan));
          } catch (error) {
            const currentRun = scheduler.get(hostRunId);
            if (currentRun?.state === "running") finish({ kind: "uncertain", detail: `Project-validation observation failed while the launched run may still be live; its host reservation and recovery files are retained: ${String(error)}` });
            else finish({ kind: "prelaunch", detail: `Host scheduler refused project validation: ${String(error)}` });
          }
        },
      };
      try {
        const scheduled = canReattachQueued
          ? scheduler.attach(hostRunId, handler)
          : scheduler.submit({ id: hostRunId, epoch: hostRunEpoch, caller, repository, selector,
            runClass: classification.runClass, classSource: classification.classSource, priority: "validation",
            runTimeoutMs: validation.timeoutMs, submittedAt }, handler);
        if (!scheduled) finish({ kind: "prelaunch", detail: "Host scheduler lost the queued project-validation run" });
        const latest = this.store.task(task.id).resolution;
        if (scheduled && latest.projectValidation?.hostRunId === hostRunId && latest.projectValidation.state === "running")
          this.store.update(task.id, { resolution: { ...latest, projectValidation: { ...latest.projectValidation,
            runTimeoutMs: scheduled.runTimeoutMs, capacityDeadlineAt: scheduled.capacityDeadlineAt } } }, "project_validation_scheduler_recorded",
          projectValidationSchedulerEvidence(hostRunId, scheduled.epoch, head));
      } catch (error) {
        finish({ kind: "prelaunch", detail: `Host scheduler rejected project validation: ${String(error)}` });
      }
      const completedRun = await completed;
      if (completedRun.kind === "uncertain") return { kind: "hold", detail: completedRun.detail };
      const currentResult = this.store.task(task.id).resolution.projectValidation ?? result;
      const scheduledAfterCompletion = scheduler.get(hostRunId);
      const dispositionFencedBeforeLaunch = isDispositionActive(this.store.task(task.id))
        && scheduledAfterCompletion?.settlement?.outcome === "cancelled" && !scheduledAfterCompletion.settlement.launched;
      if (dispositionFencedBeforeLaunch) {
        if (currentResult.candidate) {
          const candidatePath = await this.prospectiveCandidatePath(task, currentResult.candidate);
          await this.removeIsolatedCheckout(task, candidatePath, true).catch(() => { /* cancellation already fences task advancement */ });
        }
        return { kind: "hold", detail: "Project validation was cancelled before launch" };
      }
      const outcome = completedRun.kind === "prelaunch"
        ? await this.finishValidationObservation(task, currentResult, { kind: "lost", detail: completedRun.detail },
          { queueBuild, settingsRevision })
        : await this.finishValidationObservation(task, currentResult, completedRun, { queueBuild, settingsRevision });
      if (completedRun.kind === "lost") return outcome;
      let after: string | null = null;
      try { after = await this.integrationBase(task); } catch { /* Unknown base is operational. */ }
      if (after !== base) {
        stale = `Project validation base moved from ${base} to ${after ?? "an unknown state"}`;
        this.store.event(task.id, "project_validation_candidate_stale", stale);
        continue;
      }
      return outcome;
    }
    return { kind: "hold", detail: stale || "Project validation candidate did not settle" };
  }

  private hostRunStateDir(): string {
    return this.options.hostRunStateDir ?? join(this.isolationDataDir(), "host-run");
  }

  queueBuild(): string { return this.options.queueBuild ?? currentServiceBuildId(); }

}
