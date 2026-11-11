import { pidAlive } from "./pid";
import { execFile, spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { linuxStartIdentity, macStartIdentity, startIdentityMatches } from "./start-identity";
import type { HostRunCpuCoverage } from "../../shared/contracts";

/** One `/proc/sys/kernel/random/boot_id` read, cached for the process's life. */
let cachedBootId: string | null | undefined;
function linuxBootId(): string | null {
  if (cachedBootId === undefined) {
    try { cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null; }
    catch { cachedBootId = null; }
  }
  return cachedBootId;
}

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

function identityMarkers(identity: string): string[] {
  return PROCESS_START_IDENTITY_ENVS.map(name => `${name}=${identity}`);
}

function environmentHasIdentity(environment: Buffer, identity: string): boolean {
  return identityMarkers(identity).some(marker => environment.includes(Buffer.from(`${marker}\0`)));
}

function commandHasIdentity(command: string, identity: string): boolean {
  return identityMarkers(identity).some(marker => command.includes(marker));
}

const PS_TIMEOUT_MS = 1_000;
let linuxTicksPerSecond: number | null | undefined;

function linuxGroupHasIdentity(pgid: number, identity: string): boolean {
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return false; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) !== pgid) continue;
      const environment = readFileSync(`/proc/${pid}/environ`);
      if (environmentHasIdentity(environment, identity)) return true;
    } catch { /* A process that exited or cannot be read is not identity proof. */ }
  }
  return false;
}

export interface ProcessStartIdentityFact { pid: number; processGroupId: number; startIdentity: string }
export type ProcessStartIdentitySearch =
  | { state: "found"; processes: ProcessStartIdentityFact[] }
  | { state: "absent" }
  | { state: "unknown" };

export type ProcessStartIdentityLiveness = "alive" | "dead" | "unknown";

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
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    const line = result.stdout?.trim();
    if (result.status !== 0 || !line) {
      return pidAlive(pid) ? "unknown" : "dead";
    }
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

/** Find live processes carrying a step's inherited private identity. */
export function processesForStartIdentity(identity: string): ProcessStartIdentitySearch {
  if (!identity) return { state: "absent" };
  if (identityListingOverride) return identityListingOverride;
  if (process.platform === "linux") {
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
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const processGroupId = Number(fields[2]);
        const environment = readFileSync(`/proc/${pid}/environ`);
        if (environmentHasIdentity(environment, identity))
          processes.push({ pid, processGroupId, startIdentity: linuxStartIdentity(pid, stat, bootId) });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ESRCH") unreadable = true;
      }
    }
    if (processes.length) return { state: "found", processes };
    return unreadable ? { state: "unknown" } : { state: "absent" };
  }
  if (process.platform === "darwin") {
    // A host-wide `ps -E -A` times out or overflows on a loaded board (load ~50
    // is normal here): 1 s / 4 MiB was enough for the listing to fail closed as
    // `unknown`, which custody used to treat as "no escaped descendants".
    const listing = spawnSync("ps", ["-E", "-ww", "-A", "-o", "pid=,pgid=,lstart=,command="], {
      encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    if (listing.status !== 0 || !listing.stdout) return { state: "unknown" };
    const processes = listing.stdout.split("\n").flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
      if (!match || !commandHasIdentity(match[4], identity)) return [];
      const pid = Number(match[1]);
      return [{ pid, processGroupId: Number(match[2]), startIdentity: macStartIdentity(pid, match[3]) }];
    });
    return processes.length ? { state: "found", processes } : { state: "absent" };
  }
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
  const reads = darwinCandidateReads();
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

function darwinGroupHasIdentity(pgid: number, identity: string): boolean {
  const listing = spawnSync("ps", ["-ww", "-A", "-o", "pid=,pgid="], {
    encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 1024 * 1024,
  });
  if (listing.status !== 0 || !listing.stdout) return false;
  const pids = listing.stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    return match && Number(match[2]) === pgid ? [Number(match[1])] : [];
  });
  if (!pids.length) return false;
  const members = spawnSync("ps", ["-E", "-ww", "-p", pids.join(","), "-o", "pid=,pgid=,command="], {
    encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 1024 * 1024,
  });
  if (members.status !== 0 || !members.stdout) return false;
  return members.stdout.split("\n").some(line => {
    const match = /^\s*\d+\s+(\d+)\s+/.exec(line);
    return match !== null && Number(match[1]) === pgid
      && commandHasIdentity(line, identity);
  });
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

