/**
 * One task participant's runtime, per host, as one value every proof shares.
 *
 * A participant's runtime is not a tool: it is the agent host's own process tree
 * for that participant, which outlives every turn by design. BB proves it from a
 * thread id its bridge carries in the environment (nucleus#1343); T3/ACP proves it
 * from the connected server's ancestry and the task's own ACP binding
 * (nucleus#1377). Both answers are collected here and handed to one recognition,
 * so a gate never invents a second, host-specific path.
 *
 * The value carries facts only — thread ids, the server pid, the data home — never
 * a decision. A caller that cannot prove one of them leaves it absent, and the
 * recognition keeps its hold.
 */
import { dirname } from "node:path";
import { parseAgentId } from "../../shared/agent-identity";
import { hostKindOf } from "../../shared/host-kind";
import {
  readT3Connection,
  readT3RuntimeDescriptor,
  t3HttpOrigin,
} from "../../shared/t3/settings";

/** The task and run fields this recognition reads, so a run projection is enough. */
export interface RuntimeTaskFacts {
  id: string;
  agentId?: string | null;
  hostId?: string | null;
}
export interface RuntimeRunFacts {
  taskId: string;
  agentId?: string | null;
  hostId?: string | null;
}

/** The ACP task-parent runtime one T3 connection proves for these tasks. */
export interface AcpTaskRuntimeBinding {
  /** The connected T3 server process, from that server's own runtime descriptor. */
  serverPid: number;
  /** The data home whose `acp/bindings/` each parent reads. */
  dataHome: string;
  /** The task ids whose ACP binding is this task's runtime. */
  taskIds: readonly string[];
  /** The T3 participant threads that are the task's native role sessions. */
  threadIds: readonly string[];
}

/** What one proof may treat as a participant's runtime in the listing it reads. */
export interface ParticipantRuntime {
  /** BB participant threads whose bridge, session and MCP server are runtime. */
  bbThreads?: readonly string[];
  /** The ACP task parent and its native role sessions, when this host runs them. */
  acp?: AcpTaskRuntimeBinding | null;
}

/** No host binding: every process the proof sees is judged on its own facts. */
export const NO_PARTICIPANT_RUNTIME: ParticipantRuntime = {};

/** The data home a store's own directory names, or null for an in-memory store. */
export function storeDataHome(store: { path: string }): string | null {
  const path = store.path?.trim();
  return !path || path === ":memory:" ? null : dirname(path);
}

/**
 * A recorded participant identifies its own T3 thread, never another host's
 * agent. The native id is kept as given when the identity is unqualified, exactly
 * as a bare BB thread id is.
 */
export function t3ThreadForAgent(
  agentId: string | null | undefined,
  hostId?: string | null,
): string | null {
  if (!agentId) return null;
  const qualified = parseAgentId(agentId);
  const host = qualified?.hostId ?? hostId;
  if (
    hostKindOf(host) !== "t3code" ||
    (qualified && hostId && qualified.hostId !== hostId)
  )
    return null;
  return qualified?.nativeAgentId ?? agentId;
}

/**
 * The connected T3 server process and its data home, from records Nucleus wrote
 * itself: the stored connection names the endpoint, and the running server's own
 * runtime descriptor names the pid and that same origin. A descriptor for another
 * endpoint, a missing base directory or an unreadable record proves nothing.
 */
export function t3AcpServerRuntime(
  dataHome: string,
): { serverPid: number; dataHome: string } | null {
  let connection: ReturnType<typeof readT3Connection>;
  try {
    connection = readT3Connection(dataHome);
  } catch {
    return null;
  }
  if (!connection?.baseDir) return null;
  let descriptor: ReturnType<typeof readT3RuntimeDescriptor>;
  try {
    descriptor = readT3RuntimeDescriptor(connection.baseDir);
  } catch {
    return null;
  }
  if (
    !descriptor ||
    !Number.isSafeInteger(descriptor.pid) ||
    descriptor.pid <= 0
  )
    return null;
  try {
    if (t3HttpOrigin(descriptor.origin) !== t3HttpOrigin(connection.endpoint))
      return null;
  } catch {
    return null;
  }
  return { serverPid: descriptor.pid, dataHome };
}

/** The ACP binding these tasks' participants share, or null when none is proved. */
export function acpTaskRuntimeBinding(
  dataHome: string | null,
  tasks: readonly RuntimeTaskFacts[],
  runs: readonly RuntimeRunFacts[],
): AcpTaskRuntimeBinding | null {
  if (!dataHome) return null;
  const t3Tasks = tasks.filter((task) => hostKindOf(task.hostId) === "t3code");
  if (!t3Tasks.length) return null;
  const server = t3AcpServerRuntime(dataHome);
  if (!server) return null;
  const taskIds = [...new Set(t3Tasks.map((task) => task.id))].filter(Boolean);
  if (!taskIds.length) return null;
  // The task's own agent is the parent thread the binding names, not a role
  // session: only the participants' threads can name a session process.
  const threads = new Set<string>();
  const add = (agentId: string | null | undefined, hostId?: string | null) => {
    const thread = t3ThreadForAgent(agentId, hostId);
    if (thread) threads.add(thread);
  };
  for (const run of runs) {
    const task = t3Tasks.find((candidate) => candidate.id === run.taskId);
    if (!task) continue;
    // A run records its own host; a run without one belongs to its task's.
    add(run.agentId, run.hostId ?? task.hostId);
  }
  return {
    serverPid: server.serverPid,
    dataHome: server.dataHome,
    taskIds,
    threadIds: [...threads],
  };
}

/**
 * The runtime a proof may exclude for these participants: the BB threads the
 * caller already resolved, plus the ACP binding these tasks' own records prove.
 */
export function participantRuntime(input: {
  dataHome: string | null;
  tasks: readonly RuntimeTaskFacts[];
  runs?: readonly RuntimeRunFacts[];
  bbThreads?: readonly string[];
}): ParticipantRuntime {
  const bbThreads = [...new Set(input.bbThreads ?? [])];
  const acp = acpTaskRuntimeBinding(
    input.dataHome,
    input.tasks,
    input.runs ?? [],
  );
  return acp ? { bbThreads, acp } : { bbThreads };
}
