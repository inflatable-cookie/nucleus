import type { HostProcessFact } from '../host/types';
export type { HostProcessFact } from '../host/types';
/**
 * Terminal host-process sweep: when a task reaches done or cancelled, Queue
 * terminates leftover host processes whose cwd is inside the retained worktree
 * or whose process group Queue recorded for that task's own runs. Identity is
 * pid or pgid plus start identity, never a command pattern. A failure is
 * advisory and never holds or reopens the task.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cwdInWorktree, cwdMapFromLsof, type CwdState } from "../workspaces/worktree-validation";
import { linuxProcCommandLine } from "./process-identity";
import { processGroupEmpty, processGroupHasStartIdentity, processStartIdentityLiveness, signalProcessGroup } from "./process-group";
import { linuxStartIdentity, macStartIdentity, startIdentityMatches } from "./start-identity";
import { pidAlive } from "./pid";
import { now, type Store } from "../store/store";
import type { Task } from "../../shared/contracts";

export const HOST_PROCESS_SWEEP_KIND = "host_process_sweep";
export const HOST_PROCESS_SWEEP_WARNING_KIND = "host_process_sweep_warning";
export const HOST_PROCESS_SWEEP_SETTLED_KIND = "host_process_sweep_settled";
export const HOST_PROCESS_SWEEP_PASEO_SKIPPED_KIND = "host_process_sweep_paseo_skipped";
/** Short grace after SIGTERM before SIGKILL. Archive and recovery must not wait on a 30s hook grace. */
export const HOST_PROCESS_SWEEP_GRACE_MS = 1_500;
export const HOST_PROCESS_COMMAND_MAX = 4096;
const PS_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

/** Preserve command failure and partial output; never turn an OS error into absence. */
async function processListing(command: string, args: string[], env = process.env) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env,
    });
    return { status: 0, stdout };
  } catch (error) {
    const failure = error as Error & { code?: string | number; stdout?: string; signal?: NodeJS.Signals };
    return { status: typeof failure.code === "number" ? failure.code : null, stdout: failure.stdout ?? "", error, signal: failure.signal };
  }
}

export interface RecordedProcessGroup {
  pgid: number;
  startIdentity: string | null;
}

function commandArgv(command: string): string[] {
  return command.trim().match(/(?:"[^"]*"|'[^']*'|\S+)/g)?.map(arg => arg.replace(/^["']|["']$/g, "")) ?? [];
}

function argvBase(arg: string | undefined): string | undefined {
  return arg?.split(/[\\/]/).pop();
}

/** Match the Node bridge invocation, not provider config that merely names it. */
function isRunMcpReportHelper(command: string, ticket: string): boolean {
  const args = commandArgv(command);
  return argvBase(args[0]) === "node" && argvBase(args[1]) === "mcp-report.mjs" && argvBase(args[2]) === ticket;
}

function directoryOf(path: string): string | null {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : null;
}

/** The directory a program was invoked from, and where it resolves to. */
function programDirectories(program: string | undefined): string[] {
  if (!program || !/[\\/]/.test(program)) return [];
  const invoked = directoryOf(program);
  if (!invoked) return [];
  const resolved = (() => { try { return directoryOf(realpathSync(program)); } catch { return null; } })();
  return resolved && resolved !== invoked ? [invoked, resolved] : [invoked];
}

/** A command chain starts at a shell, so a shell is never one of these runtimes. */
const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "cmd.exe", "powershell", "pwsh"]);
/** Interpreters a provider ships to run the runtime scripts it keeps warm. */
const INTERPRETER_PROGRAMS = new Set(["node", "nodejs", "deno", "bun", "python", "python3"]);
const RUNTIME_SCRIPT = /\.[cm]?[jt]s$/;
/** Provider flags that bind a runtime to one provider session rather than to a command. */
const SESSION_FLAG = /^--?session[-_]?id(?:=|$)/i;
/** A session identity: a uuid or a token-length hex id, never a word a command passes on. */
const SESSION_ID_VALUE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

/**
 * The provider session id an interpreter carries, from its own arguments.
 *
 * A runtime the provider keeps is bound to one session id it was started with;
 * an agent command's arguments are not a session id, and a flag it passes on to
 * its own script (`node /workspace/build.js --working-dir /workspace`) says
 * nothing about the provider, so it never qualifies.
 */
function providerSessionId(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!SESSION_FLAG.test(arg)) continue;
    const at = arg.indexOf("=");
    const value = at >= 0 ? arg.slice(at + 1) : argv[index + 1];
    if (value && SESSION_ID_VALUE.test(value)) return value;
  }
  return null;
}