function linuxCpuSnapshot(identity: string): Map<string, number> | null {
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return null; }
  if (linuxTicksPerSecond === undefined) {
    const clock = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: PS_TIMEOUT_MS });
    const value = Number(clock.stdout?.trim());
    linuxTicksPerSecond = clock.status === 0 && Number.isFinite(value) && value > 0 ? value : null;
  }
  const ticksPerSecond = linuxTicksPerSecond;
  if (ticksPerSecond === null) return null;
  const output = new Map<string, number>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const userTicks = Number(fields[11]), systemTicks = Number(fields[12]);
      if (!Number.isFinite(userTicks) || !Number.isFinite(systemTicks)) continue;
      const environment = readFileSync(`/proc/${pid}/environ`);
      if (environmentHasIdentity(environment, identity))
        output.set(`${pid}@${fields[19]}`, Math.round((userTicks + systemTicks) * 1000 / ticksPerSecond));
    } catch { /* A process that exited during the sample contributes on the next/previous sample. */ }
  }
  return output;
}

function darwinCpuSnapshot(identity: string): Map<string, number> | null {
  const found = processesForStartIdentity(identity);
  if (found.state === "unknown") return null;
  if (found.state === "absent") return new Map();
  const pids = found.processes.map(process => process.pid);
  const listing = spawnSync("ps", ["-ww", "-p", pids.join(","), "-o", "pid=,lstart=,time="], {
    encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (listing.status !== 0 || !listing.stdout) return null;
  const known = new Set(found.processes.map(process => process.startIdentity));
  const output = new Map<string, number>();
  for (const line of listing.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+((?:\d+-)?(?:(?:\d+):)?\d+:\d{2}(?:\.\d+)?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const startIdentity = macStartIdentity(pid, match[2]);
    if (!known.has(startIdentity)) continue;
    const cpuMs = psTimeMs(match[3]);
    if (cpuMs === null) continue;
    output.set(startIdentity, cpuMs);
  }
  return output;
}

function processTreeCpuSnapshot(identity: string): Map<string, number> | null {
  if (!identity) return null;
  if (process.platform === "linux") return linuxCpuSnapshot(identity);
  if (process.platform === "darwin") return darwinCpuSnapshot(identity);
  return null;
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
 * One process's cumulative CPU in milliseconds, or null when it cannot be read
 * (exited, unsupported platform, `ps` failure). Asynchronous on macOS so a
 * caller inside the plugin host never blocks its event loop on `ps`.
 */
export async function processCpuMs(pid: number): Promise<number | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    if (linuxTicksPerSecond === undefined) {
      const clock = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: PS_TIMEOUT_MS });
      const value = Number(clock.stdout?.trim());
      linuxTicksPerSecond = clock.status === 0 && Number.isFinite(value) && value > 0 ? value : null;
    }
    if (linuxTicksPerSecond === null) return null;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[11]) + Number(fields[12]);
      return Number.isFinite(ticks) ? Math.round(ticks * 1000 / linuxTicksPerSecond) : null;
    } catch { return null; }
  }
  if (process.platform !== "darwin") return null;
  return new Promise(resolve => {
    execFile("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8", timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => resolve(error ? null : psTimeMs(stdout)));
  });
}

/** A sampled cumulative CPU lower bound, or null with why it is unknown. Never a false 0. */
export interface ProcessTreeCpu { cpuMs: number | null; cpuCoverage: HostRunCpuCoverage }

/** The run's own process group: its pgid and the leader's OS start identity, recorded at spawn. */
export interface ProcessTreeCpuGroup { pgid: number; leaderStartIdentity: string }

/** One host process as the sampler's cheap listing sees it: no environment is read. */
export interface HostProcessLine { pid: number; ppid: number; pgid: number; startIdentity: string }

/** The native reads behind the sampler; tests inject fixtures. */
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

type PsRun = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;

/**
 * The two Darwin `ps` reads. `COMMAND_MODE=unix2003` is set on the group read's
 * own child only: in unix2003 mode `-g` selects "processes with the specified
 * process group leaders"; in legacy mode it is "Ignored for compatibility".
 * An error, timeout, signal, nonzero exit or empty stdout is an unknown read.
 * Stdout is parsed and dropped, never logged or retained.
 */
