import type { HostProcessFact } from "../host/types";
export type { HostProcessFact } from "../host/types";
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
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { readFile, readdir, readlink, realpath } from "node:fs/promises";
import {
  cwdMapFromLsof,
  type CwdState,
} from "../workspaces/worktree-validation";
import { parseProcCommandLine, type ProcCommandLine } from "./process-identity";
import { linuxStartIdentity, macStartIdentity } from "./start-identity";
import {
  readHostRunStartIdentity,
  startIdentityMatches,
} from "./start-identity";
import {
  darwinBbThreadEnvironments,
  runProcessEnvironments,
} from "./run-process-identity";

/** The longest command a process fact retains; the tail carries the arguments a proof reads. */
export const HOST_PROCESS_COMMAND_MAX = 4096;
const PS_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

/** What a host process-table read proved: the table, or why there is none. */
export type HostProcessListRead =
  | { state: "listed"; processes: HostProcessFact[] }
  | { state: "unknown"; reason: string };

/**
 * Whether one process's inspection reads prove it exited between the listing
 * and its inspection. A gone process holds no tools: it leaves the table
 * instead of blocking a proof with an unreadable cwd or command. Only a read
 * that proves absence drops it; an unreadable or empty read stays unknown.
 */
export function inspectedProcessGone(
  command: ProcCommandLine,
  cwd: CwdState,
): boolean {
  return command.state === "gone" || cwd.state === "gone";
}

/**
 * Drop table rows whose cwd inspection proved the process exited between the
 * ps listing and the lsof read. A missing map (an unusable lsof pass) keeps
 * every row unknown; only a completed pass proves an omitted pid is gone.
 */
export function dropExitedProcesses(
  facts: HostProcessFact[],
  cwds: Map<number, CwdState> | null,
): HostProcessFact[] {
  if (!cwds) return facts;
  return facts.filter((fact) => {
    const cwd = cwds.get(fact.pid) ?? { state: "unreadable" as const };
    return !inspectedProcessGone({ state: "read", line: fact.command }, cwd);
  });
}

/** Preserve command failure and partial output; never turn an OS error into absence. */
async function processListing(
  command: string,
  args: string[],
  env = process.env,
) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
      env,
    });
    return { status: 0, stdout };
  } catch (error) {
    const failure = error as Error & {
      code?: string | number;
      stdout?: string;
      signal?: NodeJS.Signals;
    };
    return {
      status: typeof failure.code === "number" ? failure.code : null,
      stdout: failure.stdout ?? "",
      error,
      signal: failure.signal,
    };
  }
}

function truncateCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim().slice(0, HOST_PROCESS_COMMAND_MAX);
}

