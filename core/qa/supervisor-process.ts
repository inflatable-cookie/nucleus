/**
 * The detached supervisor's own process lifecycle, shared by both supervision
 * families: milestone QA (`core/qa/project-qa-*`) and project validation
 * (`core/qa/project-validation.ts`) start the same kind of detached Node entry
 * with the run's private identity token as its last argument, and stop one whose
 * heartbeat went stale the same way. One owner keeps the spawn shape and the
 * stop-with-proof rule in one place, so a change to either cannot leave the other
 * family running an older copy.
 *
 * The token in the child's argv is the run's identity: every liveness read and
 * every signal goes through the canonical start-identity and process-group
 * owners, so a reused pid is never signalled.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runtimeNodeArgs } from "../../shared/runtime.mjs";
import { processGroupEmpty, signalProcessGroup, signalProcessGroupByLeader, waitForProcessGroupEmpty } from "../machine/process-group";
import { processesForStartIdentity, processStartIdentityLiveness } from "../machine/process-identity-search";
import { supervisorLiveness, supervisorLivenessAsync } from "../machine/start-identity";

/** The grace a stale supervisor and its groups get between SIGTERM and SIGKILL. */
export const SUPERVISOR_STOP_GRACE_MS = 250;
/** Bounded proof window for process-group reaping after SIGKILL. */
const SUPERVISOR_STOP_PROOF_WAIT_MS = 5_000;

export interface DetachedSupervisorLaunch {
  /** The supervisor entry shipped beside the service. */
  entry: string;
  /**
   * The entry's own arguments. A family that carries the run's private identity
   * token in argv passes it last, so the live process's command line proves it is
   * that run's supervisor.
   */
  argv: string[];
  /** Overlaid on this process's environment, so a run leaf can keep its sockets off the internal drive. */
  environment?: NodeJS.ProcessEnv;
  /** What a launch with no pid means for this caller. */
  failureMessage: string;
}

/**
 * Start one detached supervisor. The child's own command line carries the run's
 * identity token, which is what every later liveness read and stop proves before
 * it signals anything. A spawn that never produced a pid throws the caller's
 * failure; a supervisor that never appears is settled as lost or held by the
 * caller's own reconciliation, never relaunched blindly.
 */
export function spawnDetachedSupervisor(launch: DetachedSupervisorLaunch): number {
  const child = spawn(process.execPath, [...runtimeNodeArgs(), launch.entry, ...launch.argv], {
    detached: true, stdio: "ignore",
    env: { ...process.env, ...launch.environment },
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
  });
  child.on("error", () => { /* no supervisor appears: the caller settles the run as lost or held */ });
  child.unref();
  if (!child.pid) throw new Error(launch.failureMessage);
  return child.pid;
}

export interface DetachedSupervisorStopTarget {
  /** The detached supervisor's own pid. */
  supervisorPid: number;
  /** Its recorded OS birth identity, when the durable record carries one. */
  supervisorStartIdentity?: string;
  /** The run's private identity token: the only processes this stop may signal. */
  identityToken: string;
  /** The step process group the supervisor published, when it published one. */
  activeProcess?: { pid: number; processGroupId: number; startIdentity: string } | null;
}

/**
 * Stop a stale supervisor, its published step group and every remaining process
 * carrying the run's token, then prove they are gone.
 *
 * The caller owns the decision that the heartbeat is stale; this owns the stop
 * and its proof. SIGTERM reaches the step group and the supervisor, the grace
 * passes, and SIGKILL follows for whatever is left. The answer is true only when
 * the supervisor is proven dead or replaced, both groups are empty and no process
 * carries the run token: an unreadable identity is never proof of a stop.
 */
export async function stopDetachedSupervisor(target: DetachedSupervisorStopTarget): Promise<boolean> {
  const { supervisorPid, supervisorStartIdentity, identityToken, activeProcess } = target;
  const signalActiveGroup = (signal: NodeJS.Signals): void => {
    if (!activeProcess) return;
    signalProcessGroup(activeProcess.processGroupId, identityToken, signal);
    signalProcessGroupByLeader(activeProcess.processGroupId, activeProcess.pid, activeProcess.startIdentity, signal);
    const owned = processesForStartIdentity(identityToken);
    if (owned.state === "found") for (const item of owned.processes) {
      if (processStartIdentityLiveness(item.pid, item.startIdentity) === "alive") {
        try { process.kill(item.pid, signal); } catch { /* the identity-checked child exited */ }
      }
    }
  };
  const signalSupervisor = (signal: NodeJS.Signals): void => {
    if (supervisorStartIdentity)
      signalProcessGroupByLeader(supervisorPid, supervisorPid, supervisorStartIdentity, signal);
    if (supervisorLiveness(supervisorPid, identityToken).state !== "live") return;
    try { process.kill(supervisorPid, signal); } catch { /* the verified supervisor exited */ }
  };
  if (activeProcess) signalActiveGroup("SIGTERM");
  signalSupervisor("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, SUPERVISOR_STOP_GRACE_MS));
  if (activeProcess && !processGroupEmpty(activeProcess.processGroupId)) signalActiveGroup("SIGKILL");
  if (!processGroupEmpty(supervisorPid)) signalSupervisor("SIGKILL");
  // SIGKILL is asynchronous: the kernel may still be reaping a supervisor or
  // step group when the signal returns. Wait for the recorded groups to empty
  // before sampling liveness and deciding whether the stop is proved.
  const [supervisorGroupEmpty, activeGroupEmpty] = await Promise.all([
    waitForProcessGroupEmpty(supervisorPid, SUPERVISOR_STOP_PROOF_WAIT_MS),
    activeProcess ? waitForProcessGroupEmpty(activeProcess.processGroupId, SUPERVISOR_STOP_PROOF_WAIT_MS) : Promise.resolve(true),
  ]);
  const supervisor = await supervisorLivenessAsync(supervisorPid, identityToken);
  const identity = supervisorStartIdentity ? processStartIdentityLiveness(supervisorPid, supervisorStartIdentity) : "unknown";
  return (supervisor.state === "dead" || identity === "dead")
    && supervisorGroupEmpty
    && activeGroupEmpty
    && processGroupEmpty(supervisorPid)
    && (!activeProcess || processGroupEmpty(activeProcess.processGroupId))
    && processesForStartIdentity(identityToken).state === "absent";
}
