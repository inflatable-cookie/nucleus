import { resolve, sep } from "node:path";
import type { Run, Task } from "../../shared/contracts";
import type { HostProcessFact } from "../host/types";
import type { Resolution } from "../resolution";
import type { PassProcessRead } from "../scheduling/pass-snapshot";
import type { Store } from "../store/store";
import { bbThreadForAgent, RunProcessTable } from "./run-process-tree";
import {
  participantTemporaryDirectory,
  runWorkspaceDirectory,
} from "./participant-roots";
import { participantRuntime, storeDataHome } from "./participant-runtime";
import { recordedRunProvider } from "./run-process-hosts";
import { startIdentityMatches, startIdentityProves } from "./start-identity";

export function isLiveProcess(fact: HostProcessFact): boolean {
  return !fact.state?.toUpperCase().startsWith("Z");
}

/**
 * A cwd or open file under either recorded root holds custody without a report helper.
 * Follow ancestry as well, so changing cwd cannot hide a live child.
 * Standing runtime is excluded as a holder, but its children are examined.
 */
export function runWorkProcesses(input: {
  live: readonly HostProcessFact[];
  byPid: ReadonlyMap<number, HostProcessFact>;
  directories: readonly (string | null | undefined)[];
  infrastructure: ReadonlySet<number>;
  providers?: readonly Pick<HostProcessFact, "pid" | "startIdentity">[];
}): HostProcessFact[] {
  const roots = input.directories.flatMap((root) =>
    root ? [resolve(root)] : [],
  );
  const providerPids = new Set(input.providers?.flatMap((recorded) => {
    const provider = input.byPid.get(recorded.pid);
    return provider && isLiveProcess(provider) &&
      startIdentityMatches(recorded.startIdentity, provider.startIdentity)
      ? [provider.pid] : [];
  }));
  if (!roots.length && !providerPids.size) return [];
  const prefixes = roots.map((root) => root.endsWith(sep) ? root : root + sep);
  const inRoots = (path: string) => roots.includes(path) || prefixes.some((prefix) => path.startsWith(prefix));
  const rooted = new Set(input.live.flatMap((fact) => fact.cwd && inRoots(fact.cwd) ? [fact.pid] : []));
  return input.live.filter((fact) => {
    // An open file is direct custody even when the holder is standing runtime.
    if (fact.openFiles?.paths.some(inRoots)) return true;
    if (providerPids.has(fact.pid) || input.infrastructure.has(fact.pid))
      return false;
    let current: HostProcessFact | undefined = fact;
    const visited = new Set<number>();
    while (current && !visited.has(current.pid)) {
      if (providerPids.has(current.pid) || rooted.has(current.pid)) return true;
      visited.add(current.pid);
      current = input.byPid.get(current.ppid ?? 0);
    }
    return false;
  });
}

export function incompleteRunProcessScan(
  scan: Pick<
    Extract<PassProcessRead, { state: "listed" }>,
    "processes" | "cwdComplete"
  >,
): boolean {
  return (
    scan.cwdComplete === false ||
    scan.processes.some((fact) => isLiveProcess(fact) &&
      (fact.cwd === null || fact.openFiles?.complete === false))
  );
}

export type RunProcessCustody =
  | { state: "live"; process: HostProcessFact }
  | { state: "unknown"; reason: string }
  | { state: "clear" };

export async function readRunProcessCustody(input: {
  store: Store;
  readProcesses: Resolution["readPassProcesses"];
  task: Task;
  runId: string;
  run?: Run | null;
  directory?: string | null;
  activityAt?: string;
}): Promise<RunProcessCustody> {
  const { store, task, run, runId } = input;
  const hostId = run?.hostId ?? task.hostId;
  const scan = await input.readProcesses(hostId, { allowMissFetch: true });
  if (scan.state === "unknown") return scan;
  const live = scan.processes.filter(isLiveProcess);
  const table = new RunProcessTable(live);
  const taskRuns = store.runs(task.id);
  const thread = bbThreadForAgent(run?.agentId ?? task.agentId, hostId);
  const runtime = participantRuntime({
    dataHome: storeDataHome(store),
    tasks: [task],
    runs: taskRuns,
    bbThreads: thread ? [thread] : [],
  });
  const activity = run ? run.participantActivity : task.participantActivity;
  const provider =
    [...table.providerBindings()].find((binding) => binding.runId === runId)
      ?.provider ??
    recordedRunProvider(store, { taskId: task.id, runId }) ??
    (activity?.runId === runId ? activity.process : null);
  const work = runWorkProcesses({
    live,
    byPid: table.byPid,
    directories: [
      input.directory ?? runWorkspaceDirectory(task, run),
      participantTemporaryDirectory(task, taskRuns, runId),
      store.getMeta<{ temporaryDirectory?: string }>(
        `runProcessCleanup:${runId}`,
      )?.temporaryDirectory,
    ],
    infrastructure: table.infrastructurePids(runtime),
    providers: provider && !table.providerHostPids().has(provider.pid) ? [provider] : [],
  });
  const process = work.find(
    (fact) =>
      fact.startIdentity.startsWith(`${fact.pid}@`) &&
      startIdentityProves(fact.startIdentity),
  );
  if (process) return { state: "live", process };
  if (work.length || incompleteRunProcessScan(scan))
    return {
      state: "unknown",
      reason:
        "run process identity, working-directory or open-file coverage is incomplete",
    };
  if (input.activityAt && Date.parse(input.activityAt) > scan.capturedAt)
    return {
      state: "unknown",
      reason: "the process listing predates the run's latest activity",
    };
  return { state: "clear" };
}
