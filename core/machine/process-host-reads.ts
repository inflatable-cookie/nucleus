import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { macStartIdentity } from "./start-identity";
import type { ProcessStartIdentityFact, ProcessStartIdentitySearch } from "./process-identity-search";
import { identityMarkers } from "./process-identity-search";

/**
 * The `ps` reads behind every process proof on macOS, and the parsers for
 * their output.
 *
 * One place owns the fixed C-locale UTC scaffold, the timeout, the output cap
 * and the "any error, timeout, signal, nonzero exit or empty stdout is an
 * unknown read" rule. Stdout is parsed and dropped, never logged or retained.
 * Linux callers read `/proc` directly and never come here.
 */

export const PS_TIMEOUT_MS = 1_000;

/** The `lstart` shape macOS prints under `LC_ALL=C TZ=UTC`. */
export const DARWIN_START = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s+[A-Z][a-z]{2}\\s+\\d+\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4}";

/** One host process as the cheap listing sees it: no environment is read. */
export interface HostProcessLine { pid: number; ppid: number; pgid: number; startIdentity: string }

export interface PsCpuLine { pid: number; pgid: number; startIdentity: string; cpuMs: number }

type PsRun = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;

const psEnv = (extra: NodeJS.ProcessEnv = {}) => ({ ...process.env, LC_ALL: "C", TZ: "UTC", ...extra });

/**
 * One `ps` read, or null. The result is unknown when the child errored, was
 * signalled, exited nonzero or printed nothing.
 */
function psRead(run: PsRun, args: string[], maxBuffer: number, env: NodeJS.ProcessEnv = psEnv()): string | null {
  const result = run("ps", args, { encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer, env });
  return result.error || result.signal || result.status !== 0 || !result.stdout?.trim() ? null : result.stdout;
}

/** Parse `pid=,ppid=,pgid=,lstart=` lines; a line that does not parse fully is ignored. */
export function parseHostProcessLines(stdout: string): HostProcessLine[] {
  const pattern = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(${DARWIN_START})\\s*$`);
  return stdout.split("\n").flatMap(line => {
    const match = pattern.exec(line);
    if (!match) return [];
    const [pid, ppid, pgid] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const startIdentity = macStartIdentity(pid, match[4]!);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(pgid) || pgid < 0
      || startIdentity.endsWith("@unknown")) return [];
    return [{ pid, ppid: Number.isSafeInteger(ppid) ? ppid : 0, pgid, startIdentity }];
  });
}

/** Parse `pid=,pgid=,lstart=,command=` lines for processes carrying this step's marker. */
export function parseEnvironmentLines(stdout: string, marker: string | string[]): ProcessStartIdentityFact[] {
  const markers = typeof marker === "string" ? [marker] : marker;
  const pattern = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(${DARWIN_START})\\s+(.*)$`);
  return stdout.split("\n").flatMap(line => {
    const match = pattern.exec(line);
    if (!match || !markers.some(value => match[4]!.includes(value))) return [];
    const pid = Number(match[1]), pgid = Number(match[2]);
    return [{ pid, processGroupId: pgid, startIdentity: macStartIdentity(pid, match[3]!) }];
  });
}