/** The script a command runs: an interpreter's own runtime script, when it has one. */
function runtimeScript(argv: readonly string[]): string | null {
  return argv.slice(1).find(arg => RUNTIME_SCRIPT.test(arg)) ?? null;
}

function carriesFlag(argv: readonly string[], name: string): boolean {
  return argv.some(arg => arg === name || arg.startsWith(`${name}=`));
}

/**
 * The provider's own standing tool runtimes among one process listing, decided
 * from those facts alone and never from a provider name list:
 *
 * 1. The program is one the provider ships — inside an application bundle
 *    (`Foo.app/Contents/…`), or beside the provider's own executable in its
 *    installation directory under the provider's own program name
 *    (`codex-code-mode-host`, `codex app-server` beside `codex`, including the
 *    real directory a `~/.local/bin` symlink resolves to). A generic host
 *    program from that same directory (`node`, `git` from a Homebrew prefix) is
 *    not the provider's, and neither is a program the agent chose.
 * 2. Its own shape is a tool server, not a command: a runtime host
 *    (`node_repl`, `*-host`) or the provider's executable in its `app-server`
 *    mode, or — started directly by one of those hosts and sharing that host and
 *    directory with another such script — an interpreter carrying the whole
 *    session binding it was started with (a `--session-id` uuid or token-length
 *    hex id *and* a `--working-dir`), which also claims the directory of the
 *    runtime script it runs.
 * 3. A runtime script that shares a scratch directory claimed by one of those
 *    session-bound runtimes is the same runtime family — the trusted worker the
 *    host writes beside its warm `kernel.js` — but only while the host started
 *    it: a script a runtime starts, even from the runtime's own scratch
 *    directory, is a command and keeps the fence.
 *
 * A session-shaped command is not enough on its own: an agent's own script that
 * is handed `--session-id`, `--working-dir`, or both, is a command unless a
 * provider tool host started it beside another runtime script. A shell is never
 * a runtime, so every command chain a provider's shell starts stays live, and a
 * runtime's children are judged one by one: a command a kernel spawned through a
 * shell, or with a script from its own scratch directory or anywhere else, is
 * real work and still holds. An unreadable command is never infrastructure.
 */
