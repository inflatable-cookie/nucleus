/**
 * The BB host's registration, identity, health and workspace custody (Spec 062).
 *
 * Phase 0 landed the reverse host-operation channel: the BB plugin connects out to
 * the service, declares `service.host-executor` and answers `host.op` requests from
 * `bb.sdk`. This file is the service's side of *identity*: it takes one declaration
 * whose probe proved the same real data directory the identity was derived from,
 * records that identity durably, registers one `bb:` host in the host registry with
 * its own admission and breaker state, and reports it in `service.health`.
 *
 * Workspace custody uses a durable local handle and the host's shared project.
 * The service composes that native surface with core policy and BB thread operations
 * once the durable store and helper route are available (phase 3).
 *
 * Spec 062: "The service derives `hostId = bb:<hash of the real data directory>`
 * and registers that identity only after a read-only probe through the channel
 * succeeds. Reconnecting must prove the same recorded data directory; a different
 * one refuses by its exact field and takes the host offline." So the recorded
 * identity is durable (a restart re-proves it, it is never re-derived from a
 * declaration) and a declaration that names a different data directory refuses by
 * `dataDir` instead of quietly registering a second BB host.
 */
import { composeBbAdapter } from "./bb-adapter";
import type { BbWorkspaceRecord } from "../hosts/bb/threads";
import { ProvenPreSendRefusalError } from "../core/host/errors";
import { Admission, admitAdapter } from "../core/host/admission";
import type { Adapter } from "../core/host/adapter";
import type { HostRegistry } from "../core/host/host-registry";
import type { Store } from "../core/store/store";
import { hostKindOf } from "../shared/host-kind";
import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { readServiceInfo } from "../shared/service/discovery";
import { ServiceClient, ServiceRequestError } from "../shared/service/client";
import {
  hostIdFromDataDir,
  isBbHostId,
  workspaceHandleForPath,
  type HostOperationOutcome,
  type HostOperationName,
} from "../shared/host-operation";
import type { Task } from "../shared/contracts";
import type { HostWorkspaceRef } from "../shared/host";

/**
 * A live host that has not sent its heartbeat inside this bound is reported stale:
 * Spec 062 takes liveness from a heartbeat, not from whether a request answered, so
 * a wedged plugin is visible instead of reading as a healthy idle host.
 */
export const BB_HEARTBEAT_STALE_MS = 45_000;

/** One registered host's identity and the diagnostics its executor announced. */
export interface BbHostRecord {
  hostId: string;
  dataDir: string;
  bbVersion: string;
  sdkVersion: string;
  /** When the executor connection that proved this identity was accepted. */
  connectedAt: string;
  /** The probe's own host list, kept as a diagnostic (`identity.probe`'s answer). */
  hostIds: string[];
  online: boolean;
  /** The last liveness heartbeat this identity's connection sent, or null before one. */
  lastHeartbeatAt: string | null;
  /** True while online with no heartbeat inside the staleness bound. */
  heartbeatStale: boolean;
}

/** Why a declaration or a probe left the host unregistered. */
export interface BbHostRefusal {
  at: string;
  hostId: string;
  dataDir: string;
  /** The exact field the refusal names, e.g. `dataDir` or `sdkVersion`. */
  field: string;
  reason: string;
}

/** What one verified declaration tells the runtime. */
export interface BbHostVerifiedInput {
  hostId: string;
  dataDir: string;
  bbVersion: string;
  sdkVersion: string;
  hostIds: string[];
  connectedAt: string;
}

/** What one refused declaration or failed probe tells the runtime. */
export interface BbHostRejectedInput {
  hostId: string;
  dataDir: string;
  field: string;
  reason: string;
  at: string;
}

/** What one released executor connection tells the runtime. */
export interface BbHostReleasedInput {
  hostId: string;
  connectedAt: string;
  reason: string;
}

export interface BbHostStatus {
  online: boolean;
  hosts: BbHostRecord[];
  /** Empty while the host is online or has never been refused. */
  offlineReason: string;
  lastRefusal: BbHostRefusal | null;
}

type RegisteredHost = { adapter: Adapter; admission: Admission };

const META_KEY = "bbHostIdentity";
const WORKSPACES_KEY = "bbWorkspaces";


/** The durable identity one BB server keeps across service restarts. */
interface RecordedIdentity {
  hostId: string;
  dataDir: string;
}

const refusal = (capability: string): never => {
  throw new ProvenPreSendRefusalError(
    `BB does not support ${capability} in phase 1 (Spec 062)`,
  );
};

