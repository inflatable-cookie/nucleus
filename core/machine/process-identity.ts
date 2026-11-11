import type { ProcessSearch } from '../host/types';
export type { ProcessSearch } from '../host/types';
/**
 * Host process identity (task 114): a pid alone is not an identity, because the
 * OS recycles pids, and a process start time is not precise enough to tell a
 * reuse apart (`ps -o lstart=` resolves to one second on macOS). Queue instead
 * identifies a detached QA supervisor by a random per-run token that the
 * supervisor carries in its own argv: the live process at the recorded pid must
 * be the one running with this run's token, which no recycled pid can have.
 *
 * The command line is read from `/proc/<pid>/cmdline` on Linux and `ps -ww -o
 * command=` elsewhere. A line this host cannot read is null — "unknown", never
 * "a different process", so a transient read failure is never proof of death.
 */
import { execFile, spawnSync } from "node:child_process";
import { readFileSync, readlinkSync, readdirSync } from "node:fs";
import { promisify } from "node:util";

export { pidAlive } from "./pid";

/** Bound on the one `ps` call; a wedged `ps` is an unreadable identity, never a stall. */
const PS_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

/** One `/proc/<pid>/cmdline` read: its line, or why it could not be read. */
export type ProcCommandLine =
  | { state: "read"; line: string }
  | { state: "empty" }
  | { state: "gone" }
  | { state: "unreadable" };

/**
 * Read one process's `/proc/<pid>/cmdline`, keeping apart the three ways it can
 * come back without a line: the process is gone, it has no argv (a kernel
 * thread or a zombie), or this host refused the read. Only the last is unknown,
 * because an unreadable entry may be the process a scan is looking for.
 */
export function linuxProcCommandLine(pid: number): ProcCommandLine {
  try {
    const text = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const line = text.split("\0").filter(Boolean).join(" ").trim();
    return line ? { state: "read", line } : { state: "empty" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? { state: "gone" } : { state: "unreadable" };
  }
}

/** `/proc/<pid>/cmdline` is NUL-separated argv; null when it is empty or unreadable. */
function linuxCommandLine(pid: number): string | null {
  const read = linuxProcCommandLine(pid);
  return read.state === "read" ? read.line : null;
}

/**
 * The executable image a live pid is running, as this host can resolve it: the
 * real path of the file the kernel would re-exec, not a name to be re-resolved
 * through PATH. A script's image is its interpreter, and `/proc` reports a
 * replaced file as `<path> (deleted)`; both are honest answers, and an
 * unreadable one is null (unknown), never a different process.
 */
export function processExecutablePath(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const target = readlinkSync(`/proc/${pid}/exe`);
      return target || null;
    } catch { /* fall through to ps */ }
  }
  const result = spawnSync("ps", ["-ww", "-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: PS_TIMEOUT_MS });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.trim() || null;
}

/** One live process's parent pid, or null when this host cannot read it. */
export function processParentPid(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const parent = Number(fields[1]);
      if (Number.isInteger(parent) && parent > 0) return parent;
    } catch { /* fall through to ps */ }
  }
  const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: PS_TIMEOUT_MS });
  if (result.status !== 0 || !result.stdout) return null;
  const parent = Number(result.stdout.trim());
  return Number.isInteger(parent) && parent > 0 ? parent : null;
}

function psCommandLine(pid: number): string | null {
  const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: PS_TIMEOUT_MS });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.trim() || null;
}

/**
 * The live process's full command line (its argv), or null when the pid is gone
 * or its command line cannot be read. Null is "unknown", never "different".
 */
export function processCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return linuxCommandLine(pid) ?? psCommandLine(pid);
  return psCommandLine(pid) ?? linuxCommandLine(pid);
}

/** Await the OS identity read without blocking the service event loop. */
export async function processCommandLineAsync(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    const line = linuxCommandLine(pid);
    if (line) return line;
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8", timeout: PS_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch { return process.platform === "linux" ? null : linuxCommandLine(pid); }
}

/** Async token search with the same complete-listing requirement as the synchronous scan. */
export async function findProcessByCommandTokenAsync(token: string): Promise<ProcessSearch> {
  if (!token || process.platform === "linux") return findProcessByCommandToken(token);
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-ww", "-o", "pid=,command="], {
      encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    });
    if (!stdout) return { state: "unknown" };
    const reads = stdout.split("\n")
      .map(line => /^\s*(\d+)\s+(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(match => ({ pid: Number(match[1]), read: { state: "read", line: match[2] } as ProcCommandLine }));
    return scanTokenVerdict(reads, token);
  } catch { return { state: "unknown" }; }
}

/**
 * The verdict of one scan over the entries a host listed. A token match is
 * `found`; absence is proven only when every entry was ruled out. An entry whose
 * command line could not be read makes the verdict `unknown`, because it may be
 * the very process the scan is looking for — an unreadable `/proc` line is never
 * proof of absence.
 */
export function scanLineVerdict(entries: Array<{ pid: number; read: ProcCommandLine }>, match: (line: string) => boolean): ProcessSearch {
  let unreadable = false;
  for (const entry of entries) {
    if (entry.read.state === "read" && match(entry.read.line)) return { state: "found", pid: entry.pid };
    if (entry.read.state === "unreadable") unreadable = true;
  }
  return unreadable ? { state: "unknown" } : { state: "absent" };
}

export function scanTokenVerdict(entries: Array<{ pid: number; read: ProcCommandLine }>, token: string): ProcessSearch {
  return scanLineVerdict(entries, line => line.includes(token));
}

function listProcessCommands(): Array<{ pid: number; read: ProcCommandLine }> | { state: "unknown" } {
  if (process.platform === "linux") {
    let entries: string[];
    try { entries = readdirSync("/proc"); } catch { return { state: "unknown" }; }
    return entries.filter(entry => /^\d+$/.test(entry))
      .map(entry => ({ pid: Number(entry), read: linuxProcCommandLine(Number(entry)) }));
  }
  const result = spawnSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8", timeout: PS_TIMEOUT_MS });
  if (result.status !== 0 || !result.stdout) return { state: "unknown" };
  return result.stdout.split("\n")
    .map(line => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({ pid: Number(match[1]), read: { state: "read", line: match[2] } as ProcCommandLine }));
}

/** True when a process argv is `git worktree add` targeting `targetPath`. */
export function worktreeAddTargets(line: string, targetPath: string): boolean {
  return Boolean(targetPath) && /(?:^|\s)worktree\s+add(?:\s|$)/.test(line) && line.includes(targetPath);
}

/**
 * Live `git worktree add` targeting `targetPath`. `unknown` is an unreadable
 * listing, never absence, so a timeout or roll cannot treat a still-running
 * populate as missing.
 */
export function findGitWorktreeAdd(targetPath: string): ProcessSearch {
  if (!targetPath) return { state: "absent" };
  const listed = listProcessCommands();
  if (!Array.isArray(listed)) return listed;
  return scanLineVerdict(listed, line => worktreeAddTargets(line, targetPath));
}

/**
 * Find a live process whose own command line carries `token`. `absent` is proof
 * that no process is running with the token — the host listed all of them and
 * every entry was read and ruled out — so a supervisor can be reconciled as lost
 * on it. `unknown` is a scan that could not run to completion (a failed listing,
 * or an entry the host would not let us read), which proves nothing.
 */
export function findProcessByCommandToken(token: string): ProcessSearch {
  if (!token) return { state: "absent" };
  const listed = listProcessCommands();
  if (!Array.isArray(listed)) return listed;
  return scanTokenVerdict(listed, token);
}
