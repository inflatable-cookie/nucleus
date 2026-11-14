import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostProcessFact } from "../host/types";
import { cwdInWorktree } from "../workspaces/worktree-validation";
import { processGroupHasStartIdentity, processStartIdentityLiveness } from "./process-group";
import { startIdentityMatches } from "./start-identity";
import type { Store } from "../store/store";
import type { Task } from "../../shared/contracts";

/**
 * Which host processes a task's terminal sweep may stop, and which it must
 * leave alone. This module is the pure decision: it reads the process table it
 * is given and the task's recorded groups, and returns targets and skips. It
 * signals nothing.
 *
 * Identity is pid or pgid plus start identity, never a command pattern. Queue
 * itself, Paseo and its daemon are never selected, and a process outside the
 * worktree is selected only while its pgid is a recorded group whose identity
 * is still proven on a live member.
 */

export interface RecordedProcessGroup {
  pgid: number;
  startIdentity: string | null;
}

export interface HostProcessTarget {
  pid: number;
  pgid: number;
  startIdentity: string;
  startTime: string;
  cwd: string;
  command: string;
  via: "cwd" | "pgid";
}

/** A recorded process group the task's own runs, hooks or validation left behind. */
export function recordedProcessGroupsForTask(store: Store, task: Task): RecordedProcessGroup[] {
  const groups = new Map<number, string | null>();
  const remember = (pgid: number | null | undefined, identity: string | null | undefined) => {
    if (!pgid || !Number.isSafeInteger(pgid) || pgid <= 0) return;
    const current = groups.get(pgid);
    if (!current && identity) groups.set(pgid, identity);
    else if (!groups.has(pgid)) groups.set(pgid, identity ?? null);
  };
  for (const record of store.hookEvents(task.id)) remember(record.processGroupId, record.leaderStartIdentity);
  const validation = task.resolution.projectValidation;
  if (validation) {
    remember(validation.processGroupId, validation.leaderStartIdentity);
    if (validation.hostRunId) {
      const run = store.hostRun(validation.hostRunId);
      if (run) remember(run.processGroupId, run.startIdentity);
    }
  }
  return [...groups].map(([pgid, startIdentity]) => ({ pgid, startIdentity }));
}

/** Queue's own process group: never a sweep target, and never a recorded group. */
export function queueProcessGroupId(): number {
  try {
    const getpgid = (process as NodeJS.Process & { getpgid?: (pid?: number) => number }).getpgid;
    if (typeof getpgid === "function") return getpgid(0);
  } catch { /* EPERM: fall through to pid. */ }
  return process.pid;
}

function livePgid(pid: number): number | null {
  try {
    const getpgid = (process as NodeJS.Process & { getpgid?: (pid?: number) => number }).getpgid;
    if (typeof getpgid === "function") return getpgid(pid);
  } catch { /* ESRCH/EPERM: unproven. */ }
  return null;
}

function startTimeOf(identity: string): string {
  const at = identity.indexOf("@");
  return at > 0 ? identity.slice(at + 1) : "unknown";
}

function commandLooksLikePaseo(command: string): boolean {
  return command.trim().split(/\s+/).some(token => {
    const base = token.split(/[\\/]/).pop() ?? "";
    return /^(paseo|paseod|paseo-daemon|paseo-supervisor)(\.exe)?$/i.test(base) || /Paseo\.app/i.test(token);
  });
}

