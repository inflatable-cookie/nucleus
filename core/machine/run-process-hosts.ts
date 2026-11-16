import type { Store } from "../store/store";
import type { HostProcessFact } from "../host/types";
import { providerRuntimePids, runInfrastructurePids, runProviderBindings } from "./owned-tool-process-proof";
import { startIdentityMatches } from "./start-identity";

export interface ProcessRunIdentity { id: string; taskId: string; agentId?: string | null }
interface RunProcessHost {
  taskId: string;
  provider: Pick<HostProcessFact, "pid" | "startIdentity">;
  infrastructure: Array<{ pid: number; startIdentity: string }>;
}
const key = (runId: string) => `runProcessHost:${runId}`;

/** Remember positively observed infrastructure before its helper can exit. Retained turns share their agent's host. */
export function rememberRunProcessHosts(store: Store, runs: ProcessRunIdentity[], facts: HostProcessFact[]): void {
  for (const binding of runProviderBindings(facts)) {
    const owner = runs.find(run => run.id === binding.runId);
    if (!owner || !startIdentityMatches(binding.provider.startIdentity, binding.provider.startIdentity)) continue;
    for (const run of runs.filter(run => run.id === owner.id || owner.agentId && run.agentId === owner.agentId)) {
      const previous = store.getMeta<RunProcessHost>(key(run.id));
      const infrastructure = new Map((previous?.infrastructure ?? []).map(identity => [`${identity.pid}:${identity.startIdentity}`, identity]));
      for (const fact of binding.infrastructure) if (startIdentityMatches(fact.startIdentity, fact.startIdentity))
        infrastructure.set(`${fact.pid}:${fact.startIdentity}`, { pid: fact.pid, startIdentity: fact.startIdentity });
      const record: RunProcessHost = { taskId: run.taskId, provider: { pid: binding.provider.pid, startIdentity: binding.provider.startIdentity }, infrastructure: [...infrastructure.values()] };
      if (JSON.stringify(previous) !== JSON.stringify(record)) store.setMeta(key(run.id), record);
    }
  }
}

/** A saved identity excludes exactly that host incarnation, never a recycled PID. */
export function protectedRunInfrastructure(store: Store, runs: ProcessRunIdentity[], facts: HostProcessFact[]): Set<number> {
  const protectedPids = runInfrastructurePids(facts);
  for (const run of runs) {
    const record = store.getMeta<RunProcessHost>(key(run.id));
    if (!record) continue;
    for (const fact of facts) if (record.infrastructure.some(identity => identity.pid === fact.pid && startIdentityMatches(identity.startIdentity, fact.startIdentity)))
      protectedPids.add(fact.pid);
    const provider = facts.find(fact => fact.pid === record.provider.pid);
    if (provider && startIdentityMatches(record.provider.startIdentity, provider.startIdentity))
      for (const pid of providerRuntimePids(provider, facts)) protectedPids.add(pid);
  }
  return protectedPids;
}

export function hasRunProcessHost(store: Store, run: ProcessRunIdentity): boolean {
  return Boolean(store.getMeta<RunProcessHost>(key(run.id)));
}
