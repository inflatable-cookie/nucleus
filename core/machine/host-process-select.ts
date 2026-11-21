import type { HostProcessFact } from "../host/types";
import { cwdInWorktree } from "../workspaces/worktree-validation";
import {
  processGroupHasStartIdentity,
  processGroupHasStartIdentityAsync,
} from "./process-group";
import { processStartIdentityLiveness } from "./process-identity-search";
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
 * itself is never selected. A host's own runtime is protected by its adapter,
 * which marks those processes on the table it supplies
 * (`HostProcessFact.protectedRuntime`); this module reads the mark and never
 * recognises a runtime by name. A process outside the worktree is selected only
 * while its pgid is a recorded group whose identity is still proven on a live
 * member.
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
export function recordedProcessGroupsForTask(
  store: Store,
  task: Task,
): RecordedProcessGroup[] {
  const groups = new Map<number, string | null>();
  const remember = (
    pgid: number | null | undefined,
    identity: string | null | undefined,
  ) => {
    if (!pgid || !Number.isSafeInteger(pgid) || pgid <= 0) return;
    const current = groups.get(pgid);
    if (!current && identity) groups.set(pgid, identity);
    else if (!groups.has(pgid)) groups.set(pgid, identity ?? null);
  };
  for (const record of store.hookEvents(task.id))
    remember(record.processGroupId, record.leaderStartIdentity);
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
    const getpgid = (
      process as NodeJS.Process & { getpgid?: (pid?: number) => number }
    ).getpgid;
    if (typeof getpgid === "function") return getpgid(0);
  } catch {
    /* EPERM: fall through to pid. */
  }
  return process.pid;
}

export function livePgid(pid: number): number | null {
  try {
    const getpgid = (
      process as NodeJS.Process & { getpgid?: (pid?: number) => number }
    ).getpgid;
    if (typeof getpgid === "function") return getpgid(pid);
  } catch {
    /* ESRCH/EPERM: unproven. */
  }
  return null;
}

function startTimeOf(identity: string): string {
  const at = identity.indexOf("@");
  return at > 0 ? identity.slice(at + 1) : "unknown";
}

function hostProcessTarget(
  fact: HostProcessFact,
  via: HostProcessTarget["via"],
): HostProcessTarget {
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
  const protectedPids = new Set<number>(
    [process.pid, process.ppid].filter(
      (pid) => Number.isSafeInteger(pid) && pid > 0,
    ),
  );
  if (extra)
    for (const pid of extra)
      if (Number.isSafeInteger(pid) && pid > 0) protectedPids.add(pid);
  return protectedPids;
}

export function isGroupBirthIdentity(
  identity: string | null,
): identity is string {
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
  if (!identity || !Number.isSafeInteger(group.pgid) || group.pgid <= 0)
    return false;
  if (!identity.includes("@") && identity.length >= 8)
    return processGroupHasStartIdentity(group.pgid, identity);
  if (!identity.includes("@") || identity.endsWith("@unknown")) return false;
  if (processes) {
    return processes.some(
      (fact) =>
        fact.pgid === group.pgid &&
        startIdentityMatches(identity, fact.startIdentity),
    );
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

/**
 * The same proof off the event loop. A `pid@time` record is answered from the
 * caller's table; only a legacy marker identity needs a member read, and that one
 * is spawned.
 */
export async function recordedGroupIdentityProvenAsync(
  group: RecordedProcessGroup,
  processes?: HostProcessFact[],
): Promise<boolean> {
  const identity = group.startIdentity;
  if (!identity || !Number.isSafeInteger(group.pgid) || group.pgid <= 0)
    return false;
  if (!identity.includes("@"))
    return processGroupHasStartIdentityAsync(group.pgid, identity);
  return recordedGroupIdentityProven(group, processes);
}

/** `provenRecordedPgids` with its legacy marker proofs awaited. */
export async function provenRecordedPgidsAsync(
  groups: RecordedProcessGroup[],
  queuePgid: number,
  processes?: HostProcessFact[],
  protectedPgids: ReadonlySet<number> = new Set(),
): Promise<Set<number>> {
  const proven = new Set<number>();
  for (const group of groups) {
    if (group.pgid === queuePgid || protectedPgids.has(group.pgid)) continue;
    if (await recordedGroupIdentityProvenAsync(group, processes))
      proven.add(group.pgid);
  }
  return proven;
}

export interface HostProcessSelection {
  targets: HostProcessTarget[];
  /** In-scope processes the host adapter marked as its protected runtime. */
  skippedProtected: HostProcessTarget[];
}

export function selectHostProcessTargetsAndSkips(input: {
  processes: HostProcessFact[];
  worktree: string | null;
  recordedGroups: RecordedProcessGroup[];
  protectedPids: Set<number>;
  queuePgid: number;
}): HostProcessSelection {
  const blockedPgids = new Set<number>();
  for (const fact of input.processes)
    if (fact.protectedRuntime || input.protectedPids.has(fact.pid))
      blockedPgids.add(fact.pgid);
  const provenPgids = provenRecordedPgids(
    input.recordedGroups,
    input.queuePgid,
    input.processes,
    blockedPgids,
  );
  const selected = new Map<number, HostProcessTarget>();
  const skippedProtected: HostProcessTarget[] = [];
  for (const fact of input.processes) {
    if (fact.startIdentity.endsWith("@unknown")) continue;
    const inGroup = provenPgids.has(fact.pgid);
    const inTree = Boolean(
      input.worktree && fact.cwd && cwdInWorktree(fact.cwd, input.worktree),
    );
    if (!inGroup && !inTree) continue;
    const target = hostProcessTarget(fact, inGroup ? "pgid" : "cwd");
    if (fact.protectedRuntime) {
      skippedProtected.push(target);
      continue;
    }
    if (input.protectedPids.has(fact.pid)) continue;
    if (fact.pid === process.pid || fact.pid === process.ppid) continue;
    selected.set(fact.pid, target);
  }
  return { targets: [...selected.values()], skippedProtected };
}

/**
 * Select kill targets from a process table. Queue itself and every process the
 * host adapter marked as its protected runtime are never selected. A process
 * outside the worktree is selected only when its pgid is a recorded group whose
 * identity is still proven on a live member.
 */
export function selectHostProcessTargets(input: {
  processes: HostProcessFact[];
  worktree: string | null;
  recordedGroups: RecordedProcessGroup[];
  protectedPids: Set<number>;
  queuePgid: number;
}): HostProcessTarget[] {
  return selectHostProcessTargetsAndSkips(input).targets;
}