/** Parse `pid=,pgid=,lstart=,time=` lines; a line that does not parse fully is ignored. */
export function parsePsCpuLines(stdout: string): PsCpuLine[] {
  const pattern = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(${DARWIN_START})\\s+(\\S+)\\s*$`);
  return stdout.split("\n").flatMap(line => {
    const match = pattern.exec(line);
    if (!match) return [];
    const pid = Number(match[1]), pgid = Number(match[2]);
    const startIdentity = macStartIdentity(pid, match[3]!);
    const cpuMs = psTimeMs(match[4]!);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(pgid) || pgid <= 0
      || startIdentity.endsWith("@unknown") || cpuMs === null) return [];
    return [{ pid, pgid, startIdentity, cpuMs }];
  });
}

/**
 * Parse `ps -o time=` into milliseconds: `[[dd-]hh:]mm:ss[.cc]`. macOS prints
 * total minutes with no hours field, so minutes may run past two digits
 * (`100:00.00`, Sol #593).
 */
export function psTimeMs(value: string): number | null {
  const time = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})(?:\.(\d+))?$/.exec(value.trim());
  if (!time) return null;
  const seconds = ((Number(time[1] ?? 0) * 24 + Number(time[2] ?? 0)) * 60 + Number(time[3])) * 60
    + Number(time[4]) + Number(`0.${time[5] ?? "0"}`);
  return Math.round(seconds * 1000);
}

/**
 * The reads a process proof can make on this host: a host-wide listing without
 * environments, the marker environment for exactly the candidate pids, one
 * group's lines, one pid set's lines, and the group's members.
 *
 * `-E` is what makes a full environment scan expensive, so it is only ever
 * asked for the candidates a caller already narrowed to.
 */
export function darwinProcessReads(run: PsRun = spawnSync) {
  return {
    /** `ps -ww -A -o pid=,ppid=,pgid=,lstart=`; null on any failure. */
    processListing(): HostProcessLine[] | null {
      const stdout = psRead(run, ["-ww", "-A", "-o", "pid=,ppid=,pgid=,lstart="], 2 * 1024 * 1024);
      return stdout === null ? null : parseHostProcessLines(stdout);
    },
    /** Marker environments for exactly these pids; unknown when a chunk could not be read. */
    environmentScan(identity: string, pids: readonly number[]): ProcessStartIdentitySearch {
      if (!identity || !pids.length) return { state: "absent" };
      const markers = identityMarkers(identity);
      const processes: ProcessStartIdentityFact[] = [];
      let unknown = false;
      for (let offset = 0; offset < pids.length; offset += ENVIRONMENT_CHUNK) {
        const chunk = pids.slice(offset, offset + ENVIRONMENT_CHUNK);
        const stdout = psRead(run, ["-E", "-ww", "-p", chunk.join(","), "-o", "pid=,pgid=,lstart=,command="], 4 * 1024 * 1024);
        if (stdout === null) { unknown = true; continue; }
        processes.push(...parseEnvironmentLines(stdout, markers));
      }
      if (processes.length) return { state: "found", processes };
      return unknown ? { state: "unknown" } : { state: "absent" };
    },
    /**
     * The host-wide marker read: every process carrying this identity. A
     * loaded board can time this read out or overflow it, which is `unknown`
     * and never "no escaped descendants".
     */
    fullEnvironmentScan(identity: string): ProcessStartIdentitySearch {
      if (!identity) return { state: "absent" };
      const stdout = psRead(run, ["-E", "-ww", "-A", "-o", "pid=,pgid=,lstart=,command="], 16 * 1024 * 1024);
      if (stdout === null) return { state: "unknown" };
      const processes = parseEnvironmentLines(stdout, identityMarkers(identity));
      return processes.length ? { state: "found", processes } : { state: "absent" };
    },
    /** The pids the kernel lists in this group; null on any failure. */
    groupMembers(pgid: number): number[] | null {
      const stdout = psRead(run, ["-ww", "-A", "-o", "pid=,pgid="], 1024 * 1024);
      if (stdout === null) return null;
      return stdout.split("\n").flatMap(line => {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        return match && Number(match[2]) === pgid ? [Number(match[1])] : [];
      });
    },
    /** `ps -ww -g <pgid> -o pid=,pgid=,lstart=,time=`; null on any failure. */
    groupListing(pgid: number): string | null {
      // `COMMAND_MODE=unix2003` is set on this read's own child only: there `-g`
      // selects "processes with the specified process group leaders"; in legacy
      // mode it is "Ignored for compatibility".
      return psRead(run, ["-ww", "-g", String(pgid), "-o", "pid=,pgid=,lstart=,time="], 1024 * 1024,
        psEnv({ COMMAND_MODE: "unix2003" }));
    },
    /** `ps -ww -p <pids> -o pid=,pgid=,lstart=,time=`; null on any failure. */
    pidListing(pids: number[]): string | null {
      return psRead(run, ["-ww", "-p", pids.join(","), "-o", "pid=,pgid=,lstart=,time="], 1024 * 1024);
    },
    /** `ps -o lstart= -p <pid>`; null on any failure. */
    startLine(pid: number): string | null {
      const result = run("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: PS_TIMEOUT_MS, env: psEnv() });
      const line = result.error || result.signal || result.status !== 0 || !result.stdout ? null : result.stdout.trim();
      return line || null;
    },
  };
}

/** Bounds on how many pids one environment read asks for. */
export const ENVIRONMENT_CHUNK = 64;

/** The native reads behind the CPU sampler; tests inject fixtures instead. */
export interface ProcessTreeCpuReads {
  platform: NodeJS.Platform;
  /** Monotonic milliseconds. */
  now(): number;
  /** Full-listing snapshot, identity to cumulative CPU ms; null when it failed. */
  snapshot(identity: string): Map<string, number> | null;
  /** Host-wide process listing without environments; null on any failure. */
  processListing(): HostProcessLine[] | null;
  /** Marker environment read for exactly these candidate pids; absent/unknown when it could not read. */
  environmentScan(identity: string, pids: readonly number[]): ProcessStartIdentitySearch;
  /** `ps -ww -g <pgid> -o pid=,pgid=,lstart=,time=` stdout; null on any failure. */
  groupListing(pgid: number): string | null;
  /** `ps -ww -p <pids> -o pid=,pgid=,lstart=,time=` stdout; null on any failure. */
  pidListing(pids: number[]): string | null;
  /** Kernel liveness: false only on ESRCH. */
  alive(pid: number): boolean;
}