export function darwinCpuListings(run: PsRun = spawnSync): Pick<ProcessTreeCpuReads, "groupListing" | "pidListing"> {
  const listing = (args: string[], env: NodeJS.ProcessEnv): string | null => {
    const result = run("ps", args, { encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 1024 * 1024, env });
    return result.error || result.signal || result.status !== 0 || !result.stdout?.trim() ? null : result.stdout;
  };
  return {
    groupListing: pgid => listing(["-ww", "-g", String(pgid), "-o", "pid=,pgid=,lstart=,time="],
      { ...process.env, LC_ALL: "C", TZ: "UTC", COMMAND_MODE: "unix2003" }),
    pidListing: pids => listing(["-ww", "-p", pids.join(","), "-o", "pid=,pgid=,lstart=,time="],
      { ...process.env, LC_ALL: "C", TZ: "UTC" }),
  };
}

/**
 * The `ps` reads behind the sampler's candidate path. The listing is host-wide
 * but carries no environment (`-E` is what makes the old full scan 574 KB and
 * 40 ms of CPU); the environment is then read for the run's own candidates only.
 * Any error, timeout, signal, nonzero exit or empty stdout is an unknown read,
 * and stdout is parsed and dropped, never logged or retained.
 */
export function darwinCandidateReads(run: PsRun = spawnSync): Pick<ProcessTreeCpuReads, "processListing" | "environmentScan"> {
  return {
    processListing: () => {
      const result = run("ps", ["-ww", "-A", "-o", "pid=,ppid=,pgid=,lstart="],
        { encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
      if (result.error || result.signal || result.status !== 0 || !result.stdout) return null;
      return parseHostProcessLines(result.stdout);
    },
    environmentScan: (identity, pids) => {
      if (!identity || !pids.length) return { state: "absent" };
      const markers = identityMarkers(identity);
      const processes: ProcessStartIdentityFact[] = [];
      let unknown = false;
      for (let offset = 0; offset < pids.length; offset += ENVIRONMENT_CHUNK) {
        const chunk = pids.slice(offset, offset + ENVIRONMENT_CHUNK);
        const result = run("ps", ["-E", "-ww", "-p", chunk.join(","), "-o", "pid=,pgid=,lstart=,command="],
          { encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
        if (result.error || result.signal || result.status !== 0 || !result.stdout) { unknown = true; continue; }
        processes.push(...parseEnvironmentLines(result.stdout, markers));
      }
      if (processes.length) return { state: "found", processes };
      return unknown ? { state: "unknown" } : { state: "absent" };
    },
  };
}

const DARWIN_START = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s+[A-Z][a-z]{2}\\s+\\d+\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4}";

/** Parse `pid=,ppid=,pgid=,lstart=` lines; a line that does not parse fully is ignored. */
export function parseHostProcessLines(stdout: string): HostProcessLine[] {
  const pattern = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(${DARWIN_START})\\s*$`);
  return stdout.split("\n").flatMap(line => {
    const match = pattern.exec(line);
    if (!match) return [];
    const [pid, ppid, pgid] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const startIdentity = macStartIdentity(pid, match[4]);
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
    if (!match || !markers.some(value => match[4].includes(value))) return [];
    const pid = Number(match[1]), pgid = Number(match[2]);
    return [{ pid, processGroupId: pgid, startIdentity: macStartIdentity(pid, match[3]) }];
  });
}

const nativeCpuReads: ProcessTreeCpuReads = {
  platform: process.platform,
  now: () => performance.now(),
  snapshot: processTreeCpuSnapshot,
  ...darwinCandidateReads(),
  ...darwinCpuListings(),
  alive: pidAlive,
};

export interface PsCpuLine { pid: number; pgid: number; startIdentity: string; cpuMs: number }

/** Parse `pid=,pgid=,lstart=,time=` lines; a line that does not parse fully is ignored. */
export function parsePsCpuLines(stdout: string): PsCpuLine[] {
  return stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s*$/.exec(line);
    if (!match) return [];
    const pid = Number(match[1]), pgid = Number(match[2]);
    const startIdentity = macStartIdentity(pid, match[3]);
    const cpuMs = psTimeMs(match[4]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(pgid) || pgid <= 0
      || startIdentity.endsWith("@unknown") || cpuMs === null) return [];
    return [{ pid, pgid, startIdentity, cpuMs }];
  });
}

/** The canonical whole-second macOS basis of an identity, or null. */
function macBasis(identity: string): string | null {
  const match = /^\d+@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.000)?Z$/.exec(identity);
  return match ? `${match[1]}Z` : null;
}

/**
 * How often one sampler repeats the expensive read: the whole listing (every
 * process on the host) on Linux, and on Darwin the host-wide process listing
 * plus the marker environment read for its own candidates. Ten times a second
 * was a per-run cost with no matching gain: the total is a cumulative maximum,
 * so a later read can only add CPU a run has already spent.
 */
export const PROCESS_TREE_FULL_SCAN_MS = 5_000;
/** How often one sampler re-reads its own process group's cumulative CPU. */
export const PROCESS_TREE_GROUP_READ_MS = 1_000;
/** Bounds on identities proven by the candidate read and on escapees re-read by PID. */
const CONFIRMED_IDENTITY_LIMIT = 4_096;
const ESCAPEE_LIMIT = 256;
const ESCAPEE_CHUNK = 64;
const ENVIRONMENT_CHUNK = 64;

/**
 * Cumulative CPU used by the identity-bearing process tree, sampled while it
 * runs (Tom, 2026-10-23: "Honest + cheaper"). Each PID and start identity
 * counts once, at the highest valid cumulative CPU any read showed; the total
 * is a sampled lower bound. No positive CPU is `null`: `unobserved` when a read
 * saw the tree, `unavailable` when none did. Reads are synchronous and never
 * overlap; a delayed tick is just a later sample.
 *
 * On Darwin with the run's group known, each sample reads only that group, once
 * a second. A group line counts only when the recorded leader (pid = pgid,
 * matching start identity) is in the same read, or its exact identity was
 * proven by the marker read; a line started before the leader never counts, so
 * a reused pgid adds nothing. Every five seconds one host-wide listing without
 * environments selects the run's own candidates - its group members, the
 * identities already proven, and their descendants - and the marker
 * environment is read for exactly those pids, so a `setsid` descendant is still
 * found while its parent lives. The escapees it finds are re-read by PID once a
 * group read. Missing a descendant only lowers the bound; it never invents CPU,
 * and the sampler never feeds custody.
 */
export class ProcessTreeCpuSampler {
  private readonly maxima = new Map<string, number>();
  private observed = false;
  private group: (ProcessTreeCpuGroup & { basis: string }) | null = null;
  private readonly confirmed = new Set<string>();
  private readonly escapees = new Map<string, number>();
  private scannedAt: number | null = null;
  private groupReadAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly identity: string, readonly intervalMs = 100, private readonly reads: ProcessTreeCpuReads = nativeCpuReads) {}

  start(group?: ProcessTreeCpuGroup): void {
    if (group) this.attachGroup(group);
    if (this.timer || !this.identity) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Scope Darwin samples to a newly spawned group; an unprovable leader keeps the full listing. */
  attachGroup(group: ProcessTreeCpuGroup): void {
    const basis = Number.isSafeInteger(group.pgid) && group.pgid > 0 && group.leaderStartIdentity.startsWith(`${group.pgid}@`)
      ? macBasis(group.leaderStartIdentity) : null;
    this.group = basis ? { ...group, basis } : null;
  }

  read(): ProcessTreeCpu {
    // A caller asking for the current value gets a fresh read of the run's own
    // group; the host-wide read keeps its own cadence because it answers a
    // cumulative maximum that one more read inside the window cannot raise.
    this.sample(true);
    let total = 0;
    for (const cpuMs of this.maxima.values()) total += cpuMs;
    if (total > 0) return { cpuMs: Math.round(total), cpuCoverage: "sampled" };
    return { cpuMs: null, cpuCoverage: this.observed ? "unobserved" : "unavailable" };
  }

  stop(): ProcessTreeCpu {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.read();
  }

  /** One owned process seen by a successful read; only a higher valid value raises its maximum. */
  private credit(identity: string, cpuMs: number): void {
    if (identity.endsWith("@unknown") || !Number.isSafeInteger(cpuMs) || cpuMs < 0) return;
    this.observed = true;
    if (cpuMs > (this.maxima.get(identity) ?? 0)) this.maxima.set(identity, cpuMs);
  }

  private sample(forceGroup = false): void {
    if (!this.identity) return;
    const { platform } = this.reads;
    if (platform === "darwin" && this.group) { this.sampleGroup(this.group, forceGroup); return; }
    if (platform !== "linux" && platform !== "darwin") return;
    // The whole-listing read covers every process on the host, so it repeats on
    // its own cadence however often the tick or a caller asks.
    const now = this.reads.now();
    if (this.scannedAt !== null && now - this.scannedAt < PROCESS_TREE_FULL_SCAN_MS) return;
    this.scannedAt = now;
    const snapshot = this.reads.snapshot(this.identity);
    if (!snapshot) return;
    for (const [identity, cpuMs] of snapshot) this.credit(identity, cpuMs);
  }

  private sampleGroup(group: ProcessTreeCpuGroup & { basis: string }, forceGroup: boolean): void {
    const notBeforeSpawn = (identity: string) => { const basis = macBasis(identity); return basis !== null && basis >= group.basis; };
    const now = this.reads.now();
    const scanDue = this.scannedAt === null || now - this.scannedAt >= PROCESS_TREE_FULL_SCAN_MS;
    const groupDue = forceGroup || this.groupReadAt === null || now - this.groupReadAt >= PROCESS_TREE_GROUP_READ_MS;
    if (!scanDue && !groupDue) return;
    // The candidate read runs first, so the group read below can already count a
    // member whose leader is gone.
    if (scanDue) { this.scannedAt = now; this.confirmCandidates(group, notBeforeSpawn); }
    if (!groupDue) return;
    this.groupReadAt = now;
    const seen = new Set<string>();
    const listing = this.reads.groupListing(group.pgid);
    if (listing !== null) {
      const lines = parsePsCpuLines(listing).filter(line => line.pgid === group.pgid && notBeforeSpawn(line.startIdentity));
      const leader = lines.some(line => line.pid === group.pgid && startIdentityMatches(group.leaderStartIdentity, line.startIdentity));
      for (const line of lines) {
        if (!leader && !this.confirmed.has(line.startIdentity)) continue;
        seen.add(line.startIdentity);
        this.credit(line.startIdentity, line.cpuMs);
      }
    }
    for (const [identity, pid] of this.escapees) if (!this.reads.alive(pid)) this.escapees.delete(identity);
    const pending = [...this.escapees].filter(([identity]) => !seen.has(identity));
    for (let offset = 0; offset < pending.length; offset += ESCAPEE_CHUNK) {
      const chunk = pending.slice(offset, offset + ESCAPEE_CHUNK);
      const read = this.reads.pidListing(chunk.map(([, pid]) => pid));
      if (read === null) continue;
      const byPid = new Map(parsePsCpuLines(read).map(line => [line.pid, line]));
      for (const [identity, pid] of chunk) {
        const line = byPid.get(pid);
        if (!line) continue;
        // A recycled PID shows another start identity: it is dropped, never attributed.
        if (!startIdentityMatches(identity, line.startIdentity)) { this.escapees.delete(identity); continue; }
        this.credit(identity, line.cpuMs);
      }
    }
  }

  /**
   * One host-wide listing without environments, then the marker environment read
   * for the run's own candidates only: its group members, the identities already
   * proven, and their descendants (which is how a `setsid` descendant is found
   * while its parent still lives). An unreadable listing or environment read
   * proves nothing and adds nothing.
   */
  private confirmCandidates(group: ProcessTreeCpuGroup & { basis: string }, notBeforeSpawn: (identity: string) => boolean): void {
    const listing = this.reads.processListing();
    if (listing === null) return;
    const own = listing.filter(line => notBeforeSpawn(line.startIdentity));
    const children = new Map<number, HostProcessLine[]>();
    for (const line of own) {
      const siblings = children.get(line.ppid);
      if (siblings) siblings.push(line); else children.set(line.ppid, [line]);
    }
    const candidates = new Set<number>();
    for (const line of own) if (line.pgid === group.pgid || this.confirmed.has(line.startIdentity)) candidates.add(line.pid);
    for (const pid of this.escapees.values()) candidates.add(pid);
    const pending = [...candidates];
    while (pending.length) {
      const pid = pending.pop()!;
      for (const child of children.get(pid) ?? []) if (!candidates.has(child.pid)) { candidates.add(child.pid); pending.push(child.pid); }
    }
    if (!candidates.size) return;
    const found = this.reads.environmentScan(this.identity, [...candidates]);
    if (found.state !== "found") return;
    for (const fact of found.processes) {
      if (!notBeforeSpawn(fact.startIdentity)) continue;
      if (this.confirmed.size < CONFIRMED_IDENTITY_LIMIT) this.confirmed.add(fact.startIdentity);
      if (!this.confirmed.has(fact.startIdentity)) continue;
      if (fact.processGroupId === group.pgid) this.escapees.delete(fact.startIdentity);
      else if (this.escapees.has(fact.startIdentity) || this.escapees.size < ESCAPEE_LIMIT) this.escapees.set(fact.startIdentity, fact.pid);
    }
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
