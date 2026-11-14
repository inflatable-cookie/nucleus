/**
 * Contract 010's canonical host-run start identity (Nucleus contract 010,
 * `docs/knowledge/contracts/010-host-run-scheduling.md` at nucleus
 * `e28164c05530afb5da4071a2247598fc19c98993`, "Start identity").
 *
 * A start identity is `<pid>@<basis>`, compared only as an exact string, never
 * parsed or re-derived:
 *
 * - macOS: the kernel start time truncated to whole seconds, written as
 *   `YYYY-MM-DDTHH:MM:SSZ`; `ps -o lstart= -p <pid>` runs with `LC_ALL=C` and
 *   `TZ=UTC` and is parsed as C-locale UTC.
 * - Linux: `<boot_id>:<starttime>`, from `/proc/sys/kernel/random/boot_id` and
 *   field 22 of `/proc/<pid>/stat`, parsed after the last `)`. There is no `ps`
 *   fallback.
 * - Unknown: `<pid>@unknown` when the basis cannot be read. It never proves
 *   identity, including against itself.
 * - Legacy: a recorded `...SS.000Z` equals `...SSZ`; any other fraction refuses.
 *
 * Producers emit only the canonical form. Readers use `startIdentityMatches`.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MAC_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PS_TIMEOUT_MS = 5_000;

export interface StartIdentityOptions {
  /** Test seam; production uses `process.platform`. */
  platform?: NodeJS.Platform;
  /** Test seam for `/proc` reads; throws when the path cannot be read. */
  readFileText?: (path: string) => string;
  /** Test seam for the forced `LC_ALL=C TZ=UTC` `ps -o lstart=` line; null when unreadable. */
  psStartLine?: (pid: number) => string | null;
  /** Test seam for the nonblocking spawned read; production spawns `ps` from PATH. */
  psStartLineRead?: (pid: number) => Promise<PsLineRead>;
}

function defaultReadFileText(path: string): string { return readFileSync(path, "utf8"); }

/** `ps -o lstart= -p <pid>` with the contract's forced C locale and UTC. */
function defaultPsStartLine(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8", timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (result.status !== 0 || !result.stdout) return null;
  const line = result.stdout.trim();
  return line || null;
}

/**
 * The same `ps -o lstart=` line without blocking the caller: a spawned child
 * instead of `spawnSync`, because the host-run endpoint's run watch proves
 * identities on the same event loop that must keep accepting the contract-010
 * socket, and one synchronous `ps` under host contention outlasts the kernel
 * accept backlog (macOS `ECONNREFUSED`). `ps` cannot tell "no such process"
 * from "could not be observed": a nonzero exit, empty output, a permission
 * denial, a spawn failure and a timeout all look alike, so every one of them
 * is `unavailable`. Positive absence comes only from kernel ESRCH (the
 * caller's liveness check) or a missing per-PID entry — never from this read.
 */
export type PsLineRead = { kind: "line"; line: string } | { kind: "unavailable" };

function psStartLineRead(pid: number): Promise<PsLineRead> {
  return new Promise(resolvePromise => {
    const child = spawn("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    let stdout = "";
    let settled = false;
    const finish = (read: PsLineRead) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(read); } };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, PS_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.once("error", () => finish({ kind: "unavailable" }));
    child.once("close", (code, signal) => {
      // A successful read is exit 0 with a nonempty line. Anything else — a
      // nonzero exit, a signal (including this read's own timeout kill), or
      // empty output — is an unobserved identity, never a proven absence.
      if (signal || code === null || code !== 0) { finish({ kind: "unavailable" }); return; }
      const line = stdout.trim();
      if (!line) { finish({ kind: "unavailable" }); return; }
      finish({ kind: "line", line });
    });
  });
}

/** One OS identity read: a canonical identity, a proven-gone pid, or an unavailable observation. */
export type StartIdentityRead =
  | { kind: "identity"; identity: string }
  | { kind: "gone" }
  | { kind: "unavailable" };

/**
 * Read a pid's canonical start identity without blocking the caller. Same
 * canonical forms and bases as `hostRunProcessStartIdentity`; the macOS `ps`
 * proof runs as a spawned child so callers that own a listening socket never
 * block on it. A missing process is `gone`; a read that could not be made is
 * `unavailable` and must never be read as absence.
 */