class BbHostOperationNotSentError extends Error {
  constructor(reason: string) {
    super(`BB host operation was not sent: ${reason}`);
    this.name = "BbHostOperationNotSentError";
  }
}

/**
 * Native workspace custody, also usable for registration before a durable store
 * and helper route are available. The full adapter composes this with BB threads.
 */
export function createBbWorkspaceAdapter(
  hostId: string,
  connected: () => boolean,
  dataDir = "",
  store?: Store,
  requestOperation?: (op: HostOperationName, input: unknown) => Promise<HostOperationOutcome>,
) {
  async function operation(op: HostOperationName, input: unknown): Promise<HostOperationOutcome> {
    let online: boolean;
    try { online = connected(); }
    catch (error) { throw new BbHostOperationNotSentError(error instanceof Error ? error.message : String(error)); }
    if (!online) throw new BbHostOperationNotSentError("BB host executor is offline");
    if (requestOperation) return requestOperation(op, input);
    let client: ServiceClient;
    try {
      const info = readServiceInfo(dataDir);
      if (!info) throw new Error("Nucleus service identity is unavailable");
      client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
      await client.connect();
    } catch (error) {
      throw new BbHostOperationNotSentError(error instanceof Error ? error.message : String(error));
    }
    try {
      return await client.request("service.bb-host-operation", { hostId, op, input }, 25_000) as HostOperationOutcome;
    } finally { client.close(); }
  }
  const workspaces = (): Record<string, BbWorkspaceRecord> => store?.getMeta<Record<string, BbWorkspaceRecord>>(WORKSPACES_KEY) ?? {};
  const getWorkspace = (id: string) => workspaces()[id];
  const putWorkspace = (record: BbWorkspaceRecord) => { if (!store) throw new Error("BB workspace store is unavailable"); store.setMeta(WORKSPACES_KEY, { ...workspaces(), [record.id]: record }); };
  const removeWorkspace = (id: string) => { if (!store) throw new Error("BB workspace store is unavailable"); const next = workspaces(); delete next[id]; store.setMeta(WORKSPACES_KEY, next); };
  async function workspaceAvailable(id: string): Promise<boolean> {
    let record = getWorkspace(id);
    if (!record || record.archivedAt || !existsSync(record.directory)) return false;
    const result = await operation("workspace.inspect", { repositoryRoot: record.repositoryRoot, ...(record.projectId ? { projectId: record.projectId } : {}) });
    const inspected = result.value as { projectId: string | null; projectFound: boolean };
    if (inspected.projectFound && inspected.projectId && !record.projectId) {
      record = { ...record, projectId: inspected.projectId };
      putWorkspace(record);
    }
    if (!inspected.projectFound) return false;
    if (record.environmentId) {
      const read = await operation("environment.list", {});
      const rows = (read.value as { environments: Array<{ environmentId: string; path: string; status: string }> }).environments;
      return rows.some(row => row.environmentId === record.environmentId && row.path === record.directory && row.status !== "destroyed");
    }
    return true;
  }
  const native = {
    hostId,
    operation, records: workspaces, put: putWorkspace,
    isConnected: connected,
    capabilities: () => ({
      reportingViaMcp: false,
      supportsCoordinatorRecovery: true,
      nativeDecisions: false,
      lifecycleDispatch: false,
      perThreadEnvironment: false,
      repositorySharedWorkspaces: false,
    }),
    observe: async () => refusal("observation"),
    createAgent: async () => refusal("thread creation"),
    findAgents: async () => refusal("thread lookup"),
    archiveAgent: async () => refusal("thread archive"),
    validate: async () => refusal("workspace validation"),
    workspaceIdAccepted: (id: unknown) => typeof id === "string" && /^bb-worktree-[a-f0-9]{40}$/.test(id),
    async repositoryProject(root: string) {
      const repositoryRoot = realpathSync(root);
      const result = await operation("workspace.inspect", { repositoryRoot });
      const value = result.value as { projectId: string | null; projectFound: boolean };
      return { ...(value.projectFound && value.projectId ? { projectId: value.projectId } : {}), workspaceRoot: repositoryRoot };
    },
    async createWorkspace(task: Task) {
      if (!task.directory) throw new ProvenPreSendRefusalError("BB workspace creation requires the task's recorded worktree directory");
      const directory = realpathSync(task.directory);
      const repositoryRoot = realpathSync(task.repoPath);
      const id = workspaceHandleForPath(directory);
      const old = getWorkspace(id);
      if (old) {
        if (old.directory !== directory || old.repositoryRoot !== repositoryRoot) throw new Error("BB workspace identity conflict");
        const { archivedAt, ...active } = old;
        if (archivedAt) putWorkspace(active);
        if (active.projectId) return { id, directory };
        const inspected = await operation("workspace.inspect", { repositoryRoot });
        const project = inspected.value as { projectId: string | null; projectFound: boolean };
        if (!project.projectFound || !project.projectId) throw new Error("BB workspace creation remains unknown; project inspection found no matching project, so it was not resent");
        putWorkspace({ ...active, projectId: project.projectId });
        return { id, directory };
      }
      // Record custody before the SDK write. If its reply is lost, a later create
      // adopts the project by a fresh exact-root read and never repeats the write.
      putWorkspace({ id, directory, repositoryRoot, projectId: "", title: task.title });
      let result: HostOperationOutcome;
      try { result = await operation("workspace.create", { repositoryRoot, workspacePath: directory, name: basename(repositoryRoot) || task.title }); }
      catch (error) {
        // A local failure before the service request, or a typed refusal before the
        // SDK write, proves the project create could not have landed. Unknown
        // outcomes keep the reservation so a later call must observe, never resend.
        if (error instanceof BbHostOperationNotSentError || (error instanceof ServiceRequestError && (error.code === "invalid_input" || error.code === "refused"))) removeWorkspace(id);
        throw error;
      }
      const value = result.value as { projectId: string; handle: string; path: string; spawned: number };
      if (value.handle !== id || value.path !== directory || value.spawned !== 0) throw new Error("BB workspace.create returned a mismatched handle or spawned a thread");
      putWorkspace({ id, directory, repositoryRoot, projectId: value.projectId, title: task.title });
      return { id, directory };
    },
    async findWorkspaces(task: Task) {
      if (!task.directory) return [];
      const directory = realpathSync(task.directory);
      return Object.values(workspaces()).filter(item => item.directory === directory && item.projectId && !item.archivedAt).map(item => ({ id: item.id, directory: item.directory }));
    },
    workspaceAvailable,
    workspaceRef(id: string): HostWorkspaceRef {
      let available = false;
      return {
        get directory() { return getWorkspace(id)?.directory ?? null; },
        async refresh() { available = await workspaceAvailable(id); return available; },
        current() { const record = getWorkspace(id); return available && record ? { projectRootPath: record.directory, workspaceDirectory: record.directory, projectId: record.projectId, workspaceKind: "external" } : null; },
        async archive() {
          const record = getWorkspace(id);
          const archivedAt = record?.archivedAt ?? new Date().toISOString();
          if (record && !record.archivedAt) putWorkspace({ ...record, archivedAt });
          return { archivedAt, error: null };
        },
      };
    },
    async taskWorkspaceArchived(id: string) { const record = getWorkspace(id); return !record || Boolean(record.archivedAt); },
    verifyResume: async () => refusal("resume verification"),
    verifyCheckpoint: async () => refusal("checkpoint verification"),
    verifyReplacementSource: async () =>
      refusal("replacement source verification"),
    verifyCleanQueueWorktree: async () => refusal("worktree verification"),
    verifyWorkspace: async () => refusal("workspace verification"),
    verifyPr: async () => refusal("forge reads"),
  };
  return native;
}

