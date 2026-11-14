import { readFileSync, readdirSync } from "node:fs";
import { pidAlive } from "./pid";
import { parseLinuxProcStat, linuxStartIdentity, macStartIdentity, startIdentityMatches } from "./start-identity";
import { darwinProcessReads } from "./process-host-reads";

/**
 * Which host processes carry one process group's private birth identity, and
 * which identity a live pid has now.
 *
 * The identity is a marker in the process environment (or command line, which
 * `ps` exposes) plus the OS start identity that proves a pid was not reused.
 * This module owns the marker form, the two platform searches and the single
 * tri-state answer every custody decision reads: found, absent, unknown.
 */

/** Unique birth identity inherited by a step's leader and descendants. */
export const PROCESS_START_IDENTITY_ENV = "NUCLEUS_QUEUE_PROCESS_START_IDENTITY";
/**
 * Retained read only: a process group recorded before Nucleus, or an escaped
 * descendant of one, still carries this marker and no launch writes it now.
 * Dropping the read would make that recorded group unprovable and unreapable.
 */
export const LEGACY_PROCESS_START_IDENTITY_ENV = "NORTHSTAR_QUEUE_PROCESS_START_IDENTITY";
const PROCESS_START_IDENTITY_ENVS = [PROCESS_START_IDENTITY_ENV, LEGACY_PROCESS_START_IDENTITY_ENV];

/** One identity under the current name; the retained marker is read, never written. */
export function processStartIdentityEnvironment(identity: string): Record<string, string> {
  return { [PROCESS_START_IDENTITY_ENV]: identity };
}

export function identityMarkers(identity: string): string[] {
  return PROCESS_START_IDENTITY_ENVS.map(name => `${name}=${identity}`);
}

export function environmentHasIdentity(environment: Buffer, identity: string): boolean {
  return identityMarkers(identity).some(marker => environment.includes(Buffer.from(`${marker}\0`)));
}

export function commandHasIdentity(command: string, identity: string): boolean {
  return identityMarkers(identity).some(marker => command.includes(marker));
}

export interface ProcessStartIdentityFact { pid: number; processGroupId: number; startIdentity: string }
export type ProcessStartIdentitySearch =
  | { state: "found"; processes: ProcessStartIdentityFact[] }
  | { state: "absent" }
  | { state: "unknown" };

export type ProcessStartIdentityLiveness = "alive" | "dead" | "unknown";

/** The Darwin reads this search makes, injected in tests. */
const darwinReads = () => darwinProcessReads();

/** Check a recorded pid against the same OS start identity used by process scans. */
export function processStartIdentityLiveness(pid: number, startIdentity: string): ProcessStartIdentityLiveness {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !startIdentity.startsWith(`${pid}@`)) return "unknown";
  if (process.platform === "linux") {
    try {
      const observed = linuxStartIdentity(pid, readFileSync(`/proc/${pid}/stat`, "utf8"), linuxBootId());
      if (observed.endsWith("@unknown")) return "unknown";
      return startIdentityMatches(startIdentity, observed) ? "alive" : "dead";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ESRCH" ? "dead" : "unknown";
    }
  }
  if (process.platform === "darwin") {
    // `ps` cannot tell "no such process" from "could not be observed": only the
    // kernel's own ESRCH proves the pid is gone.
    const line = darwinReads().startLine(pid);
    if (line === null) return pidAlive(pid) ? "unknown" : "dead";
    const observed = macStartIdentity(pid, line);
    if (observed.endsWith("@unknown")) return "unknown";
    return startIdentityMatches(startIdentity, observed) ? "alive" : "dead";
  }
  return "unknown";
}

/** Test seam: substitute identity listings. Production is null. */
let identityListingOverride: ProcessStartIdentitySearch | null = null;
export function overrideIdentityListing(result: ProcessStartIdentitySearch | null): void {
  identityListingOverride = result;
}

/** One `/proc/sys/kernel/random/boot_id` read, cached for the process's life. */
let cachedBootId: string | null | undefined;
export function linuxBootId(): string | null {
  if (cachedBootId === undefined) {
    try { cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null; }
    catch { cachedBootId = null; }
  }
  return cachedBootId;
}

function linuxIdentitySearch(identity: string): ProcessStartIdentitySearch {
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return { state: "unknown" }; }
  const processes: ProcessStartIdentityFact[] = [];
  let unreadable = false;
  const bootId = linuxBootId();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = parseLinuxProcStat(stat);
      const environment = readFileSync(`/proc/${pid}/environ`);
      if (!fields || !environmentHasIdentity(environment, identity)) continue;
      processes.push({ pid, processGroupId: fields.pgid, startIdentity: linuxStartIdentity(pid, stat, bootId) });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ESRCH") unreadable = true;
    }
  }
  if (processes.length) return { state: "found", processes };
  return unreadable ? { state: "unknown" } : { state: "absent" };
}

/** Find live processes carrying a step's inherited private identity. */
export function processesForStartIdentity(identity: string): ProcessStartIdentitySearch {
  if (!identity) return { state: "absent" };
  if (identityListingOverride) return identityListingOverride;
  if (process.platform === "linux") return linuxIdentitySearch(identity);
  // A host-wide `ps -E -A` times out or overflows on a loaded board (load ~50
  // is normal here), and its failure is `unknown`, never "no escaped
  // descendants".
  if (process.platform === "darwin") return darwinReads().fullEnvironmentScan(identity);
  return { state: "unknown" };
}

/**
 * Identity-bearing processes reachable from this run's group or already-known
 * pids. Darwin walks the cheap host listing (no `-E`) and reads marker
 * environments only for those candidates, so a `setsid` descendant is found
 * while its parent still lives without a host-wide `ps -E -A`. Linux already
 * walks `/proc` for the marker, so it uses the full search.
 */
export function processesForStartIdentityInTree(
  identity: string,
  roots: { processGroupId: number | null; pids: readonly number[] },
): ProcessStartIdentitySearch {
  if (!identity) return { state: "absent" };
  if (identityListingOverride) return identityListingOverride;
  if (process.platform === "linux") return processesForStartIdentity(identity);
  if (process.platform !== "darwin") return { state: "unknown" };
  const reads = darwinReads();
  const listing = reads.processListing();
  if (listing === null) return { state: "unknown" };
  const children = new Map<number, number[]>();
  for (const line of listing) {
    const siblings = children.get(line.ppid);
    if (siblings) siblings.push(line.pid); else children.set(line.ppid, [line.pid]);
  }
  const candidates = new Set<number>(roots.pids.filter(pid => Number.isSafeInteger(pid) && pid > 0));
  if (roots.processGroupId) for (const line of listing) if (line.pgid === roots.processGroupId) candidates.add(line.pid);
  const pending = [...candidates];
  while (pending.length) {
    const pid = pending.pop()!;
    for (const child of children.get(pid) ?? []) if (!candidates.has(child)) { candidates.add(child); pending.push(child); }
  }
  if (!candidates.size) return { state: "absent" };
  return reads.environmentScan(identity, [...candidates]);
}
