import type { Run, Task } from '../../shared/contracts';
import type { HostOutage } from '../../shared/host-outage';
import type { IdentitySource } from '../../shared/host-kind';

/**
 * Every host question a composition root answers (`nucleus#1232`). The runtime
 * that owns the host registry wires one set. A root that was not wired keeps
 * `ambientHostPorts`, the one host it knows.
 *
 * This is one contract on purpose: a caller cannot wire some of these questions
 * and leave the rest on a silent default, which is how a task's run reached the
 * ambient host instead of its own before #1154 and how the same five answers
 * came to be written out twice, once per root.
 */
export interface HostPorts {
  /** The task's own host, and the run's when given, are reachable now. */
  taskAvailable(task: Task, run?: Run): boolean;
  /** The open outage for a host, when one exists. */
  outage(hostId: string): HostOutage | null;
  workerProviderUnavailable(task: Task): boolean;
  /** Re-bind the transport context for the host calls `work` makes. */
  withHost<T>(hostId: string, fn: () => T): T;
  /** Registered and connected, read independent of the ambient host context. */
  online(hostId: string): boolean;
  inventoryMatches(hostId: string): boolean;
  originAvailable(hostId: string): boolean;
  /** Bounded wait for the plugin bridge after a roll; null refuses at once. */
  awaitBridge: ((waitMs: number) => Promise<boolean>) | null;
  bridgeWaitMs: number;
  canReuseUnqualifiedOriginWorkspace(): boolean;
  identifyOriginHost(agentId: string, identitySource?: IdentitySource): Promise<string | undefined>;
  catalogKnown(): boolean;
}

/**
 * The ambient host: one registered host, always reachable, and `origin` reads the
 * adapter's own identity. This is the whole of the unwired answer, in one place,
 * and it answers the way a single-host install behaves: nothing is refused and no
 * transport context is re-bound.
 */
export function ambientHostPorts(origin: () => string | undefined): HostPorts {
  return {
    taskAvailable: () => true,
    outage: () => null,
    workerProviderUnavailable: () => false,
    withHost: (_hostId, fn) => fn(),
    online: () => true,
    inventoryMatches: () => true,
    originAvailable: () => true,
    awaitBridge: null,
    bridgeWaitMs: 90_000,
    canReuseUnqualifiedOriginWorkspace: () => true,
    identifyOriginHost: async () => origin(),
    catalogKnown: () => true,
  };
}

/**
 * Every host call that names a task's or a run's own agent runs on that owner's
 * host (#1154). A stored agent id is native, so a call made in no host context
 * unwraps it against the default host; a missing recorded host keeps the ambient
 * context. The rule reads the owner's recorded `hostId`, never a caller's claim.
 */
export function onOwnerHost<T>(
  ports: Pick<HostPorts, 'withHost'>, owner: { hostId?: string | null } | null | undefined, work: () => T,
): T {
  const hostId = owner?.hostId;
  return hostId ? ports.withHost(hostId, work) : work();
}
