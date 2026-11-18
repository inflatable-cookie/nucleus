import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

import type { HostProcessFact } from "../host/types";
import { pidAlive } from "./pid";
import {
  processStartIdentityLiveness,
  processStartIdentityLivenessAsync,
} from "./process-identity-search";
import {
  readHostRunStartIdentity,
  startIdentityMatches,
} from "./start-identity";

const execFileAsync = promisify(execFile);
const KEYS = [
  "NUCLEUS_TICKET",
  "NUCLEUS_CONTINUATION_TICKET",
  "TMPDIR",
  "TMP",
  "TEMP",
  "BB_THREAD_ID",
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
  } = {},
): Promise<Map<number, RunProcessEnvironment | null>> {
  const result = new Map<number, RunProcessEnvironment | null>();
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    for (const pid of pids) {
      try {
        const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split(
          "\0",
        );
        result.set(
          pid,
          Object.fromEntries(
            entries.flatMap((entry) => {
              const at = entry.indexOf("=");
              const key = entry.slice(0, at);
              return KEYS.includes(key as (typeof KEYS)[number])
                ? [[key, entry.slice(at + 1)]]
                : [];
            }),
          ),
        );
      } catch {
        result.set(pid, null);
      }
    }
  } else if (platform === "darwin") {
    for (let offset = 0; offset < pids.length; offset += 64) {
      const chunk = pids.slice(offset, offset + 64);
      for (const pid of chunk) result.set(pid, null);
      try {
        const stdout = options.darwinRead
          ? await options.darwinRead(chunk)
          : await execFileAsync(
              "ps",
              ["-E", "-ww", "-p", chunk.join(","), "-o", "pid=,command="],
              { encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
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
  return linuxZombieIsDead(pid) ? "dead" : live;
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
 * spawned (never `spawnSync`) and bounded by the caller; any pid it could not
 * read keeps the table's answer, because a failed read proves nothing.
 */
export async function refreshedRunProcessLiveness(
  pids: readonly number[],
  table: RunProcessLivenessLookup,
): Promise<RunProcessLivenessLookup> {
  const unique = [
    ...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0)),
  ];
  if (!unique.length) return table;
  const reads = await Promise.all(
    unique.map((pid) =>
      readHostRunStartIdentity(pid).catch(() => ({
        kind: "unavailable" as const,
      })),
    ),
  );
  const observed = new Map(
    unique.map((pid, index) => [pid, reads[index]!] as const),
  );
  return (pid, startIdentity) => {
    const read = observed.get(pid);
    if (!read) return table(pid, startIdentity);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !startIdentity.startsWith(`${pid}@`)
    )
      return "unknown";
    if (read.kind === "gone") return "dead";
    if (process.platform === "linux" && linuxZombieIsDead(pid)) return "dead";
    if (read.kind === "unavailable") return pidAlive(pid) ? "unknown" : "dead";
    if (read.identity.endsWith("@unknown")) return "unknown";
    return startIdentityMatches(startIdentity, read.identity)
      ? "alive"
      : "dead";
  };
}
