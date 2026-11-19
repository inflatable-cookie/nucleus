import { join } from "node:path";
import { ServiceClient } from "../shared/service/client";
import { readServiceInfo } from "../shared/service/discovery";
import type { AcpSessionSurface } from "../shared/acp/surface";
import {
  createHost,
  createAdapter,
  type T3DisconnectReason,
  type T3ProtocolError,
} from "../hosts/t3code";
import type { Adapter, HostPolicyConstructor } from "../core/host";
import { HostPolicies } from "../core/host/host-policies";
import { Admission, admitAdapter } from "../core/host/admission";
import type { HostRegistry } from "../core/host/host-registry";
import { hostKindOf } from "../shared/host-kind";

/** Owner-only settings; never part of the service's public settings projection. */
export interface T3ConnectionConfig {
  endpoint: string;
  bearer: string;
  probeThreadId?: string;
  sessionId?: string;
}

interface NativeConnection {
  readonly connected: boolean;
  /** Whether this host is parenting role threads natively, or why it is not (nucleus#1305). */
  readonly nativeParentingStatus?: string;
  readonly lastDisconnectReason?: T3DisconnectReason | null;
  readonly lastProtocolError?: T3ProtocolError | null;
  readonly hostId: string;
  readonly version: string;
  readonly threadShapePending?: boolean;
  readonly compatibilityFailure?: string;
  /** Provider model option descriptors from the last config read (nucleus#1375). */
  readonly modelShapes?: string;
  connect(probeThreadId?: string): Promise<void>;
  openInboxUi?(): Promise<{ status: "opened" | "reused" }>;
  close(): void;
}

type RegisteredHost = { adapter: Adapter; admission: Admission };
interface ConnectionDependencies {
  create(
    config: T3ConnectionConfig & {
      statePath: string;
      acp?: () => AcpSessionSurface | null;
    },
  ): NativeConnection;
  adapter(host: NativeConnection): Adapter;
}

