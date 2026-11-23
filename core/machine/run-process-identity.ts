import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import type { HostProcessFact } from "../host/types";
import { pidAlive } from "./pid";
import { darwinProcessReadsAsync } from "./process-host-reads";
import {
  processStartIdentityLiveness,
  processStartIdentityLivenessAsync,
} from "./process-identity-search";
import { linuxStartIdentity, startIdentityMatches } from "./start-identity";

const execFileAsync = promisify(execFile);
const KEYS = [
  "NUCLEUS_TICKET",
  "NUCLEUS_CONTINUATION_TICKET",
  "TMPDIR",
  "TMP",
  "TEMP",
  "BB_THREAD_ID",
  "NUCLEUS_ACP_SESSION",
  "NUCLEUS_DATA_HOME",
  "T3CODE_THREAD_ID",
] as const;
export type RunProcessEnvironment = Partial<
  Record<(typeof KEYS)[number], string>
>;

/** Parse KERN_PROCARGS2 without flattening environment entries into ambiguous text. */
export function darwinBbThreadFromProcargs(data: Buffer): string | null {
  if (data.length < 5) return null;
  const argc = data.readInt32LE(0);
  if (argc < 1 || argc > 65536) return null;
  let offset = data.indexOf(0, 4);
  if (offset < 0) return null;
  while (offset < data.length && data[offset] === 0) offset++;
  for (let i = 0; i < argc; i++) {
    offset = data.indexOf(0, offset);
    if (offset < 0) return null;
    offset++;
  }
  let value: string | null = null;
  while (offset < data.length && data[offset] !== 0) {
    const end = data.indexOf(0, offset);
    if (end < 0) return null;
    const entry = data.subarray(offset, end);
    const prefix = Buffer.from("BB_THREAD_ID=");
    if (entry.subarray(0, prefix.length).equals(prefix)) {
      if (value !== null) return null;
      value = entry.subarray(prefix.length).toString("utf8");
    }
    offset = end + 1;
  }
  return value || null;
}

// sysctl returns NUL-delimited argv and environment; ps -E loses the boundaries.
// macOS ships osascript and its Objective-C bridge; no developer tools are needed.
// The helper returns the raw kernel response only over its private stdout pipe.
const DARWIN_PROCARGS = `ObjC.import('Foundation');
ObjC.bindFunction('calloc', ['void *', ['size_t', 'size_t']]);
ObjC.bindFunction('free', ['void', ['void *']]);
ObjC.bindFunction('sysctl', ['int', ['void *', 'unsigned int', 'void *', 'void *', 'void *', 'size_t']]);
function put(p, offset, n) { for (let i = 0; i < 4; i++) p[offset + i] = (n >>> (i * 8)) & 255; }
function size(p) { return p[0] + p[1] * 256 + p[2] * 65536 + p[3] * 16777216; }
function run(args) {
  const out = {};
  for (const arg of args) {
    const pid = Number(arg);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const mib = $.calloc(12, 1), length = $.calloc(8, 1);
    try {
      put(mib, 0, 1); put(mib, 4, 49); put(mib, 8, pid);
      if ($.sysctl(mib, 3, null, length, null, 0) !== 0) continue;
      const count = size(length);
      if (count < 5 || count > 2097152) continue;
      const data = $.calloc(count, 1);
      try {
        if ($.sysctl(mib, 3, data, length, null, 0) === 0 && size(length) <= count)
          out[arg] = ObjC.unwrap($.NSData.dataWithBytesLength(data, size(length)).base64EncodedStringWithOptions(0));
      } finally { $.free(data); }
    } finally { $.free(length); $.free(mib); }
  }
  return JSON.stringify(out);
}`;

export async function darwinBbThreadEnvironments(
  pids: readonly number[],
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>(pids.map((pid) => [pid, null]));
  for (let offset = 0; offset < pids.length; offset += 32) {
    const chunk = pids.slice(offset, offset + 32);
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", DARWIN_PROCARGS, "--", ...chunk.map(String)],
        { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
      );
      const output = JSON.parse(stdout) as Record<string, string>;
      for (const pid of chunk)
        if (typeof output[pid] === "string")
          result.set(
            pid,
            darwinBbThreadFromProcargs(Buffer.from(output[pid]!, "base64")),
          );
    } catch {
      /* No positive environment proof. */
    }
  }
  return result;
}

/** The environment keys an ACP task parent or a T3 session carries. */
const ACP_ENVIRONMENT_KEYS = [
  "NUCLEUS_ACP_SESSION",
  "NUCLEUS_DATA_HOME",
  "T3CODE_THREAD_ID",
] as const;

/**
 * What one T3 process's own environment says about its identity. A null field is
 * unknown, never an absence: nothing proves the process carries no thread, only
 * that this read could not see one.
 */
export interface AcpProcessIdentity {
  /** The T3 thread this process runs for, when its host passes one. */
  t3ThreadId: string | null;
  /** The explicit ACP binding pointer, when the host passed one. */
  sessionPath: string | null;
  /** The data home that resolves this process's checkout binding. */
  dataHome: string | null;
}