function providerRuntimePids(provider: HostProcessFact, processes: readonly HostProcessFact[]): Set<number> {
  const providerArgv = commandArgv(provider.command);
  const providerProgram = argvBase(providerArgv[0])?.toLowerCase() ?? "";
  const providerDirectories = new Set(programDirectories(providerArgv[0]));
  const providerShipped = (program: string, base: string): boolean => {
    if (/\.app\/Contents\//.test(program)) return true;
    if (!providerProgram || (base !== providerProgram && !base.startsWith(`${providerProgram}-`))) return false;
    return programDirectories(program).some(directory => providerDirectories.has(directory));
  };
  const candidates = processes.flatMap(process => {
    const argv = commandArgv(process.command);
    const program = argv[0];
    const base = argvBase(program)?.toLowerCase() ?? "";
    if (!program || !base || SHELL_PROGRAMS.has(base) || !providerShipped(program, base)) return [];
    return [{ process, argv, base }];
  });
  const byPid = new Map(processes.map(process => [process.pid, process]));
  const runtimes = new Set<number>();
  const hosts = new Set<number>();
  for (const { process, argv, base } of candidates) {
    // A nested provider server is a host; the provider itself is the root this
    // proof already starts from, never one of its own runtimes.
    if (process.pid === provider.pid) continue;
    const host = base.endsWith("-host") || base.endsWith("_repl") || base === "node_repl"
      || (base === providerProgram && argv.slice(1).some(arg => argvBase(arg) === "app-server"));
    if (!host) continue;
    hosts.add(process.pid);
    runtimes.add(process.pid);
  }
  /**
   * The provider's runtime set is the set of scripts one of its own tool hosts
   * writes and starts together, so a single session-shaped script is never
   * enough on its own: it must share its host and its directory with another
   * runtime script. A command cannot join that set by copying arguments, and a
   * runtime is still recognised when its host runs several scripts side by side
   * (`kernel.js` and the trusted worker).
   */
  const families = new Map<string, Set<string>>();
  for (const { process, argv, base } of candidates) {
    if (!INTERPRETER_PROGRAMS.has(base) || process.ppid == null) continue;
    const script = runtimeScript(argv);
    const directory = script ? directoryOf(script) : null;
    if (!script || !directory) continue;
    const key = `${process.ppid}\u0000${directory}`;
    families.set(key, new Set([...(families.get(key) ?? []), script]));
  }
  const scratchDirectories = new Set<string>();
  for (const { process, argv, base } of candidates) {
    if (runtimes.has(process.pid) || !INTERPRETER_PROGRAMS.has(base)) continue;
    if (process.ppid == null || !hosts.has(process.ppid)) continue;
    if (providerSessionId(argv) === null || !carriesFlag(argv, "--working-dir")) continue;
    const script = runtimeScript(argv);
    const directory = script ? directoryOf(script) : null;
    if (!directory) continue;
    if ((families.get(`${process.ppid}\u0000${directory}`)?.size ?? 0) < 2) continue;
    runtimes.add(process.pid);
    scratchDirectories.add(directory);
  }
  for (const { process, argv, base } of candidates) {
    if (runtimes.has(process.pid) || !INTERPRETER_PROGRAMS.has(base)) continue;
    // Only the host's own runtime scripts: a script the host's runtime starts is
    // a command, even when it runs from the runtime's own scratch directory.
    if (process.ppid == null || !hosts.has(process.ppid)) continue;
    const script = runtimeScript(argv);
    const directory = script ? directoryOf(script) : null;
    if (directory && scratchDirectories.has(directory)) runtimes.add(process.pid);
  }
  return runtimes;
}

export interface OwnedToolProcessProofOptions {
  /**
   * The same agent's own fresh observation already proves no provider turn is
   * live, so the provider's standing tool runtimes are not this run's work.
   * Absent or false reads every descendant as a possible command.
   */
  noTurnLive?: boolean;
}

/**
 * Inspect the provider process rooted by this run's unique Queue MCP report
 * helper. The helper itself is expected; any other descendant means a shell
 * or command may still be running. Missing or ambiguous identity is unknown.
 * Once no turn is live, a descendant that is only the provider's own standing
 * tool runtime is not work either, while its own children still are.
 */
export function ownedToolProcessTreeVerdict(runId: string, processes: readonly HostProcessFact[] | null, options: OwnedToolProcessProofOptions = {}):
  { state: "empty"; providerPid: number; helperPid: number } | { state: "live"; providerPid: number; helperPid: number; pid: number } | { state: "unknown"; reason: string } {
  if (!processes) return { state: "unknown", reason: "host process listing is unreadable" };
  const ticket = `mcp-${runId}.json`;
  const helpers = processes.filter(process => isRunMcpReportHelper(process.command, ticket));
  if (helpers.length !== 1) return { state: "unknown", reason: helpers.length ? "multiple MCP report helpers match this run" : "MCP report helper is missing" };
  const helper = helpers[0]!;
  if (!Number.isSafeInteger(helper.ppid) || helper.ppid! <= 0 || !processes.some(process => process.pid === helper.ppid))
    return { state: "unknown", reason: "MCP report helper parent is unreadable" };
  const providerPid = helper.ppid!;
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (process.ppid != null && (process.ppid === providerPid || descendants.has(process.ppid)) && !descendants.has(process.pid)) {
        descendants.add(process.pid);
        changed = true;
      }
    }
  }
  const helperTree = new Set<number>([helper.pid]);
  changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) if (process.ppid != null && helperTree.has(process.ppid) && !helperTree.has(process.pid)) {
      helperTree.add(process.pid);
      changed = true;
    }
  }
  for (const pid of helperTree) descendants.delete(pid);
  const runtimes = options.noTurnLive
    ? providerRuntimePids(processes.find(process => process.pid === providerPid)!, processes) : null;
  const other = [...descendants].sort((a, b) => a - b).find(pid => !runtimes?.has(pid));
  return other === undefined ? { state: "empty", providerPid, helperPid: helper.pid }
    : { state: "live", providerPid, helperPid: helper.pid, pid: other };
}

/**
 * A provider process is agent-owned, while its report helper ticket is run-owned.
 * Search the agent's run tickets newest first so a superseded run can use the
 * helper retained by the agent's current run.
 */
export function ownedToolAgentProcessTreeVerdict(runIdsNewestFirst: readonly string[], processes: readonly HostProcessFact[] | null, options: OwnedToolProcessProofOptions = {}):
  { state: "empty"; runId: string; providerPid: number; helperPid: number }
  | { state: "live"; runId: string; providerPid: number; helperPid: number; pid: number }
  | { state: "unknown"; reason: string } {
  if (!processes) return { state: "unknown", reason: "host process listing is unreadable" };
  if (!runIdsNewestFirst.length) return { state: "unknown", reason: "no run process identity is available" };
  for (const runId of runIdsNewestFirst) {
    const verdict = ownedToolProcessTreeVerdict(runId, processes, options);
    if (verdict.state === "unknown" && verdict.reason === "MCP report helper is missing") continue;
    return verdict.state === "unknown" ? verdict : { ...verdict, runId };
  }
  return { state: "unknown", reason: "MCP report helper is missing" };
}

