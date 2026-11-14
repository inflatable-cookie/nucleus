import type { AgentObservation } from '../host/adapter';
import type { Engine } from '../engine';
import { startsNoRuns } from '../closeout/queue-drain';
import { now } from '../store/store';
import { archiveWait } from './thread-archive-effect';

/**
 * The Paseo Failed-workspace sweep: Paseo marks a workspace Failed while any of
 * its agents reports status `error`, and an agent that a later run displaced keeps
 * it Failed with no live work behind it. Paseo's agent surface offers no
 * attention-clear call (only `archive`), so this sweep archives retired errored
 * agents no unreleased run references, once the errored thread has stopped. Agents
 * still referenced, active, or outside the task workspace are never touched. A
 * task is swept when its retired set grows, else at most every ten minutes, so the
 * sweep adds no per-pass Paseo read per retired agent. Each unreadable read and
 * refused archive is recorded on the thread-archive wait lane.
 */
export type RetiredArchiveContext = Pick<Engine, 'adapter' | 'host' | 'store' | 'stopped' | 'taskHostAvailable' | 'withHost'>;

export async function archiveRetiredErroredAgents(deps: RetiredArchiveContext, scopedHost?: string): Promise<void> {
  if (!scopedHost) {
    const hosts = new Set(deps.store.activeCapacityTasks().flatMap(task => task.hostId ? [task.hostId] : []));
    for (const host of hosts) await deps.withHost(host, () => archiveRetiredErroredAgents(deps, host));
    return;
  }
  // T3 keeps every task thread visible until closeout, including displaced
  // workers and support threads. This Paseo Failed-workspace cleanup must not
  // archive them while their task is still open (nucleus#1155).
  if (typeof deps.adapter.deleteAgent === 'function') return;
  const sweep = deps.store.getMeta<Record<string, { count: number; at: string; archived?: string[] }>>('retiredArchiveSweep') ?? {};
  let sweepChanged = false;
  const tasks = deps.store.activeCapacityTasks();
  const activeIds = new Set(tasks.map(task => task.id));
  for (const taskId of Object.keys(sweep)) if (!activeIds.has(taskId)) {
    delete sweep[taskId];
    sweepChanged = true;
  }
  for (const task of tasks) {
    if (startsNoRuns(deps.store, deps.stopped)) return;
    if (task.hostId !== scopedHost) continue;
    if (!deps.taskHostAvailable(task)) continue;
    const stamped = sweep[task.id];
    if (stamped && stamped.count === task.retiredWorkers.length && Date.now() - Date.parse(stamped.at) < 10 * 60_000) continue;
    sweep[task.id] = { ...stamped, count: task.retiredWorkers.length, at: now() };
    sweepChanged = true;
    const runs = deps.store.runs(task.id);
    const referenced = new Set<string>();
    for (const run of runs) if (!run.released && run.agentId) referenced.add(run.agentId);
    for (const id of [task.agentId, task.resolution.reviewerAgentId, task.coordinatorAgentId]) if (id) referenced.add(id);
    const candidates: Array<{ agentId: string; why: string }> = [];
    for (const retired of task.retiredWorkers) {
      if (!retired.agentId || referenced.has(retired.agentId)) continue;
      candidates.push({ agentId: retired.agentId, why: `retired worker ${retired.runId}` });
    }
    for (const run of runs) {
      if (!run.released || run.status !== 'superseded' || !run.agentId || referenced.has(run.agentId)) continue;
      if (run.role === 'reviewer' && run.agentId === task.resolution.reviewerAgentId) continue;
      candidates.push({ agentId: run.agentId, why: `superseded ${run.role} run ${run.id}` });
    }
    const candidateIds = new Set(candidates.map(candidate => candidate.agentId));
    const archived = new Set((sweep[task.id]?.archived ?? []).filter(id => candidateIds.has(id)));
    if (sweep[task.id]!.archived?.length !== archived.size) sweepChanged = true;
    sweep[task.id]!.archived = [...archived];
    for (const candidate of candidates) {
      if (archived.has(candidate.agentId)) continue;
      if (startsNoRuns(deps.store, deps.stopped)) return;
      let state: AgentObservation | null = null;
      try { state = await deps.host.observe(candidate.agentId); }
      catch (error) {
        // An unreadable thread is not an archived one: say so once per reason, on
        // the same wait record the terminal archive lane uses.
        archiveWait(deps.store, task.id, candidate.agentId, `Retired agent could not be observed before its archive: ${String(error)}`);
        continue;
      }
      if (!state || state.workspaceId !== task.workspaceId) continue;
      if (state.active || state.activeTurnId || state.permissions) continue;
      if (!["idle", "closed", "error"].includes(state.status)) continue;
      if (state.status !== 'error' && !state.error) continue;
      try {
        await deps.host.archiveAgent(candidate.agentId);
      } catch (error) {
        // A refused archive leaves the workspace reported Failed: record the wait
        // rather than dropping the failure, and try again next sweep.
        archiveWait(deps.store, task.id, candidate.agentId, `Archiving the retired errored agent failed: ${String(error)}`);
        continue;
      }
      archived.add(candidate.agentId);
      sweep[task.id]!.archived = [...archived];
      sweepChanged = true;
      deps.store.setMeta('retiredArchiveSweep', sweep);
      sweepChanged = false;
      deps.store.event(task.id, 'retired_errored_agent_archived', `${candidate.why}: archived errored agent ${candidate.agentId} so the workspace no longer reports Failed`);
    }
  }
  if (sweepChanged) deps.store.setMeta('retiredArchiveSweep', sweep);
}