/** One identity read per pid; null when that process's environment is unreadable. */
export type AcpProcessIdentities = Map<number, AcpProcessIdentity | null>;

export function acpIdentityFromEnvironment(
  values: RunProcessEnvironment | null | undefined,
): AcpProcessIdentity | null {
  return values ? {
    t3ThreadId: values.T3CODE_THREAD_ID?.trim() || null,
    sessionPath: values.NUCLEUS_ACP_SESSION?.trim() || null,
    dataHome: values.NUCLEUS_DATA_HOME?.trim() || null,
  } : null;
}

/**
 * Read only the identity variables a T3 task parent or role session carries, for
 * a bounded pid set, and never retain a whole environment.
 *
 * A process whose read fails, or whose environment cannot be parsed, stays null,
 * so a proof built on it holds instead of guessing. This is a synchronous read:
 * the process proofs that consume it are synchronous decisions over one listing.
 */
export function readAcpProcessIdentities(
  pids: readonly number[],
  options: { platform?: NodeJS.Platform } = {},
): AcpProcessIdentities {
  const unique = [
    ...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0)),
  ];
  const result: AcpProcessIdentities = new Map(
    unique.map((pid) => [pid, null]),
  );
  if (!unique.length) return result;
  const assign = (pid: number, values: Record<string, string>) =>
    result.set(pid, acpIdentityFromEnvironment(values));
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    for (const pid of unique) {
      try {
        const text = readFileSync(`/proc/${pid}/environ`, "utf8");
        const values: Record<string, string> = {};
        for (const entry of text.split("\0")) {
          const at = entry.indexOf("=");
          if (at <= 0) continue;
          const key = entry.slice(0, at);
          if ((ACP_ENVIRONMENT_KEYS as readonly string[]).includes(key))
            values[key] = entry.slice(at + 1);
        }
        assign(pid, values);
      } catch {
        /* An unreadable environment stays unknown. */
      }
    }
    return result;
  }
  if (platform === "darwin") {
    try {
      const listing = spawnSync(
        "ps",
        ["-E", "-ww", "-p", unique.join(","), "-o", "pid=,command="],
        {
          encoding: "utf8",
          timeout: 5_000,
          killSignal: "SIGKILL",
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        },
      );
      if (listing.error || listing.signal || listing.status !== 0)
        return result;
      for (const line of (listing.stdout ?? "").split("\n")) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!match) continue;
        const pid = Number(match[1]);
        if (!result.has(pid)) continue;
        const values: Record<string, string> = {};
        for (const key of ACP_ENVIRONMENT_KEYS) {
          const value = new RegExp(
            `(?:^| )${key}=(.*?)(?= [A-Za-z_][A-Za-z_0-9]*=|$)`,
          ).exec(match[2])?.[1];
          if (value !== undefined) values[key] = value;
        }
        assign(pid, values);
      }
    } catch {
      /* An unreadable listing proves nothing. */
    }
  }
  return result;
}

/** The answer every custody decision reads: found, proved gone, or unobserved. */
export type RunProcessLiveness = ReturnType<
  typeof processStartIdentityLiveness
>;
/** A liveness answer for one recorded pid and start identity. */
export type RunProcessLivenessLookup = (
  pid: number,
  startIdentity: string,
) => RunProcessLiveness;

/** Read only run ownership fields; never retain or log a process's full environment. Null is unknown. */
export async function runProcessEnvironments(
  pids: readonly number[],
  options: {
    platform?: NodeJS.Platform;
    darwinRead?: (pids: readonly number[]) => Promise<string>;
    signal?: AbortSignal;
  } = {},
): Promise<Map<number, RunProcessEnvironment | null>> {
  const result = new Map<number, RunProcessEnvironment | null>();
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    for (
      let offset = 0;
      offset < pids.length && !options.signal?.aborted;
      offset += 64
    ) {
      await Promise.all(
        pids.slice(offset, offset + 64).map(async (pid) => {
          const text = await readFile(`/proc/${pid}/environ`, {
            encoding: "utf8",
            signal: options.signal,
          }).catch(() => null);
          const environment: RunProcessEnvironment = {};
          for (const entry of text?.split("\0") ?? []) {
            const at = entry.indexOf("=");
            const key = entry.slice(0, at) as (typeof KEYS)[number];
            if (at >= 0 && KEYS.includes(key))
              environment[key] = entry.slice(at + 1);
          }
          result.set(pid, text === null ? null : environment);
        }),
      );
    }
  } else if (platform === "darwin") {
    for (
      let offset = 0;
      offset < pids.length && !options.signal?.aborted;
      offset += 64
    ) {
      const chunk = pids.slice(offset, offset + 64);
      for (const pid of chunk) result.set(pid, null);
      try {
        const stdout = options.darwinRead
          ? await options.darwinRead(chunk)
          : await execFileAsync(
              "ps",
              ["-E", "-ww", "-p", chunk.join(","), "-o", "pid=,command="],
              {
                encoding: "utf8",
                timeout: 5_000,
                killSignal: "SIGKILL",
                maxBuffer: 4 * 1024 * 1024,
                signal: options.signal,
              },
            ).then((result) => result.stdout);
        for (const line of stdout.split("\n")) {
          const match = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (!match) continue;
          const environment: RunProcessEnvironment = {};
          for (const key of KEYS) {
            if (key === "BB_THREAD_ID") continue; // ps output cannot prove entry boundaries.
            const value = new RegExp(
              `(?:^| )${key}=(.*?)(?= [A-Za-z_][A-Za-z_0-9]*=|$)`,
            ).exec(match[2])?.[1];
            if (value !== undefined) environment[key] = value;
          }
          result.set(Number(match[1]), environment);
        }
      } catch {
        /* The candidates in this chunk remain unknown. */
      }
    }
  }
  return result;
}

