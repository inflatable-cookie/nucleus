import type { HostProcessFact } from '../host/types';
/**
 * The terminal host-process sweep: when a task reaches done or cancelled, Queue
 * terminates leftover host processes whose cwd is inside the retained worktree
 * or whose process group Queue recorded for that task's own runs, records the
 * one history event, and clears the durable intent. A failure is advisory and
 * never holds or reopens the task.
 *
 * Which processes are targets is the selector's decision
 * (`host-process-select.ts`); which processes exist is the listing's
 * (`host-process-listing.ts`). This module only stops a target it was given,
 * once, with the start identity it was selected under.
 */
import { existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { processGroupEmpty, signalProcessGroup } from "./process-group";
import { processStartIdentityLiveness } from "./process-identity-search";
import { pidAlive } from "./pid";
import { now, type Store } from "../store/store";
import type { Task } from "../../shared/contracts";
import { readHostUidProcesses } from "./host-process-listing";
import {
  isGroupBirthIdentity, paseoProcessOwnership, provenRecordedPgids, protectedHostPids, queueProcessGroupId,
  recordedGroupIdentityProven, recordedProcessGroupsForTask, selectHostProcessTargetsAndSkips,
  type HostProcessTarget, type RecordedProcessGroup,
} from "./host-process-select";

export const HOST_PROCESS_SWEEP_KIND = "host_process_sweep";
export const HOST_PROCESS_SWEEP_WARNING_KIND = "host_process_sweep_warning";
export const HOST_PROCESS_SWEEP_SETTLED_KIND = "host_process_sweep_settled";
export const HOST_PROCESS_SWEEP_PASEO_SKIPPED_KIND = "host_process_sweep_paseo_skipped";
/** Short grace after SIGTERM before SIGKILL. Archive and recovery must not wait on a 30s hook grace. */
export const HOST_PROCESS_SWEEP_GRACE_MS = 1_500;

export interface HostProcessSweepResult {
  terminated: HostProcessTarget[];
  failed: Array<HostProcessTarget & { reason: string }>;
  /** Paseo-owned targets that matched the sweep scope and were deliberately skipped. */
  skippedPaseo: HostProcessTarget[];
  /**
   * Why the sweep could not read what it needed, or null when it did. An
   * unreadable table or cwd column proves nothing about the host, so nothing is
   * stopped and the sweep is reported as unknown rather than as an empty pass.
   */
  unavailable: HostProcessSweepUnavailable | null;
}

export interface HostProcessSweepUnavailable {
  /** The read that failed, and the reason it could not be made. */
  read: "process-listing" | "cwd-listing";
  reason: string;
}

export interface HostProcessSweepOptions {
  graceMs?: number;
  directory?: string | null;
  recordedGroups?: RecordedProcessGroup[];
  protectedPids?: Iterable<number>;
  /** Test seam; production reads ~/.paseo/paseo.pid. */
  paseoDaemonPid?: number | null;
  /** Run even before the task is terminal (disposition archive). */
  force?: boolean;
  /** Test seam: substitute the host process table. */
  processes?: HostProcessFact[] | null;
  /** Test seam: override start-identity liveness between discovery and signal. */
  identityLiveness?: (pid: number, startIdentity: string) => ReturnType<typeof processStartIdentityLiveness>;
}

const noSweep = (unavailable: HostProcessSweepUnavailable | null = null): HostProcessSweepResult =>
  ({ terminated: [], failed: [], skippedPaseo: [], unavailable });

function signalPid(pid: number, identity: string, signal: NodeJS.Signals, liveness: NonNullable<HostProcessSweepOptions["identityLiveness"]>): boolean {
  if (liveness(pid, identity) !== "alive") return false;
  try { process.kill(pid, signal); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function waitForExit(pids: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (pids.every(pid => !pidAlive(pid))) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(0, deadline - Date.now()))));
  }
}

function formatTarget(target: HostProcessTarget): string {
  return `pid=${target.pid} pgid=${target.pgid} start=${target.startTime} cwd=${target.cwd || "-"} command=${target.command || "-"}`;
}

export function formatHostProcessSweepEvent(result: HostProcessSweepResult): string {
  if (!result.terminated.length && !result.failed.length) return "Host process sweep found no leftover host processes";
  const parts: string[] = [];
  if (result.terminated.length)
    parts.push(`terminated ${result.terminated.length}: ${result.terminated.map(formatTarget).join("; ")}`);
  if (result.failed.length)
    parts.push(`could not stop ${result.failed.length}: ${result.failed.map(target => `${formatTarget(target)} reason=${target.reason}`).join("; ")}`);
  return `Host process sweep ${parts.join(". ")}`;
}

