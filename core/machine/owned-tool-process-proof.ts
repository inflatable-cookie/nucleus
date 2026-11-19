import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import type { HostProcessFact } from "../host/types";
import { parseAgentId } from "../../shared/agent-identity";
import { hostKindOf } from "../../shared/host-kind";
import type { Run, Task } from "../../shared/contracts";
/**
 * The owned-tool process proof: does the provider process rooted by this run's
 * own Queue MCP report helper still carry a descendant that could be work?
 *
 * Identity is the process table plus each provider runtime's own shape. Nothing
 * here reads a provider name list, a label or a message: the questions it
 * answers are "is this program the provider's own", "is this an interpreter
 * bound to one provider session" and "is any descendant left once no turn is
 * live". The caller decides what an `unknown` answer means.
 */

function commandArgv(command: string): string[] {
  return (
    command
      .trim()
      .match(/(?:"[^"]*"|'[^']*'|\S+)/g)
      ?.map((arg) => arg.replace(/^["']|["']$/g, "")) ?? []
  );
}

function argvBase(arg: string | undefined): string | undefined {
  return arg?.split(/[\\/]/).pop();
}

/** A recorded BB participant identifies its own native thread, never a Paseo agent. */
export function bbThreadForAgent(
  agentId: string | null | undefined,
  hostId?: string | null,
): string | null {
  if (!agentId) return null;
  const qualified = parseAgentId(agentId);
  const host = qualified?.hostId ?? hostId;
  if (
    hostKindOf(host) !== "bb" ||
    (qualified && hostId && qualified.hostId !== hostId)
  )
    return null;
  return qualified?.nativeAgentId ?? agentId;
}

/** All recorded participants of this workspace, not merely the one being observed. */
export function bbWorkspaceThreads(
  task: Task,
  runs: readonly Run[],
  workspaceId?: string | null,
  options: { includeAllRuns?: boolean } = {},
): string[] {
  if (!workspaceId) return [];
  const threads = new Set<string>();
  const add = (agentId: string | null | undefined, hostId?: string | null) => {
    const thread = bbThreadForAgent(agentId, hostId);
    if (thread) threads.add(thread);
  };
  if (task.workspaceId === workspaceId) add(task.agentId, task.hostId);
  for (const retired of task.retiredWorkers ?? []) {
    const run = runs.find((item) => item.id === retired.runId);
    if (
      run &&
      (run.taskId !== task.id ||
        run.role !== "revision" ||
        run.agentId !== retired.agentId)
    )
      throw Error("Retired worker run identity conflicts");
    if ((run?.workspaceId ?? task.workspaceId) === workspaceId)
      add(retired.agentId, run?.hostId ?? task.hostId);
  }
  for (const run of runs)
    if (
      run.taskId === task.id &&
      run.workspaceId === workspaceId &&
      (options.includeAllRuns ||
        ["revision", "reviewer", "executor"].includes(run.role))
    )
      add(run.agentId, run.hostId ?? task.hostId);
  return [...threads];
}

/** Only a bridge under the BB daemon and its positively bound session are runtime. */
export function bbRuntimePids(
  processes: readonly Pick<
    HostProcessFact,
    "pid" | "ppid" | "command" | "bbThreadId" | "trustedCuaExecutable"
  >[],
  threadIds: readonly string[],
): Set<number> {
  return bbBridgePids(processes, new Set(threadIds.filter(Boolean)));
}

/** Cleanup must also preserve a plausible BB runtime whose environment is unreadable. */
export function possibleBbRuntimePids(
  processes: readonly Pick<
    HostProcessFact,
    "pid" | "ppid" | "command" | "bbThreadId" | "trustedCuaExecutable"
  >[],
): Set<number> {
  return bbBridgePids(processes, null);
}

function bbBridgePids(
  processes: readonly Pick<
    HostProcessFact,
    "pid" | "ppid" | "command" | "bbThreadId" | "trustedCuaExecutable"
  >[],
  wanted: Set<string> | null,
): Set<number> {
  const runtime = new Set<number>();
  if (wanted && !wanted.size) return runtime;
  const bbProgram = (command: string) =>
    /\.app\/Contents\/MacOS\/bb(?:\s|$)/i.test(command);
  const script = (command: string, name: string) =>
    command.includes(`/host-daemon/dist/${name}.mjs`);
  if (!wanted)
    for (const bridge of processes) {
      const daemon = processes.find((fact) => fact.pid === bridge.ppid);
      if (
        daemon &&
        bbProgram(bridge.command) &&
        bbProgram(daemon.command) &&
        script(bridge.command, "bb-provider-bridge-worker") &&
        script(daemon.command, "daemon-bundle")
      )
        runtime.add(bridge.pid);
    }
  for (const session of processes) {
    if (
      session.ppid == null ||
      (wanted && (!session.bbThreadId || !wanted.has(session.bbThreadId)))
    )
      continue;
    const bridge = processes.find((fact) => fact.pid === session.ppid);
    const daemon = bridge && processes.find((fact) => fact.pid === bridge.ppid);
    if (
      !bridge ||
      !daemon ||
      !bbProgram(bridge.command) ||
      !bbProgram(daemon.command) ||
      !script(bridge.command, "bb-provider-bridge-worker") ||
      !script(daemon.command, "daemon-bundle")
    )
      continue;
    runtime.add(bridge.pid);
    runtime.add(session.pid);
    for (const child of processes) {
      if (child.ppid !== session.pid) continue;
      const argv = commandArgv(child.command);
      if (
        child.trustedCuaExecutable &&
        argvBase(argv[0]) === "cua-driver" &&
        argv.length === 2 &&
        argv[1] === "mcp"
      )
        runtime.add(child.pid);
    }
  }
  return runtime;
}

/** The per-run report bridges Queue starts beside an agent session. */
const REPORT_HELPER_SCRIPTS = ["mcp-report.mjs", "worker-report.mjs"];

/** Match the Node bridge invocation, not provider config that merely names it. */
function isRunMcpReportHelper(command: string, ticket: string): boolean {
  const args = commandArgv(command);
  return (
    argvBase(args[0]) === "node" &&
    argvBase(args[1]) === "mcp-report.mjs" &&
    argvBase(args[2]) === ticket
  );
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
  const resolved = (() => {
    try {
      return directoryOf(realpathSync(program));
    } catch {
      return null;
    }
  })();
  return resolved && resolved !== invoked ? [invoked, resolved] : [invoked];
}

/** A command chain starts at a shell, so a shell is never one of these runtimes. */
const SHELL_PROGRAMS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "cmd.exe",
  "powershell",
  "pwsh",
]);
/** Interpreters a provider ships to run the runtime scripts it keeps warm. */
const INTERPRETER_PROGRAMS = new Set([
  "node",
  "nodejs",
  "deno",
  "bun",
  "python",
  "python3",
]);
const RUNTIME_SCRIPT = /\.[cm]?[jt]s$/;
/** Provider flags that bind a runtime to one provider session rather than to a command. */
const SESSION_FLAG = /^--?session[-_]?id(?:=|$)/i;
/** A session identity: a uuid or a token-length hex id, never a word a command passes on. */
const SESSION_ID_VALUE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

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
  return argv.slice(1).find((arg) => RUNTIME_SCRIPT.test(arg)) ?? null;
}

function carriesFlag(argv: readonly string[], name: string): boolean {
  return argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function runtimeHost(base: string, argv: readonly string[], providerProgram: string): boolean {
  return base.endsWith("-host") || base.endsWith("_repl") ||
    (base === providerProgram && argv.slice(1).some(arg => argvBase(arg) === "app-server"));
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
export function providerRuntimePids(
  provider: HostProcessFact,
  processes: readonly HostProcessFact[],
): Set<number> {
  return new Set(new RunProcessTable(processes).runtimePids(provider));
}

function runtimePids(
  provider: HostProcessFact,
  providerProgram: string,
  providerDirectories: Set<string>,
  rows: readonly ProcessCommand[],
  directories: (program: string) => readonly string[],
): Set<number> {
  const providerShipped = (program: string, base: string): boolean => {
    if (/\.app\/Contents\//.test(program)) return true;
    if (
      !providerProgram ||
      (base !== providerProgram && !base.startsWith(`${providerProgram}-`))
    )
      return false;
    return directories(program).some((directory) =>
      providerDirectories.has(directory),
    );
  };
  const candidates = rows.filter(({ program, base }) => providerShipped(program, base));
  const runtimes = new Set<number>();
  const hosts = new Set<number>();
  for (const { process, argv, base } of candidates) {
    // A nested provider server is a host; the provider itself is the root this
    // proof already starts from, never one of its own runtimes.
    if (process.pid === provider.pid) continue;
    if (!runtimeHost(base, argv, providerProgram)) continue;
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
    if (providerSessionId(argv) === null || !carriesFlag(argv, "--working-dir"))
      continue;
    const script = runtimeScript(argv);
    const directory = script ? directoryOf(script) : null;
    if (!directory) continue;
    if ((families.get(`${process.ppid}\u0000${directory}`)?.size ?? 0) < 2)
      continue;
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
    if (directory && scratchDirectories.has(directory))
      runtimes.add(process.pid);
  }
  return runtimes;
}

interface RunProviderBinding {
  runId: string;
  provider: HostProcessFact;
  infrastructure: HostProcessFact[];
}

/** Agent hosts, their standing runtimes and report helpers are infrastructure, never run cleanup targets. */
export function runInfrastructurePids(
  processes: readonly HostProcessFact[],
  bbThreads: readonly string[] = [],
): Set<number> {
  return new RunProcessTable(processes).infrastructurePids(bbThreads);
}

interface ProcessCommand {
  process: HostProcessFact;
  argv: string[];
  program: string;
  base: string;
}

/** Parsed facts and provider classifications valid only for this listing. */
export class RunProcessTable {
  readonly byPid = new Map<number, HostProcessFact>();
  readonly orphanedHelpers = new Set<number>();
  private readonly commands = new Map<number, ProcessCommand>();
  private readonly runtimeCandidates: ProcessCommand[] = [];
  private readonly helpers: Array<{ fact: HostProcessFact; runId?: string }> = [];
  private readonly directories = new Map<string, readonly string[]>();
  private readonly runtimes = new Map<string, ReadonlySet<number>>();

  constructor(private readonly facts: readonly HostProcessFact[]) {
    for (const fact of facts) {
      const argv = commandArgv(fact.command);
      const program = argv[0] ?? "";
      const base = argvBase(program) ?? "";
      const row = { process: fact, argv, program, base: base.toLowerCase() };
      this.byPid.set(fact.pid, fact);
      this.commands.set(fact.pid, row);
      if (row.base && !SHELL_PROGRAMS.has(row.base)) this.runtimeCandidates.push(row);
      const script = base === "node" ? argvBase(argv[1]) : undefined;
      if (script && REPORT_HELPER_SCRIPTS.includes(script)) {
        const runId = script === "mcp-report.mjs"
          ? /(?:^|[\\/])mcp-(.+)\.json$/.exec(argv[2] ?? "")?.[1]
          : undefined;
        this.helpers.push({ fact, runId });
      }
    }
    for (const { fact } of this.helpers)
      if (!this.byPid.has(fact.ppid ?? 0)) this.orphanedHelpers.add(fact.pid);
  }

  /** Resolve executable links once, off the executor loop, for cleanup. */
  async readProgramDirectories(signal: AbortSignal): Promise<void> {
    const programs = [...new Set([...this.commands.values()].map(row => row.program))];
    for (let offset = 0; offset < programs.length && !signal.aborted; offset += 64) {
      await Promise.all(programs.slice(offset, offset + 64).map(async program => {
        const invoked = directoryOf(program);
        if (!invoked) { this.directories.set(program, []); return; }
        const resolved = await realpath(program).then(directoryOf, () => null);
        this.directories.set(program, resolved && resolved !== invoked ? [invoked, resolved] : [invoked]);
      }));
    }
  }

  private directoriesFor = (program: string): readonly string[] => {
    const existing = this.directories.get(program);
    if (existing) return existing;
    const directories = programDirectories(program);
    this.directories.set(program, directories);
    return directories;
  };

  runtimePids(provider: HostProcessFact): ReadonlySet<number> {
    const row = this.commands.get(provider.pid);
    const argv = row?.argv ?? commandArgv(provider.command);
    const program = argv[0] ?? "";
    const base = row?.base ?? argvBase(program)?.toLowerCase() ?? "";
    // A provider that would itself be a tool host must be excluded from its
    // own answer. Every other incarnation of an executable shares its answer.
    const isHost = runtimeHost(base, argv, base);
    const key = isHost ? `${provider.pid}\0${program}` : program;
    let pids = this.runtimes.get(key);
    if (!pids) {
      pids = runtimePids(provider, base, new Set(this.directoriesFor(program)),
        this.runtimeCandidates, this.directoriesFor);
      this.runtimes.set(key, pids);
    }
    return pids;
  }

  /** The bridge positively identifies its parent provider and the run's ticket. */
  *providerBindings(): Iterable<RunProviderBinding> {
    for (const { fact: helper, runId } of this.helpers) {
      const provider = this.byPid.get(helper.ppid ?? 0);
      if (!runId || !provider) continue;
      const pids = this.runtimePids(provider);
      yield { runId, provider, infrastructure: this.facts.filter(fact =>
        fact.pid === provider.pid || fact.pid === helper.pid || pids.has(fact.pid)) };
    }
  }

  infrastructurePids(bbThreads: readonly string[]): Set<number> {
    const protectedPids = bbRuntimePids(this.facts, bbThreads);
    const seenRuntimes = new Set<ReadonlySet<number>>();
    for (const { fact: helper } of this.helpers) {
      // A bridge with no provider is its finished run's own leftover.
      if (this.orphanedHelpers.has(helper.pid)) continue;
      protectedPids.add(helper.pid);
      const provider = this.byPid.get(helper.ppid ?? 0)!;
      const runtimes = this.runtimePids(provider);
      if (!seenRuntimes.has(runtimes)) {
        seenRuntimes.add(runtimes);
        for (const pid of runtimes) protectedPids.add(pid);
      }
      let ancestor: HostProcessFact | undefined = provider;
      while (ancestor && !protectedPids.has(ancestor.pid)) {
        protectedPids.add(ancestor.pid);
        ancestor = this.byPid.get(ancestor.ppid ?? 0);
      }
    }
    return protectedPids;
  }
}

export interface OwnedToolProcessProofOptions {
  /**
   * The same agent's own fresh observation already proves no provider turn is
   * live, so the provider's standing tool runtimes are not this run's work.
   * Absent or false reads every descendant as a possible command.
   */
  noTurnLive?: boolean;
  bbThreads?: readonly string[];
}

/**
 * Why the process tree proof could not answer. Each code is a distinct fact a
 * caller acts on: a missing helper may be looked for on another run, while an
 * unreadable table or an ambiguous helper never is.
 */
export type OwnedToolProcessUnknownCode =
  | "listing-unreadable"
  | "no-run-identity"
  | "helper-missing"
  | "helper-ambiguous"
  | "helper-parent-unreadable";

export type OwnedToolProcessTreeVerdict =
  | { state: "empty"; providerPid: number; helperPid: number }
  | { state: "live"; providerPid: number; helperPid: number; pid: number }
  | { state: "unknown"; code: OwnedToolProcessUnknownCode; reason: string };

export type OwnedToolAgentProcessTreeVerdict =
  | { state: "empty"; runId: string; providerPid: number; helperPid: number }
  | {
      state: "live";
      runId: string;
      providerPid: number;
      helperPid: number;
      pid: number;
    }
  | { state: "unknown"; code: OwnedToolProcessUnknownCode; reason: string };

/**
 * Inspect the provider process rooted by this run's unique Queue MCP report
 * helper. The helper itself is expected; any other descendant means a shell
 * or command may still be running. Missing or ambiguous identity is unknown.
 * Once no turn is live, a descendant that is only the provider's own standing
 * tool runtime is not work either, while its own children still are.
 */
export function ownedToolProcessTreeVerdict(
  runId: string,
  processes: readonly HostProcessFact[] | null,
  options: OwnedToolProcessProofOptions = {},
): OwnedToolProcessTreeVerdict {
  if (!processes)
    return {
      state: "unknown",
      code: "listing-unreadable",
      reason: "host process listing is unreadable",
    };
  const ticket = `mcp-${runId}.json`;
  const helpers = processes.filter((process) =>
    isRunMcpReportHelper(process.command, ticket),
  );
  if (helpers.length !== 1)
    return helpers.length
      ? {
          state: "unknown",
          code: "helper-ambiguous",
          reason: "multiple MCP report helpers match this run",
        }
      : {
          state: "unknown",
          code: "helper-missing",
          reason: "MCP report helper is missing",
        };
  const helper = helpers[0]!;
  if (
    !Number.isSafeInteger(helper.ppid) ||
    helper.ppid! <= 0 ||
    !processes.some((process) => process.pid === helper.ppid)
  )
    return {
      state: "unknown",
      code: "helper-parent-unreadable",
      reason: "MCP report helper parent is unreadable",
    };
  const providerPid = helper.ppid!;
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (
        process.ppid != null &&
        (process.ppid === providerPid || descendants.has(process.ppid)) &&
        !descendants.has(process.pid)
      ) {
        descendants.add(process.pid);
        changed = true;
      }
    }
  }
  const helperTree = new Set<number>([helper.pid]);
  changed = true;
  while (changed) {
    changed = false;
    for (const process of processes)
      if (
        process.ppid != null &&
        helperTree.has(process.ppid) &&
        !helperTree.has(process.pid)
      ) {
        helperTree.add(process.pid);
        changed = true;
      }
  }
  for (const pid of helperTree) descendants.delete(pid);
  const runtimes = options.noTurnLive
    ? providerRuntimePids(
        processes.find((process) => process.pid === providerPid)!,
        processes,
      )
    : null;
  if (runtimes)
    for (const pid of bbRuntimePids(processes, options.bbThreads ?? []))
      runtimes.add(pid);
  const other = [...descendants]
    .sort((a, b) => a - b)
    .find((pid) => !runtimes?.has(pid));
  return other === undefined
    ? { state: "empty", providerPid, helperPid: helper.pid }
    : { state: "live", providerPid, helperPid: helper.pid, pid: other };
}

/**
 * A provider process is agent-owned, while its report helper ticket is run-owned.
 * Search the agent's run tickets newest first so a superseded run can use the
 * helper retained by the agent's current run.
 */
export function ownedToolAgentProcessTreeVerdict(
  runIdsNewestFirst: readonly string[],
  processes: readonly HostProcessFact[] | null,
  options: OwnedToolProcessProofOptions = {},
): OwnedToolAgentProcessTreeVerdict {
  if (!processes)
    return {
      state: "unknown",
      code: "listing-unreadable",
      reason: "host process listing is unreadable",
    };
  if (!runIdsNewestFirst.length)
    return {
      state: "unknown",
      code: "no-run-identity",
      reason: "no run process identity is available",
    };
  for (const runId of runIdsNewestFirst) {
    const verdict = ownedToolProcessTreeVerdict(runId, processes, options);
    if (verdict.state === "unknown" && verdict.code === "helper-missing")
      continue;
    return verdict.state === "unknown" ? verdict : { ...verdict, runId };
  }
  return {
    state: "unknown",
    code: "helper-missing",
    reason: "MCP report helper is missing",
  };
}
