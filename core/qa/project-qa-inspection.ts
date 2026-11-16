import { qaLostDiagnosticDetail, qaServiceWindow } from "./project-qa-diagnostics";
import { SupervisorLivenessReader } from "../machine/start-identity";
import { FileFacts } from "../machine/file-facts";
import { isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { repositoryOrigin } from "../planning/lanes";
import type { Store } from "../store/store";
import type { HostRunScheduler } from "../host-runs/host-run-scheduler";
import type { ProjectQaRun, HostRunResult, HostRunEscapedDescendant } from "../../shared/contracts";
import {
  readQaSupervisionPlanFile,
  readQaSupervisionStateFile,
  readQaHeartbeat,
  readHostRunResult,
  qaSupervisionPaths,
  type QaFileRead,
  type QaSupervisionState,
  type QaSupervisionPlan,
} from "./project-qa-supervision-files";
import { supervisorLivenessAsync } from "../machine/start-identity";
import { findProcessByCommandTokenAsync } from "../machine/process-identity";
import { processGroupEmpty } from "../machine/process-group";
import { processesForStartIdentity, processStartIdentityLiveness } from "../machine/process-identity-search";
import { confirmStaleSupervisorHeartbeat, SUPERVISOR_STUCK_CONFIRMATION_MS } from "../machine/supervisor-watchdog";
import { stopDetachedSupervisor } from "./supervisor-process";

/**
 * What one running row's durable evidence says about its supervisor. A `running`
 * answer keeps the row as it is and may name why the evidence could not be read:
 * an unreadable plan or heartbeat is never a run that never started.
 */
export type SupervisorInspection =
  | { kind: "settled"; state: QaSupervisionState | null; hostResult: HostRunResult | null }
  | { kind: "running"; state: QaSupervisionState | null; reason?: string }
  | { kind: "unstarted"; state: null; plan: QaSupervisionPlan }
  | {
    kind: "dead"; state: QaSupervisionState | null; reason: string; escapedDescendants?: HostRunEscapedDescendant[];
    /** Set when this verdict followed stopping a stale supervisor, so a late result is re-read. */
    staleStop?: true;
  };

/** Why one supervision-file read was refused, or null when it was the record or a proven absence. */
const unreadableReason = (read: QaFileRead<unknown>): string | null => read.kind === "unreadable" ? read.reason : null;

export interface QaRunReadContext {
  store: Pick<Store, "qaRun" | "latestQaRun">;
  reconcile(key: string, requestedId?: string): Promise<void>;
}

export const projectQaRunReads = {
  /** Read one recorded run by ID or the latest run for a repository. */
  async get(this: QaRunReadContext, input: { id: string } | { repository: string }): Promise<ProjectQaRun | null> {
    if ("id" in input) {
      const run = this.store.qaRun(input.id);
      if (!run) return null;
      await reconcileBestEffort(this, run.key, run.id);
      return this.store.qaRun(input.id);
    }
    const origin = isAbsolute(input.repository) ? null : normalizeRepositoryOrigin(input.repository);
    if (origin) {
      await reconcileBestEffort(this, origin);
      const direct = this.store.latestQaRun(origin);
      if (direct) return direct;
    }
    if (isAbsolute(input.repository)) {
      const real = await realpath(input.repository).catch(() => input.repository);
      const checkoutOrigin = await repositoryOrigin(real).catch(() => null);
      const key = checkoutOrigin ?? real;
      await reconcileBestEffort(this, key);
      return this.store.latestQaRun(key);
    }
    return this.store.latestQaRun(origin ?? input.repository);
  }

};

async function reconcileBestEffort(context: QaRunReadContext, key: string, requestedId?: string): Promise<void> {
  try {
    await context.reconcile(key, requestedId);
  } catch (error) {
    const subject = requestedId ? `run ${requestedId}` : `repository ${key}`;
    console.warn(`[nucleus] Project QA read reconciliation failed for ${subject}:`, error);
  }
}

export class ProjectQaInspection {
  private readonly staleSupervisorObservations = new Map<string, { heartbeatAt: string; firstObservedAt: number }>();
  constructor(readonly hostRuns: Pick<HostRunScheduler, "get">, readonly qaRepositoryRootPath: (key: string) => string, readonly serviceHistory?: Pick<Store, "getMeta">) {}

  /**
   * Classify a running row's supervisor from its durable evidence. The
   * supervision file carries the supervisor's pid and identity token once it
   * starts; before that, the plan the service wrote before spawning carries the
   * token. A pid is only ever trusted together with that token, and an
   * unreadable identity stays unresolved rather than being reaped.
   */
  private readonly supervisorLiveness = new SupervisorLivenessReader();
  private readonly supervisionFacts = new FileFacts(readQaSupervisionStateFile);
  private readonly supervisionPlans = new FileFacts(readQaSupervisionPlanFile);

  async inspectSupervisor(run: ProjectQaRun): Promise<SupervisorInspection> {
    const attempt = run.teardownRetryAttempt ?? 0;
    const { statePath, planPath, resultPath, heartbeatPath } = qaSupervisionPaths(this.qaRepositoryRootPath(run.key), run.id, attempt);
    const stateRead = this.supervisionFacts.read(statePath);
    const planRead = this.supervisionPlans.read(planPath);
    // A record this process cannot read is evidence that is missing, not evidence
    // that the run never started: hold the row instead of reaping or resuming it.
    const stateRefusal = unreadableReason(stateRead);
    const planRefusal = unreadableReason(planRead);
    if (stateRefusal || planRefusal) {
      const named = [stateRefusal && `the supervision heartbeat (${stateRefusal})`,
        planRefusal && `the supervision plan (${planRefusal})`].filter(Boolean).join(" and ");
      return { kind: "running", state: null, reason: `${named} could not be read; the run is held` };
    }
    const state = stateRead.kind === "present"
      ? { ...stateRead.value, heartbeatAt: readQaHeartbeat(heartbeatPath, stateRead.value) } : null;
    let observedLiveness = "unknown";
    let observedGroupEmpty: boolean | null = null;
    const plan = planRead.kind === "present" ? planRead.value : null;
    const validPlan = plan?.runId === run.id && plan.key === run.key ? plan : null;
    const hostResult = readHostRunResult(resultPath, run.id);
    const inspect = async (): Promise<SupervisorInspection> => {
      if (hostResult || state?.result) {
        const result = hostResult ?? state?.result?.hostResult ?? null;
        const identityToken = state?.identityToken ?? validPlan?.identityToken;
        const processGroupId = result?.pgid ?? state?.activeProcess?.processGroupId;
        const supervisorDead = state && identityToken
          ? (await this.supervisorLiveness.read(state.pid, identityToken, state.supervisorStartIdentity, true)).state === "dead"
          : identityToken ? (await findProcessByCommandTokenAsync(identityToken)).state === "absent" : false;
        if (!identityToken || !supervisorDead || processGroupId && !processGroupEmpty(processGroupId))
          return { kind: "running", state };
        return { kind: "settled", state, hostResult: result };
      }
      if (state) {
        const liveness = await this.supervisorLiveness.read(state.pid, state.identityToken, state.supervisorStartIdentity);
        observedLiveness = liveness.state;
        observedGroupEmpty = state.activeProcess ? processGroupEmpty(state.activeProcess.processGroupId) : null;
        // The OS liveness read yielded: a heartbeat may have advanced meanwhile.
        state.heartbeatAt = readQaHeartbeat(heartbeatPath, state);
        const staleAgeMs = confirmStaleSupervisorHeartbeat(this.staleSupervisorObservations, run.id, state.heartbeatAt);
        const sameSupervisorAlive = staleAgeMs !== null && state.supervisorStartIdentity
          && processStartIdentityLiveness(state.pid, state.supervisorStartIdentity) === "alive";
        if (staleAgeMs !== null && (liveness.state === "live" || sameSupervisorAlive)) {
          // A live process with no recent heartbeat may be hung or unable to write.
          // Keep pre-stop evidence. The run token in each group's environment
          // proves which processes may be stopped.
          if (sameSupervisorAlive) observedLiveness = "live";
          const stopped = await stopDetachedSupervisor({
            supervisorPid: state.pid,
            ...(state.supervisorStartIdentity ? { supervisorStartIdentity: state.supervisorStartIdentity } : {}),
            identityToken: state.identityToken, activeProcess: state.activeProcess,
          });
          if (stopped)
            return { kind: "dead", state, staleStop: true, reason: `the supervisor heartbeat was stale for ${staleAgeMs}ms and unchanged across checks ${SUPERVISOR_STUCK_CONFIRMATION_MS}ms apart; its process groups were stopped` };
          return { kind: "running", state };
        }
        if (liveness.state === "dead") {
          if (state.activeProcess && !processGroupEmpty(state.activeProcess.processGroupId))
            return { kind: "running", state };
          if (!state.activeProcess && state.inFlight) {
            if (!state.pendingProcessIdentity) return { kind: "running", state };
            const inFlight = processesForStartIdentity(state.pendingProcessIdentity);
            if (inFlight.state !== "absent") return { kind: "running", state };
          }
          const escaped = processesForStartIdentity(state.activeProcess?.leaderStartIdentity ?? state.identityToken);
          if (escaped.state !== "absent") return { kind: "running", state };
          return { kind: "dead", state, reason: liveness.reason, escapedDescendants: [] };
        }
        return { kind: "running", state };
      }
      if (!validPlan) return { kind: "dead", state: null, reason: "no supervisor was started for this run" };
      // The supervisor's first write precedes checkout preparation and every
      // QA side effect. Resume only when the host-run record also proves no QA
      // step process was launched; this remains true across a restart after the
      // detached supervisor pid was recorded.
      const supervisor = await findProcessByCommandTokenAsync(validPlan.identityToken);
      if (supervisor.state === "absent") {
        const steps = processesForStartIdentity(validPlan.identityToken);
        const scheduled = this.hostRuns.get(run.id);
        const scheduledGroup = scheduled?.processGroupId;
        if (steps.state === "absent" && (!scheduledGroup || processGroupEmpty(scheduledGroup))) {
          const hostStepNeverLaunched = scheduled?.state === "running"
            && !scheduled.pid && !scheduled.processGroupId && !scheduled.startIdentity;
          if (hostStepNeverLaunched && !run.steps.length && !run.failedStep && !run.interruptedStep)
            return { kind: "unstarted", state: null, plan: validPlan };
          if (!run.pid) return { kind: "dead", state: null, reason: "no live process carries this run's identity" };
        }
      }
      if (!run.pid || supervisor.state !== "absent") return { kind: "running", state: null };
      const liveness = await supervisorLivenessAsync(run.pid, validPlan.identityToken);
      observedLiveness = liveness.state;
      if (liveness.state === "dead") {
        const steps = processesForStartIdentity(validPlan.identityToken);
        const scheduledGroup = this.hostRuns.get(run.id)?.processGroupId;
        if (steps.state !== "absent" || scheduledGroup && !processGroupEmpty(scheduledGroup)) return { kind: "running", state: null };
        return { kind: "dead", state: null, reason: liveness.reason };
      }
      return { kind: "running", state: null };
    };
    let inspection = await inspect();
    if (inspection.kind === "dead") {
      const through = new Date().toISOString();
      const window = qaServiceWindow(this.serviceHistory ?? { getMeta: () => undefined }, state?.heartbeatAt ?? run.startedAt, through);
      inspection = { ...inspection, reason: `${inspection.reason}. ${qaLostDiagnosticDetail(state, observedLiveness, observedGroupEmpty, window)}` };
    }
    // Detached supervision files can progress while the OS scan yields too.
    const observedState = this.supervisionFacts.read(statePath);
    if (inspection.kind === "dead" && inspection.staleStop) {
      const lateResult = readHostRunResult(resultPath, run.id);
      if (!lateResult) return inspection;
    }
    if (state && readQaHeartbeat(heartbeatPath, state) !== state.heartbeatAt
        || JSON.stringify(observedState) !== JSON.stringify(stateRead)
        || JSON.stringify(this.supervisionPlans.read(planPath)) !== JSON.stringify(planRead)
        || JSON.stringify(readHostRunResult(resultPath, run.id)) !== JSON.stringify(hostResult))
      return { kind: "running", state: observedState.kind === "present" ? observedState.value : null };
    return inspection;
  }

}
