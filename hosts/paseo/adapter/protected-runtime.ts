import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostProcessFact } from "../../../core/host";
import type { HostProcessTable } from "../../../core/host/types";

/**
 * Paseo's own runtime, recognised on the adapter side only. Shared cleanup reads
 * the `protectedRuntime` mark this module sets on the process table; it never
 * learns Paseo's names or its pid file.
 */

/** The Paseo daemon pid file, the one place the daemon records its pid. */
export const PASEO_DAEMON_PID_PATH = join(homedir(), ".paseo", "paseo.pid");

export type PaseoDaemonPidEvidence =
  | { state: "absent" }
  | { state: "pid"; pid: number }
  | { state: "unreadable"; reason: string };

/**
 * What the pid file says about the daemon. A missing file means no daemon was
 * recorded, so only command recognition protects Paseo. A file that exists but
 * cannot be read, or does not hold one pid, is ambiguous: the listing then
 * stays unavailable and nothing is stopped.
 */
export function readPaseoDaemonPid(
  path: string = PASEO_DAEMON_PID_PATH,
): PaseoDaemonPidEvidence {
  if (!existsSync(path)) return { state: "absent" };
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    return {
      state: "unreadable",
      reason: `Paseo daemon pid file ${path} could not be read: ${(error as Error).message}`,
    };
  }
  const match = /^\s*(\d+)\s*$/.exec(contents);
  const pid = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return {
      state: "unreadable",
      reason: `Paseo daemon pid file ${path} does not hold one pid`,
    };
  return { state: "pid", pid };
}

/** A process whose executable is Paseo's app, daemon or supervisor. */
function commandLooksLikePaseo(command: string): boolean {
  return command
    .trim()
    .split(/\s+/)
    .some((token) => {
      const base = token.split(/[\\/]/).pop() ?? "";
      return (
        /^(paseo|paseod|paseo-daemon|paseo-supervisor)(\.exe)?$/i.test(base) ||
        /Paseo\.app/i.test(token)
      );
    });
}

/**
 * The listing the Paseo adapter hands to shared cleanup. An ambiguous daemon pid
 * file answers null, so every sweep that needs the table stays fenced; an
 * absent or readable one marks the table.
 */
export function paseoRuntimeListing(
  processes: HostProcessTable | null,
  daemon: PaseoDaemonPidEvidence,
): HostProcessTable | null {
  if (!processes) return null;
  if (daemon.state === "unreadable") return null;
  const table: HostProcessTable = markPaseoRuntime(
    processes, daemon.state === "pid" ? daemon.pid : null,
  );
  if (processes.cwdComplete !== undefined) table.cwdComplete = processes.cwdComplete;
  return table;
}

/**
 * Mark Paseo's runtime on a process table: the daemon, every process it or an
 * app or supervisor process starts, and every member of the daemon's process
 * group. A pid the pid file names is protected whatever its command, because a
 * reused pid is then the conservative reading. Returns new facts; the input
 * is not changed.
 */
export function markPaseoRuntime(
  processes: HostProcessFact[],
  daemonPid: number | null,
): HostProcessFact[] {
  const byPid = new Map(processes.map((fact) => [fact.pid, fact]));
  const roots = new Set<number>();
  for (const fact of processes)
    if (commandLooksLikePaseo(fact.command)) roots.add(fact.pid);
  if (daemonPid !== null) roots.add(daemonPid);

  // A live process group's id is its leader's pid, so the daemon's group is the
  // one named by its pid even when the daemon is not in the table.
  const daemonFact = daemonPid === null ? undefined : byPid.get(daemonPid);
  const daemonPgid = daemonPid === null ? null : (daemonFact?.pgid ?? daemonPid);

  return processes.map((fact) => {
    let owned = false;
    let current: HostProcessFact | undefined = fact;
    const visited = new Set<number>();
    while (current && !visited.has(current.pid)) {
      visited.add(current.pid);
      if (roots.has(current.pid)) {
        owned = true;
        break;
      }
      const parent = current.ppid;
      if (!parent || parent <= 0 || parent === current.pid) break;
      if (roots.has(parent)) {
        owned = true;
        break;
      }
      current = byPid.get(parent);
    }
    if (daemonPgid !== null && fact.pgid === daemonPgid) owned = true;
    return owned ? { ...fact, protectedRuntime: true } : fact;
  });
}