function paseoDaemonPidFromFile(): number | null {
  try {
    const contents = readFileSync(join(homedir(), ".paseo", "paseo.pid"), "utf8");
    const match = /^\s*(\d+)\s*$/.exec(contents);
    const pid = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

export interface PaseoProcessOwnership {
  daemonPid: number | null;
  daemonPgid: number | null;
  pids: Set<number>;
  pgids: Set<number>;
}

/** Every process Paseo or its daemon owns: its descendants and its process group. */
export function paseoProcessOwnership(
  processes: HostProcessFact[],
  configuredDaemonPid?: number | null,
  lookupMissingDaemonPgid = true,
): PaseoProcessOwnership {
  const configured = configuredDaemonPid === undefined ? paseoDaemonPidFromFile() : configuredDaemonPid;
  const daemonPid = Number.isSafeInteger(configured) && configured! > 0 ? configured! : null;
  const byPid = new Map(processes.map(fact => [fact.pid, fact]));
  const roots = new Set<number>();
  for (const fact of processes) if (commandLooksLikePaseo(fact.command)) roots.add(fact.pid);
  if (daemonPid !== null) roots.add(daemonPid);

  const daemonFact = daemonPid === null ? undefined : byPid.get(daemonPid);
  const daemonPgid = daemonFact?.pgid ?? (lookupMissingDaemonPgid && daemonPid !== null ? livePgid(daemonPid) : null);
  const pids = new Set<number>();
  const pgids = new Set<number>();
  if (daemonPgid !== null && daemonPgid > 0) pgids.add(daemonPgid);

  for (const fact of processes) {
    let current: HostProcessFact | undefined = fact;
    const visited = new Set<number>();
    let owned = false;
    while (current && !visited.has(current.pid)) {
      visited.add(current.pid);
      if (roots.has(current.pid)) { owned = true; break; }
      const parent = current.ppid;
      if (!parent || parent <= 0 || parent === current.pid) break;
      if (roots.has(parent)) { owned = true; break; }
      current = byPid.get(parent);
    }
    if (daemonPgid !== null && fact.pgid === daemonPgid) owned = true;
    if (!owned) continue;
    pids.add(fact.pid);
    if (Number.isSafeInteger(fact.pgid) && fact.pgid > 0) pgids.add(fact.pgid);
  }
  return { daemonPid, daemonPgid, pids, pgids };
}

function hostProcessTarget(fact: HostProcessFact, via: HostProcessTarget["via"]): HostProcessTarget {
  return {
    pid: fact.pid,
    pgid: fact.pgid,
    startIdentity: fact.startIdentity,
    startTime: startTimeOf(fact.startIdentity),
    cwd: fact.cwd ?? "",
    command: fact.command || `pid ${fact.pid}`,
    via,
  };
}

/** This process, its parent, and the caller's own protected identities. */
export function protectedHostPids(extra?: Iterable<number>): Set<number> {
  const protectedPids = new Set<number>([process.pid, process.ppid].filter(pid => Number.isSafeInteger(pid) && pid > 0));
  if (extra) for (const pid of extra) if (Number.isSafeInteger(pid) && pid > 0) protectedPids.add(pid);
  return protectedPids;
}

export function isGroupBirthIdentity(identity: string | null): identity is string {
  return Boolean(identity && !identity.includes("@") && identity.length >= 8);
}

/**
 * A recorded process group is proven only while a live member still carries
 * the recorded identity. UUID tokens look for NUCLEUS_QUEUE_PROCESS_START_IDENTITY
 * (and the retained NORTHSTAR_ one, which pre-Nucleus groups still carry) on a
 * current group member. OS pid@time tokens match a live member of that pgid.
 */
export function recordedGroupIdentityProven(
  group: RecordedProcessGroup,
  processes?: HostProcessFact[],
): boolean {
  const identity = group.startIdentity;
  if (!identity || !Number.isSafeInteger(group.pgid) || group.pgid <= 0) return false;
  if (!identity.includes("@") && identity.length >= 8) return processGroupHasStartIdentity(group.pgid, identity);
  if (!identity.includes("@") || identity.endsWith("@unknown")) return false;
  if (processes) {
    return processes.some(fact => fact.pgid === group.pgid && startIdentityMatches(identity, fact.startIdentity));
  }
  const pid = Number(identity.slice(0, identity.indexOf("@")));
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (processStartIdentityLiveness(pid, identity) !== "alive") return false;
  const pgid = livePgid(pid);
  return pgid === null || pgid === group.pgid;
}

export function provenRecordedPgids(
  groups: RecordedProcessGroup[],
  queuePgid: number,
  processes?: HostProcessFact[],
  protectedPgids: ReadonlySet<number> = new Set(),
): Set<number> {
  const proven = new Set<number>();
  for (const group of groups) {
    if (group.pgid === queuePgid || protectedPgids.has(group.pgid)) continue;
    if (recordedGroupIdentityProven(group, processes)) proven.add(group.pgid);
  }
  return proven;
}

export interface HostProcessSelection {
  targets: HostProcessTarget[];
  skippedPaseo: HostProcessTarget[];
}

export function selectHostProcessTargetsAndSkips(input: {
  processes: HostProcessFact[];
  worktree: string | null;
  recordedGroups: RecordedProcessGroup[];
  protectedPids: Set<number>;
  queuePgid: number;
  paseo: PaseoProcessOwnership;
}): HostProcessSelection {
  const blockedPgids = new Set(input.paseo.pgids);
  const provenPgids = provenRecordedPgids(input.recordedGroups, input.queuePgid, input.processes, blockedPgids);
  const selected = new Map<number, HostProcessTarget>();
  const skippedPaseo: HostProcessTarget[] = [];
  for (const fact of input.processes) {
    if (fact.startIdentity.endsWith("@unknown")) continue;
    const inGroup = provenPgids.has(fact.pgid);
    const inTree = Boolean(input.worktree && fact.cwd && cwdInWorktree(fact.cwd, input.worktree));
    if (!inGroup && !inTree) continue;
    const target = hostProcessTarget(fact, inGroup ? "pgid" : "cwd");
    if (input.paseo.pids.has(fact.pid)) {
      skippedPaseo.push(target);
      continue;
    }
    if (input.protectedPids.has(fact.pid)) continue;
    if (fact.pid === process.pid || fact.pid === process.ppid) continue;
    if (commandLooksLikePaseo(fact.command)) {
      skippedPaseo.push(target);
      continue;
    }
    selected.set(fact.pid, target);
  }
  return { targets: [...selected.values()], skippedPaseo };
}

/**
 * Select kill targets from a process table. Queue itself, Paseo and its daemon
 * are never selected. A process outside the worktree is selected only when its
 * pgid is a recorded group whose identity is still proven on a live member.
 */
export function selectHostProcessTargets(input: {
  processes: HostProcessFact[];
  worktree: string | null;
  recordedGroups: RecordedProcessGroup[];
  protectedPids: Set<number>;
  queuePgid: number;
  paseoDaemonPid?: number | null;
}): HostProcessTarget[] {
  // This selector is a pure decision over the supplied process snapshot. The
  // production reap path may resolve the configured daemon and query its live
  // pgid before calling the lower-level selector.
  const paseo = paseoProcessOwnership(input.processes, input.paseoDaemonPid ?? null, false);
  return selectHostProcessTargetsAndSkips({ ...input, paseo }).targets;
}