export interface HostProcessTarget {
  pid: number;
  pgid: number;
  startIdentity: string;
  startTime: string;
  cwd: string;
  command: string;
  via: "cwd" | "pgid";
}

export interface HostProcessSweepResult {
  terminated: HostProcessTarget[];
  failed: Array<HostProcessTarget & { reason: string }>;
  /** Paseo-owned targets that matched the sweep scope and were deliberately skipped. */
  skippedPaseo: HostProcessTarget[];
}

export interface HostProcessSweepOptions {
  graceMs?: number;
  directory?: string | null;
  recordedGroups?: RecordedProcessGroup[];
  protectedPids?: Iterable<number>;
  /** Test seam; production reads ~/.paseo/paseo.pid. */
  paseoDaemonPid?: number | null;
  /** Run even before the task is terminal (disposition archive). */
  force?: boolean;
  /** Test seam: substitute the host process table. */
  processes?: HostProcessFact[] | null;
  /** Test seam: override start-identity liveness between discovery and signal. */
  identityLiveness?: (pid: number, startIdentity: string) => ReturnType<typeof processStartIdentityLiveness>;
}

function uidOf(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

function ourPgid(): number {
  try {
    const getpgid = (process as NodeJS.Process & { getpgid?: (pid?: number) => number }).getpgid;
    if (typeof getpgid === "function") return getpgid(0);
  } catch { /* EPERM: fall through to pid. */ }
  return process.pid;
}

function truncateCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim().slice(0, HOST_PROCESS_COMMAND_MAX);
}

function startTimeOf(identity: string): string {
  const at = identity.indexOf("@");
  return at > 0 ? identity.slice(at + 1) : "unknown";
}

function commandLooksLikePaseo(command: string): boolean {
  return command.trim().split(/\s+/).some(token => {
    const base = token.split(/[\\/]/).pop() ?? "";
    return /^(paseo|paseod|paseo-daemon|paseo-supervisor)(\.exe)?$/i.test(base) || /Paseo\.app/i.test(token);
  });
}

function paseoDaemonPidFromFile(): number | null {
  try {
    const contents = readFileSync(join(homedir(), ".paseo", "paseo.pid"), "utf8");
    const match = /^\s*(\d+)\s*$/.exec(contents);
    const pid = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function linuxCwd(pid: number): CwdState {
  try { return { state: "read", path: realpathSync(readlinkSync(`/proc/${pid}/cwd`)) }; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? { state: "gone" } : { state: "unreadable" };
  }
}

function linuxUid(pid: number): number | null {
  try {
    const match = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

function linuxBootId(): string | null {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null; }
  catch { return null; }
}

/** Host processes owned by this uid, with cwd when it can be read. */
export async function listHostUidProcesses(): Promise<HostProcessFact[] | null> {
  const uid = uidOf();
  if (uid < 0) return [];
  if (process.platform === "linux") {
    let entries: string[];
    try { entries = readdirSync("/proc"); } catch { return null; }
    const bootId = linuxBootId();
    const listed: HostProcessFact[] = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const owner = linuxUid(pid);
      if (owner !== uid) continue;
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ppid = Number(fields[1]);
        const pgid = Number(fields[2]);
        const command = linuxProcCommandLine(pid);
        const cwd = linuxCwd(pid);
        listed.push({
          pid, ppid, pgid, uid,
          startIdentity: linuxStartIdentity(pid, stat, bootId),
          command: command.state === "read" ? truncateCommand(command.line) : "",
          cwd: cwd.state === "read" ? cwd.path : null,
        });
      } catch { /* Exited during the walk. */ }
    }
    return listed;
  }
  if (process.platform !== "darwin") return [];
  const listing = await processListing("ps", ["-axo", "uid=,pid=,ppid=,pgid=,lstart=,command="],
    { ...process.env, LC_ALL: "C", TZ: "UTC" });
  if (listing.status !== 0 || !listing.stdout) return null;
  const facts: HostProcessFact[] = [];
  for (const line of listing.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) !== uid) continue;
    const pid = Number(match[2]);
    facts.push({
      pid, ppid: Number(match[3]), pgid: Number(match[4]), uid,
      startIdentity: macStartIdentity(pid, match[5]),
      command: truncateCommand(match[6]),
      cwd: null,
    });
  }
  const pids = facts.map(fact => fact.pid);
  let cwds = cwdMapFromLsof(pids, await processListing("lsof", ["-a", "-d", "cwd", "-Fn", "-u", String(uid)]));
  if (!cwds && pids.length) {
    cwds = cwdMapFromLsof(pids, await processListing("lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")]));
  }
  if (cwds) for (const fact of facts) {
    const cwd = cwds.get(fact.pid);
    if (cwd?.state === "read") fact.cwd = cwd.path;
  }
  return facts;
}

