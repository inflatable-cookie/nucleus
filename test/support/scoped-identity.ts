import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { TestContext } from "node:test";
import { pidAlive } from "../../core/machine/pid";
import {
  darwinProcessReads,
  psTimeMs,
  type ProcessTreeCpuReads,
} from "../../core/machine/process-host-reads";
import {
  environmentHasIdentity,
  linuxBootId,
  overrideIdentityListing,
  type ProcessStartIdentityFact,
  type ProcessStartIdentitySearch,
} from "../../core/machine/process-identity-search";
import {
  hostRunProcessStartIdentity,
  linuxStartIdentity,
  parseLinuxProcStat,
  startIdentityMatches,
  startIdentityProves,
} from "../../core/machine/start-identity";

/** Inspect only the fixture's recorded process identities. */
export function identityListingForRecords(
  identity: string,
  records: Array<{ pid: number; identity: string }>,
): ProcessStartIdentitySearch {
  if (
    records.some(
      ({ pid, identity }) =>
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        typeof identity !== "string" ||
        !startIdentityProves(identity),
    )
  )
    return { state: "unknown" };
  const live: number[] = [];
  for (const { pid, identity } of records) {
    if (!pidAlive(pid)) continue;
    const observed = hostRunProcessStartIdentity(pid);
    if (observed.endsWith("@unknown")) return { state: "unknown" };
    if (startIdentityMatches(identity, observed)) live.push(pid);
  }
  if (!live.length) return { state: "absent" };
  if (process.platform === "darwin")
    return darwinProcessReads().environmentScan(identity, live);
  if (process.platform !== "linux") return { state: "unknown" };
  const facts: ProcessStartIdentityFact[] = [];
  for (const pid of live) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const parsed = parseLinuxProcStat(stat);
      if (!parsed) return { state: "unknown" };
      if (
        environmentHasIdentity(readFileSync(`/proc/${pid}/environ`), identity)
      )
        facts.push({
          pid,
          processGroupId: parsed.pgid,
          startIdentity: linuxStartIdentity(pid, stat, linuxBootId()),
        });
    } catch {
      if (pidAlive(pid)) return { state: "unknown" };
    }
  }
  return facts.length
    ? { state: "found", processes: facts }
    : { state: "absent" };
}

/** Use only fixture-published PIDs. Missing publication remains unknown. */
export function scopedIdentityListing(t: TestContext, paths: string[] = []) {
  const read = (identity: string): ProcessStartIdentitySearch => {
    if (paths.some((path) => !existsSync(path))) return { state: "unknown" };
    let records: Array<{ pid: number; identity: string }>;
    try {
      records = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return { state: "unknown" };
    }
    return identityListingForRecords(identity, records);
  };
  overrideIdentityListing(read);
  t.after(() => {
    overrideIdentityListing(null);
    for (const path of paths) {
      try {
        const { pid, identity } = JSON.parse(readFileSync(path, "utf8")) as {
          pid: number;
          identity: string;
        };
        if (
          pidAlive(pid) &&
          startIdentityMatches(identity, hostRunProcessStartIdentity(pid))
        )
          process.kill(pid, "SIGKILL");
      } catch {
        /* Missing, already gone or unproven: never signal it. */
      }
    }
  });
  return read;
}

/** A custody-only fixture does not need CPU sampling. */
export const noCpuReads: ProcessTreeCpuReads = {
  platform: "win32",
  now: () => performance.now(),
  snapshot: () => null,
  processListing: () => null,
  environmentScan: () => ({ state: "unknown" }),
  groupListing: () => null,
  pidListing: () => null,
  alive: () => false,
};

/** Sample only the one command PID published by this no-descendant fixture. */
export function singleCommandCpuReads(
  statePath: string,
  qaState = false,
): ProcessTreeCpuReads {
  return {
    ...darwinProcessReads(),
    platform: process.platform,
    now: () => performance.now(),
    alive: pidAlive,
    processListing: () => [],
    snapshot: () => {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        const { pid, identity } = qaState
          ? {
              pid: state.activeProcess?.pid,
              identity: state.activeProcess?.startIdentity,
            }
          : { pid: state.commandPid, identity: state.commandStartIdentity };
        if (
          !pidAlive(pid) ||
          !startIdentityMatches(identity, hostRunProcessStartIdentity(pid))
        )
          return null;
        const result = spawnSync("ps", ["-p", String(pid), "-o", "time="], {
          encoding: "utf8",
          timeout: 1_000,
        });
        const ms = result.status === 0 ? psTimeMs(result.stdout.trim()) : null;
        return ms === null ? null : new Map([[identity, ms]]);
      } catch {
        return null;
      }
    },
  };
}