export function createBbHostAdapter(
  hostId: string, connected: () => boolean, dataDir = "", store?: Store,
  requestOperation?: (op: HostOperationName, input: unknown) => Promise<HostOperationOutcome>,
): Adapter {
  const native = createBbWorkspaceAdapter(hostId, connected, dataDir, store, requestOperation);
  if (!store) return native as unknown as Adapter;
  return composeBbAdapter({ hostId, connected, dataDir, store, workspaces: native, operation: native.operation,
    records: native.records, put: native.put,
    notSent: error => error instanceof BbHostOperationNotSentError || (error instanceof ServiceRequestError && (error.code === "invalid_input" || error.code === "refused")),
  });
}

/**
 * One BB host identity's registry claim, admission and diagnostics.
 *
 * The executor link itself lives in the service process (it is a socket
 * connection); this object lives with the runtime that owns the registry, so the
 * durable entry, the admission resource and health are in one place.
 */
export class BbHostConnection {
  private session: { id: string; token: object; connectedAt: string } | null =
    null;
  private readonly records = new Map<string, BbHostRecord>();
  private offlineReason = "";
  private lastRefusal: BbHostRefusal | null = null;

  private readonly now: () => number;

  constructor(
    private readonly store: Store,
    private readonly registry: HostRegistry<RegisteredHost>,
    private readonly makeAdmission: () => Admission,
    private readonly dataDir: string,
    now: () => number = Date.now,
  ) {
    this.now = now;
    const recorded = this.recorded();
    if (recorded) {
      // A restart proves nothing about the host until its executor re-probes, so a
      // recorded identity starts offline with a reason that says exactly that.
      this.records.set(recorded.hostId, {
        hostId: recorded.hostId,
        dataDir: recorded.dataDir,
        bbVersion: "",
        sdkVersion: "",
        connectedAt: "",
        hostIds: [],
        online: false,
        lastHeartbeatAt: null,
        heartbeatStale: false,
      });
      this.offlineReason =
        "BB plugin is not connected; the identity re-proves on its next probe";
    }
  }

