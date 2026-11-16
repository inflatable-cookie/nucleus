import { parseAgentId } from "../shared/agent-identity";
import {
  DEFAULT_HOST_KIND,
  HOST_PLUGIN_RELOAD_COMMANDS,
  hostKindOf,
  type IdentitySource,
} from "../shared/host-kind";
import { hostConnected } from "../core/host";
import type { Adapter } from "../core/host/adapter";
import { HostFacade } from "../core/host/host-facade";
import { resolveIngressHost } from "../core/host/ingress-host";
import {
  identitySourceHostEvidence,
  resolveOriginHost,
  type HostRegistry,
  type KnownHost,
} from "../core/host/host-registry";
import type { Admission } from "../core/host/admission";
import type { Engine } from "../core/engine";
import type { Store } from "../core/store/store";
import type { T3HostConnection } from "./t3code-host";
import type { BbHostConnection } from "./bb-host";

export type RegisteredHost = { adapter: Adapter; admission: Admission };
export type HostSession = { id: string; token: object };

/** The runtime ports host-connection ownership reads and writes. */
export interface HostConnectionOwner {
  adapter: Adapter;
  hostSession: HostSession | null;
  hostRegistry: HostRegistry<RegisteredHost>;
  t3Host: T3HostConnection | null;
  /** Spec 062: the BB host's claim, retired on the same passes as T3's. */
  bbHost: BbHostConnection;
  bootstrapped: boolean;
  closing: boolean;
  idleShutdownLatched: boolean;
  bootstrapRunning: Promise<void> | null;
  serveHostRunEndpoint: boolean;
  hostRunEndpoint: { serving(): boolean } | null;
  hostRuns: { liveRuns(): { length: number } };
  store: Store;
  engine: Engine;
  pluginLostGraceMs: number;
  paseoHostId: string;
}

/** Engine host-hook ports the runtime wires once at construction. */
export interface EngineHostWiring {
  adapter: Adapter;
  hostRegistry: HostRegistry<RegisteredHost>;
  hostSession: HostSession | null;
  connected(): boolean;
  store: Engine['store'];
}

/**
 * Wire the engine's host hooks to this runtime's registry, session and
 * availability. One owner of those assignments so QueueRuntime's constructor
 * does not also invent the routing policy.
 */
