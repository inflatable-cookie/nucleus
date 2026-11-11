import { SupervisorLivenessReader } from "../machine/supervisor-liveness";
import { FileFacts } from "../machine/file-facts";
import { isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { repositoryOrigin } from "../planning/lanes";
import type { Store } from "../store/store";
import type { HostRunScheduler } from "../host-runs/host-run-scheduler";
import type { ProjectQaRun, HostRunResult, HostRunEscapedDescendant } from "../../shared/contracts";
import {
  readQaSupervision,
  readQaSupervisionPlan,
  readHostRunResult,
  qaSupervisionPaths,
  type QaSupervisionState,
  type QaSupervisionPlan,
} from "./project-qa-supervision-files";
import { supervisorLiveness, supervisorLivenessAsync } from "../machine/supervisor-liveness";
import { findProcessByCommandTokenAsync } from "../machine/process-identity";
import { processGroupEmpty, processStartIdentityLiveness, processesForStartIdentity, signalProcessGroup, signalProcessGroupByLeader } from "../machine/process-group";
import { confirmStaleSupervisorHeartbeat, SUPERVISOR_STUCK_CONFIRMATION_MS } from "../machine/supervisor-watchdog";

/** What one running row's durable evidence says about its supervisor. */
export type SupervisorInspection =
  | { kind: "settled"; state: QaSupervisionState | null; hostResult: HostRunResult | null }
  | { kind: "running"; state: QaSupervisionState | null }
  | { kind: "unstarted"; state: null; plan: QaSupervisionPlan }
  | { kind: "dead"; state: QaSupervisionState | null; reason: string; escapedDescendants?: HostRunEscapedDescendant[] };

const sleep = (ms: number) => new Promise<void>(resolvePromise => { setTimeout(resolvePromise, ms); });

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
      await this.reconcile(run.key, run.id).catch(() => { /* reconciliation is best-effort on reads */ });
      return this.store.qaRun(input.id);
    }
    const origin = isAbsolute(input.repository) ? null : normalizeRepositoryOrigin(input.repository);
    if (origin) {
      await this.reconcile(origin).catch(() => { /* reconciliation is best-effort on reads */ });
      const direct = this.store.latestQaRun(origin);
      if (direct) return direct;
    }
    if (isAbsolute(input.repository)) {
      const real = await realpath(input.repository).catch(() => input.repository);
      const checkoutOrigin = await repositoryOrigin(real).catch(() => null);
      const key = checkoutOrigin ?? real;
      await this.reconcile(key).catch(() => { /* reconciliation is best-effort on reads */ });
      return this.store.latestQaRun(key);
    }
    return this.store.latestQaRun(origin ?? input.repository);
  }

};

export class ProjectQaInspection {
  private readonly staleSupervisorObservations = new Map<string, { heartbeatAt: string; firstObservedAt: number }>();
  constructor(readonly hostRuns: Pick<HostRunScheduler, "get">, readonly qaRepositoryRootPath: (key: string) => string) {}

  /**
   * Classify a running row's supervisor from its durable evidence. The
   * supervision file carries the supervisor's pid and identity token once it
   * starts; before that, the plan the service wrote before spawning carries the
   * token. A pid is only ever trusted together with that token, and an
   * unreadable identity stays unresolved rather than being reaped.
   */
  private readonly supervisorLiveness = new SupervisorLivenessReader();
  private readonly supervisionFacts = new FileFacts(readQaSupervision);
  private readonly supervisionPlans = new FileFacts(readQaSupervisionPlan);

