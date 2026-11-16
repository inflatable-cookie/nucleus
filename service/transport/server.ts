import { writeOwnedJson } from "../../core/machine/owned-file.mjs";
import { dataHome } from "../../shared/data-home.mjs";
/**
 * Standalone Queue service (Contract 007 / Spec 013).
 *
 * One persistent local process owns the SQLite store, engine, callbacks and
 * its Paseo SDK connection. It serves the shared RPC catalogue over an
 * owner-only Unix socket with credential authentication. Exactly one process
 * holds the process lease: construction proves the prior owner is gone, and
 * drain reaches a durable safe point and releases socket and lease before the
 * process ends. Unknown ownership or an ambiguous spawn fails closed.
 *
 * Since g01.027, SQLite access and full-history validation live behind one
 * service-local persistence executor (a single worker thread). The request
 * loop never runs SQLite work or full record validation: catalogue handlers
 * await the executor, health and the revisioned compact board projection are
 * answered from executor-pushed in-memory snapshots, and executor saturation
 * returns typed backpressure rather than a longer timeout.
 */
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import type { RuntimeHealth, RuntimeOwnerOptions } from "../runtime-owner";
import type { AdmissionOptions } from "../../core/host/admission";
import { ExecutorError, PersistenceExecutor, type ExecutorFault, type ExecutorOptions } from "../executor/executor";
import { callCatalogueMethod, CapacityWriteRefusalError, MethodNotServedError, parseCatalogueInput, parseCatalogueOutput } from "./dispatch";
import { RPC_CATALOGUE } from "../../shared/rpc-catalogue";
import { rpcContractDigests } from "../../shared/rpc-contracts";
import type { UiBoard } from "../../shared/contracts";
import { formatSchemaRefusal } from "../../shared/schema-refusal";
import { WEB_SURFACE } from "../../shared/web-surface";
import {
  PROTOCOL_VERSION, MAX_CONNECTIONS, MAX_IN_FLIGHT, MAX_FRAME_BYTES, DEFAULT_IDLE_TIMEOUT_MS,
  ProtocolError, createFrameReader, encodeFrame, parseRequest,
  type ServiceErrorCode, type ServiceRequest, type ServiceResponse,
} from "../../shared/service/protocol";
import {
  currentLoginSession,
  newCredential,
  onLoginSessionFault,
  pidAlive,
  readServiceInfo,
  removeServiceInfo,
  serviceSocketPath,
  writeServiceExecutorFault,
  writeServiceInfo,
} from "./identity";
import {
  HostExecutorLink,
  HostExecutorUnavailableError,
  HostOperationRefusedError,
  HostOperationUnknownDeliveryError,
} from "../host-executor";
import {
  HOST_EXECUTOR_METHOD,
  hostIdFromDataDir,
  type HostExecutorAcceptance,
  type HostOperationName,
  type HostOperationOutcome,
} from "../../shared/host-operation";
import { parseHostExecutorDeclaration } from "../../shared/service/host-channel";
import { probeDiagnostics } from "../bb-host";
import { WebBoard, defaultWebBundleDir, uiLinkInputSchema, type WebBoardHost, type WebBoardOptions } from "../web/web-board";

export { SERVICE_BUILD, currentServiceBuildId } from "../../shared/service/build";
import { currentServiceBuildId } from "../../shared/service/build";

