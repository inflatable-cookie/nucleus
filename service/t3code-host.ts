import { join } from 'node:path';
import { createHost, createAdapter } from '../hosts/t3code';
import type { Adapter, HostPolicyConstructor } from '../core/host';
import { HostPolicies } from '../core/host/host-policies';
import { Admission, admitAdapter } from '../core/host/admission';
import type { HostRegistry } from '../core/host/host-registry';

/** Owner-only settings; never part of the service's public settings projection. */
export interface T3ConnectionConfig {
  endpoint: string;
  bearer: string;
  probeThreadId?: string;
}

interface NativeConnection {
  readonly connected: boolean;
  readonly hostId: string;
  readonly version: string;
  readonly threadShapePending?: boolean;
  readonly compatibilityFailure?: string;
  connect(probeThreadId?: string): Promise<void>;
  close(): void;
}

type RegisteredHost = { adapter: Adapter; admission: Admission };
interface ConnectionDependencies {
  create(config: T3ConnectionConfig & { statePath: string }): NativeConnection;
  adapter(host: NativeConnection): Adapter;
}

/** A secondary host has its own connection, registry claim and admission state. */
export class T3HostConnection {
  #config: T3ConnectionConfig;
  private host: NativeConnection | null = null;
  private session: { id: string; token: object } | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private errorValue = '';
  private lastIdentity: string | null = null;
  private versionValue = '';

  constructor(
    config: T3ConnectionConfig,
    private readonly dataDir: string,
    private readonly registry: HostRegistry<RegisteredHost>,
    private readonly makeAdmission: () => Admission,
    private readonly dependencies: ConnectionDependencies = {
      create: config => createHost(config),
      adapter: host => createAdapter(HostPolicies as unknown as HostPolicyConstructor, host as ReturnType<typeof createHost>, {
        socketPath: join(dataDir, 'callback.sock'),
        helperPath: join(dataDir, 'worker-report.mjs'),
      }),
    },
  ) {
    const endpoint = new URL(config.endpoint);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new Error('T3Code endpoint must be an HTTP or WebSocket URL without credentials, query or fragment');
    if (!config.bearer.trim()) throw new Error('T3Code session bearer is required');
    this.#config = { ...config };
  }

  /** Only connection facts are returned; no endpoint, credential or native object. */
  status(): { id: string | null; connected: boolean; error: string; version: string; threadShapePending: boolean } {
    this.retireDisconnected();
    return { id: this.lastIdentity, connected: this.session !== null, error: this.errorValue, version: this.versionValue,
      threadShapePending: this.session !== null && this.host?.threadShapePending === true };
  }

  /** A disconnected socket invalidates this claim, never another host's claim. */
  retireDisconnected(): void {
    if (this.session && (!this.host?.connected || this.host.hostId !== this.session.id)) {
      if (this.host?.compatibilityFailure) this.errorValue = `T3Code: ${this.host.compatibilityFailure}`;
      this.registry.disconnect(this.session.id, this.session.token);
      this.session = null;
    }
  }

  ensureConnected(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.retireDisconnected();
    if (this.session) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    this.host?.close();
    this.host = null;
    let candidate: NativeConnection | null = null;
    try {
      candidate = this.dependencies.create({ ...this.#config, statePath: join(this.dataDir, 'hosts', 't3code.json') });
      this.host = candidate;
      await candidate.connect(this.#config.probeThreadId);
      if (this.closed) { candidate.close(); return; }
      if (!candidate.connected || !candidate.hostId.startsWith('t3code:') || candidate.hostId === 't3code:')
        throw new Error('T3Code authenticated environment identity is missing');
      if (this.lastIdentity && candidate.hostId !== this.lastIdentity)
        throw new Error('T3Code endpoint returned a different identity');
      const admission = this.registry.resource(candidate.hostId, this.makeAdmission);
      const adapter = admitAdapter(this.dependencies.adapter(candidate), admission);
      const token = this.registry.connect(candidate.hostId, this.#config.endpoint, { adapter, admission });
      this.session = { id: candidate.hostId, token };
      this.lastIdentity = candidate.hostId;
      this.versionValue = candidate.version;
      this.errorValue = '';
    } catch (error) {
      candidate?.close();
      this.host = null;
      // Connector diagnostics name missing methods/fields, but never trust a
      // transport to have omitted credential material from its error text.
      const detail = error instanceof Error ? error.message : 'Connection failed';
      this.errorValue = `T3Code: ${detail.split(this.#config.bearer).join('[redacted]')
        .replace(/(wsTicket|ticket|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        .slice(0, 500)}`;
    }
  }

  close(): void {
    this.closed = true;
    if (this.session) this.registry.disconnect(this.session.id, this.session.token);
    this.session = null;
    this.host?.close();
    this.host = null;
  }
}