export async function terminateHostProcessTargets(
  targets: HostProcessTarget[],
  options: Pick<HostProcessSweepOptions, "graceMs" | "identityLiveness"> & {
    recordedGroups?: RecordedProcessGroup[];
    paseoPids?: Iterable<number>;
    paseoPgids?: Iterable<number>;
  } = {},
): Promise<Omit<HostProcessSweepResult, "unavailable">> {
  const graceMs = options.graceMs ?? HOST_PROCESS_SWEEP_GRACE_MS;
  const liveness = options.identityLiveness ?? processStartIdentityLiveness;
  const queuePgid = queueProcessGroupId();
  const recordedGroups = options.recordedGroups ?? [];
  const paseoPids = new Set(options.paseoPids ?? []);
  const paseoPgids = new Set(options.paseoPgids ?? []);
  const provenPgids = provenRecordedPgids(recordedGroups, queuePgid, undefined, paseoPgids);
  const terminated: HostProcessTarget[] = [];
  const failed: Array<HostProcessTarget & { reason: string }> = [];
  const groupSignalled = new Set<number>();

  for (const group of recordedGroups) {
    if (!provenPgids.has(group.pgid) || !isGroupBirthIdentity(group.startIdentity)) continue;
    if (signalProcessGroup(group.pgid, group.startIdentity, "SIGTERM")) groupSignalled.add(group.pgid);
  }

  for (const target of targets) {
    if (paseoPids.has(target.pid)) continue;
    if (target.via === "pgid" && !provenPgids.has(target.pgid) && !paseoPgids.has(target.pgid)) {
      failed.push({ ...target, reason: "recorded process group identity not proven" });
      continue;
    }
    if (liveness(target.pid, target.startIdentity) !== "alive") {
      failed.push({ ...target, reason: "start identity changed before signal" });
      continue;
    }
    const sent = groupSignalled.has(target.pgid) || signalPid(target.pid, target.startIdentity, "SIGTERM", liveness);
    if (!sent && pidAlive(target.pid) && liveness(target.pid, target.startIdentity) !== "alive") {
      failed.push({ ...target, reason: "start identity changed before signal" });
      continue;
    }
    if (!sent && pidAlive(target.pid)) {
      failed.push({ ...target, reason: "SIGTERM was refused" });
      continue;
    }
    terminated.push(target);
  }

  const survivors = terminated.filter(target => pidAlive(target.pid));
  if (survivors.length) await waitForExit(survivors.map(target => target.pid), graceMs);

  for (const group of recordedGroups) {
    if (!provenPgids.has(group.pgid) || paseoPgids.has(group.pgid) || !isGroupBirthIdentity(group.startIdentity)) continue;
    if (processGroupEmpty(group.pgid)) continue;
    if (!recordedGroupIdentityProven(group)) continue;
    signalProcessGroup(group.pgid, group.startIdentity, "SIGKILL");
  }
  for (const target of terminated) {
    if (paseoPids.has(target.pid)) continue;
    if (!pidAlive(target.pid)) continue;
    if (liveness(target.pid, target.startIdentity) !== "alive") continue;
    signalPid(target.pid, target.startIdentity, "SIGKILL", liveness);
  }
  if (survivors.length) await waitForExit(survivors.map(target => target.pid), Math.min(400, graceMs));

  const stillLive: Array<HostProcessTarget & { reason: string }> = [];
  const gone: HostProcessTarget[] = [];
  for (const target of terminated) {
    if (paseoPids.has(target.pid)) continue;
    if (!pidAlive(target.pid)) gone.push(target);
    else if (liveness(target.pid, target.startIdentity) === "alive")
      stillLive.push({ ...target, reason: "still running after SIGKILL" });
    else gone.push(target);
  }
  return { terminated: gone, failed: [...failed, ...stillLive], skippedPaseo: [] };
}

