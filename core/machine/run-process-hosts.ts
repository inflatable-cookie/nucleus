import type { ParticipantProcess } from "../../shared/schema/task-activity";
import type { Store } from "../store/store";
import type { HostProcessFact } from "../host/types";
import { bbThreadForAgent, RunProcessTable } from "./run-process-tree";
import {
  participantRuntime,
  storeDataHome,
  type ParticipantRuntime,
} from "./participant-runtime";
import { startIdentityMatches, startIdentityProves } from "./start-identity";

export interface ProcessRunIdentity {
  id: string;
  taskId: string;
  agentId?: string | null;
  hostId?: string | null;
}
interface RunProcessHost {
  taskId: string;
  provider: Pick<HostProcessFact, "pid" | "startIdentity">;
  infrastructure: Array<{ pid: number; startIdentity: string }>;
}
const key = (runId: string) => `runProcessHost:${runId}`;

/** An existing cleanup observation also names the provider behind this run. */
export function recordedRunProvider(
  store: Store, binding: { taskId: string; runId: string },
): ParticipantProcess | null {
  const record = store.getMeta<RunProcessHost>(key(binding.runId));
  return record?.taskId === binding.taskId ? { ...record.provider, seenAt: null } : null;
}

/** Remember positively observed infrastructure before its helper can exit. Retained turns share their agent's host. */
export function rememberRunProcessHosts(
  store: Store,
  runs: ProcessRunIdentity[],
  facts: HostProcessFact[],
  table = new RunProcessTable(facts),
): Map<string, RunProcessHost> {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const byAgent = new Map<string, ProcessRunIdentity[]>();
  const records = new Map<string, RunProcessHost>();
  for (const run of runs) {
    const record = store.getMeta<RunProcessHost>(key(run.id));
    if (record) records.set(run.id, record);
    if (!run.agentId) continue;
    const related = byAgent.get(run.agentId);
    if (related) related.push(run);
    else byAgent.set(run.agentId, [run]);
  }
  for (const binding of table.providerBindings()) {
    const owner = byId.get(binding.runId);
    if (!owner || !startIdentityProves(binding.provider.startIdentity))
      continue;
    for (const run of owner.agentId ? byAgent.get(owner.agentId)! : [owner]) {
      const previous = records.get(run.id);
      const infrastructure = new Map(
        (previous?.infrastructure ?? []).map((identity) => [
          `${identity.pid}:${identity.startIdentity}`,
          identity,
        ]),
      );
      for (const fact of binding.infrastructure)
        if (startIdentityProves(fact.startIdentity))
          infrastructure.set(`${fact.pid}:${fact.startIdentity}`, {
            pid: fact.pid,
            startIdentity: fact.startIdentity,
          });
      const record: RunProcessHost = {
        taskId: run.taskId,
        provider: {
          pid: binding.provider.pid,
          startIdentity: binding.provider.startIdentity,
        },
        infrastructure: [...infrastructure.values()],
      };
      if (JSON.stringify(previous) !== JSON.stringify(record)) {
        store.setMeta(key(run.id), record);
        records.set(run.id, record);
      }
    }
  }
  // A retained provider can start another standing runtime after its helper
  // exits. Preserve that positive observation before the provider can exit too.
  for (const run of runs) {
    const record = records.get(run.id);
    const provider = record && table.byPid.get(record.provider.pid);
    if (
      !record ||
      !provider ||
      !startIdentityMatches(
        record.provider.startIdentity,
        provider.startIdentity,
      )
    )
      continue;
    const saved = matchingInfrastructure(record, table);
    const additions = [...table.runtimePids(provider)].flatMap((pid) => {
      const fact = table.byPid.get(pid)!;
      return !saved.has(pid) && startIdentityProves(fact.startIdentity)
        ? [{ pid, startIdentity: fact.startIdentity }]
        : [];
    });
    if (additions.length) {
      const updated = {
        ...record,
        infrastructure: [...record.infrastructure, ...additions],
      };
      store.setMeta(key(run.id), updated);
      records.set(run.id, updated);
    }
  }
  return records;
}

function matchingInfrastructure(
  record: RunProcessHost,
  table: RunProcessTable,
): Set<number> {
  return new Set(
    record.infrastructure.flatMap((identity) => {
      const fact = table.byPid.get(identity.pid);
      return fact &&
        startIdentityMatches(identity.startIdentity, fact.startIdentity)
        ? [fact.pid]
        : [];
    }),
  );
}

/** A saved identity excludes exactly that host incarnation, never a recycled PID. */
export function protectedRunInfrastructure(
  store: Store,
  runs: ProcessRunIdentity[],
  facts: HostProcessFact[],
  table = new RunProcessTable(facts),
  records?: ReadonlyMap<string, RunProcessHost>,
): Set<number> {
  const bbThreads = runs
    .map((run) => bbThreadForAgent(run.agentId, run.hostId))
    .filter((thread): thread is string => Boolean(thread));
  // A swept task's own host runtime — a T3 ACP parent and its native role
  // sessions — is never a released run's tool (nucleus#1377).
  const tasks = [...new Set(runs.map((run) => run.taskId))].flatMap(
    (taskId) => {
      const task = store.task(taskId);
      return task ? [task] : [];
    },
  );
  const runtime: ParticipantRuntime = participantRuntime({
    dataHome: storeDataHome(store),
    tasks,
    runs,
    bbThreads,
  });
  const protectedPids = table.infrastructurePids(runtime);
  // A saved record outlives the helper it was written with. A bridge whose
  // provider has since exited keeps no exclusion: its identity is the run's own
  // leftover, and the sweep's cleanup reaps it by that identity (nucleus#1329).
  const seenRuntimes = new Set<ReadonlySet<number>>();
  for (const run of runs) {
    const record = records
      ? records.get(run.id)
      : store.getMeta<RunProcessHost>(key(run.id));
    if (!record) continue;
    for (const pid of matchingInfrastructure(record, table))
      if (!table.orphanedHelpers.has(pid)) protectedPids.add(pid);
    const provider = table.byPid.get(record.provider.pid);
    if (
      provider &&
      startIdentityMatches(
        record.provider.startIdentity,
        provider.startIdentity,
      )
    ) {
      const runtimes = table.runtimePids(provider);
      if (!seenRuntimes.has(runtimes)) {
        seenRuntimes.add(runtimes);
        for (const pid of runtimes) protectedPids.add(pid);
      }
    }
  }
  return protectedPids;
}
