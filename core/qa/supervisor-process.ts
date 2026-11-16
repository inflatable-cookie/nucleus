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
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runtimeNodeArgs } from "../../shared/runtime.mjs";
import { processGroupEmpty, signalProcessGroup, signalProcessGroupByLeader } from "../machine/process-group";
import { processesForStartIdentity, processStartIdentityLiveness } from "../machine/process-identity-search";
import { supervisorLiveness, supervisorLivenessAsync } from "../machine/start-identity";
import { hostRunProcessStartIdentity } from "../machine/start-identity";

/** The grace a stale supervisor and its groups get between SIGTERM and SIGKILL. */
export const SUPERVISOR_STOP_GRACE_MS = 250;

/**
 * Spec 064 P2: the detached supervisor's actual child exit, retained by the
 * parent that spawned it. It is the parent's own `exit` event for the child it
 * started — never a census, an EOF or a PID poll — and it carries both start
 * identities so a reused pid reads as a different process.
 */
export type DetachedSupervisorExit =
  | {
    state: "observed"; pid: number; startIdentity: string; code: number | null; signal: string | null;
    observedAt: string; source: "child-exit-event";
  }
  | { state: "unknown"; pid: number; startIdentity: string | null; reason: string; observedAt: string };

/** The opt-in retained-child return: the supervisor's pid and its exit promise. */
export interface RetainedDetachedSupervisor {
  pid: number;
  /** Settles only when this parent observes its actual child's exit (or its spawn error). */
  exited: Promise<DetachedSupervisorExit>;
}

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
  /**
   * Spec 064 P2 (opt-in): retain this parent's actual child exit for the whole
   * attempt instead of returning only a pid. Absent keeps every existing caller's
   * pid-only return unchanged.
   */
  retainChild?: boolean;
}

/**
 * Start one detached supervisor. The child's own command line carries the run's
 * identity token, which is what every later liveness read and stop proves before
 * it signals anything. A spawn that never produced a pid throws the caller's
 * failure; a supervisor that never appears is settled as lost or held by the
 * caller's own reconciliation, never relaunched blindly.
 *
 * Spec 064 P2: a caller that asks for `retainChild` gets this parent's actual
 * child exit promise for the whole attempt (the service→S wait), so the wait is
 * observed rather than inferred. Every other caller keeps the pid-only return.
 */
export function spawnDetachedSupervisor(launch: DetachedSupervisorLaunch & { retainChild: true }): RetainedDetachedSupervisor;
export function spawnDetachedSupervisor(launch: DetachedSupervisorLaunch): number;
export function spawnDetachedSupervisor(launch: DetachedSupervisorLaunch): number | RetainedDetachedSupervisor {
  const child = spawn(process.execPath, [...runtimeNodeArgs(), launch.entry, ...launch.argv], {
    detached: true, stdio: "ignore",
    env: { ...process.env, ...launch.environment },
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
  });
  const exited = launch.retainChild ? retainedChildExit(child) : null;
  child.on("error", () => { /* no supervisor appears: the caller settles the run as lost or held */ });
  child.unref();
  if (!child.pid) throw new Error(launch.failureMessage);
  if (!exited) return child.pid;
  return { pid: child.pid, exited };
}

/** The parent's own observation of the child it just spawned; it never rejects. */
function retainedChildExit(child: ChildProcess): Promise<DetachedSupervisorExit> {
  return new Promise(resolvePromise => {
    const pid = child.pid ?? 0;
    const startIdentity = pid ? hostRunProcessStartIdentity(pid) : null;
    child.on("exit", (code, signal) => resolvePromise({
      state: "observed", pid, startIdentity: startIdentity ?? "", code, signal,
      observedAt: new Date().toISOString(), source: "child-exit-event",
    }));
    child.on("error", error => resolvePromise({
      state: "unknown", pid, startIdentity, observedAt: new Date().toISOString(),
      reason: `The detached supervisor's own child exit was never observed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  });
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
  /**
   * Spec 064 P3: a qualification stop never terminates S as a cleanup shortcut.
   * With `qualification_direct`, this route declines before any signal and the
   * caller retains the unknown closure; only S's own cooperative stop may end it.
   */
  stopMode?: "group" | "qualification_direct";
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
  // Spec 064 P3: a qualification attempt's supervisor is never stopped by this
  // cleanup route. Nothing is signalled; false is "not proven stopped", which the
  // caller keeps as unknown closure rather than escalating.
  if (target.stopMode === "qualification_direct") return false;
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
  const supervisor = await supervisorLivenessAsync(supervisorPid, identityToken);
  const identity = supervisorStartIdentity ? processStartIdentityLiveness(supervisorPid, supervisorStartIdentity) : "unknown";
  return (supervisor.state === "dead" || identity === "dead")
    && processGroupEmpty(supervisorPid)
    && (!activeProcess || processGroupEmpty(activeProcess.processGroupId))
    && processesForStartIdentity(identityToken).state === "absent";
}
