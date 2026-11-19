/**
 * The ACP task parent and its T3 sessions, recognised from positive identities.
 *
 * A T3 task is one thread on the Nucleus ACP provider (Spec 065). T3 starts that
 * provider as `nucleus-acp.mjs` with the task's worktree as its cwd, and starts
 * every role session — worker, reviewer, recovery, closeout — as a native child
 * of that thread. Both outlive any tool a role is running: the parent holds its
 * turn for the whole task, and an idle role session holds its thread. A
 * cwd-rooted process proof therefore sees them as "a process in the workspace"
 * and blocks review or closeout, even though they are the task's own runtime
 * (nucleus#1377).
 *
 * Nothing here is proved by a name or a path alone. A parent is runtime when all
 * three facts hold:
 *
 * 1. its parent is the *connected* T3 server process — the pid the server's own
 *    runtime descriptor records, under the base directory of the stored
 *    connection whose origin that descriptor names (`acpTaskRuntimeBinding`);
 * 2. it runs the Nucleus ACP entry point (`nucleus-acp.mjs`), not a namesake;
 * 3. its own environment names a Nucleus ACP binding, or its cwd resolves one,
 *    and that binding's task id is this task's.
 *
 * A session is runtime when it is a direct child of a recognised parent (T3 runs
 * that parent's roles under it) or when it is a direct child of the same
 * connected server and its own environment names one of this task's participant
 * threads (`T3CODE_THREAD_ID`). A session's standing MCP server — the Nucleus
 * report helper, or a program started in its own `mcp` server mode — is runtime
 * too. A command a session's tools start never is: `node build.mjs` beneath a
 * session is work, and a shell is never a runtime, so every chain it starts
 * stays live.
 *
 * An unreadable environment, a parent that is not the server, and a binding that
 * names another task all hold. The same recognition protects these processes
 * from run cleanup and lets workspace proof pass while a task is idle.
 */
import { readFileSync } from "node:fs";
import { acpBindingPath, acpBindingSchema } from "../../shared/acp/binding";
import {
  argvBase,
  commandArgv,
  INTERPRETER_PROGRAMS,
  isShellProgram,
  REPORT_HELPER_SCRIPTS,
} from "./process-shapes";
import {
  readAcpProcessIdentities,
  type AcpProcessIdentities,
} from "./run-process-identity";
import type { AcpTaskRuntimeBinding } from "./participant-runtime";

/** The process facts this recognition reads: identity, parent, state, command and cwd. */
export type RuntimeProcessFact = {
  pid: number;
  ppid?: number | null;
  state?: string | null;
  command: string;
  cwd: string | null;
};

/** The installed ACP agent entry point the `nucleus` provider runs. */
export const ACP_ENTRY_SCRIPT = "nucleus-acp.mjs";

/** The interpreter arguments that run the ACP entry point, never a namesake. */
export function isAcpEntryPoint(command: string): boolean {
  const argv = commandArgv(command);
  const base = argvBase(argv[0])?.toLowerCase();
  if (base === ACP_ENTRY_SCRIPT) return true;
  if (!base || !INTERPRETER_PROGRAMS.has(base)) return false;
  return argv.slice(1).some((arg) => argvBase(arg) === ACP_ENTRY_SCRIPT);
}

/**
 * A standing MCP server a session keeps: the Nucleus report helper that session
 * was started with, or a program started in its own `mcp` server mode. A
 * command that merely passes the word along is not one, so `node build.mjs`
 * under the session stays a tool.
 */
export function isSessionMcpServer(command: string): boolean {
  const argv = commandArgv(command);
  const base = argvBase(argv[0])?.toLowerCase();
  if (!base) return false;
  if (INTERPRETER_PROGRAMS.has(base)) {
    const script = argvBase(argv[1]);
    if (script && REPORT_HELPER_SCRIPTS.includes(script)) return true;
  }
  const mode = (argv[1] ?? "").toLowerCase();
  return mode === "mcp" || mode === "mcp-server" || mode === "mcp_server";
}

const alive = (fact: { state?: string | null }) =>
  !(fact.state ?? "").toUpperCase().startsWith("Z");