export function recordedProcessGroupsForTask(store: Store, task: Task): RecordedProcessGroup[] {
  const groups = new Map<number, string | null>();
  const remember = (pgid: number | null | undefined, identity: string | null | undefined) => {
    if (!pgid || !Number.isSafeInteger(pgid) || pgid <= 0) return;
    const current = groups.get(pgid);
    if (!current && identity) groups.set(pgid, identity);
    else if (!groups.has(pgid)) groups.set(pgid, identity ?? null);
  };
  for (const record of store.hookEvents(task.id)) remember(record.processGroupId, record.leaderStartIdentity);
  const validation = task.resolution.projectValidation;
  if (validation) {
    remember(validation.processGroupId, validation.leaderStartIdentity);
    if (validation.hostRunId) {
      const run = store.hostRun(validation.hostRunId);
      if (run) remember(run.processGroupId, run.startIdentity);
    }
  }
  return [...groups].map(([pgid, startIdentity]) => ({ pgid, startIdentity }));
}

function defaultProtectedPids(extra?: Iterable<number>): Set<number> {
  const protectedPids = new Set<number>([process.pid, process.ppid].filter(pid => Number.isSafeInteger(pid) && pid > 0));
  if (extra) for (const pid of extra) if (Number.isSafeInteger(pid) && pid > 0) protectedPids.add(pid);
  return protectedPids;
}

interface PaseoProcessOwnership {
  daemonPid: number | null;
  daemonPgid: number | null;
  pids: Set<number>;
  pgids: Set<number>;
}

function paseoProcessOwnership(processes: HostProcessFact[], configuredDaemonPid?: number | null): PaseoProcessOwnership {
  const configured = configuredDaemonPid === undefined ? paseoDaemonPidFromFile() : configuredDaemonPid;
  const daemonPid = Number.isSafeInteger(configured) && configured! > 0 ? configured! : null;
  const byPid = new Map(processes.map(fact => [fact.pid, fact]));
  const roots = new Set<number>();
  for (const fact of processes) if (commandLooksLikePaseo(fact.command)) roots.add(fact.pid);
  if (daemonPid !== null) roots.add(daemonPid);

  const daemonFact = daemonPid === null ? undefined : byPid.get(daemonPid);
  const daemonPgid = daemonFact?.pgid ?? (daemonPid === null ? null : livePgid(daemonPid));
  const pids = new Set<number>();
  const pgids = new Set<number>();
  if (daemonPgid !== null && daemonPgid > 0) pgids.add(daemonPgid);

  for (const fact of processes) {
    let current: HostProcessFact | undefined = fact;
    const visited = new Set<number>();
    let owned = false;
    while (current && !visited.has(current.pid)) {
      visited.add(current.pid);
      if (roots.has(current.pid)) { owned = true; break; }
      const parent = current.ppid;
      if (!parent || parent <= 0 || parent === current.pid) break;
      if (roots.has(parent)) { owned = true; break; }
      current = byPid.get(parent);
    }
    if (daemonPgid !== null && fact.pgid === daemonPgid) owned = true;
    if (!owned) continue;
    pids.add(fact.pid);
    if (Number.isSafeInteger(fact.pgid) && fact.pgid > 0) pgids.add(fact.pgid);
  }
  return { daemonPid, daemonPgid, pids, pgids };
}

function hostProcessTarget(fact: HostProcessFact, via: HostProcessTarget["via"]): HostProcessTarget {
  return {
    pid: fact.pid,
    pgid: fact.pgid,
    startIdentity: fact.startIdentity,
    startTime: startTimeOf(fact.startIdentity),
    cwd: fact.cwd ?? "",
    command: fact.command || `pid ${fact.pid}`,
    via,
  };
}