/** Zombies have stopped; only their parent can reap them. */
export function runProcessLiveness(
  pid: number,
  identity: string,
): RunProcessLiveness {
  const live = processStartIdentityLiveness(pid, identity);
  if (live !== "alive" || process.platform !== "linux") return live;
  return linuxZombieIsDead(pid) ? "dead" : live;
}

/** The same rule off the event loop: the macOS identity read spawns `ps`. */
export async function runProcessLivenessAsync(
  pid: number,
  identity: string,
): Promise<RunProcessLiveness> {
  const live = await processStartIdentityLivenessAsync(pid, identity);
  if (live !== "alive" || process.platform !== "linux") return live;
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  return stat?.slice(stat.lastIndexOf(")") + 2).startsWith("Z") ? "dead" : live;
}

function linuxZombieIsDead(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    /* The identity reader remains authoritative for an unreadable process. */ return false;
  }
}

/**
 * Liveness for every process one already-read host table holds, with no further
 * read: the table is the sweep's single observation, so identity and liveness
 * checks share it instead of spawning `ps` per pid.
 *
 * A listed pid is the recorded process only while it still carries the recorded
 * start identity, and a zombie has stopped. A pid the table does not hold is
 * `dead` only once the kernel proves it gone (ESRCH): the table proves nothing
 * about a process that was never in it.
 */
export function listedProcessLiveness(
  facts: readonly Pick<HostProcessFact, "pid" | "state" | "startIdentity">[],
): RunProcessLivenessLookup {
  const byPid = new Map(facts.map((fact) => [fact.pid, fact]));
  return (pid, startIdentity) => {
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !startIdentity.startsWith(`${pid}@`)
    )
      return "unknown";
    const fact = byPid.get(pid);
    if (fact) {
      if (fact.state?.startsWith("Z")) return "dead";
      return startIdentityMatches(startIdentity, fact.startIdentity)
        ? "alive"
        : "dead";
    }
    return pidAlive(pid) ? "unknown" : "dead";
  };
}

/**
 * The table's answers with a bounded fresh read for exactly these pids: signalling
 * one needs its identity proved now, not as of the sweep's listing. The read is
 * bounded by the caller. A PID that could not be read is unknown while the
 * kernel still sees it, even if the original table held a positive identity.
 */
export async function refreshedRunProcessLiveness(
  pids: readonly number[],
  table: RunProcessLivenessLookup,
  signal?: AbortSignal,
): Promise<RunProcessLivenessLookup> {
  const unique = [
    ...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0)),
  ];
  if (!unique.length) return table;
  const wanted = new Set(unique);
  const identities =
    process.platform === "darwin"
      ? await darwinProcessReadsAsync().startIdentities(unique, signal)
      : new Map<number, string>();
  const zombies = new Set<number>();
  if (process.platform === "linux") {
    const bootId = await readFile("/proc/sys/kernel/random/boot_id", {
      encoding: "utf8",
      signal,
    }).then(
      (value) => value.trim() || null,
      () => null,
    );
    for (
      let offset = 0;
      offset < unique.length && !signal?.aborted;
      offset += 64
    ) {
      await Promise.all(
        unique.slice(offset, offset + 64).map(async (pid) => {
          const stat = await readFile(`/proc/${pid}/stat`, {
            encoding: "utf8",
            signal,
          }).catch(() => null);
          if (!stat) return;
          if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z"))
            zombies.add(pid);
          identities.set(pid, linuxStartIdentity(pid, stat, bootId));
        }),
      );
    }
  }
  return (pid, startIdentity) => {
    if (!wanted.has(pid)) return table(pid, startIdentity);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !startIdentity.startsWith(`${pid}@`)
    )
      return "unknown";
    if (zombies.has(pid) || !pidAlive(pid)) return "dead";
    const identity = identities.get(pid);
    if (!identity || identity.endsWith("@unknown")) return "unknown";
    return startIdentityMatches(startIdentity, identity) ? "alive" : "dead";
  };
}
