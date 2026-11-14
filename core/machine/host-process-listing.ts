import type { HostProcessFact } from '../host/types';
export type { HostProcessFact } from '../host/types';
/**
 * One host process-table read for this uid, with cwd when the host can give it.
 *
 * The read is the single owner of the platform facts every process decision
 * needs (pid, parent, group, start identity, command, cwd). Its answer is
 * typed: a process table that could not be read or that this platform cannot
 * enumerate is `unknown` with its reason, never an empty list, because an
 * empty list reads as "nothing is running" to every caller.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { cwdMapFromLsof, type CwdState } from "../workspaces/worktree-validation";
import { linuxProcCommandLine } from "./process-identity";
import { linuxStartIdentity, macStartIdentity } from "./start-identity";

/** The longest command a process fact retains; the tail carries the arguments a proof reads. */
export const HOST_PROCESS_COMMAND_MAX = 4096;
const PS_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

/** What a host process-table read proved: the table, or why there is none. */
export type HostProcessListRead =
  | { state: "listed"; processes: HostProcessFact[] }
  | { state: "unknown"; reason: string };

/** Preserve command failure and partial output; never turn an OS error into absence. */
async function processListing(command: string, args: string[], env = process.env) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env,
    });
    return { status: 0, stdout };
  } catch (error) {
    const failure = error as Error & { code?: string | number; stdout?: string; signal?: NodeJS.Signals };
    return { status: typeof failure.code === "number" ? failure.code : null, stdout: failure.stdout ?? "", error, signal: failure.signal };
  }
}

function truncateCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim().slice(0, HOST_PROCESS_COMMAND_MAX);
}

function uidOf(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

function linuxCwd(pid: number): CwdState {
  try { return { state: "read", path: realpathSync(readlinkSync(`/proc/${pid}/cwd`)) }; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? { state: "gone" } : { state: "unreadable" };
  }
}

function linuxUid(pid: number): number | null {
  try {
    const match = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

function linuxBootId(): string | null {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null; }
  catch { return null; }
}

async function linuxProcesses(uid: number): Promise<HostProcessListRead> {
  let entries: string[];
  try { entries = readdirSync("/proc"); }
  catch (error) { return { state: "unknown", reason: `the /proc listing is unreadable: ${String(error)}` }; }
  const bootId = linuxBootId();
  const listed: HostProcessFact[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (linuxUid(pid) !== uid) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const command = linuxProcCommandLine(pid);
      const cwd = linuxCwd(pid);
      listed.push({
        pid, ppid: Number(fields[1]), pgid: Number(fields[2]), uid,
        startIdentity: linuxStartIdentity(pid, stat, bootId),
        command: command.state === "read" ? truncateCommand(command.line) : "",
        cwd: cwd.state === "read" ? cwd.path : null,
      });
    } catch { /* Exited during the walk. */ }
  }
  return { state: "listed", processes: listed };
}

async function darwinProcesses(uid: number): Promise<HostProcessListRead> {
  const listing = await processListing("ps", ["-axo", "uid=,pid=,ppid=,pgid=,lstart=,command="],
    { ...process.env, LC_ALL: "C", TZ: "UTC" });
  if (listing.status !== 0 || !listing.stdout)
    return { state: "unknown", reason: `the host process listing failed: ${listing.error ? String(listing.error) : `ps exited with code ${listing.status}`}` };
  const facts: HostProcessFact[] = [];
  for (const line of listing.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) !== uid) continue;
    const pid = Number(match[2]);
    facts.push({
      pid, ppid: Number(match[3]), pgid: Number(match[4]), uid,
      startIdentity: macStartIdentity(pid, match[5]),
      command: truncateCommand(match[6]),
      cwd: null,
    });
  }
  const pids = facts.map(fact => fact.pid);
  let cwds = cwdMapFromLsof(pids, await processListing("lsof", ["-a", "-d", "cwd", "-Fn", "-u", String(uid)]));
  if (!cwds && pids.length) {
    cwds = cwdMapFromLsof(pids, await processListing("lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")]));
  }
  if (cwds) for (const fact of facts) {
    const cwd = cwds.get(fact.pid);
    if (cwd?.state === "read") fact.cwd = cwd.path;
  }
  return { state: "listed", processes: facts };
}

/**
 * Every host process owned by this uid, or the reason the table is unknown.
 *
 * An absent uid or an unsupported platform is unknown, not empty: nothing here
 * proves that no process is running, so no caller may read it that way.
 */
export async function readHostUidProcesses(): Promise<HostProcessListRead> {
  const uid = uidOf();
  if (uid < 0) return { state: "unknown", reason: "the host process owner cannot be read on this platform" };
  if (process.platform === "linux") return linuxProcesses(uid);
  if (process.platform === "darwin") return darwinProcesses(uid);
  return { state: "unknown", reason: `host process listing is unsupported on ${process.platform}` };
}