  /** Only connection facts: no executor socket, no operation payload. */
  status(): BbHostStatus {
    this.retireDisconnected();
    return {
      online: this.session !== null,
      hosts: [...this.records.values()].map((record) => ({
        ...record,
        online: this.session?.id === record.hostId,
        heartbeatStale: this.session?.id === record.hostId && this.stale(record.lastHeartbeatAt),
      })),
      offlineReason: this.session ? "" : this.offlineReason,
      lastRefusal: this.lastRefusal,
    };
  }

  /** Whether this host identity holds a live registry claim right now. */
  connected(): boolean {
    return this.session !== null;
  }

  /** A dropped executor connection retires this claim, never another host's. */
  retireDisconnected(): void {
    const session = this.session;
    if (!session) return;
    if (this.registry.get(session.id)) return;
    this.session = null;
    const record = this.records.get(session.id);
    if (record) this.records.set(session.id, { ...record, online: false });
    if (!this.offlineReason) this.offlineReason = "BB plugin is not connected";
  }

  /**
   * One declaration whose probe succeeded. The recorded identity is the authority:
   * the same data directory re-registers, a different one refuses by its field.
   */
  verified(
    input: BbHostVerifiedInput,
  ): { ok: true } | { ok: false; field: string; reason: string } {
    const refuse = (
      field: string,
      reason: string,
    ): { ok: false; field: string; reason: string } => {
      this.rejected({
        hostId: input.hostId,
        dataDir: input.dataDir,
        field,
        reason,
        at: new Date().toISOString(),
      });
      return { ok: false, field, reason };
    };
    if (!isBbHostId(input.hostId) || hostKindOf(input.hostId) !== "bb")
      return refuse(
        "hostId",
        `BB host identity ${String(input.hostId)} is malformed`,
      );
    // The probe is the authority on the data directory; the identity is its hash.
    const derived = hostIdFromDataDir(input.dataDir);
    if (derived !== input.hostId)
      return refuse(
        "dataDir",
        `identity.probe answered dataDir ${input.dataDir}, which derives ${derived} instead of ${input.hostId}`,
      );
    const recorded = this.recorded();
    if (
      recorded &&
      (recorded.hostId !== input.hostId || recorded.dataDir !== input.dataDir)
    )
      return refuse(
        "dataDir",
        `BB data directory changed: recorded ${recorded.dataDir} (${recorded.hostId}), this plugin announced ${input.dataDir} (${input.hostId})`,
      );
    if (!recorded)
      this.store.setMeta(META_KEY, {
        hostId: input.hostId,
        dataDir: input.dataDir,
      } satisfies RecordedIdentity);
    const admission = this.registry.resource(input.hostId, this.makeAdmission);
    const adapter = admitAdapter(
      createBbHostAdapter(
        input.hostId,
        () => this.session?.id === input.hostId,
        this.dataDir,
        this.store,
      ),
      admission,
    );
    // A reload replaces the previous claim for this identity; the newer connection wins.
    if (
      this.session &&
      this.session.id === input.hostId &&
      this.session.connectedAt !== input.connectedAt
    ) {
      this.registry.disconnect(this.session.id, this.session.token);
      this.session = null;
    }
    if (!this.session) {
      const token = this.registry.connect(
        input.hostId,
        bbEndpoint(input.dataDir),
        { adapter, admission },
      );
      this.session = {
        id: input.hostId,
        token,
        connectedAt: input.connectedAt,
      };
    }
    this.records.set(input.hostId, {
      hostId: input.hostId,
      dataDir: input.dataDir,
      bbVersion: input.bbVersion,
      sdkVersion: input.sdkVersion,
      connectedAt: input.connectedAt,
      hostIds: [...input.hostIds],
      online: true,
      // A fresh acceptance is itself proof of liveness until the first heartbeat.
      lastHeartbeatAt: null,
      heartbeatStale: false,
    });
    this.offlineReason = "";
    this.lastRefusal = null;
    this.store.advanceRevision();
    return { ok: true };
  }