/** The ACP binding a parent carries: its environment's pointer, or its cwd's own. */
function bindingTaskId(
  fact: RuntimeProcessFact,
  identity: { sessionPath: string | null; dataHome: string | null } | null,
  dataHome: string,
  cache: Map<string, string | null>,
): string | null {
  if (!identity) return null;
  const path =
    identity.sessionPath ??
    (fact.cwd ? acpBindingPath(identity.dataHome ?? dataHome, fact.cwd) : null);
  if (!path) return null;
  if (cache.has(path)) return cache.get(path)!;
  let taskId: string | null = null;
  try {
    taskId = acpBindingSchema.parse(
      JSON.parse(readFileSync(path, "utf8")),
    ).taskId;
  } catch {
    taskId = null;
  }
  cache.set(path, taskId);
  return taskId;
}

/**
 * The pids one task's ACP parent, its native role sessions and those sessions'
 * standing MCP servers hold among one process listing. An identity this listing
 * cannot prove is simply not in the set: the caller keeps its hold.
 */
export function acpTaskRuntimePids(
  processes: readonly RuntimeProcessFact[],
  binding: AcpTaskRuntimeBinding | null | undefined,
  reads: { identities?: typeof readAcpProcessIdentities } = {},
): Set<number> {
  const runtime = new Set<number>();
  if (
    !binding ||
    !binding.taskIds.length ||
    !Number.isSafeInteger(binding.serverPid) ||
    binding.serverPid <= 0
  )
    return runtime;
  // The connected server must be in this listing: its pid alone proves nothing.
  if (!processes.some((fact) => fact.pid === binding.serverPid)) return runtime;
  const candidates = processes.filter(
    (fact) =>
      fact.ppid === binding.serverPid &&
      alive(fact) &&
      !isShellProgram(argvBase(commandArgv(fact.command)[0])?.toLowerCase()),
  );
  if (!candidates.length) return runtime;
  const wantedTasks = new Set(binding.taskIds);
  const wantedThreads = new Set(binding.threadIds);
  const cache = new Map<string, string | null>();
  const readIdentities = reads.identities ?? readAcpProcessIdentities;
  const parentIdentities = readIdentities(candidates.map((fact) => fact.pid));
  const parents = new Set<number>();
  for (const fact of candidates) {
    if (!isAcpEntryPoint(fact.command)) continue;
    const taskId = bindingTaskId(
      fact,
      parentIdentities.get(fact.pid) ?? null,
      binding.dataHome,
      cache,
    );
    if (!taskId || !wantedTasks.has(taskId)) continue;
    parents.add(fact.pid);
    runtime.add(fact.pid);
  }
  if (!parents.size) return runtime;
  // A role session is the recognised parent's own child, or any child of the same
  // connected server whose own environment names one of this task's participant
  // threads. A command a session's tools start is neither.
  const sessions = processes.filter(
    (fact) =>
      alive(fact) &&
      !parents.has(fact.pid) &&
      (parents.has(fact.ppid as number) || fact.ppid === binding.serverPid) &&
      !isShellProgram(argvBase(commandArgv(fact.command)[0])?.toLowerCase()),
  );
  const sessionIdentities = readIdentities(
    sessions
      .filter((fact) => !parentIdentities.has(fact.pid))
      .map((fact) => fact.pid),
  );
  for (const session of sessions) {
    const thread =
      (sessionIdentities.get(session.pid) ?? parentIdentities.get(session.pid))
        ?.t3ThreadId ?? null;
    const underParent = parents.has(session.ppid as number);
    if (!underParent && !(thread && wantedThreads.has(thread))) continue;
    runtime.add(session.pid);
    for (const child of processes) {
      if (child.ppid !== session.pid || !alive(child)) continue;
      if (isSessionMcpServer(child.command)) runtime.add(child.pid);
    }
  }
  return runtime;
}

/**
 * The same shape without the identities a binding proves, for run cleanup: a
 * task parent and its sessions are never a released run's tool, so a process
 * whose environment is unreadable must not be stopped on that guess.
 */
export function possibleAcpRuntimePids(
  processes: readonly RuntimeProcessFact[],
): Set<number> {
  const runtime = new Set<number>();
  for (const parent of processes) {
    if (!alive(parent) || !isAcpEntryPoint(parent.command)) continue;
    runtime.add(parent.pid);
    for (const session of processes) {
      if (session.ppid !== parent.pid || !alive(session)) continue;
      if (
        isShellProgram(argvBase(commandArgv(session.command)[0])?.toLowerCase())
      )
        continue;
      runtime.add(session.pid);
      for (const server of processes)
        if (
          server.ppid === session.pid &&
          alive(server) &&
          isSessionMcpServer(server.command)
        )
          runtime.add(server.pid);
    }
  }
  return runtime;
}