const authInputSchema = z.object({ credential: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** A recovery ask names one request key; anything else fails closed. */
const requestOutcomeInputSchema = z.object({ key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/) }).strict();
const SERVICE_RPC_CONTRACTS = rpcContractDigests();
/** A bridge roll names the builds so the drain can record it on the tasks it may interrupt. */
const drainInputSchema = z.object({ roll: z.object({ fromBuild: z.string().max(64), toBuild: z.string().max(64) }).strict().optional() }).passthrough();

/**
 * The bound on a just-declared executor's identity probe. The plugin answers from
 * `bb.sdk` in milliseconds; a probe past this deadline leaves the identity
 * unproven, so the declaration refuses instead of registering a host that might
 * never answer.
 */
const BB_IDENTITY_PROBE_DEADLINE_MS = 15_000;

/**
 * The field a probe's own refusal text names, when it names one. A schema refusal
 * renders as `field: expected ...` and the schema issue is the last such clause, so
 * the last match is the field; an epoch or a sentence colon before it is not.
 */
function namedField(message: string, fallback: string): string {
  const matches = [...message.matchAll(/([A-Za-z][A-Za-z0-9_.]*):\s/g)];
  return matches.length ? matches[matches.length - 1]![1]! : fallback;
}

export interface ServiceOptions {
  owner?: RuntimeOwnerOptions;
  idleTimeoutMs?: number;
  /** Fixture override; production checks detached ownership every five seconds. */
  ownershipCheckMs?: number;
  /**
   * Host-connection lifecycle: drain once no host and no bridge presence has
   * been connected for the idle grace (Tom's ten-minute shutdown). The
   * standalone service enables it; fixtures opt in to prove it. A service
   * without it never closes on idleness.
   */
  hostLifecycle?: boolean;
  /** Fixture override for the lifecycle poll; production checks every five seconds. */
  hostLifecycleIntervalMs?: number;
  /** Named persistence fixture (adapter or store); fixtures only. */
  fixture?: string;
  /** Structured-cloneable fixture state handed to the persistence executor. */
  fixtureState?: Record<string, unknown>;
  /** Enables the bounded fixture debug channel for seeding and inspecting the executor store. */
  debug?: boolean;
  /** The persistence worker has died. Its state is lost, so the process should go and let the bridge replace it. */
  onExecutorDeath?: () => void;
  /** A service request outstanding longer than this is named in health and logged. Fixture override; production uses five seconds. */
  heldSlotWarnMs?: number;
  /** Warm standby: wait for this old service pid to exit before opening the store writable. */
  standbyFor?: number;
  /** Local web board overrides: a fixture clock for token expiry, or a bundle directory (null for none). */
  webBoard?: Pick<WebBoardOptions, "now" | "bundleDir">;
}

export interface ServiceHealthStatus extends RuntimeHealth {
  requestTimings: ReturnType<PersistenceExecutor["requestTimings"]>;
  service: "nucleus";
  protocolVersion: number;
  buildId: string;
  rpcContracts: Record<string, string>;
  pid: number;
  startedAt: string;
}

interface Connection {
  socket: Socket;
  authed: boolean;
  inFlight: number;
  closing: boolean;
  hostPresence: boolean;
  /**
   * The reverse host-operation role this connection declared, when it declared one
   * (Spec 062, phase 0). A connection without it is exactly the client it was
   * before: this field adds a role, never a shape.
   */
  hostExecutor: HostExecutorLink | null;
}

function serviceError(code: ServiceErrorCode, error: unknown): { code: ServiceErrorCode; message: string } {
  if (error instanceof ProtocolError) return { code: error.code, message: error.message };
  // A policy refusal is a definite, healthy answer, never an internal fault.
  if (error instanceof CapacityWriteRefusalError) return { code: "refused", message: error.message };
  if (error instanceof ExecutorError && error.code === "refused") return { code: "refused", message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof z.ZodError) return { code: "invalid_input", message: formatSchemaRefusal(error) };
  return { code: "internal", message };
}

export class QueueService {
  readonly dataDir: string;
  readonly executor: PersistenceExecutor;
  readonly startedAt = new Date().toISOString();
  private readonly credential = newCredential();
  readonly socketPath: string;
  private server: Server | null = null;
  /** The local web board's HTTP server; null when it did not start, and the socket still serves. */
  private web: WebBoard | null = null;
  private connections = new Set<Connection>();
  /** One declared executor connection per host identity; the newest wins a reload. */
  private readonly hostExecutors = new Map<string, HostExecutorLink>();
  private draining = false;
  private drained: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private ownershipTimer: NodeJS.Timeout | null = null;
  private hostLifecycleTimer: NodeJS.Timeout | null = null;
  private hostLifecyclePending = false;
  private hostPresenceRevision = 0;
  private readonly idleTimeoutMs: number;
  /** Whether this service watches host presence and closes after the idle grace. */
  private readonly hostLifecycle: boolean;
  private readonly hostLifecycleIntervalMs: number;
  private readonly catalogue = new Map(RPC_CATALOGUE.map(entry => [entry.name, entry]));

  constructor(readonly options: ServiceOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    // Serving the host-run endpoint is what makes this process the daemon: it
    // is the long-lived owner a host attaches to, so it is the one that closes
    // after the last host leaves.
    this.hostLifecycle = options.hostLifecycle ?? options.owner?.hostRunEndpoint === true;
    this.hostLifecycleIntervalMs = options.hostLifecycleIntervalMs ?? 5_000;
    this.dataDir = options.owner?.dataDir ?? dataHome();
    this.socketPath = serviceSocketPath(this.dataDir);
    // The executor proves the prior owner is gone and takes the lease inside
    // start(); an ambiguous live owner fails closed before any socket exists.
    this.executor = new PersistenceExecutor(this.executorOptions());
    this.executor.onFailure = fault => this.recordExecutorFault(fault);
  }

  /**
   * Keep the executor's death where a replacement bridge can read it. The write is
   * best effort: the service already fails closed, and a missing record only loses
   * the post-mortem detail, never the refusal.
   */
  private recordExecutorFault(fault: ExecutorFault) {
    if (fault.kind === "projection") return;
    try {
      writeServiceExecutorFault(this.dataDir, {
        at: fault.at, kind: fault.kind, exitCode: fault.exitCode, pid: process.pid,
        buildId: currentServiceBuildId(), message: fault.message, stack: fault.stack,
      });
    } catch { /* the in-memory fault still refuses health and requests */ }
    try { this.options.onExecutorDeath?.(); }
    catch { /* the service still fails closed */ }
  }

  /** Cloneable executor options; handler functions stay on the worker side (fixtures). */
  private executorOptions(): ExecutorOptions {
    const owner: RuntimeOwnerOptions = this.options.owner ?? {};
    const { adapterFactory: _adapterFactory, instrumentStore: _instrumentStore, ...cloneable } = owner;
    void _adapterFactory; void _instrumentStore;
    const admission = cloneable.admission
      ? (Object.fromEntries(Object.entries(cloneable.admission).filter(([, value]) => typeof value !== "function")) as AdmissionOptions)
      : undefined;
    return {
      owner: { ...cloneable, ...(admission ? { admission } : {}) },
      fixture: this.options.fixture,
      fixtureState: this.options.fixtureState ?? {},
      debug: this.options.debug === true,
      ...(this.options.standbyFor ? { standbyFor: this.options.standbyFor } : {}),
      ...(this.options.heldSlotWarnMs !== undefined ? { heldSlotWarnMs: this.options.heldSlotWarnMs } : {}),
    };
  }

  /** True once this process has bound the service socket; only then may it remove the socket file. */
  private boundSocket = false;
  get buildId() { return currentServiceBuildId(); }
  get drainingNow() { return this.draining; }

  /** Fixture-only debug channel: seed and inspect the executor store. */
  debug(op: unknown): Promise<unknown> {
    return this.executor.debug(op);
  }

  /** Bind the owner-only socket and publish the credential identity file. */
  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    return (async () => {
      const socketFile = this.socketPath;
      // The persistence executor proves the prior owner is gone and owns the
      // writable store before any socket exists; a live owner fails closed.
      await this.executor.boot();
      if (this.draining) return;
      if (existsSync(socketFile)) {
        // We hold the live process lease, so any socket file left behind
        // belongs to a dead previous owner and may be reclaimed.
        unlinkSync(socketFile);
      }
      // The board server starts first so its port is in the identity file the socket
      // publishes. A board that cannot bind leaves the socket serving without it.
      this.web = await this.openWebBoard();
      try {
        await new Promise<void>((resolve, reject) => {
          const server = createServer();
          server.on("error", error => { reject(error instanceof Error ? error : new Error(String(error))); });
          server.on("connection", socket => this.acceptConnection(socket));
          server.listen(socketFile, () => {
            // Long socket paths bind without error on macOS but create no file; the
            // service must fail closed instead of running with an unreachable socket.
            if (!existsSync(socketFile)) { reject(new Error(`Service socket path exceeds the local transport length bound: ${socketFile}`)); return; }
            chmodSync(socketFile, 0o600);
            this.boundSocket = true;
            this.server = server;
            writeServiceInfo(this.dataDir, {
              protocolVersion: PROTOCOL_VERSION, buildId: currentServiceBuildId(), socketPath: socketFile,
              credential: this.credential, pid: process.pid, startedAt: this.startedAt,
              sessionId: currentLoginSession(),
              ...(this.web?.address ? { httpPort: this.web.address.port } : {}),
            });
            onLoginSessionFault(() => { void this.stop(); });
            this.idleTimer = setInterval(() => this.closeIdleConnections(), Math.min(this.idleTimeoutMs, 30_000));
            this.idleTimer.unref?.();
            if (this.hostLifecycle) {
              this.hostLifecycleTimer = setInterval(() => { void this.checkHostLifecycle(); }, this.hostLifecycleIntervalMs);
              this.hostLifecycleTimer.unref?.();
            }
            // A detached service must remain discoverable through the identity it
            // published. If a test, failed reload, or external cleanup removes or
            // replaces that identity, this process can no longer be reached safely
            // and must release its private store instead of becoming an orphan.
            this.ownershipTimer = setInterval(() => {
              const current = readServiceInfo(this.dataDir);
              if (!current || current.pid !== process.pid || current.buildId !== currentServiceBuildId() || current.socketPath !== this.socketPath) {
                void this.stop();
              }
            }, this.options.ownershipCheckMs ?? 5_000);
            this.ownershipTimer.unref?.();
            resolve();
          });
        });
      } catch (error) {
        await this.closeWebBoard();
        throw error;
      }
    })();
  }

  /** Start the local web board; a bind failure is logged and leaves the socket serving without it. */
  private async openWebBoard(): Promise<WebBoard | null> {
    const web = new WebBoard({ host: this.webHost(), bundleDir: defaultWebBundleDir(), ...this.options.webBoard });
    try {
      await web.listen();
      return web;
    } catch (error) {
      console.error(`Nucleus board HTTP server did not start; the socket still serves: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async closeWebBoard() {
    const web = this.web;
    this.web = null;
    await web?.close();
  }

  /** What the board server reads from the executor: dispatch with `via: "web"`, the published board and its publication stream. */
  private webHost(): WebBoardHost {
    return {
      call: (method, input) => this.webCall(method, input),
      board: () => this.executor.current().board,
      unavailable: () => this.executor.unavailableReason(),
      subscribe: listener => this.executor.onSnapshot(listener),
    };
  }

  /**
   * One catalogue call from the local web board. It runs the socket's sequence:
   * shared input validation, the cached board for `queue.ui-snapshot`, the executor
   * with the transport surface, and output validation. Only the surface differs.
   */
  private async webCall(method: string, input: unknown): Promise<unknown> {
    const entry = this.catalogue.get(method);
    if (!entry) throw new MethodNotServedError(method);
    const parsed = await (entry.contract.input as { parseAsync?: (value: unknown) => Promise<unknown> }).parseAsync?.(input) ?? input;
    if (method === "queue.ui-snapshot") return this.serveBoard(parsed);
    const raw = await this.executor.rpc(method, parsed, WEB_SURFACE);
    return await (entry.contract.output as { parseAsync?: (value: unknown) => Promise<unknown> })?.parseAsync?.(raw) ?? raw;
  }

  /** The loopback address of the local web board, or null when it is not listening. Tests and diagnostics read it. */
  webBoardAddress(): { host: string; port: number } | null {
    return this.web?.address ?? null;
  }

  /**
   * Close the daemon once no host and no bridge presence has been connected for
   * the idle grace, with no active host run (Tom, 2026-11-08). The runtime owns
   * the grace clock and its durable record; this loop only asks, and a presence
   * that appeared during the decision cancels it before anything drains.
   */
  private async checkHostLifecycle() {
    if (this.draining || this.hostLifecyclePending) return;
    if ([...this.connections].some(connection => connection.hostPresence && !connection.closing)) {
      return;
    }
    this.hostLifecyclePending = true;
    const presenceRevision = this.hostPresenceRevision;
    try {
      const due = await this.executor.callHandler("hostShutdownDue", {});
      if (due === true) {
        if (presenceRevision !== this.hostPresenceRevision || [...this.connections].some(connection => connection.hostPresence && !connection.closing)) await this.executor.callHandler("cancelHostShutdown", {});
        else {
          console.log("Nucleus service stopping: the last host closed more than the idle grace ago and no host run is live");
          await this.stop();
        }
      }
    } catch { /* An unavailable executor is unknown, never permission to stop. */ }
    finally { this.hostLifecyclePending = false; }
  }

  private closeIdleConnections() {
    const now = Date.now();
    for (const connection of this.connections) {
      const idleFor = now - Math.max((connection.socket as Socket & { _nsLastSeen?: number })._nsLastSeen ?? now, 0);
      // A host executor is a long-lived role like the presence claim: idleness is
      // its normal state, so the idle sweep never closes it.
      if (!connection.hostPresence && !connection.hostExecutor && idleFor >= this.idleTimeoutMs && connection.inFlight === 0) {
        connection.socket.end();
        connection.closing = true;
      }
    }
  }

  private acceptConnection(socket: Socket) {
    if (this.draining || this.connections.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    const connection: Connection = { socket, authed: false, inFlight: 0, closing: false, hostPresence: false, hostExecutor: null };
    this.connections.add(connection);
    (socket as Socket & { _nsLastSeen?: number })._nsLastSeen = Date.now();
    const reader = createFrameReader(
      frame => { void this.handleFrame(connection, frame); },
      error => { this.respond(connection, { v: PROTOCOL_VERSION, id: "protocol", error: serviceError(error.code, error) }, true); socket.destroy(); },
    );
    socket.on("data", chunk => { (socket as Socket & { _nsLastSeen?: number })._nsLastSeen = Date.now(); reader.feed(chunk); });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.connections.delete(connection);
      this.releaseHostExecutor(connection, "the host executor connection closed");
      if (connection.hostPresence) this.hostPresenceRevision++;
      if (connection.hostPresence && !this.draining && ![...this.connections].some(other => other.hostPresence && !other.closing))
        void this.executor.callHandler("hostPresenceClosed", {}).catch(() => {});
    });
  }

  private async handleFrame(connection: Connection, frame: unknown) {
    if (connection.closing) return;
    // A frame without a method on a declared executor connection is that
    // connection's answer to one reverse request. It settles exactly that
    // operation; anything else falls through to the ordinary request path.
    if (connection.hostExecutor && typeof (frame as { method?: unknown } | null)?.method !== "string" && connection.hostExecutor.settle(frame)) return;
    const parsed = parseRequest(frame);
    if (!parsed.ok) {
      const id = typeof (frame as { id?: unknown })?.id === "string" ? (frame as { id: string }).id : "protocol";
      this.respond(connection, { v: PROTOCOL_VERSION, id, error: serviceError(parsed.error.code, parsed.error) }, true);
      return;
    }
    const request = parsed.request;
    if (!connection.authed && request.method !== "service.auth") {
      // Fail closed: an unauthenticated connection gets one typed rejection and is closed.
      this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, error: { code: "unauthenticated", message: "Authenticate before any other method" } }, true, request.method);
      return;
    }
    if (this.draining) {
      this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, error: { code: "draining", message: "Service is draining; a replacement build will follow" } }, false, request.method);
      return;
    }
    try {
      switch (request.method) {
        case "service.auth": return await this.handleAuth(connection, request);
        case "service.nucleus-bridge-presence": {
          // The one bridge presence claim: a second bridge waits on standby
          // until this connection closes, and a stale claim cannot be stolen.
          const occupied = [...this.connections].some(other => other !== connection && other.hostPresence && !other.closing);
          if (occupied) return this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, result: { active: false } }, false, request.method);
          if (!connection.hostPresence) {
            this.hostPresenceRevision++;
            connection.hostPresence = true;
            // A newly granted single claim is presence returning: clear the plugin-lost fault.
            void this.executor.callHandler("hostPresenceOpened", {}).catch(() => {});
          } else connection.hostPresence = true;
          return this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, result: { active: true } }, false, request.method);
        }
        case "service.health": {
          // The registered executor's own health read is its liveness heartbeat (Spec
          // 062: liveness comes from a heartbeat, never from whether a request
          // answered). It changes no answer and no connection: a heartbeat that never
          // arrives, or arrives late, is reported in health and never closes the link.
          const executor = connection.hostExecutor;
          if (executor && this.hostExecutors.get(executor.hostId) === executor) {
            void this.executor.callHandler("bbHostHeartbeat", { hostId: executor.hostId, at: new Date().toISOString() }).catch(() => {});
          }
          return this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, result: this.health() }, false, request.method);
        }
        // The reverse host-operation role (Spec 062, decision 1). Additive: a client
        // that never declares it sees the service exactly as before, and the one
        // presence claim, roll recovery and the catalogue path never read it.
        case HOST_EXECUTOR_METHOD: return this.handleHostExecutor(connection, request);
        case "service.request-outcome": {
          // Roll recovery: the replacement answers what happened to one keyed
          // request the old service received before it drained. A store read,
          // like every other catalogue call; unknown keys answer `not_received`.
          const parsed = requestOutcomeInputSchema.safeParse(request.input);
          if (!parsed.success) return this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, error: serviceError("invalid_input", parsed.error) }, false, request.method);
          const outcome = await this.executor.callHandler("requestOutcome", parsed.data) as { status?: unknown } | null;
          return this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, result: outcome ?? { status: "not_received" } }, false, request.method);
        }
        case "service.drain": return this.handleDrainRequest(connection, request);
        case "service.profile": return this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, result: await this.executor.callHandler("cpuProfile", request.input) }, false, request.method);
        // Bridge lifecycle hints are validated and acknowledged here, not on the
        // public plugin RPC surface: they are scheduling signals only. The exact
        // identity mapping runs inside the persistence executor.
        case "service.lifecycle-signal": return this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, result: await this.executor.callHandler("lifecycleSignal", request.input) }, false, request.method);
        // The board link is minted here, in the process that serves the board: a
        // token exists only in this process's memory. Owner-socket callers only.
        case "service.ui-link": return this.handleUiLink(connection, request);
        default: return await this.handleCatalogueMethod(connection, request);
      }
    } catch (error) {
      const mapped = serviceError("internal", error);
      this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, error: mapped }, false, request.method);
    }
  }

  /**
   * A connection becomes this server's host executor for one BB host identity.
   *
   * The identity is derived here, never taken from the plugin: the same real data
   * directory always answers the same `bb:` id. It is *registered* only after a
   * read-only probe through this channel succeeds (`identity.probe`: `status.get`,
   * `system.version` and one `threads.list`, Spec 062 phase 1), and the runtime is
   * the authority on whether that identity is the one it already recorded — a
   * changed data directory refuses by its field and leaves the host offline.
   * A second declaration for the same identity replaces the older connection, which
   * is what a plugin reload looks like, and the older connection's in-flight
   * operations settle as unknown delivery rather than being replayed on the new one.
   */
  private async handleHostExecutor(
    connection: Connection,
    request: ServiceRequest,
  ) {
    if (!connection.authed)
      return this.respond(
        connection,
        {
          v: PROTOCOL_VERSION,
          id: request.id,
          error: {
            code: "unauthenticated",
            message: "Authenticate before declaring a host executor",
          },
        },
        true,
        request.method,
      );
    const parsed = parseHostExecutorDeclaration(request.input);
    if (!parsed.ok) return this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, error: { code: "invalid_input", message: parsed.failure.message } }, false, request.method);
    if (connection.hostExecutor) {
      return this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, error: { code: "refused", message: `This connection already executes host operations for ${connection.hostExecutor.hostId}` } }, false, request.method);
    }
    const hostId = hostIdFromDataDir(parsed.value.host.dataDir);
    const link = new HostExecutorLink({
      hostId,
      declaration: parsed.value,
      write: frame => { connection.socket.write(encodeFrame(frame)); },
      deadlineMs: BB_IDENTITY_PROBE_DEADLINE_MS,
    });
    // The probe's answer comes back on this same connection, so the link holds the
    // role while it proves itself. It is registered (below) only if the identity
    // proves; a refusal drops the role and closes the socket.
    connection.hostExecutor = link;
    const probe = await this.probeHostIdentity(link);
    if (!probe.ok) {
      // The identity is unproven: nothing registers, nothing is kept, and the
      // refusal names the field. The plugin's own loop reconnects and re-proves.
      // Recorded and then answered: the refusal is bounded by the probe's own deadline,
      // never by how long the runtime takes to write it down.
      void this.recordHostRefusal({
        hostId,
        dataDir: parsed.value.host.dataDir,
        field: probe.field,
        reason: probe.reason,
      });
      connection.hostExecutor = null;
      link.close(probe.reason);
      this.releaseBbHostExecutors(probe.reason);
      return this.respond(
        connection,
        {
          v: PROTOCOL_VERSION,
          id: request.id,
          error: { code: "refused", message: probe.reason },
        },
        true,
        request.method,
      );
    }
    const verified = (await this.executor
      .callHandler("bbHostVerified", {
        hostId,
        dataDir: probe.dataDir,
        bbVersion: probe.bbVersion,
        sdkVersion: probe.sdkVersion,
        hostIds: probe.hostIds,
        connectedAt: link.connectedAt,
      })
      .catch((error: unknown) => ({
        ok: false,
        field: "identity.probe",
        reason: error instanceof Error ? error.message : String(error),
      }))) as { ok?: boolean; field?: string; reason?: string };
    if (verified?.ok === false) {
      connection.hostExecutor = null;
      link.close(verified.reason ?? "the host identity was refused");
      this.releaseBbHostExecutors(
        verified.reason ?? "the host identity was refused",
      );
      return this.respond(
        connection,
        {
          v: PROTOCOL_VERSION,
          id: request.id,
          error: {
            code: "refused",
            message: `${verified.field ?? "identity"}: ${verified.reason ?? "the host identity was refused"}`,
          },
        },
        true,
        request.method,
      );
    }
    const previous = this.hostExecutors.get(hostId);
    this.hostExecutors.set(hostId, link);
    if (previous && previous !== link)
      this.releaseHostExecutor(
        previous,
        "a newer connection declared this host's executor role",
      );
    const result: HostExecutorAcceptance = {
      ok: true,
      hostId,
      dataDir: probe.dataDir,
      acceptedAt: new Date().toISOString(),
    };
    this.respond(
      connection,
      { v: PROTOCOL_VERSION, id: request.id, result },
      false,
      request.method,
    );
  }

  /**
   * Ask a just-declared executor to prove its identity through the channel. The
   * probe is read-only and bounded; a refusal, a malformed answer, a missing field
   * and a passed deadline all leave the identity unproven, and the reason names the
   * field the schema refused so health can say which one.
   */
  private async probeHostIdentity(
    link: HostExecutorLink,
  ): Promise<
    | {
        ok: true;
        dataDir: string;
        bbVersion: string;
        sdkVersion: string;
        hostIds: string[];
      }
    | { ok: false; field: string; reason: string }
  > {
    try {
      const outcome = await link.request("identity.probe", {});
      const diagnostics = probeDiagnostics(outcome);
      if (typeof diagnostics.dataDir !== "string" || !diagnostics.dataDir)
        return {
          ok: false,
          field: "dataDir",
          reason: "identity.probe answered no data directory",
        };
      return { ok: true, ...diagnostics };
    } catch (error) {
      if (error instanceof HostOperationRefusedError)
        return {
          ok: false,
          field: namedField(error.failure.message, "identity.probe"),
          reason: `identity.probe was refused (${error.failure.code}): ${error.failure.message}`,
        };
      if (error instanceof HostOperationUnknownDeliveryError)
        return {
          ok: false,
          field: namedField(error.message, "identity.probe"),
          reason: error.message,
        };
      return {
        ok: false,
        field: "identity.probe",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * A refused BB identity takes the BB host offline: the live executor connection for
   * the recorded identity (if any) is released and its in-flight work settles unknown.
   * This service serves one BB host identity, so a declaration that proved a different
   * data directory is a change to the host it serves, not a second host.
   */
  private releaseBbHostExecutors(reason: string) {
    for (const link of [...this.hostExecutors.values()]) {
      if (link.hostId.startsWith("bb:")) this.releaseHostExecutor(link, reason);
    }
  }

  /** Record one unproven identity with the runtime, so health names why the host is offline. */
  private async recordHostRefusal(input: {
    hostId: string;
    dataDir: string;
    field: string;
    reason: string;
  }): Promise<void> {
    await this.executor
      .callHandler("bbHostRejected", { ...input, at: new Date().toISOString() })
      .catch(() => {
        /* health then reports the recorded identity, never a guess */
      });
  }

  /** Detach one executor link from the registry and settle its work as unknown delivery. */
  private releaseHostExecutor(connectionOrLink: Connection | HostExecutorLink, reason: string) {
    const link = connectionOrLink instanceof HostExecutorLink ? connectionOrLink : connectionOrLink.hostExecutor;
    if (!link) return;
    const registered = this.hostExecutors.get(link.hostId) === link;
    link.close(reason);
    if (registered) this.hostExecutors.delete(link.hostId);
    if (registered) {
      // A registered identity goes offline with the connection that proved it. The
      // runtime keeps the durable record and the reason, so health still names the
      // host and why it left (Spec 062, phase 1).
      void this.executor
        .callHandler("bbHostReleased", {
          hostId: link.hostId,
          connectedAt: link.connectedAt,
          reason,
        })
        .catch(() => {});
    }
    for (const connection of this.connections) {
      if (connection.hostExecutor !== link) continue;
      connection.hostExecutor = null;
      // A replaced executor connection is finished: the plugin that held it is
      // reloading, so its socket goes and its replacement declares afresh.
      if (!connection.socket.destroyed) { connection.closing = true; connection.socket.destroy(); }
    }
  }

  /** The host identities currently holding an executor connection, for adapters and tests. */
  hostExecutorIds(): string[] { return [...this.hostExecutors.keys()].sort(); }

  /**
   * What one declared executor connection announces, or null when none holds it.
   * `connectedAt` is the evidence a reload produced a new connection rather than a
   * resumed one, and the declared data directory is what identity is re-proved from.
   */
  hostExecutorStatus(hostId: string): { hostId: string; dataDir: string; bbVersion: string; sdkVersion: string; connectedAt: string } | null {
    const link = this.hostExecutors.get(hostId);
    if (!link) return null;
    return { hostId, ...link.declaration.host, connectedAt: link.connectedAt };
  }

  /**
   * Run one bounded host operation on a declared executor connection. Phase 0 wires
   * nothing to this: no catalogue method, no dispatch path and no host registration
   * calls it, so the only callers are the proof and its tests.
   */
  sendHostOperation(hostId: string, op: HostOperationName, input: unknown): Promise<HostOperationOutcome> {
    const link = this.hostExecutors.get(hostId);
    if (!link) return Promise.reject(new HostExecutorUnavailableError(hostId));
    return link.request(op, input);
  }

  private async handleAuth(connection: Connection, request: ServiceRequest) {
    const input = authInputSchema.safeParse(request.input);
    const expected = createHash("sha256").update(this.credential).digest();
    const provided = input.success ? createHash("sha256").update(input.data.credential).digest() : Buffer.alloc(32);
    const match = timingSafeEqual(expected, provided);
    if (!input.success || !match) {
      this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, error: { code: "unauthenticated", message: "Service credential rejected" } }, true, request.method);
      return;
    }
    connection.authed = true;
    this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, result: { ok: true, buildId: currentServiceBuildId(), protocolVersion: PROTOCOL_VERSION, pid: process.pid } }, false, request.method);
  }

  /** `nucleus ui`: mint one board link, or revoke every outstanding token. */
  private handleUiLink(connection: Connection, request: ServiceRequest) {
    const parsed = uiLinkInputSchema.safeParse(request.input ?? {});
    if (!parsed.success) {
      this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, error: { code: "invalid_input", message: formatSchemaRefusal(parsed.error) } }, false, request.method);
      return;
    }
    const web = this.web;
    if (!web) {
      this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, error: { code: "unavailable", message: "The local board server is not listening; the service log says why it did not start. The queue still serves over the socket." } }, false, request.method);
      return;
    }
    const result = parsed.data.action === "revoke" ? { revoked: web.revokeAll() } : web.issueLink(parsed.data.ttlMinutes);
    this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, result }, false, request.method);
  }

  private async handleCatalogueMethod(connection: Connection, request: ServiceRequest) {
    const entry = this.catalogue.get(request.method);
    if (!entry) {
      this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, error: { code: "method_unknown", message: `Unknown method ${request.method}` } }, false, request.method);
      return;
    }
    let input: unknown;
    try {
      input = await (entry.contract.input as { parseAsync?: (value: unknown) => Promise<unknown> }).parseAsync?.(request.input) ?? request.input;
    } catch (error) {
      this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, error: serviceError("invalid_input", error) }, false, request.method);
      return;
    }
    // The compact board projection is a revisioned cached read: it is answered
    // from the executor-pushed in-memory snapshot and never awaits or re-runs
    // SQLite work, so a delayed database operation cannot delay it (Spec 013).
    if (request.method === "queue.ui-snapshot") {
      try {
        this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, result: this.serveBoard(input) }, false, request.method);
      } catch (error) {
        this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, error: serviceError("internal", error) }, false, request.method);
      }
      return;
    }
    if (connection.inFlight >= MAX_IN_FLIGHT) {
      this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, error: { code: "busy", message: "Too many in-flight requests on this connection" } }, false, request.method);
      return;
    }
    connection.inFlight++;
    try {
      // The request's transport surface rides to the dispatch point, which owns the
      // Settings-only capacity rule. Nothing else reads it. A client-minted request
      // key rides only for a mutating call, where the executor journals it so a
      // replacement can answer a lost response's real outcome.
      const raw = await this.executor.rpc(request.method, input, request.via, entry.mutating ? request.key : undefined);
      const result = await (entry.contract.output as { parseAsync?: (value: unknown) => Promise<unknown> })?.parseAsync?.(raw) ?? raw;
      this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, result }, false, request.method);
    } catch (error) {
      this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, error: serviceError("internal", error) }, false, request.method);
    } finally {
      connection.inFlight--;
    }
  }

  /** Serve the cached board projection and its unchanged-revision acknowledgement. */
  private serveBoard(input: unknown): UiBoard {
    // A retained executor death or failed publication withholds the cached board: a
    // stale snapshot must never answer as current.
    const reason = this.executor.unavailableReason();
    if (reason) throw new ProtocolError("unavailable", reason);
    const board = this.executor.current().board;
    if (!board) throw new ProtocolError("unavailable", "The persistence executor has not published a board projection yet");
    const input_ = parseCatalogueInput("queue.ui-snapshot", input) as { revision?: number };
    if (input_?.revision !== undefined && input_.revision === board.revision) {
      return { unchanged: true as const, revision: board.revision, connected: board.connected, paused: board.paused, dispatchHeld: board.dispatchHeld, drained: board.drained, boundRuns: board.boundRuns, quiet: board.quiet, activeWorkers: board.activeWorkers, unsettled: board.unsettled, stoppedThreads: board.stoppedThreads, resumedThreads: board.resumedThreads, error: board.error };
    }
    return board;
  }

  private handleDrainRequest(connection: Connection, request: ServiceRequest) {
    if (this.draining) {
      this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, result: { ok: true, draining: true } }, false, request.method);
      return;
    }
    this.draining = true;
    this.respond(connection, { v: PROTOCOL_VERSION, id: request.id, result: { ok: true, draining: true } }, false, request.method);
    const roll = drainInputSchema.safeParse(request.input ?? {}).data?.roll;
    this.drained = (async () => {
      // Drain to a durable safe point: stop new work and connections, drain the
      // persistence executor (which closes SQLite and releases its store work),
      // then release socket and identity. No uncertain effect is killed.
      await this.closeWebBoard();
      this.server?.close();
      this.idleTimer && clearInterval(this.idleTimer);
      this.ownershipTimer && clearInterval(this.ownershipTimer);
      this.hostLifecycleTimer && clearInterval(this.hostLifecycleTimer);
      // Best effort: detached validation supervisors survive this drain and
      // persist their result for the replacement service to reconcile.
      if (roll) { try { await this.executor.callHandler("recordServiceRoll", roll); } catch { /* the roll proceeds */ } }
      try { await this.executor.drain(); } catch { /* the durable safe point is what the executor already committed; release proceeds */ }
      for (const connection of this.connections) { connection.closing = true; connection.socket.destroy(); }
      this.connections.clear();
      // Only the process that bound the socket removes it: a replacement that never
      // started must not unlink the live owner's socket when it is stopped.
      if (this.boundSocket) rmSync(this.socketPath, { force: true });
      // A roll drain keeps identity while this pid is still alive so a retrying
      // spawn starts as a standby for it. Idle drain and stop still drop it.
      if (!roll) this.removeOwnedIdentity();
      this.server = null;
    })();
  }

  private respond(connection: Connection, response: ServiceResponse, fatal = false, method = "protocol") {
    if (connection.socket.destroyed || connection.socket.writableEnded) return;
    if (connection.socket.bufferSize > 32 * 1024 * 1024) { connection.socket.destroy(); return; }
    try {
      connection.socket.write(encodeFrame(response));
      if (fatal) { connection.closing = true; connection.socket.end(); }
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "oversize" && error.frameBytes !== undefined) {
        // One owner-only latest record stays bounded even if a caller repeats the refusal.
        const path = join(this.dataDir, "oversize-response.json");
        try {
          writeOwnedJson(path, { at: new Date().toISOString(), method, bytes: error.frameBytes, ceiling: MAX_FRAME_BYTES });
        } catch { /* diagnostic is advisory */ }
        const sizeMb = (error.frameBytes / 1_000_000).toFixed(1);
        const sizeBytes = error.frameBytes.toLocaleString("en-US");
        const ceilingBytes = MAX_FRAME_BYTES.toLocaleString("en-US");
        const boundedError: ServiceResponse = {
          v: PROTOCOL_VERSION,
          id: response.id,
          error: {
            code: "oversize",
            message: `Response for ${method} is ${sizeMb} MB, over the 16 MiB bound (${sizeBytes} bytes; ${ceilingBytes}-byte ceiling)`,
          },
        };
        try {
          connection.closing = true;
          connection.socket.end(encodeFrame(boundedError));
          return;
        } catch { /* the bounded error frame should always fit; preserve fail-closed behavior if it cannot be written */ }
      }
      connection.socket.destroy();
    }
  }

  health(): ServiceHealthStatus {
    const reason = this.executor.unavailableReason();
    if (reason) throw new ProtocolError("unavailable", reason);
    if (this.executor.current().revision < 0) {
      throw new ProtocolError("unavailable", "The persistence executor has not published health yet");
    }
    const runtime = this.executor.current().health;
    return {
      ...runtime,
      requestTimings: this.executor.requestTimings(),
      service: "nucleus" as const,
      protocolVersion: PROTOCOL_VERSION,
      buildId: currentServiceBuildId(),
      rpcContracts: SERVICE_RPC_CONTRACTS,
      pid: process.pid,
      startedAt: this.startedAt,
    };
  }

  /** Resolves once a requested drain has fully released socket, store and lease. */
  drainedPromise(): Promise<void> {
    return this.drained ?? (this.draining ? new Promise(() => {}) : Promise.resolve());
  }

  /** Stop the service from a test or supervisor; drain to a durable safe point. */
  async stop(): Promise<void> {
    if (!this.draining) {
      this.draining = true;
      onLoginSessionFault(null);
      this.drained = (async () => {
        await this.closeWebBoard();
        this.server?.close();
        this.idleTimer && clearInterval(this.idleTimer);
        this.ownershipTimer && clearInterval(this.ownershipTimer);
      this.hostLifecycleTimer && clearInterval(this.hostLifecycleTimer);
        try { await this.executor.drain(); } catch { /* release proceeds against the committed durable state */ }
        for (const connection of this.connections) { connection.closing = true; connection.socket.destroy(); }
        this.connections.clear();
        // Only the process that bound the socket removes it: a replacement that never
        // started must not unlink the live owner's socket when it is stopped.
        if (this.boundSocket) rmSync(this.socketPath, { force: true });
        this.removeOwnedIdentity();
        this.server = null;
      })();
    }
    await this.drained;
  }

  private removeOwnedIdentity() {
    if (readServiceInfo(this.dataDir)?.pid === process.pid) removeServiceInfo(this.dataDir);
  }

  /** Prove a dead prior owner left reclaimable files; caller holds the lease. */
  static reclaimStaleSocket(dataDir: string) {
    const socketFile = serviceSocketPath(dataDir);
    if (!existsSync(socketFile)) return;
    const info = readServiceInfo(dataDir);
    if (!info || !pidAlive(info.pid)) unlinkSync(socketFile);
  }
}