export async function reapHostProcesses(input: {
  directory?: string | null;
  recordedGroups?: RecordedProcessGroup[];
  protectedPids?: Iterable<number>;
  paseoDaemonPid?: number | null;
  processes?: HostProcessFact[] | null;
  graceMs?: number;
  identityLiveness?: HostProcessSweepOptions["identityLiveness"];
}): Promise<HostProcessSweepResult> {
  const recorded = input.recordedGroups ?? [];
  let worktree: string | null = null;
  if (input.directory && existsSync(input.directory)) {
    try { worktree = realpathSync(input.directory); }
    catch { worktree = input.directory; }
  }
  if (!worktree && !recorded.length) return noSweep();
  let processes: HostProcessFact[] | null;
  if (input.processes === undefined) {
    const read = await readHostUidProcesses();
    if (read.state === "unknown") return noSweep({ read: "process-listing", reason: read.reason });
    processes = read.processes;
  } else processes = input.processes;
  if (!processes) return noSweep({ read: "process-listing", reason: "the host process listing is unavailable" });
  if (worktree && processes.length && processes.every(process => process.cwd === null))
    return noSweep({ read: "cwd-listing", reason: "no process in the host listing has a readable cwd" });
  const paseo = paseoProcessOwnership(processes, input.paseoDaemonPid);
  const selection = selectHostProcessTargetsAndSkips({
    processes,
    worktree,
    recordedGroups: recorded,
    protectedPids: protectedHostPids([...(input.protectedPids ?? []), ...paseo.pids]),
    queuePgid: queueProcessGroupId(),
    paseo,
  });
  const result = await terminateHostProcessTargets(selection.targets, {
    graceMs: input.graceMs, identityLiveness: input.identityLiveness, recordedGroups: recorded,
    paseoPids: paseo.pids, paseoPgids: paseo.pgids,
  });
  return { ...result, skippedPaseo: selection.skippedPaseo, unavailable: null };
}

export function hostProcessSweepIntent(phase: "done" | "cancelled"): { phase: "done" | "cancelled"; at: string } {
  return { phase, at: now() };
}

/**
 * Run the terminal host-process sweep, record one history event, and clear the
 * durable intent. Listing or kill failure is a warning; the task stays terminal.
 */
export async function sweepTaskHostProcesses(store: Store, task: Task, options: HostProcessSweepOptions = {}): Promise<HostProcessSweepResult> {
  const latest = store.task(task.id);
  const terminal = ["done", "cancelled"].includes(latest.phase);
  if (!terminal && !options.force) return noSweep();
  const owed = latest.resolution.hostProcessSweep != null;
  const directory = options.directory === undefined ? latest.directory : options.directory;
  const recordedGroups = options.recordedGroups ?? recordedProcessGroupsForTask(store, latest);
  let result: HostProcessSweepResult;
  try {
    result = await reapHostProcesses({
      directory,
      recordedGroups,
      protectedPids: options.protectedPids,
      paseoDaemonPid: options.paseoDaemonPid,
      processes: options.processes,
      graceMs: options.graceMs,
      identityLiveness: options.identityLiveness,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    store.event(latest.id, HOST_PROCESS_SWEEP_WARNING_KIND, `Host process sweep could not run: ${reason}`);
    settleSweepIntent(store, latest.id);
    return noSweep();
  }
  if (result.unavailable) {
    // Nothing was proven about the host, so the durable intent stays owed and a
    // later pass re-reads it. The warning names the read that failed.
    store.event(latest.id, HOST_PROCESS_SWEEP_WARNING_KIND, result.unavailable.reason);
    return result;
  }
  if (result.skippedPaseo.length && !store.eventsAll(latest.id).some(event => event.kind === HOST_PROCESS_SWEEP_PASEO_SKIPPED_KIND)) {
    store.event(latest.id, HOST_PROCESS_SWEEP_PASEO_SKIPPED_KIND,
      `Skipped ${result.skippedPaseo.length} Paseo-owned process${result.skippedPaseo.length === 1 ? "" : "es"}: ${result.skippedPaseo.map(formatTarget).join("; ")}`);
  }
  const found = result.terminated.length > 0 || result.failed.length > 0;
  if (found || owed) store.event(latest.id, HOST_PROCESS_SWEEP_KIND, formatHostProcessSweepEvent(result));
  settleSweepIntent(store, latest.id);
  return result;
}

function settleSweepIntent(store: Store, taskId: string): void {
  const latest = store.task(taskId);
  if (!latest.resolution.hostProcessSweep) return;
  if (!["done", "cancelled"].includes(latest.phase)) return;
  store.update(latest.id, { resolution: { ...latest.resolution, hostProcessSweep: null } },
    HOST_PROCESS_SWEEP_SETTLED_KIND, "Host process sweep evaluated; durable intent cleared");
}