export async function readHostRunStartIdentity(pid: number, options: StartIdentityOptions = {}): Promise<StartIdentityRead> {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const read = await (options.psStartLineRead ?? psStartLineRead)(pid);
    if (read.kind !== "line") return read;
    // A line that does not parse as C-locale UTC whole seconds is malformed
    // data, not a disproven identity.
    const identity = macStartIdentity(pid, read.line);
    return identity.endsWith("@unknown") ? { kind: "unavailable" } : { kind: "identity", identity };
  }
  if (platform === "linux") {
    const readFileText = options.readFileText ?? defaultReadFileText;
    let stat: string;
    try {
      stat = readFileText(`/proc/${pid}/stat`);
    } catch (error) {
      // Only a missing PID entry proves absence; any other read failure is
      // an unobserved identity.
      const code = (error as NodeJS.ErrnoException)?.code;
      return code === "ENOENT" || code === "ESRCH" ? { kind: "gone" } : { kind: "unavailable" };
    }
    let bootId: string | null;
    try {
      bootId = readFileText("/proc/sys/kernel/random/boot_id").trim() || null;
    } catch {
      // Unrelated host metadata: a missing boot id never proves a PID gone
      // when that PID's own entry reads.
      bootId = null;
    }
    const identity = linuxStartIdentity(pid, stat, bootId);
    return identity.endsWith("@unknown") ? { kind: "unavailable" } : { kind: "identity", identity };
  }
  return { kind: "identity", identity: hostRunProcessStartIdentity(pid, options) };
}

/** How long a proven (pid, recorded identity) pair may stand in for a fresh OS read. */
export const HOST_RUN_IDENTITY_PROOF_CACHE_MS = 5_000;

export interface RecordedIdentityProofOptions {
  read: (pid: number) => Promise<StartIdentityRead>;
  alive: (pid: number) => boolean;
  now: () => number;
  cacheMs: number;
}

/** The proof verdict: matched, definitively not matched, or an unavailable observation. */
export type IdentityProof = boolean | "unknown";

/** Upper bound on cached proofs, so a long-lived endpoint cannot grow without bound. */
const IDENTITY_PROOF_CACHE_LIMIT = 4096;

/**
 * Bounded proofs that a live pid carries a recorded start identity.
 *
 * A proof may stand in for an OS read only within `cacheMs` and only while the
 * pid still answers liveness; past that the identity is re-read, so a reused
 * pid number expires instead of inheriting its predecessor's proof even when
 * no poll observed the death. Reads for the same key are shared while in
 * flight, a completion that arrives after a cache reset is discarded, and only
 * a positively matched identity is ever cached. `fresh` bypasses the cache for
 * identity-dependent loss and settlement decisions, where an age-only cache is
 * not a fresh identity proof. An unavailable read returns `unknown` while the
 * pid still answers liveness, and `false` once only kernel ESRCH proves the
 * absence the read could not see (a Darwin `ps` failure cannot tell permission
 * from absence). Neither verdict is cached: unknown never matches, and a
 * later observable read proves normally.
 */
export class RecordedIdentityProofs {
  private readonly entries = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<IdentityProof>>();
  private generation = 0;

  constructor(private readonly options: RecordedIdentityProofOptions) {}

  /** Drop every cached proof: later completions of in-flight reads are stale. */
  reset(): void {
    this.generation++;
    this.entries.clear();
  }

  check(pid: number, recorded: string, fresh = false): Promise<IdentityProof> {
    const key = `${pid}|${recorded}`;
    const provenAt = this.entries.get(key);
    if (!fresh && provenAt !== undefined && this.options.now() - provenAt <= this.options.cacheMs && this.options.alive(pid)) {
      return Promise.resolve(true);
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const read = this.options.read(pid).then(read => {
      this.inFlight.delete(key);
      if (generation !== this.generation) return "unknown" as const;
      if (read.kind === "unavailable") {
        if (this.options.alive(pid)) return "unknown" as const;
        this.entries.delete(key);
        return false as const;
      }
      if (read.kind === "gone") {
        this.entries.delete(key);
        return false as const;
      }
      if (!startIdentityMatches(read.identity, recorded)) {
        this.entries.delete(key);
        return false as const;
      }
      if (this.entries.size >= IDENTITY_PROOF_CACHE_LIMIT) this.entries.clear();
      this.entries.set(key, this.options.now());
      return true as const;
    }, () => {
      this.inFlight.delete(key);
      return "unknown" as const;
    });
    this.inFlight.set(key, read);
    return read;
  }
}

/**
 * The `/proc/<pid>/stat` fields every process read needs, parsed once after the
 * last `)` so a command name containing `)` is safe. Indices follow
 * proc(5): ppid 4, pgrp 5, utime 14, stime 15, starttime 22, one-based.
 */
export interface LinuxProcStat { ppid: number; pgid: number; starttime: string; userTicks: number; systemTicks: number }

export function parseLinuxProcStat(stat: string): LinuxProcStat | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(" ");
  const starttime = fields[19];
  const ppid = Number(fields[1]), pgid = Number(fields[2]);
  const userTicks = Number(fields[11]), systemTicks = Number(fields[12]);
  if (!/^\d+$/.test(starttime ?? "")) return null;
  return { ppid, pgid, starttime, userTicks, systemTicks };
}

