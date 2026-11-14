import { formatAgentId } from '../../shared/agent-identity';
import { occupiesSlot } from '../dispatch/capacity';
import { now } from '../store/store';
import type { Task } from '../../shared/contracts';
import type { AgentObservation } from '../host/adapter';
import type { Engine } from '../engine';


/**
 * Audit A6: a retired worker is re-read on this bounded cadence instead of every
 * pass. Its record keeps the last observation in between, and a Paseo lifecycle
 * signal or an ordinary Queue invalidation for that identity or workspace makes
 * it due at once; missing evidence is still re-read rather than remembered.
 */
export const RETIRED_OBSERVATION_INTERVAL_MS = 120_000;
/** A retired worker's record is unsettled only past its own cadence plus the ordinary window. */
export const RETIRED_OBSERVATION_STALE_MS = RETIRED_OBSERVATION_INTERVAL_MS + 45_000;
/** Bound on the lifecycle identities remembered until the next pass; a burst cannot grow it without limit. */
const LIFECYCLE_INVALIDATION_LIMIT = 512;
/**
 * A key-order-independent digest of the persisted retired-worker observations,
 * so a pass that observed nothing new writes no record at all (audit A6).
 */
function observationMapDigest(records: Record<string,{active:boolean;at:string}>): string {
  return JSON.stringify(Object.keys(records).sort().map(key => [key, records[key]!.active, records[key]!.at]));
}

/**
 * The retired-worker observation a pass keeps, reads and hands to the board's
 * quiet detection. Same-name `Engine` methods delegate here; `store` and `host`
 * read the engine per call, so a replaced adapter still applies.
 */
export type RetiredObservationsContext = Pick<Engine, 'activeHostId' | 'host' | 'retiredObservationKey' | 'store' | 'taskHostAvailable'>;

export class RetiredObservations {
  /** Identities and workspaces a Paseo lifecycle signal invalidated since the last pass (audit A6). */
  private readonly invalidatedIdentities = new Set<string>();
  private readonly invalidatedWorkspaces = new Set<string>();
  private readonly scopedInvalidatedIdentities = new Set<string>();
  private readonly scopedInvalidatedWorkspaces = new Set<string>();
  constructor(readonly engine: RetiredObservationsContext) {}
  get store() { return this.engine.store; }
  /**
   * A Paseo lifecycle hint reaches Queue before the next pass (audit A6): the
   * named identity or workspace is re-read then, rather than waiting for the
   * retired-worker cadence. A hint is never authority; it only makes an
   * observation due, and a burst is bounded so it cannot grow this memory.
   */
  noteLifecycleSignal(input: { agentId?: string | null; workspaceId?: string | null; hostId?: string | null }): void {
    const add = (set: Set<string>, value: string | null | undefined) => {
      if (!value) return;
      set.delete(value);
      set.add(value);
      while (set.size > LIFECYCLE_INVALIDATION_LIMIT) set.delete(set.values().next().value!);
    };
    if (input.hostId) {
      add(this.scopedInvalidatedIdentities, input.agentId ? formatAgentId(input.hostId, input.agentId) : null);
      add(this.scopedInvalidatedWorkspaces, input.workspaceId ? JSON.stringify([input.hostId, input.workspaceId]) : null);
    } else {
      add(this.invalidatedIdentities, input.agentId);
      add(this.invalidatedWorkspaces, input.workspaceId);
    }
  }
  /**
   * The retired-worker records this pass keeps and the identities it must read.
   * A record survives its cadence only while it is still readable and no
   * lifecycle signal or Queue invalidation named it; everything else is due and
   * is re-read from live evidence rather than carried forward.
   */
  retiredObservationPlan(): { persisted: Record<string,{active:boolean;at:string}>; keep: Record<string,{active:boolean;at:string}>; due: string[] } {
    const scope = this.engine.activeHostId;
    const persisted = this.store.getMeta<Record<string,{active:boolean;at:string}>>(scope ? this.engine.retiredObservationKey(scope) : "retiredObservations") ?? {};
    const keep: Record<string,{active:boolean;at:string}> = {};
    const due: string[] = [];
    const nowMs = Date.now();
    // Task 629 moved slots to live agents, so a task between runs holds no slot —
    // its retired workers are exactly the ones quiet detection must keep reading.
    for (const task of this.store.activeCapacityTasks().filter(task => (!scope || task.hostId === scope) && this.engine.taskHostAvailable(task) && (occupiesSlot(task) || task.retiredWorkers.length > 0))) for (const worker of task.retiredWorkers) {
      const previous = persisted[worker.agentId];
      const at = previous ? Date.parse(previous.at) : Number.NaN;
      const invalidated = this.invalidatedIdentities.has(worker.agentId) || Boolean(scope && this.scopedInvalidatedIdentities.has(formatAgentId(scope, worker.agentId)))
        || Boolean(task.workspaceId && (this.invalidatedWorkspaces.has(task.workspaceId) || scope && this.scopedInvalidatedWorkspaces.has(JSON.stringify([scope, task.workspaceId]))));
      if (previous && Number.isFinite(at) && nowMs - at < RETIRED_OBSERVATION_INTERVAL_MS && !invalidated) keep[worker.agentId] = previous;
      else due.push(worker.agentId);
    }
    return { persisted, keep, due };
  }
  clearRetiredInvalidations(): void { this.invalidatedIdentities.clear(); this.invalidatedWorkspaces.clear(); this.scopedInvalidatedIdentities.clear(); this.scopedInvalidatedWorkspaces.clear(); }
  /**
   * Re-read the due retired workers and return the map the board counters read.
   * A failed read leaves its identity absent, exactly as before: missing evidence
   * keeps quiet detection unsettled instead of remembering an older answer. The
   * store write is skipped when nothing moved, so an unchanged pass persists no
   * observation at all.
   */
  async observeRetiredWorkers(plan: { persisted: Record<string,{active:boolean;at:string}>; keep: Record<string,{active:boolean;at:string}>; due: string[] },
    inventory: ReadonlyMap<string, AgentObservation> | null): Promise<{ observations: Record<string,{active:boolean;at:string}>; changed: boolean }> {
    const observations: Record<string,{active:boolean;at:string}> = { ...plan.keep };
    if (plan.due.length) {
      const workspaces = new Map<string,string|null>();
      for (const task of this.store.activeCapacityTasks().filter(task => (!this.engine.activeHostId || task.hostId === this.engine.activeHostId) && (occupiesSlot(task) || task.retiredWorkers.length > 0))) for (const worker of task.retiredWorkers) workspaces.set(worker.agentId, task.workspaceId);
      for (const agentId of plan.due) {
        try {
          const state = inventory?.get(agentId) ?? await this.engine.host.observe(agentId);
          observations[agentId] = { active: state.active || state.permissions || !["idle","error","closed"].includes(state.status) || state.workspaceId !== workspaces.get(agentId), at: now() };
        } catch { /* Missing evidence keeps quiet detection unsettled. */ }
      }
    }
    return { observations, changed: observationMapDigest(observations) !== observationMapDigest(plan.persisted) };
  }
}