  /**
   * One liveness heartbeat from the executor connection that holds this identity's
   * claim. A heartbeat for an identity that is not the connected one proves nothing
   * and is ignored.
   */
  heartbeat(hostId: string, at: string): void {
    if (!this.session || this.session.id !== hostId) return;
    const record = this.records.get(hostId);
    if (!record) return;
    this.records.set(hostId, { ...record, lastHeartbeatAt: at, heartbeatStale: false });
    this.store.advanceRevision();
  }

  private stale(lastHeartbeatAt: string | null): boolean {
    if (!lastHeartbeatAt) return this.now() - Date.parse(this.session?.connectedAt ?? "") > BB_HEARTBEAT_STALE_MS;
    return this.now() - Date.parse(lastHeartbeatAt) > BB_HEARTBEAT_STALE_MS;
  }

  /**
   * One declaration the service refused, or a probe that proved nothing. The host
   * is offline and health names the field that refused.
   */
  rejected(input: BbHostRejectedInput): void {
    this.retireDisconnected();
    this.lastRefusal = {
      at: input.at,
      hostId: input.hostId,
      dataDir: input.dataDir,
      field: input.field,
      reason: input.reason,
    };
    // The offline reason leads with the field, because Spec 062's acceptance is that a
    // refused identity is offline *by name*: an operator reads which field refused it.
    this.offlineReason = input.reason.startsWith(`${input.field}:`)
      ? input.reason
      : `${input.field}: ${input.reason}`;
    // This service serves one BB host identity, so a refusal for an identity that is
    // not the one holding the claim still takes the recorded host offline: either the
    // plugin announced a different data directory than the recorded one, or the
    // identity never proved itself, and in both cases the host it would be is offline.
    const recorded = this.recorded()?.hostId;
    if (
      this.session &&
      (this.session.id === input.hostId || this.session.id === recorded)
    ) {
      this.registry.disconnect(this.session.id, this.session.token);
      this.session = null;
    }
    const record = this.records.get(input.hostId);
    if (record) this.records.set(input.hostId, { ...record, online: false });
    this.store.advanceRevision();
  }

  /**
   * The executor connection closed. A stale release (an older connection replaced
   * by a reload) never retires its successor's claim.
   */
  released(input: BbHostReleasedInput): void {
    if (!this.session || this.session.id !== input.hostId) return;
    if (
      this.session.connectedAt &&
      input.connectedAt &&
      this.session.connectedAt !== input.connectedAt
    )
      return;
    this.registry.disconnect(this.session.id, this.session.token);
    this.session = null;
    const record = this.records.get(input.hostId);
    if (record) this.records.set(input.hostId, { ...record, online: false });
    // A release never overwrites the field-prefixed reason a refusal just recorded; an
    // ordinary drop has no earlier reason, so it names itself.
    if (!this.offlineReason)
      this.offlineReason = input.reason || "BB plugin is not connected";
    this.store.advanceRevision();
  }

  private recorded(): RecordedIdentity | null {
    const value = this.store.getMeta<Partial<RecordedIdentity>>(META_KEY);
    if (
      !value ||
      typeof value.hostId !== "string" ||
      typeof value.dataDir !== "string"
    )
      return null;
    return { hostId: value.hostId, dataDir: value.dataDir };
  }
}

/**
 * The registry's durable endpoint for one BB identity. The connection is outbound
 * from the plugin, so the endpoint is the data directory the identity was proved
 * from rather than a URL: it is what "the same host" means here.
 */
function bbEndpoint(dataDir: string): string {
  return `bb-data-dir:${dataDir}`;
}

/** The probe's host list and version strings are diagnostics, never an allowlist. */
export function probeDiagnostics(outcome: HostOperationOutcome): {
  bbVersion: string;
  sdkVersion: string;
  hostIds: string[];
  dataDir: string;
} {
  const value = outcome.value as {
    dataDir: string;
    bbVersion: string;
    sdkVersion: string;
    hostIds: string[];
  };
  return {
    dataDir: value.dataDir,
    bbVersion: value.bbVersion,
    sdkVersion: value.sdkVersion,
    hostIds: [...value.hostIds],
  };
}
