import { readFileSync, readdirSync } from "node:fs";
import { darwinProcessReads } from "./process-host-reads";
import { environmentHasIdentity, processStartIdentityLiveness } from "./process-identity-search";
import { parseLinuxProcStat } from "./start-identity";

/**
 * Process group custody: which group a recorded identity still proves, and the
 * one signal call that may follow.
 *
 * A group is never addressed by its number alone. Every read here answers the
 * same question — does a live member of this pgid still carry the recorded
 * birth identity — and every signal refuses unless that answer is yes, so a
 * recycled pgid is never signalled.
 */

/** The member pids the kernel lists in this group, or null when the read failed. */
function linuxGroupMembers(pgid: number): number[] | null {
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return null; }
  const members: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const fields = parseLinuxProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (fields && fields.pgid === pgid) members.push(pid);
    } catch { /* A process that exited or cannot be read is not identity proof. */ }
  }
  return members;
}

function linuxGroupHasIdentity(pgid: number, identity: string): boolean {
  const members = linuxGroupMembers(pgid);
  if (!members) return false;
  for (const pid of members) {
    try {
      if (environmentHasIdentity(readFileSync(`/proc/${pid}/environ`), identity)) return true;
    } catch { /* A process that exited or cannot be read is not identity proof. */ }
  }
  return false;
}

function darwinGroupHasIdentity(pgid: number, identity: string): boolean {
  const reads = darwinProcessReads();
  const members = reads.groupMembers(pgid);
  if (members === null || !members.length) return false;
  // The environment scan filters by the marker itself, so a returned member has
  // already proven the recorded identity.
  const found = reads.environmentScan(identity, members);
  return found.state === "found" && found.processes.some(process => process.processGroupId === pgid);
}

/** True only when a live member of `pgid` carries this step's private birth identity. */
export function processGroupHasStartIdentity(pgid: number, identity: string): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 0 || !identity) return false;
  if (process.platform === "linux") return linuxGroupHasIdentity(pgid, identity);
  if (process.platform === "darwin") return darwinGroupHasIdentity(pgid, identity);
  return false;
}

/** Signal a process group only while a live member proves its recorded identity. */
export function signalProcessGroup(pgid: number, identity: string, signal: NodeJS.Signals): boolean {
  if (!processGroupHasStartIdentity(pgid, identity)) return false;
  try { process.kill(-pgid, signal); return true; }
  catch (error) {
    if (["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

/** Signal a detached supervisor's group after proving the recorded leader birth identity. */
export function signalProcessGroupByLeader(pgid: number, leaderPid: number, leaderStartIdentity: string, signal: NodeJS.Signals): boolean {
  if (processStartIdentityLiveness(leaderPid, leaderStartIdentity) !== "alive") return false;
  try { process.kill(-pgid, signal); return true; }
  catch (error) {
    if (["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

/** A process group is empty only when the kernel says no member exists. */
export function processGroupEmpty(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return true;
  try { process.kill(-pgid, 0); return false; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Wait a bounded time for all group members, including descendants, to exit. */
export async function waitForProcessGroupEmpty(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (!processGroupEmpty(pgid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(20, remaining)));
  }
  return true;
}