function uidOf(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

async function linuxCwd(pid: number): Promise<CwdState> {
  try {
    return {
      state: "read",
      path: await realpath(await readlink(`/proc/${pid}/cwd`)),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH"
      ? { state: "gone" }
      : { state: "unreadable" };
  }
}

async function linuxUid(pid: number): Promise<number | null> {
  try {
    const match = /^Uid:\s+(\d+)/m.exec(
      await readFile(`/proc/${pid}/status`, "utf8"),
    );
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function linuxCommand(pid: number): Promise<ProcCommandLine> {
  try {
    return parseProcCommandLine(await readFile(`/proc/${pid}/cmdline`, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH"
      ? { state: "gone" } : { state: "unreadable" };
  }
}

async function linuxProcesses(
  uid: number,
  pids?: readonly number[],
): Promise<HostProcessListRead> {
  let entries: string[];
  try {
    entries = pids ? pids.map(String) : await readdir("/proc");
  } catch (error) {
    return {
      state: "unknown",
      reason: `the /proc listing is unreadable: ${String(error)}`,
    };
  }
  const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8").then(value => value.trim() || null, () => null);
  const listed: HostProcessFact[] = [];
  for (let offset = 0; offset < entries.length; offset += 64) {
    const facts = await Promise.all(entries.slice(offset, offset + 64).map(async entry => {
      if (!/^\d+$/.test(entry)) return null;
      const pid = Number(entry);
      if (await linuxUid(pid) !== uid) return null;
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
      if (!stat) return null;
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const [command, cwd] = await Promise.all([linuxCommand(pid), linuxCwd(pid)]);
      // Exits during the walk are absent. Other inspection failures stay unknown.
      if (inspectedProcessGone(command, cwd)) return null;
      return {
        pid,
        ppid: Number(fields[1]),
        state: fields[0] || null,
        pgid: Number(fields[2]),
        uid,
        startIdentity: linuxStartIdentity(pid, stat, bootId),
        command: command.state === "read" ? truncateCommand(command.line) : "",
        cwd: cwd.state === "read" ? cwd.path : null,
      };
    }));
    for (const fact of facts) if (fact) listed.push(fact);
  }
  return { state: "listed", processes: listed };
}

async function darwinProcesses(
  uid: number,
  requested?: readonly number[],
): Promise<HostProcessListRead> {
  if (requested && !requested.length) return { state: "listed", processes: [] };
  const args = requested
    ? [
        "-p",
        requested.join(","),
        "-o",
        "uid=,pid=,ppid=,pgid=,stat=,lstart=,command=",
      ]
    : ["-axo", "uid=,pid=,ppid=,pgid=,stat=,lstart=,command="];
  const listing = await processListing("ps", args, {
    ...process.env,
    LC_ALL: "C",
    TZ: "UTC",
  });
  if (listing.status !== 0 || !listing.stdout)
    return {
      state: "unknown",
      reason: `the host process listing failed: ${listing.error ? String(listing.error) : `ps exited with code ${listing.status}`}`,
    };
  const facts: HostProcessFact[] = [];
  for (const line of listing.stdout.split("\n")) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(
        line,
      );
    if (!match || Number(match[1]) !== uid) continue;
    const pid = Number(match[2]);
    facts.push({
      pid,
      ppid: Number(match[3]),
      state: match[5] || null,
      pgid: Number(match[4]),
      uid,
      startIdentity: macStartIdentity(pid, match[6]),
      command: truncateCommand(match[7]),
      cwd: null,
    });
  }
  const pids = facts.map((fact) => fact.pid);
  if (!pids.length) return { state: "listed", processes: [] };
  // One bounded cwd read for the PIDs from this snapshot; a failed read stays unknown.
  const cwds = cwdMapFromLsof(
    pids,
    await processListing("lsof", [
      "-a",
      "-d",
      "cwd",
      "-Fn",
      "-p",
      pids.join(","),
    ]),
  );
  if (cwds)
    for (const fact of facts) {
      const cwd = cwds.get(fact.pid);
      if (cwd?.state === "read") fact.cwd = cwd.path;
    }
  return { state: "listed", processes: dropExitedProcesses(facts, cwds) };
}

/**
 * Every host process owned by this uid, or the reason the table is unknown.
 *
 * An absent uid or an unsupported platform is unknown, not empty: nothing here
 * proves that no process is running, so no caller may read it that way.
 */
export async function readHostUidProcesses(): Promise<HostProcessListRead> {
  const uid = uidOf();
  if (uid < 0)
    return {
      state: "unknown",
      reason: "the host process owner cannot be read on this platform",
    };
  if (process.platform === "linux" || process.platform === "darwin") {
    const read =
      process.platform === "linux"
        ? await linuxProcesses(uid)
        : await darwinProcesses(uid);
    if (read.state === "listed") {
      await readBbSessionEnvironments(read.processes);
      await markTrustedCuaProcesses(read.processes);
    }
    return read;
  }
  return {
    state: "unknown",
    reason: `host process listing is unsupported on ${process.platform}`,
  };
}

// proc_pidpath reads the loaded image, unlike argv or KERN_PROCARGS2's exec path.
const DARWIN_LOADED_IMAGES = `ObjC.import('Foundation');
ObjC.bindFunction('dlopen', ['void *', ['char *', 'int']]);
ObjC.bindFunction('calloc', ['void *', ['size_t', 'size_t']]);
ObjC.bindFunction('free', ['void', ['void *']]);
$.dlopen('/usr/lib/libproc.dylib', 9);
ObjC.bindFunction('proc_pidpath', ['int', ['int', 'void *', 'unsigned int']]);
function run(args) {
  const out = {};
  for (const arg of args) {
    const pid = Number(arg);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const buf = $.calloc(4096, 1);
    try {
      const count = $.proc_pidpath(pid, buf, 4096);
      if (count > 0 && count < 4096)
        out[arg] = ObjC.unwrap($.NSData.dataWithBytesLength(buf, count).base64EncodedStringWithOptions(0));
    } finally { $.free(buf); }
  }
  return JSON.stringify(out);
}`;

/** Read a loaded executable by PID, never from process arguments. */
export async function loadedExecutablePaths(
  pids: readonly number[],
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>(pids.map((pid) => [pid, null]));
  if (process.platform === "linux") {
    for (const pid of pids)
      try {
        result.set(pid, await readlink(`/proc/${pid}/exe`));
      } catch {
        /* Unknown. */
      }
  } else if (process.platform === "darwin") {
    for (let offset = 0; offset < pids.length; offset += 64) {
      const chunk = pids.slice(offset, offset + 64);
      try {
        const { stdout } = await execFileAsync(
          "/usr/bin/osascript",
          [
            "-l",
            "JavaScript",
            "-e",
            DARWIN_LOADED_IMAGES,
            "--",
            ...chunk.map(String),
          ],
          { encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        );
        const output = JSON.parse(stdout) as Record<string, string>;
        for (const pid of chunk)
          if (typeof output[pid] === "string")
            result.set(
              pid,
              Buffer.from(output[pid]!, "base64").toString("utf8"),
            );
      } catch {
        /* Unknown; never use argv as a substitute. */
      }
    }
  }
  return result;
}

/** Only the installed executable loaded by this PID can be the standing Cua MCP server. */
export async function markTrustedCuaProcesses(
  facts: HostProcessFact[],
  installed = join(homedir(), ".local/bin/cua-driver"),
  reads: {
    images?: typeof loadedExecutablePaths;
    identity?: typeof readHostRunStartIdentity;
  } = {},
): Promise<void> {
  for (const fact of facts) delete fact.trustedCuaExecutable;
  let trusted: string;
  try {
    trusted = await realpath(installed);
  } catch {
    return;
  }
  const candidates = facts.filter((fact) => {
    const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(fact.command.trim());
    const program = match?.[1] ?? match?.[2] ?? match?.[3];
    return Boolean(
      program && isAbsolute(program) && basename(program) === "cua-driver",
    );
  });
  const images = await (reads.images ?? loadedExecutablePaths)(
    candidates.map((fact) => fact.pid),
  ).catch(() => new Map<number, string | null>());
  await Promise.all(
    candidates.map(async (fact) => {
      try {
        const image = images.get(fact.pid);
        const identity = await (reads.identity ?? readHostRunStartIdentity)(
          fact.pid,
        );
        if (
          image &&
          await realpath(image) === trusted &&
          identity.kind === "identity" &&
          startIdentityMatches(fact.startIdentity, identity.identity)
        )
          fact.trustedCuaExecutable = true;
      } catch {
        /* An unreadable executable is not positive identity. */
      }
    }),
  );
}

/** Read only possible bridge sessions, and keep a reused or unreadable pid unknown. */
export async function readBbSessionEnvironments(
  facts: HostProcessFact[],
  reads: {
    environments?: typeof runProcessEnvironments;
    bbThreads?: typeof darwinBbThreadEnvironments;
    platform?: NodeJS.Platform;
    identity?: typeof readHostRunStartIdentity;
  } = {},
): Promise<void> {
  const bridges = new Set(
    facts
      .filter((fact) =>
        /(?:^|\/)host-daemon\/dist\/bb-provider-bridge-worker\.mjs(?:\s|$)/.test(
          fact.command,
        ),
      )
      .map((fact) => fact.pid),
  );
  const candidates = facts.filter(
    (fact) => fact.ppid != null && bridges.has(fact.ppid),
  );
  if (!candidates.length) return;
  const pids = candidates.map((fact) => fact.pid);
  const platform = reads.platform ?? process.platform;
  const threads =
    platform === "darwin"
      ? await (reads.bbThreads ?? darwinBbThreadEnvironments)(pids)
      : new Map(
          [
            ...(await (reads.environments ?? runProcessEnvironments)(pids, {
              platform,
            })),
          ].map(([pid, env]) => [pid, env?.BB_THREAD_ID ?? null]),
        );
  await Promise.all(
    candidates.map(async (fact) => {
      const identity = await (reads.identity ?? readHostRunStartIdentity)(
        fact.pid,
      ).catch(() => ({ kind: "unavailable" as const }));
      fact.bbThreadId =
        identity.kind === "identity" &&
        startIdentityMatches(fact.startIdentity, identity.identity)
          ? (threads.get(fact.pid) ?? null)
          : null;
    }),
  );
}

/** Read only explicitly owned fixture PIDs; never infer a host-wide absence from this subset. */
export async function readProcessSubset(
  pids: readonly number[],
): Promise<HostProcessListRead> {
  const requested = [...new Set(pids)].filter(
    (pid) => Number.isSafeInteger(pid) && pid > 0,
  );
  if (!requested.length) return { state: "listed", processes: [] };
  const uid = uidOf();
  if (uid < 0)
    return {
      state: "unknown",
      reason: "the host process owner cannot be read",
    };
  if (process.platform === "linux") return linuxProcesses(uid, requested);
  if (process.platform === "darwin") return darwinProcesses(uid, requested);
  return {
    state: "unknown",
    reason: `process listing is unsupported on ${process.platform}`,
  };
}
