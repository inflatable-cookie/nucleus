import { execFile, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { pidAlive } from "./pid";
import { parseLinuxProcStat, startIdentityMatches } from "./start-identity";
import {
  PS_TIMEOUT_MS, darwinProcessReads, parsePsCpuLines, psTimeMs,
  type HostProcessLine, type ProcessTreeCpuReads,
} from "./process-host-reads";
export type { ProcessTreeCpuReads } from "./process-host-reads";
import { environmentHasIdentity, processesForStartIdentity } from "./process-identity-search";
import type { HostRunCpuCoverage } from "../../shared/contracts";

/**
 * Cumulative CPU used by one run's identity-bearing process tree, sampled while
 * it runs (Tom, 2026-10-23: "Honest + cheaper").
 *
 * The total is a sampled lower bound, never a measurement: each pid and start
 * identity counts once, at the highest valid cumulative CPU any read showed.
 * No positive CPU is `null` — `unobserved` when a read saw the tree,
 * `unavailable` when none did. Reads never overlap; a delayed tick is just a
 * later sample.
 */

/** A sampled cumulative CPU lower bound, or null with why it is unknown. Never a false 0. */
export interface ProcessTreeCpu { cpuMs: number | null; cpuCoverage: HostRunCpuCoverage }

/** The run's own process group: its pgid and the leader's OS start identity, recorded at spawn. */
export interface ProcessTreeCpuGroup { pgid: number; leaderStartIdentity: string }

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

let linuxTicksPerSecond: number | null | undefined;

function linuxCpuTicksPerSecond(): number | null {
  if (linuxTicksPerSecond === undefined) {
    const clock = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: PS_TIMEOUT_MS });
    const value = Number(clock.stdout?.trim());
    linuxTicksPerSecond = clock.status === 0 && Number.isFinite(value) && value > 0 ? value : null;
  }
  return linuxTicksPerSecond;
}

function linuxCpuSnapshot(identity: string): Map<string, number> | null {
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return null; }
  const ticksPerSecond = linuxCpuTicksPerSecond();
  if (ticksPerSecond === null) return null;
  const output = new Map<string, number>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = parseLinuxProcStat(stat);
      if (!fields) continue;
      const environment = readFileSync(`/proc/${pid}/environ`);
      if (environmentHasIdentity(environment, identity))
        output.set(`${pid}@${fields.starttime}`, Math.round((fields.userTicks + fields.systemTicks) * 1000 / ticksPerSecond));
    } catch { /* A process that exited during the sample contributes on the next/previous sample. */ }
  }
  return output;
}

function darwinCpuSnapshot(identity: string): Map<string, number> | null {
  const found = processesForStartIdentity(identity);
  if (found.state === "unknown") return null;
  if (found.state === "absent") return new Map();
  const pids = found.processes.map(process => process.pid);
  const listing = darwinProcessReads().pidListing(pids);
  if (listing === null) return null;
  const known = new Set(found.processes.map(process => process.startIdentity));
  const output = new Map<string, number>();
  for (const line of parsePsCpuLines(listing)) {
    if (!known.has(line.startIdentity)) continue;
    output.set(line.startIdentity, line.cpuMs);
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
 * One process's cumulative CPU in milliseconds, or null when it cannot be read
 * (exited, unsupported platform, `ps` failure). Asynchronous on macOS so a
 * caller inside the plugin host never blocks its event loop on `ps`.
 */
export async function processCpuMs(pid: number): Promise<number | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    const ticksPerSecond = linuxCpuTicksPerSecond();
    if (ticksPerSecond === null) return null;
    try {
      const fields = parseLinuxProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (!fields) return null;
      const ticks = fields.userTicks + fields.systemTicks;
      return Number.isFinite(ticks) ? Math.round(ticks * 1000 / ticksPerSecond) : null;
    } catch { return null; }
  }
  if (process.platform !== "darwin") return null;
  return new Promise(resolve => {
    execFile("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8", timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => resolve(error ? null : psTimeMs(stdout)));
  });
}

/** The canonical whole-second macOS basis of an identity, or null. */
function macBasis(identity: string): string | null {
  const match = /^\d+@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.000)?Z$/.exec(identity);
  return match ? `${match[1]}Z` : null;
}

const nativeCpuReads: ProcessTreeCpuReads = {
  platform: process.platform,
  now: () => performance.now(),
  snapshot: processTreeCpuSnapshot,
  ...darwinProcessReads(),
  alive: pidAlive,
};

/**
 * Cumulative CPU used by the identity-bearing process tree, sampled while it
 * runs. Each PID and start identity counts once, at the highest valid
 * cumulative CPU any read showed; the total is a sampled lower bound.
 *
 * On Darwin with the run's group known, each sample reads only that group, once
 * a second. A group line counts only when the recorded leader (pid = pgid,
 * matching start identity) is in the same read, or its exact identity was
 * proven by the marker read; a line started before the leader never counts, so
 * a reused pgid adds nothing. Every five seconds one host-wide listing without
 * environments selects the run's own candidates — its group members, the
 * identities already proven, and their descendants — and the marker
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
    const own: HostProcessLine[] = listing.filter(line => notBeforeSpawn(line.startIdentity));
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
