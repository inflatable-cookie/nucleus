/**
 * Settings → Hosts (nucleus#1325): the durable host catalogue as the operator
 * reads it, and the operator verb that forgets one host.
 *
 * Status and its reason come from the health projection (`service.health`'s
 * `hosts`), BB's identity, versions and heartbeat from its `bb` block and T3's
 * version from its own status, so Settings and health never disagree. Only what a
 * host reported is shown.
 *
 * `host.remove` is Settings-only: the dispatch point refuses every surface but the
 * Settings transports before this runs (service-boundary contract, "Host identity
 * registry"), and this handler refuses a missing surface itself in case a future
 * seam forgets to pass one. A removal is recorded with its time, host and surface.
 */
import type { HostRegistry } from "../core/host/host-registry";
import { HostForgetRefusedError } from "../core/host/host-registry";
import { hostDependents, hostRemovalBlockers } from "../core/host/host-dependents";
import type { Store } from "../core/store/store";
import { capacityWriteSurface, hostRemoveRefusalMessage } from "../shared/capacity-authority";
import { HOST_KIND_LABELS, hostKindOf, type HostKind } from "../shared/host-kind";
import type { HostRemovalRecord, HostView } from "../shared/rpc/hosts";
import type { BbHostStatus } from "./bb-host";
import type { HostHealth } from "./runtime-health";

/** The durable record of applied removals; the newest are kept. */
export const HOST_REMOVALS_META = "hostRemovals";
const HOST_REMOVALS_KEPT = 50;

export interface HostCatalogueContext {
  readonly store: Store;
  readonly hostRegistry: Pick<HostRegistry<unknown>, "known" | "legacyPaseoPrimary" | "onlineIds" | "connectedAt" | "lastSeenAt" | "forget">;
  /** The same host projection `service.health` publishes. */
  hostStates(): HostHealth[];
  bb(): BbHostStatus;
  t3(): { id: string | null; version: string } | undefined;
  /** The operator default host kind in force, or null for the planner's host. */
  defaultHostKind(): HostKind | null;
  /** Drop a forgotten BB identity's recorded data directory; inside the removal's transaction. */
  forgetBb(hostId: string): void;
  now?: () => Date;
}

/** The host the operator default resolves to, as ingress picks it; none when ambiguous. */
function defaultHostId(kind: HostKind | null, known: readonly string[], online: readonly string[]): string | null {
  if (!kind) return null;
  const pick = (ids: readonly string[]) => { const matching = ids.filter(id => hostKindOf(id) === kind); return matching.length === 1 ? matching[0]! : null; };
  const onlineMatches = online.filter(id => hostKindOf(id) === kind);
  return onlineMatches.length ? pick(online) : pick(known);
}

export class HostCatalogueSettings {
  constructor(private readonly context: HostCatalogueContext) {}

  hostList(): { hosts: HostView[]; defaultHostKind: HostKind | null; removals: HostRemovalRecord[] } {
    const { store, hostRegistry } = this.context;
    const states = new Map(this.context.hostStates().map(state => [state.id, state]));
    const bb = this.context.bb();
    const t3 = this.context.t3();
    const known = hostRegistry.known();
    const online = hostRegistry.onlineIds();
    const primaryId = hostRegistry.legacyPaseoPrimary()?.id ?? null;
    const defaultHostKind = this.context.defaultHostKind();
    const defaultId = defaultHostId(defaultHostKind, known.map(entry => entry.id), online);
    const hosts = known.map((entry): HostView => {
      const kind = hostKindOf(entry.id);
      const state = states.get(entry.id) ?? { id: entry.id, state: online.includes(entry.id) ? "online" as const : "offline" as const, reason: "" };
      const connectedAt = hostRegistry.connectedAt(entry.id);
      const lastSeenAt = hostRegistry.lastSeenAt(entry.id);
      const versions: HostView["versions"] = [];
      let heartbeat: HostView["heartbeat"];
      if (kind === "bb") {
        const record = bb.hosts.find(candidate => candidate.hostId === entry.id);
        if (record?.bbVersion) versions.push({ label: "BB", value: record.bbVersion });
        if (record?.sdkVersion) versions.push({ label: "SDK", value: record.sdkVersion });
        if (record) heartbeat = { at: record.lastHeartbeatAt, stale: record.heartbeatStale };
      } else if (kind === "t3code" && t3?.id === entry.id && t3.version) versions.push({ label: "T3Code", value: t3.version });
      const dependents = hostDependents(store, { id: entry.id, kind, primary: entry.id === primaryId });
      return {
        id: entry.id, kind, label: HOST_KIND_LABELS[kind], endpoint: entry.endpoint,
        state: state.state, reason: state.reason, isDefault: entry.id === defaultId,
        ...(connectedAt !== null ? { connectedAt: new Date(connectedAt).toISOString() } : {}),
        ...(lastSeenAt ? { lastSeenAt } : {}),
        versions, ...(heartbeat ? { heartbeat } : {}),
        dependents, removalBlockers: hostRemovalBlockers(state.state === "online" || online.includes(entry.id), dependents),
      };
    });
    return { hosts, defaultHostKind, removals: this.removals() };
  }

  /**
   * Forget one offline host with nothing depending on it. Each refusal names every
   * reason; the dependency check runs again inside the write's transaction.
   */
  removeHost(input: { hostId: string }, _accepted?: unknown, context?: { via?: string | null }): { removed: HostRemovalRecord } {
    const surface = capacityWriteSurface(context?.via);
    if (!surface) throw new Error(hostRemoveRefusalMessage());
    const { store, hostRegistry } = this.context;
    const primaryId = hostRegistry.legacyPaseoPrimary()?.id ?? null;
    let removed: HostRemovalRecord | null = null;
    try {
      hostRegistry.forget(input.hostId, entry => {
        const kind = hostKindOf(entry.id);
        const blockers = hostRemovalBlockers(hostRegistry.onlineIds().includes(entry.id), hostDependents(store, { id: entry.id, kind, primary: entry.id === primaryId }));
        if (blockers.length) throw new HostForgetRefusedError(`Host ${entry.id} cannot be removed: ${blockers.join("; ")}`);
        if (kind === "bb") this.context.forgetBb(entry.id);
        removed = { at: (this.context.now?.() ?? new Date()).toISOString(), hostId: entry.id, endpoint: entry.endpoint, surface };
        store.setMeta(HOST_REMOVALS_META, [...this.removals(), removed].slice(-HOST_REMOVALS_KEPT));
        store.advanceRevision();
      });
    } catch (error) {
      if (error instanceof HostForgetRefusedError && /is online$/.test(error.message))
        throw new Error(`Host ${input.hostId} cannot be removed: Host is online`);
      throw error;
    }
    return { removed: removed! };
  }

  private removals(): HostRemovalRecord[] {
    const stored = this.context.store.getMeta<HostRemovalRecord[]>(HOST_REMOVALS_META);
    return Array.isArray(stored) ? stored : [];
  }
}