  async inspectSupervisor(run: ProjectQaRun): Promise<SupervisorInspection> {
    const attempt = run.teardownRetryAttempt ?? 0;
    const { statePath, planPath, resultPath } = qaSupervisionPaths(this.qaRepositoryRootPath(run.key), run.id, attempt);
    const state = this.supervisionFacts.read(statePath);
    const plan = this.supervisionPlans.read(planPath);
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
        const staleAgeMs = confirmStaleSupervisorHeartbeat(this.staleSupervisorObservations, run.id, state.heartbeatAt);
        const sameSupervisorAlive = staleAgeMs !== null && state.supervisorStartIdentity
          && processStartIdentityLiveness(state.pid, state.supervisorStartIdentity) === "alive";
        if (staleAgeMs !== null && (liveness.state === "live" || sameSupervisorAlive)) {
          // A live process with no recent durable heartbeat has a blocked event
          // loop. Stop its owned child group and detached supervisor group using
          // the run token carried in each group's inherited environment.
          const signalActiveGroup = (signal: NodeJS.Signals): void => {
            const active = state.activeProcess;
            if (!active) return;
            signalProcessGroup(active.processGroupId, state.identityToken, signal);
            signalProcessGroupByLeader(active.processGroupId, active.pid, active.startIdentity, signal);
            const owned = processesForStartIdentity(state.identityToken);
            if (owned.state === "found") for (const item of owned.processes) {
              if (processStartIdentityLiveness(item.pid, item.startIdentity) === "alive") {
                try { process.kill(item.pid, signal); } catch { /* the identity-checked child exited */ }
              }
            }
          };
          if (state.activeProcess) signalActiveGroup("SIGTERM");
          const signalSupervisor = (signal: NodeJS.Signals): void => {
            if (state.supervisorStartIdentity)
              signalProcessGroupByLeader(state.pid, state.pid, state.supervisorStartIdentity, signal);
            if (supervisorLiveness(state.pid, state.identityToken).state !== "live") return;
            try { process.kill(state.pid, signal); } catch { /* the verified supervisor exited */ }
          };
          signalSupervisor("SIGTERM");
          await sleep(250);
          if (state.activeProcess && !processGroupEmpty(state.activeProcess.processGroupId)) signalActiveGroup("SIGKILL");
          if (!processGroupEmpty(state.pid)) signalSupervisor("SIGKILL");
          const stoppedLiveness = await supervisorLivenessAsync(state.pid, state.identityToken);
          const stoppedIdentity = state.supervisorStartIdentity
            ? processStartIdentityLiveness(state.pid, state.supervisorStartIdentity) : "unknown";
          const stoppedCommands = processesForStartIdentity(state.identityToken);
          const activeGroupStopped = !state.activeProcess || processGroupEmpty(state.activeProcess.processGroupId);
          const supervisorGroupStopped = processGroupEmpty(state.pid);
          if ((stoppedLiveness.state === "dead" || stoppedIdentity === "dead")
              && activeGroupStopped && supervisorGroupStopped && stoppedCommands.state === "absent")
            return { kind: "dead", state, reason: `the supervisor heartbeat was stale for ${staleAgeMs}ms and unchanged across checks ${SUPERVISOR_STUCK_CONFIRMATION_MS}ms apart; its process groups were stopped` };
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
      if (liveness.state === "dead") {
        const steps = processesForStartIdentity(validPlan.identityToken);
        const scheduledGroup = this.hostRuns.get(run.id)?.processGroupId;
        if (steps.state !== "absent" || scheduledGroup && !processGroupEmpty(scheduledGroup)) return { kind: "running", state: null };
        return { kind: "dead", state: null, reason: liveness.reason };
      }
      return { kind: "running", state: null };
    };
    const inspection = await inspect();
    // Detached supervision files can progress while the OS scan yields too.
    const observedState = this.supervisionFacts.read(statePath);
    if (inspection.kind === "dead" && inspection.reason.startsWith("the supervisor heartbeat was stale")
        ) {
      const lateResult = readHostRunResult(resultPath, run.id);
      if (!lateResult) return inspection;
    }
    if (observedState !== state
        || this.supervisionPlans.read(planPath) !== plan
        || JSON.stringify(readHostRunResult(resultPath, run.id)) !== JSON.stringify(hostResult))
      return { kind: "running", state: observedState };
    return inspection;
  }

}
