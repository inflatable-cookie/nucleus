import type { WorktreeValidationScan } from '../host/types';
export type { WorktreeValidationScan } from '../host/types';
/**
 * Live validation in a task worktree (task #163): a worker can end its turn
 * while `effigy qa` or the repository QA command is still running. Queue's
 * missing-callback clock must treat that process as liveness, not absence.
 *
 * Identity is the worktree cwd plus the command line. A pid alone is not an
 * identity (see process-identity.ts); a command in another checkout is not
 * this task's run. Absence is proven only by a complete scan that ruled every
 * entry out. An incomplete or unreadable listing is `unverified`, never
 * "alive" and never "absent".
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readlinkSync, realpathSync } from "node:fs";
import { linuxProcCommandLine } from "../machine/process-identity";

const PS_TIMEOUT_MS = 5_000;

export type WorktreeValidation = { command: string; pid: number };
export type CwdState = { state: "read"; path: string } | { state: "gone" } | { state: "unreadable" };
export type ListedProcess = { pid: number; command?: string };

/** Retry one incomplete host scan so a transient ps/lsof failure does not hold a task by itself. */
export function retryOnceAfterIncompleteScan<T>(scan: () => T, isComplete: (result: T) => boolean): T {
  const first = scan();
  return isComplete(first) ? first : scan();
}

/** True when argv looks like an Effigy QA invocation (`effigy qa` / `effigy qa:…`). */
export function commandLooksLikeEffigyQa(command: string): boolean {
  const tokens = tokenize(command);
  const start = runnerIndex(tokens);
  if (start < 0) return false;
  return tokens.slice(start).some(token => token === "qa" || token.startsWith("qa:"));
}

/** True when `command` contains `argv` as consecutive tokens (basename-tolerant on argv[0]). */
export function commandContainsArgv(command: string, argv: string[]): boolean {
  if (!argv.length) return false;
  const tokens = tokenize(command);
  if (containsConsecutive(tokens, argv)) return true;
  const base = argv[0].split(/[\\/]/).pop();
  return Boolean(base && base !== argv[0] && containsConsecutive(tokens, [base, ...argv.slice(1)]));
}

export function commandLooksLikeValidation(command: string, extraArgv: string[][] = []): boolean {
  if (commandLooksLikeEffigyQa(command)) return true;
  return extraArgv.some(argv => commandContainsArgv(command, argv));
}

