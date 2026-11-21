import type { Adapter } from "./adapter";
import type { HostCapabilities } from "../../shared/host";

/** Host-neutral refusal when a host-bound operation runs outside any bound host context. */
export const UNBOUND_HOST_REFUSAL = "No host is bound for this operation";

const UNBOUND_ADAPTER = Symbol("unbound-host-adapter");

/** True when `adapter` is the host-neutral sentinel used when no host is bound. */
export function isUnboundAdapter(
  adapter: Adapter | null | undefined,
): boolean {
  return Boolean(adapter && Reflect.get(adapter, UNBOUND_ADAPTER) === true);
}

function rejectUnbound(): Promise<never> {
  return Promise.reject(new Error(UNBOUND_HOST_REFUSAL));
}

/**
 * Host-neutral sentinel adapter used when no host context is bound.
 *
 * Every required operation refuses with `UNBOUND_HOST_REFUSAL` instead of
 * falling back to Paseo, and every optional capability is absent so
 * capability checks (`!adapter.X`) never observe another host's methods.
 */
export function createUnboundAdapter(): Adapter {
  const adapter: Adapter = {
    isConnected: () => false,
    capabilities: (): HostCapabilities => ({
      reportingViaMcp: false,
      supportsCoordinatorRecovery: false,
    }),
    profiles: () => rejectUnbound(),
    validate: () => rejectUnbound(),
    findWorkspaces: () => rejectUnbound(),
    findAgents: () => rejectUnbound(),
    createWorkspace: () => rejectUnbound(),
    verifyWorkspace: () => rejectUnbound(),
    createAgent: () => rejectUnbound(),
    observe: () => rejectUnbound(),
    archiveAgent: () => rejectUnbound(),
    verifyPr: () => rejectUnbound(),
  };
  Object.defineProperty(adapter, UNBOUND_ADAPTER, { value: true });
  return adapter;
}