/** Field 22 of `/proc/<pid>/stat`, parsed after the last `)` so `(a) b)` is safe. */
export function parseLinuxStarttime(stat: string): string | null {
  return parseLinuxProcStat(stat)?.starttime ?? null;
}

/** Canonical Linux identity from an already-read stat line and boot id. */
export function linuxStartIdentity(pid: number, stat: string, bootId: string | null): string {
  const starttime = parseLinuxStarttime(stat);
  return bootId && starttime ? `${pid}@${bootId}:${starttime}` : `${pid}@unknown`;
}

/** Parse one C-locale `ps -o lstart=` line as UTC whole seconds; null when it does not match. */
export function parseMacStartBasis(line: string): string | null {
  const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(line.trim());
  if (!match) return null;
  const month = MAC_MONTHS.indexOf(match[1]);
  if (month < 0) return null;
  const ms = Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
  if (!Number.isFinite(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/** Canonical macOS identity from an already-read `ps` line. */
export function macStartIdentity(pid: number, line: string | null): string {
  const basis = line === null ? null : parseMacStartBasis(line);
  return basis === null ? `${pid}@unknown` : `${pid}@${basis}`;
}

let ownIdentity: string | null = null;

/**
 * This process's own canonical start identity, cached once a positive read
 * exists: a pid's identity never changes while it is this process's pid, and
 * authority writes and the run watch ask for it constantly on the accepting
 * loop. An initial unreadable basis (`@unknown`, a failed ps at boot) is
 * never cached — later calls re-read until a positive identity is observed,
 * and there is no fabricated fallback.
 */
export function hostRunOwnStartIdentity(options: StartIdentityOptions = {}): string {
  const hasSeams = options.platform !== undefined || options.psStartLine !== undefined || options.readFileText !== undefined;
  if (!hasSeams && ownIdentity !== null) return ownIdentity;
  const computed = hostRunProcessStartIdentity(process.pid, options);
  if (!hasSeams && !computed.endsWith("@unknown")) ownIdentity = computed;
  return computed;
}

/**
 * The canonical start identity of a host process. Unreadable bases are
 * `<pid>@unknown`; producers never fall back to a sampling time.
 */
export function hostRunProcessStartIdentity(pid: number = process.pid, options: StartIdentityOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const readFileText = options.readFileText ?? defaultReadFileText;
  if (platform === "linux") {
    try {
      const bootId = readFileText("/proc/sys/kernel/random/boot_id").trim();
      return linuxStartIdentity(pid, readFileText(`/proc/${pid}/stat`), bootId || null);
    } catch { return `${pid}@unknown`; }
  }
  if (platform === "darwin") {
    const line = (options.psStartLine ?? defaultPsStartLine)(pid);
    return macStartIdentity(pid, line);
  }
  return `${pid}@unknown`;
}

/** Normalize one identity for comparison; null means it can never prove identity. */
function comparableStartIdentity(identity: string): string | null {
  const at = identity.indexOf("@");
  if (at <= 0) return null;
  const basis = identity.slice(at + 1);
  if (basis === "unknown") return null;
  const legacy = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.000Z$/.exec(basis);
  return `${identity.slice(0, at)}@${legacy ? `${legacy[1]}Z` : basis}`;
}

/**
 * Contract 010 comparison: exact strings, except a recorded whole-second macOS
 * `...SS.000Z` equals `...SSZ`. `@unknown` proves nothing, not even itself.
 */
export function startIdentityMatches(recorded: string, observed: string): boolean {
  const left = comparableStartIdentity(recorded);
  const right = comparableStartIdentity(observed);
  return left !== null && right !== null && left === right;
}
