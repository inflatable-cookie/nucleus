/**
 * The BB host's registration, identity and health (Spec 062, phase 1).
 *
 * Phase 0 landed the reverse host-operation channel: the BB plugin connects out to
 * the service, declares `service.host-executor` and answers `host.op` requests from
 * `bb.sdk`. This file is the service's side of *identity*: it takes one declaration
 * whose probe proved the same real data directory the identity was derived from,
 * records that identity durably, registers one `bb:` host in the host registry with
 * its own admission and breaker state, and reports it in `service.health`.
 *
 * Nothing here reaches a task workflow. The registered adapter refuses every task
 * call by name because phase 1 adds registration and identity only: no run, no
 * workspace custody, no observation. A refusal is the honest answer, and it is a
 * `ProvenPreSendRefusalError` — nothing was sent to the host.
 *
 * Spec 062: "The service derives `hostId = bb:<hash of the real data directory>`
 * and registers that identity only after a read-only probe through the channel
 * succeeds. Reconnecting must prove the same recorded data directory; a different
 * one refuses by its exact field and takes the host offline." So the recorded
 * identity is durable (a restart re-proves it, it is never re-derived from a
 * declaration) and a declaration that names a different data directory refuses by
 * `dataDir` instead of quietly registering a second BB host.
 */
import { ProvenPreSendRefusalError } from "../core/host/errors";
import { Admission, admitAdapter } from "../core/host/admission";
import type { Adapter } from "../core/host/adapter";
import type { HostRegistry } from "../core/host/host-registry";
import type { Store } from "../core/store/store";
import { hostKindOf } from "../shared/host-kind";
import {
  hostIdFromDataDir,
  isBbHostId,
  type HostOperationOutcome,
} from "../shared/host-operation";

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

/**
 * The adapter a registered BB host answers with in phase 1. Its identity is real
 * (the health surface, the routing snapshot and the host kind all read it), and
 * every task-workflow call refuses by name before anything is sent.
 */
export function createBbHostAdapter(
  hostId: string,
  connected: () => boolean,
): Adapter {
  return {
    hostId,
    isConnected: connected,
    capabilities: () => ({
      reportingViaMcp: false,
      supportsCoordinatorRecovery: true,
      lifecycleDispatch: false,
      perThreadEnvironment: false,
      repositorySharedWorkspaces: false,
    }),
    observe: async () => refusal("observation"),
    createAgent: async () => refusal("thread creation"),
    findAgents: async () => refusal("thread lookup"),
    archiveAgent: async () => refusal("thread archive"),
    validate: async () => refusal("workspace validation"),
    createWorkspace: async () => refusal("workspace creation"),
    findWorkspaces: async () => refusal("workspace lookup"),
    verifyResume: async () => refusal("resume verification"),
    verifyCheckpoint: async () => refusal("checkpoint verification"),
    verifyReplacementSource: async () =>
      refusal("replacement source verification"),
    verifyCleanQueueWorktree: async () => refusal("worktree verification"),
    verifyWorkspace: async () => refusal("workspace verification"),
    verifyPr: async () => refusal("forge reads"),
  } as unknown as Adapter;
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

  constructor(
    private readonly store: Store,
    private readonly registry: HostRegistry<RegisteredHost>,
    private readonly makeAdmission: () => Admission,
  ) {
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
    });
    this.offlineReason = "";
    this.lastRefusal = null;
    this.store.advanceRevision();
    return { ok: true };
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