function selectHostProcessTargetsAndSkips(input: {
  processes: HostProcessFact[];
  worktree: string | null;
  recordedGroups: RecordedProcessGroup[];
  protectedPids: Set<number>;
  queuePgid: number;
  paseo: PaseoProcessOwnership;
}): { targets: HostProcessTarget[]; skippedPaseo: HostProcessTarget[] } {
  const blockedPgids = new Set(input.paseo.pgids);
  const provenPgids = provenRecordedPgids(input.recordedGroups, input.queuePgid, input.processes, blockedPgids);
  const selected = new Map<number, HostProcessTarget>();
  const skippedPaseo: HostProcessTarget[] = [];
  for (const fact of input.processes) {
    if (fact.startIdentity.endsWith("@unknown")) continue;
    const inGroup = provenPgids.has(fact.pgid);
    const inTree = Boolean(input.worktree && fact.cwd && cwdInWorktree(fact.cwd, input.worktree));
    if (!inGroup && !inTree) continue;
    const target = hostProcessTarget(fact, inGroup ? "pgid" : "cwd");
    if (input.paseo.pids.has(fact.pid)) {
      skippedPaseo.push(target);
      continue;
    }
    if (input.protectedPids.has(fact.pid)) continue;
    if (fact.pid === process.pid || fact.pid === process.ppid) continue;
    if (commandLooksLikePaseo(fact.command)) {
      skippedPaseo.push(target);
      continue;
    }
    selected.set(fact.pid, target);
  }
  return { targets: [...selected.values()], skippedPaseo };
}

/**
 * Select kill targets from a process table. Queue itself, Paseo and its daemon
 * are never selected. A process outside the worktree is selected only when its
 * pgid is a recorded group whose identity is still proven on a live member.
 */
export function selectHostProcessTargets(input: {
  processes: HostProcessFact[];
  worktree: string | null;
  recordedGroups: RecordedProcessGroup[];
  protectedPids: Set<number>;
  queuePgid: number;
  paseoDaemonPid?: number | null;
}): HostProcessTarget[] {
  const paseo = paseoProcessOwnership(input.processes, input.paseoDaemonPid);
  return selectHostProcessTargetsAndSkips({ ...input, paseo }).targets;
}

function signalPid(pid: number, identity: string, signal: NodeJS.Signals, liveness: NonNullable<HostProcessSweepOptions["identityLiveness"]>): boolean {
  if (liveness(pid, identity) !== "alive") return false;
  try { process.kill(pid, signal); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function waitForExit(pids: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (pids.every(pid => !pidAlive(pid))) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(0, deadline - Date.now()))));
  }
}

function formatTarget(target: HostProcessTarget): string {
  return `pid=${target.pid} pgid=${target.pgid} start=${target.startTime} cwd=${target.cwd || "-"} command=${target.command || "-"}`;
}

export function formatHostProcessSweepEvent(result: HostProcessSweepResult): string {
  if (!result.terminated.length && !result.failed.length) return "Host process sweep found no leftover host processes";
  const parts: string[] = [];
  if (result.terminated.length)
    parts.push(`terminated ${result.terminated.length}: ${result.terminated.map(formatTarget).join("; ")}`);
  if (result.failed.length)
    parts.push(`could not stop ${result.failed.length}: ${result.failed.map(target => `${formatTarget(target)} reason=${target.reason}`).join("; ")}`);
  return `Host process sweep ${parts.join(". ")}`;
}

function isGroupBirthIdentity(identity: string | null): identity is string {
  return Boolean(identity && !identity.includes("@") && identity.length >= 8);
}

function livePgid(pid: number): number | null {
  try {
    const getpgid = (process as NodeJS.Process & { getpgid?: (pid?: number) => number }).getpgid;
    if (typeof getpgid === "function") return getpgid(pid);
  } catch { /* ESRCH/EPERM: unproven. */ }
  return null;
}

/**
 * A recorded process group is proven only while a live member still carries
 * the recorded identity. UUID tokens look for NUCLEUS_QUEUE_PROCESS_START_IDENTITY
 * (and the retained NORTHSTAR_ one, which pre-Nucleus groups still carry) on a
 * current group member. OS pid@time tokens match a live member of that pgid.
 */
export function recordedGroupIdentityProven(
  group: RecordedProcessGroup,
  processes?: HostProcessFact[],
): boolean {
  const identity = group.startIdentity;
  if (!identity || !Number.isSafeInteger(group.pgid) || group.pgid <= 0) return false;
  if (!identity.includes("@") && identity.length >= 8) return processGroupHasStartIdentity(group.pgid, identity);
  if (!identity.includes("@") || identity.endsWith("@unknown")) return false;
  if (processes) {
    return processes.some(fact => fact.pgid === group.pgid && startIdentityMatches(identity, fact.startIdentity));
  }
  const pid = Number(identity.slice(0, identity.indexOf("@")));
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (processStartIdentityLiveness(pid, identity) !== "alive") return false;
  const pgid = livePgid(pid);
  return pgid === null || pgid === group.pgid;
}