/** The one validation both construction and a live reconfigure apply. */
function validateConfig(config: T3ConnectionConfig): T3ConnectionConfig {
  const endpoint = new URL(config.endpoint);
  if (
    !["http:", "https:", "ws:", "wss:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "T3Code endpoint must be an HTTP or WebSocket URL without credentials, query or fragment",
    );
  if (!config.bearer.trim())
    throw new Error("T3Code session bearer is required");
  return { ...config };
}

/** A secondary host has its own connection, registry claim and admission state. */
export class T3HostConnection {
  #config: T3ConnectionConfig;
  private host: NativeConnection | null = null;
  private session: { id: string; token: object } | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private errorValue = "";
  private lastIdentity: string | null = null;
  private versionValue = "";
  private lastDisconnectReason: T3DisconnectReason | null = null;
  private lastProtocolError: T3ProtocolError | null = null;

  private readonly dependencies: ConnectionDependencies;
  constructor(
    config: T3ConnectionConfig,
    private readonly dataDir: string,
    private readonly registry: HostRegistry<RegisteredHost>,
    private readonly makeAdmission: () => Admission,
    dependencies?: ConnectionDependencies,
    /**
     * The service's ACP session surface, read when a host is built: it owns the parent
     * thread's binding and the release of its held turn (nucleus#1305). Absent, the
     * host keeps top-level role threads.
     */
    private readonly acp: () => AcpSessionSurface | null = () => null,
  ) {
    this.dependencies = dependencies ?? {
      create: (config) =>
        createHost({
          ...config,
          acp: this.acp,
          boardLink: async () => {
            const info = readServiceInfo(this.dataDir);
            if (!info)
              throw new Error("The local board service is unavailable");
            const client = new ServiceClient({
              socketPath: info.socketPath,
              credential: info.credential,
            });
            try {
              const result = (await client.request("service.ui-link", {
                action: "issue",
              })) as { url?: unknown };
              if (typeof result.url !== "string")
                throw new Error("The local board did not issue a link");
              return result.url;
            } finally {
              client.close();
            }
          },
        }),
      adapter: (host) =>
        createAdapter(
          HostPolicies as unknown as HostPolicyConstructor,
          host as ReturnType<typeof createHost>,
          {
            socketPath: join(dataDir, "callback.sock"),
            helperPath: join(dataDir, "worker-report.mjs"),
          },
        ),
    };
    this.#config = validateConfig(config);
  }

  /** Drop this connection's claim and native host, leaving the object usable. */
  private detach(): void {
    if (this.session)
      this.registry.disconnect(this.session.id, this.session.token);
    this.session = null;
    this.host?.close();
    this.host = null;
    this.lastIdentity = null;
    this.errorValue = "";
    this.lastDisconnectReason = null;
    this.lastProtocolError = null;
    this.versionValue = "";
  }

  /** Only connection facts are returned; no endpoint, credential or native object. */
  status(): {
    id: string | null;
    connected: boolean;
    sessionId: string | null;
    error: string;
    version: string;
    threadShapePending: boolean;
    nativeParenting: string;
    modelShapes: string;
    lastDisconnectReason: T3DisconnectReason | null;
    lastProtocolError: T3ProtocolError | null;
  } {
    this.retireDisconnected();
    const connected = this.session !== null;
    return {
      lastDisconnectReason: this.lastDisconnectReason,
      lastProtocolError: this.lastProtocolError,
      id: this.lastIdentity,
      connected,
      sessionId: connected ? (this.#config.sessionId ?? null) : null,
      error: this.errorValue,
      version: this.versionValue,
      threadShapePending: connected && this.host?.threadShapePending === true,
      nativeParenting: connected
        ? (this.host?.nativeParentingStatus ?? "")
        : "",
      modelShapes: connected ? (this.host?.modelShapes ?? "") : "",
    };
  }

  /** A disconnected socket invalidates this claim, never another host's claim. */
  retireDisconnected(): void {
    this.lastDisconnectReason =
      this.host?.lastDisconnectReason ?? this.lastDisconnectReason;
    this.lastProtocolError =
      this.host?.lastProtocolError ?? this.lastProtocolError;
    if (
      this.session &&
      (!this.host?.connected || this.host.hostId !== this.session.id)
    ) {
      if (this.host?.compatibilityFailure)
        this.errorValue = `T3Code: ${this.host.compatibilityFailure}`;
      this.registry.disconnect(this.session.id, this.session.token);
      this.session = null;
    }
  }

  ensureConnected(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.retireDisconnected();
    if (this.session) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    this.host?.close();
    this.host = null;
    let candidate: NativeConnection | null = null;
    try {
      candidate = this.dependencies.create({
        ...this.#config,
        statePath: join(this.dataDir, "hosts", "t3code.json"),
      });
      this.host = candidate;
      await candidate.connect(this.#config.probeThreadId);
      if (this.closed) {
        candidate.close();
        return;
      }
      if (
        !candidate.connected ||
        hostKindOf(candidate.hostId) !== "t3code" ||
        candidate.hostId === "t3code:"
      )
        throw new Error("T3Code authenticated environment identity is missing");
      if (this.lastIdentity && candidate.hostId !== this.lastIdentity)
        throw new Error("T3Code endpoint returned a different identity");
      const admission = this.registry.resource(
        candidate.hostId,
        this.makeAdmission,
      );
      const adapter = admitAdapter(
        this.dependencies.adapter(candidate),
        admission,
      );
      const token = this.registry.connect(
        candidate.hostId,
        this.#config.endpoint,
        { adapter, admission },
      );
      this.session = { id: candidate.hostId, token };
      this.lastIdentity = candidate.hostId;
      this.versionValue = candidate.version;
      this.errorValue = "";
    } catch (error) {
      this.lastDisconnectReason =
        candidate?.lastDisconnectReason ?? this.lastDisconnectReason;
      this.lastProtocolError =
        candidate?.lastProtocolError ?? this.lastProtocolError;
      candidate?.close();
      this.host = null;
      // Connector diagnostics name missing methods/fields, but never trust a
      // transport to have omitted credential material from its error text.
      const detail =
        error instanceof Error ? error.message : "Connection failed";
      this.errorValue = `T3Code: ${detail
        .split(this.#config.bearer)
        .join("[redacted]")
        .replace(
          /(wsTicket|ticket|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi,
          "$1=[redacted]",
        )
        .slice(0, 500)}`;
    }
  }

  async openInboxUi(hostId: string): Promise<{ status: "opened" | "reused" }> {
    this.retireDisconnected();
    if (!this.session || this.session.id !== hostId || !this.host?.connected) {
      throw new Error(`T3Code host ${hostId} is not connected`);
    }
    if (!this.host.openInboxUi) {
      throw new Error(
        `T3Code host ${hostId} does not support opening the board`,
      );
    }
    return await this.host.openInboxUi();
  }

  close(): void {
    this.closed = true;
    this.detach();
  }
}
