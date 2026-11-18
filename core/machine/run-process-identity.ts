import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

import type { HostProcessFact } from "../host/types";
import { pidAlive } from "./pid";
import { processStartIdentityLiveness, processStartIdentityLivenessAsync } from "./process-identity-search";
import { readHostRunStartIdentity, startIdentityMatches } from "./start-identity";

const execFileAsync = promisify(execFile);
const KEYS = ["NUCLEUS_TICKET", "NUCLEUS_CONTINUATION_TICKET", "TMPDIR", "TMP", "TEMP", "BB_THREAD_ID"] as const;
export type RunProcessEnvironment = Partial<Record<typeof KEYS[number], string>>;

/** The answer every custody decision reads: found, proved gone, or unobserved. */
export type RunProcessLiveness = ReturnType<typeof processStartIdentityLiveness>;
/** A liveness answer for one recorded pid and start identity. */
export type RunProcessLivenessLookup = (pid: number, startIdentity: string) => RunProcessLiveness;

/** Read only run ownership fields; never retain or log a process's full environment. Null is unknown. */
export async function runProcessEnvironments(pids: readonly number[], options: {
  platform?: NodeJS.Platform;
  darwinRead?: (pids: readonly number[]) => Promise<string>;
} = {}): Promise<Map<number, RunProcessEnvironment | null>> {
  const result = new Map<number, RunProcessEnvironment | null>();
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    for (const pid of pids) {
      try {
        const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        result.set(pid, Object.fromEntries(entries.flatMap(entry => {
          const at = entry.indexOf("=");
          const key = entry.slice(0, at);
          return KEYS.includes(key as typeof KEYS[number]) ? [[key, entry.slice(at + 1)]] : [];
        })));
      } catch { result.set(pid, null); }
    }
  } else if (platform === "darwin") {
    for (let offset = 0; offset < pids.length; offset += 64) {
      const chunk = pids.slice(offset, offset + 64);
      for (const pid of chunk) result.set(pid, null);
      try {
        const stdout = options.darwinRead ? await options.darwinRead(chunk) : await execFileAsync("ps", ["-E", "-ww", "-p", chunk.join(","), "-o", "pid=,command="],
          { encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }).then(result => result.stdout);
        for (const line of stdout.split("\n")) {
          const match = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (!match) continue;
          const environment: RunProcessEnvironment = {};
          for (const key of KEYS) {
            const value = new RegExp(`(?:^| )${key}=(.*?)(?= [A-Za-z_][A-Za-z_0-9]*=|$)`).exec(match[2])?.[1];
            if (value !== undefined) environment[key] = value;
          }
          result.set(Number(match[1]), environment);
        }
      } catch { /* The candidates in this chunk remain unknown. */ }
    }
  }
  return result;
}

/** Zombies have stopped; only their parent can reap them. */
export function runProcessLiveness(pid: number, identity: string): RunProcessLiveness {
  const live = processStartIdentityLiveness(pid, identity);
  if (live !== "alive" || process.platform !== "linux") return live;
  return linuxZombieIsDead(pid) ? "dead" : live;
}

/** The same rule off the event loop: the macOS identity read spawns `ps`. */
export async function runProcessLivenessAsync(pid: number, identity: string): Promise<RunProcessLiveness> {
  const live = await processStartIdentityLivenessAsync(pid, identity);
  if (live !== "alive" || process.platform !== "linux") return live;
  return linuxZombieIsDead(pid) ? "dead" : live;
}

function linuxZombieIsDead(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch { /* The identity reader remains authoritative for an unreadable process. */ return false; }
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
export function listedProcessLiveness(facts: readonly Pick<HostProcessFact, "pid" | "state" | "startIdentity">[]): RunProcessLivenessLookup {
  const byPid = new Map(facts.map(fact => [fact.pid, fact]));
  return (pid, startIdentity) => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !startIdentity.startsWith(`${pid}@`)) return "unknown";
    const fact = byPid.get(pid);
    if (fact) {
      if (fact.state?.startsWith("Z")) return "dead";
      return startIdentityMatches(startIdentity, fact.startIdentity) ? "alive" : "dead";
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
  const unique = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  if (!unique.length) return table;
  const reads = await Promise.all(unique.map(pid => readHostRunStartIdentity(pid).catch(() => ({ kind: "unavailable" as const }))));
  const observed = new Map(unique.map((pid, index) => [pid, reads[index]!] as const));
  return (pid, startIdentity) => {
    const read = observed.get(pid);
    if (!read) return table(pid, startIdentity);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !startIdentity.startsWith(`${pid}@`)) return "unknown";
    if (read.kind === "gone") return "dead";
    if (process.platform === "linux" && linuxZombieIsDead(pid)) return "dead";
    if (read.kind === "unavailable") return pidAlive(pid) ? "unknown" : "dead";
    if (read.identity.endsWith("@unknown")) return "unknown";
    return startIdentityMatches(startIdentity, read.identity) ? "alive" : "dead";
  };
}