/** `cwd` is this worktree or a directory inside it; a sibling prefix is not a match. */
export function cwdInWorktree(cwd: string, worktree: string): boolean {
  const root = normalizeDir(worktree);
  const path = normalizeDir(cwd);
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Verdict over a listed process table. `listing === null` is a failed OS scan.
 * `cwdsFor` runs only when a readable command looks like QA; `null` from it is
 * a failed cwd scan. Unreadable command lines or cwds cannot prove absence.
 */
export function worktreeValidationVerdict(
  worktree: string,
  listing: ListedProcess[] | null,
  extraArgv: string[][],
  cwdsFor: (pids: number[]) => Map<number, CwdState> | null,
): WorktreeValidationScan {
  if (!listing) return { state: "unverified", reason: "process listing failed" };
  let unreadableCommand = false;
  const matched: WorktreeValidation[] = [];
  for (const entry of listing) {
    if (entry.command == null) { unreadableCommand = true; continue; }
    if (commandLooksLikeValidation(entry.command, extraArgv)) matched.push({ pid: entry.pid, command: entry.command });
  }
  if (!matched.length) {
    return unreadableCommand ? { state: "unverified", reason: "process listing is incomplete" } : { state: "absent" };
  }
  const cwds = cwdsFor(matched.map(entry => entry.pid));
  if (!cwds) return { state: "unverified", reason: "cwd listing failed" };
  let unreadableCwd = false;
  for (const entry of matched) {
    const cwd = cwds.get(entry.pid);
    if (!cwd || cwd.state === "unreadable") { unreadableCwd = true; continue; }
    if (cwd.state === "gone") continue;
    if (cwdInWorktree(cwd.path, worktree)) return { state: "alive", command: entry.command, pid: entry.pid };
  }
  if (unreadableCwd) return { state: "unverified", reason: "cwd listing is incomplete" };
  if (unreadableCommand) return { state: "unverified", reason: "process listing is incomplete" };
  return { state: "absent" };
}

/**
 * Scan the host for Effigy QA or a repository QA argv whose cwd is `directory`.
 * `alive` is a match; `absent` is a complete scan with none; `unverified` is a
 * listing this host could not finish.
 */
export function findWorktreeValidation(directory: string, extraArgv: string[][] = []): WorktreeValidationScan {
  if (!directory) return { state: "absent" };
  let worktree: string;
  try { worktree = realpathSync(directory); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { state: "absent" } : { state: "unverified", reason: "worktree path could not be resolved" };
  }
  return worktreeValidationVerdict(worktree, listProcesses(), extraArgv, processCwds);
}

function tokenize(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function basename(token: string): string {
  return token.split(/[\\/]/).pop() ?? token;
}

function isEffigyToken(token: string): boolean {
  return /(^|[\\/])effigy(?:\.js)?$/i.test(token) || /[\\/]effigy[\\/]/i.test(token);
}

/** argv[0] is Effigy, or a node-family wrapper whose later argv names Effigy. */
function runnerIndex(tokens: string[]): number {
  if (!tokens.length) return -1;
  if (isEffigyToken(tokens[0])) return 0;
  if (!/^(node|nodejs|bun|deno|npx|npm|pnpm|yarn|tsx|env)(?:\.exe)?$/i.test(basename(tokens[0]))) return -1;
  return tokens.findIndex((token, index) => index > 0 && isEffigyToken(token));
}

function containsConsecutive(tokens: string[], argv: string[]): boolean {
  if (argv.length > tokens.length) return false;
  for (let i = 0; i <= tokens.length - argv.length; i++) {
    if (argv.every((arg, offset) => tokens[i + offset] === arg)) return true;
  }
  return false;
}

function normalizeDir(path: string): string {
  return path.replace(/[\\/]+$/, "").replaceAll("\\", "/");
}

function listProcesses(): ListedProcess[] | null {
  if (process.platform === "linux") {
    let entries: string[];
    try { entries = readdirSync("/proc"); } catch { return null; }
    const listed: ListedProcess[] = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const read = linuxProcCommandLine(pid);
      if (read.state === "read") listed.push({ pid, command: read.line });
      else if (read.state === "unreadable") listed.push({ pid });
    }
    return listed;
  }
  const result = retryOnceAfterIncompleteScan(
    () => spawnSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8", timeout: PS_TIMEOUT_MS }),
    scan => scan.status === 0 && Boolean(scan.stdout) && !scan.error && !scan.signal,
  );
  if (result.status !== 0 || !result.stdout || result.error || result.signal) return null;
  return result.stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match && match[2].trim() ? [{ pid: Number(match[1]), command: match[2].trim() }] : [];
  });
}

function processCwds(pids: number[]): Map<number, CwdState> | null {
  if (!pids.length) return new Map();
  if (process.platform === "linux") {
    const found = new Map<number, CwdState>();
    for (const pid of pids) found.set(pid, linuxCwd(pid));
    return found;
  }
  const listing = retryOnceAfterIncompleteScan(
    () => spawnSync("lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")], {
      encoding: "utf8", timeout: PS_TIMEOUT_MS,
    }),
    scan => scan.status === 0 && !scan.error && !scan.signal,
  );
  return cwdMapFromLsof(pids, listing);
}

/**
 * macOS lsof cwd listing. Omitted pids are `gone` only on a completed exit 0.
 * A nonzero, timed-out, or signalled run may have printed only some pids;
 * those missing entries are `unreadable`, never proof the process vanished.
 */
export function cwdMapFromLsof(
  pids: number[],
  listing: {
    status: number | null;
    stdout?: string | null;
    error?: unknown;
    signal?: NodeJS.Signals | number | null;
  },
): Map<number, CwdState> | null {
  const complete = listing.status === 0 && !listing.error && !listing.signal;
  if (!complete && !listing.stdout) return null;
  const found = new Map<number, CwdState>();
  let pid = 0;
  for (const line of (listing.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) {
      const cwd = line.slice(1);
      try { found.set(pid, { state: "read", path: realpathSync(cwd) }); }
      catch { found.set(pid, { state: "read", path: cwd }); }
      pid = 0;
    }
  }
  const omitted: CwdState = complete ? { state: "gone" } : { state: "unreadable" };
  for (const requested of pids) if (!found.has(requested)) found.set(requested, omitted);
  return found;
}

function linuxCwd(pid: number): CwdState {
  try { return { state: "read", path: realpathSync(readlinkSync(`/proc/${pid}/cwd`)) }; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? { state: "gone" } : { state: "unreadable" };
  }
}