function provenRecordedPgids(
  groups: RecordedProcessGroup[],
  queuePgid: number,
  processes?: HostProcessFact[],
  protectedPgids: ReadonlySet<number> = new Set(),
): Set<number> {
  const proven = new Set<number>();
  for (const group of groups) {
    if (group.pgid === queuePgid || protectedPgids.has(group.pgid)) continue;
    if (recordedGroupIdentityProven(group, processes)) proven.add(group.pgid);
  }
  return proven;
}

export async function terminateHostProcessTargets(
  targets: HostProcessTarget[],
  options: Pick<HostProcessSweepOptions, "graceMs" | "identityLiveness"> & {
    recordedGroups?: RecordedProcessGroup[];
    paseoPids?: Iterable<number>;
    paseoPgids?: Iterable<number>;
  } = {},
): Promise<HostProcessSweepResult> {
  const graceMs = options.graceMs ?? HOST_PROCESS_SWEEP_GRACE_MS;
  const liveness = options.identityLiveness ?? processStartIdentityLiveness;
  const queuePgid = ourPgid();
  const recordedGroups = options.recordedGroups ?? [];
  const paseoPids = new Set(options.paseoPids ?? []);
  const paseoPgids = new Set(options.paseoPgids ?? []);
  const provenPgids = provenRecordedPgids(recordedGroups, queuePgid, undefined, paseoPgids);
  const terminated: HostProcessTarget[] = [];
  const failed: Array<HostProcessTarget & { reason: string }> = [];
  const groupSignalled = new Set<number>();

  for (const group of recordedGroups) {
    if (!provenPgids.has(group.pgid) || !isGroupBirthIdentity(group.startIdentity)) continue;
    if (signalProcessGroup(group.pgid, group.startIdentity, "SIGTERM")) groupSignalled.add(group.pgid);
  }

  for (const target of targets) {
    if (paseoPids.has(target.pid)) continue;
    if (target.via === "pgid" && !provenPgids.has(target.pgid) && !paseoPgids.has(target.pgid)) {
      failed.push({ ...target, reason: "recorded process group identity not proven" });
      continue;
    }
    if (liveness(target.pid, target.startIdentity) !== "alive") {
      failed.push({ ...target, reason: "start identity changed before signal" });
      continue;
    }
    const sent = groupSignalled.has(target.pgid) || signalPid(target.pid, target.startIdentity, "SIGTERM", liveness);
    if (!sent && pidAlive(target.pid) && liveness(target.pid, target.startIdentity) !== "alive") {
      failed.push({ ...target, reason: "start identity changed before signal" });
      continue;
    }
    if (!sent && pidAlive(target.pid)) {
      failed.push({ ...target, reason: "SIGTERM was refused" });
      continue;
    }
    terminated.push(target);
  }

  const survivors = terminated.filter(target => pidAlive(target.pid));
  if (survivors.length) await waitForExit(survivors.map(target => target.pid), graceMs);

  for (const group of recordedGroups) {
    if (!provenPgids.has(group.pgid) || paseoPgids.has(group.pgid) || !isGroupBirthIdentity(group.startIdentity)) continue;
    if (processGroupEmpty(group.pgid)) continue;
    if (!recordedGroupIdentityProven(group)) continue;
    signalProcessGroup(group.pgid, group.startIdentity, "SIGKILL");
  }
  for (const target of terminated) {
    if (paseoPids.has(target.pid)) continue;
    if (!pidAlive(target.pid)) continue;
    if (liveness(target.pid, target.startIdentity) !== "alive") continue;
    signalPid(target.pid, target.startIdentity, "SIGKILL", liveness);
  }
  if (survivors.length) await waitForExit(survivors.map(target => target.pid), Math.min(400, graceMs));

  const stillLive: Array<HostProcessTarget & { reason: string }> = [];
  const gone: HostProcessTarget[] = [];
  for (const target of terminated) {
    if (paseoPids.has(target.pid)) continue;
    if (!pidAlive(target.pid)) gone.push(target);
    else if (liveness(target.pid, target.startIdentity) === "alive")
      stillLive.push({ ...target, reason: "still running after SIGKILL" });
    else gone.push(target);
  }
  return { terminated: gone, failed: [...failed, ...stillLive], skippedPaseo: [] };
}