export function wireEngineHosts(engine: Engine, runtime: EngineHostWiring): void {
  engine.selectIngressHost = (explicit, repoPath, origin) => {
    const registered = runtime.hostRegistry.known().map(host => host.id);
    const online = runtime.hostRegistry.onlineIds();
    if (!repoPath && !origin) {
      if (explicit) {
        if (!registered.includes(explicit)) throw new Error('Selected host is not registered');
        return explicit;
      }
      return online.length === 1 ? online[0] : undefined;
    }
    const settings = runtime.store.canonicalRepository(repoPath ?? '', origin);
    const hostKind = settings?.hostKind ?? DEFAULT_HOST_KIND;
    try {
      return resolveIngressHost({ explicit, hostKind, registered, online }).hostId;
    } catch (error) {
      if (settings) throw new Error(`Cannot select host for repository ${settings.repository.origin ?? settings.repository.path}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };
  engine.resolveHostAdapter = (id) => runtime.hostRegistry.get(id)?.adapter;
  engine.hostIds = () => runtime.hostRegistry.known().map((host) => host.id);
  engine.inventoryHostMatches = (id) => runtime.hostSession?.id === id;
  engine.retiredObservationKey = (id) =>
    id === runtime.hostRegistry.primary()?.id
      ? "retiredObservations"
      : `retiredObservations:${JSON.stringify(id)}`;
  // A host that can host no task yet (a registered BB host, Spec 062 phase 1) cannot
  // make an unqualified origin workspace ambiguous, so it never changes Paseo's reuse.
  engine.canReuseUnqualifiedOriginWorkspace = () =>
    runtime.hostRegistry.known().filter((host) => hostKindOf(host.id) !== "bb")
      .length === 1;
  engine.identifyOriginHost = (agentId, identitySource?: IdentitySource) => {
    const qualified = parseAgentId(agentId);
    if (qualified) return Promise.resolve(runtime.hostRegistry.get(qualified.hostId) ? qualified.hostId : undefined);
    return resolveOriginHost(runtime.hostRegistry, agentId, async (host, id) => {
      if (!host.adapter.originAgent) return 'unknown';
      try { return await new HostFacade({ adapter: host.adapter }).originAgent(id) ? 'mine' : 'not-mine'; }
      catch { return 'unknown'; }
    }, identitySourceHostEvidence(agentId, identitySource, runtime.hostRegistry.known().map((entry: KnownHost) => entry.id)));
  };
  engine.hostAvailable = id => {
    const selected = runtime.hostRegistry.get(id);
    return Boolean(selected && (engine.activeHostId ? engine.activeHostId === id : selected.adapter === runtime.adapter && runtime.connected()));
  };
}

/**
 * Paseo session claim, plugin-presence watch and idle-shutdown decision. T3
 * keeps its own connection owner; this class is the primary-claim and
 * presence side of the same host-connection seam.
 */
export class HostConnections {
  private pluginPresenceTimer: NodeJS.Timeout | null = null;
  private pluginPresenceEpoch = 0;

  constructor(private readonly owner: HostConnectionOwner) {}

  /** The connection alone gates lifecycle work. */
  connected(): boolean {
    if (!hostConnected(this.owner.adapter) || (this.owner.hostSession !== null && this.owner.paseoHostId !== this.owner.hostSession.id)) {
      if (this.owner.hostSession) this.owner.hostRegistry.disconnect(this.owner.hostSession.id, this.owner.hostSession.token);
      this.owner.hostSession = null;
      this.owner.bootstrapped = false;
      return false;
    }
    return this.owner.hostSession !== null && this.owner.hostRegistry.get(this.owner.hostSession.id)?.adapter === this.owner.adapter;
  }

  anyHostConnected(): boolean {
    this.connected();
    this.owner.t3Host?.retireDisconnected();
    this.owner.bbHost.retireDisconnected();
    return this.owner.hostRegistry.onlineIds().length > 0;
  }

  hostShutdownDue(): boolean {
    this.owner.t3Host?.retireDisconnected();
    this.owner.bbHost.retireDisconnected();
    if (this.owner.closing || this.owner.idleShutdownLatched || this.connected() || hostConnected(this.owner.adapter) || this.owner.bootstrapRunning || (this.owner.serveHostRunEndpoint && !this.owner.hostRunEndpoint?.serving())) return false;
    if (!this.owner.hostRegistry.shouldShutdown(this.owner.hostRuns.liveRuns().length)) return false;
    this.owner.idleShutdownLatched = true;
    return true;
  }

  cancelHostShutdown(): void { this.owner.idleShutdownLatched = false; }

  hostPresenceClosed(): void {
    this.owner.idleShutdownLatched = false;
    this.owner.hostRegistry.restartGrace();
    if (this.anyHostConnected()) this.armPluginPresenceWatch();
    else this.clearPluginPresenceWatch();
  }

  hostPresenceOpened(): void {
    this.pluginPresenceEpoch++;
    this.clearPluginPresenceWatch();
    this.clearPluginPresenceFault();
  }

  armPluginPresenceWatch(): void {
    this.clearPluginPresenceWatch();
    const epoch = ++this.pluginPresenceEpoch;
    this.pluginPresenceTimer = setTimeout(() => {
      this.pluginPresenceTimer = null;
      void this.raisePluginPresenceFault(epoch).catch(() => { /* a throwing store write must not kill the executor */ });
    }, this.owner.pluginLostGraceMs);
    this.pluginPresenceTimer.unref?.();
  }

  clearPluginPresenceWatch(): void {
    if (!this.pluginPresenceTimer) return;
    clearTimeout(this.pluginPresenceTimer);
    this.pluginPresenceTimer = null;
  }

  pluginPresenceFaultMessage(): string {
    if (!this.anyHostConnected()) return '';
    return this.owner.store.getMeta<{ message?: string }>('pluginPresenceFault')?.message ?? '';
  }

  private clearPluginPresenceFault(): void {
    if (!this.owner.store.getMeta('pluginPresenceFault')) return;
    this.owner.store.deleteMeta('pluginPresenceFault');
    this.owner.store.advanceRevision();
  }

  private async raisePluginPresenceFault(epoch: number): Promise<void> {
    if (epoch !== this.pluginPresenceEpoch) return;
    if (this.owner.closing) return;
    if (!this.anyHostConnected()) return;
    if (this.owner.store.getMeta('pluginPresenceFault')) return;
    // The hint names the reload command of the plugin that is missing. With BB beside
    // Paseo either plugin can be the absent one, and Paseo's command cannot restore a
    // BB plugin (Spec 062, "Presence"). Paseo's own wording is kept when it is the
    // connected host, so nothing an operator reads today changes.
    const kinds = [
      ...new Set(
        this.owner.hostRegistry.onlineIds().map((id) => hostKindOf(id)),
      ),
    ];
    const bbOnly = kinds.length > 0 && kinds.every((kind) => kind === "bb");
    const commands = bbOnly
      ? [HOST_PLUGIN_RELOAD_COMMANDS.bb!]
      : kinds
          .map((kind) => HOST_PLUGIN_RELOAD_COMMANDS[kind])
          .filter((command): command is string => Boolean(command));
    const message = bbOnly
      ? "The Nucleus plugin is not present while BB is still connected. The recovery thread cannot act while the plugin is down."
      : "The Nucleus plugin is not present while Paseo is still connected. The recovery thread cannot act while the plugin is down.";
    const at = new Date().toISOString();
    this.owner.store.setMeta('pluginPresenceFault', { at, message });
    this.owner.store.advanceRevision();
    const planner = this.owner.store.projectPlannerRecipient(this.owner.store.queueProject());
    if (!planner || !this.owner.adapter.notify) return;
    try {
      const hostId = await this.owner.engine.identifyOriginHost(planner);
      if (!hostId) return;
      const reload = commands.length
        ? commands
            .map((command) => `Reload the plugin with: ${command}`)
            .join("\n")
        : `Reload the plugin with: ${HOST_PLUGIN_RELOAD_COMMANDS.paseo}`;
      await this.owner.engine.withHost(hostId, () =>
        this.owner.engine.host.sendMessage(planner, {
          messageId: `ns-plugin-presence-${at}`,
          text: `Nucleus: ${message}\n${reload}`,
        }),
      );
    } catch {
      /* the board error is the operator-visible surface */
    }
  }
}