export async function reapHostProcesses(input: {
  directory?: string | null;
  recordedGroups?: RecordedProcessGroup[];
  protectedPids?: Iterable<number>;
  paseoDaemonPid?: number | null;
  processes?: HostProcessFact[] | null;
  graceMs?: number;
  identityLiveness?: HostProcessSweepOptions["identityLiveness"];
}): Promise<HostProcessSweepResult> {
  const recorded = input.recordedGroups ?? [];
  let worktree: string | null = null;
  if (input.directory && existsSync(input.directory)) {
    try { worktree = realpathSync(input.directory); }
    catch { worktree = input.directory; }
  }
  if (!worktree && !recorded.length) return { terminated: [], failed: [], skippedPaseo: [] };
  const processes = input.processes === undefined ? await listHostUidProcesses() : input.processes;
  if (!processes) return { terminated: [], failed: [{
    pid: 0, pgid: 0, startIdentity: "0@unknown", startTime: "unknown", cwd: worktree ?? "", command: "", via: "cwd",
    reason: "host process listing failed",
  }], skippedPaseo: [] };
  if (worktree && processes.length && processes.every(process => process.cwd === null)) return { terminated: [], failed: [{
    pid: 0, pgid: 0, startIdentity: "0@unknown", startTime: "unknown", cwd: worktree, command: "", via: "cwd",
    reason: "cwd listing failed",
  }], skippedPaseo: [] };
  const paseo = paseoProcessOwnership(processes, input.paseoDaemonPid);
  const selection = selectHostProcessTargetsAndSkips({
    processes,
    worktree,
    recordedGroups: recorded,
    protectedPids: defaultProtectedPids([...(input.protectedPids ?? []), ...paseo.pids]),
    queuePgid: ourPgid(),
    paseo,
  });
  const result = await terminateHostProcessTargets(selection.targets, {
    graceMs: input.graceMs, identityLiveness: input.identityLiveness, recordedGroups: recorded,
    paseoPids: paseo.pids, paseoPgids: paseo.pgids,
  });
  return { ...result, skippedPaseo: selection.skippedPaseo };
}

export function hostProcessSweepIntent(phase: "done" | "cancelled"): { phase: "done" | "cancelled"; at: string } {
  return { phase, at: now() };
}

/**
 * Run the terminal host-process sweep, record one history event, and clear the
 * durable intent. Listing or kill failure is a warning; the task stays terminal.
 */
export async function sweepTaskHostProcesses(store: Store, task: Task, options: HostProcessSweepOptions = {}): Promise<HostProcessSweepResult> {
  const none: HostProcessSweepResult = { terminated: [], failed: [], skippedPaseo: [] };
  const latest = store.task(task.id);
  const terminal = ["done", "cancelled"].includes(latest.phase);
  if (!terminal && !options.force) return none;
  const owed = latest.resolution.hostProcessSweep != null;
  const directory = options.directory === undefined ? latest.directory : options.directory;
  const recordedGroups = options.recordedGroups ?? recordedProcessGroupsForTask(store, latest);
  let result: HostProcessSweepResult;
  try {
    result = await reapHostProcesses({
      directory,
      recordedGroups,
      protectedPids: options.protectedPids,
      paseoDaemonPid: options.paseoDaemonPid,
      processes: options.processes,
      graceMs: options.graceMs,
      identityLiveness: options.identityLiveness,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    store.event(latest.id, HOST_PROCESS_SWEEP_WARNING_KIND, `Host process sweep could not run: ${reason}`);
    settleSweepIntent(store, latest.id);
    return none;
  }
  const listingFailed = result.failed.length === 1 && result.failed[0]!.pid === 0;
  if (listingFailed) {
    store.event(latest.id, HOST_PROCESS_SWEEP_WARNING_KIND, result.failed[0]!.reason);
    return result;
  }
  if (result.skippedPaseo.length && !store.eventsAll(latest.id).some(event => event.kind === HOST_PROCESS_SWEEP_PASEO_SKIPPED_KIND)) {
    store.event(latest.id, HOST_PROCESS_SWEEP_PASEO_SKIPPED_KIND,
      `Skipped ${result.skippedPaseo.length} Paseo-owned process${result.skippedPaseo.length === 1 ? "" : "es"}: ${result.skippedPaseo.map(formatTarget).join("; ")}`);
  }
  const found = result.terminated.length > 0 || result.failed.length > 0;
  if (found || owed) store.event(latest.id, HOST_PROCESS_SWEEP_KIND, formatHostProcessSweepEvent(result));
  settleSweepIntent(store, latest.id);
  return result;
}

function settleSweepIntent(store: Store, taskId: string): void {
  const latest = store.task(taskId);
  if (!latest.resolution.hostProcessSweep) return;
  if (!["done", "cancelled"].includes(latest.phase)) return;
  store.update(latest.id, { resolution: { ...latest.resolution, hostProcessSweep: null } },
    HOST_PROCESS_SWEEP_SETTLED_KIND, "Host process sweep evaluated; durable intent cleared");
}
