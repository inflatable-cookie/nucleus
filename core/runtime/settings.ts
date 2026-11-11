import { checkPoolEntries, normalizeRetryAt, saveProfileSettings, type ProfileSettings } from "../../shared/pool";
import { nucleusProfileSchema, type ProviderMap } from "../../shared/profiles";
import { hostCatalogSchema, storedHostCatalogSchema } from "../../shared/host";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store, StoreMaintenanceError } from "../store/store";
import type { Adapter } from "../host/adapter";
import type { Engine } from "../engine";
import type { UsageLevel, DemandRoleOffsets, PoolEntry } from "../../shared/contracts";
import { capacitySchema, projectDispatchLimitSchema } from "../../shared/contracts";
import type { Decisions } from '../planning/decisions';
import { applyRoutingGrant } from "../dispatch/routing-grants";
import type { CapacityChangeJournal } from '../dispatch/capacity-changes';
import { capacityWriteRefusalMessage, capacityWriteSurface } from '../../shared/capacity-authority';
/** Meta key prefix of the stored host catalog, one per host and directory (nucleus#970). */
const HOST_CATALOG_META_PREFIX = "hostCatalog:";

/** Narrow dependencies; construction and lifecycle remain runtime-owned. */
export interface SettingsContext {
  store: Store;
  engine: Pick<Engine, "profiles" | "wake" | "resumePausedStops">;
  decisions: Decisions;
  capacityChanges: CapacityChangeJournal;
  readonly started: Promise<void>;
  readonly hostId: string;
  readonly startError: string;
  readonly adapter: Pick<Adapter, "catalog">;
  connected(): boolean;
  wakeAndSettlePostBootstrapTimeout(): Promise<void>;
  markStoreAccess(): void;
}

export class RuntimeSettings {
  constructor(private readonly context: SettingsContext) {}

  configurePool({ entries }: { entries: PoolEntry[] }) {
    checkPoolEntries(entries, new Set(this.context.engine.profiles.map(p => p.id)), this.context.store.pool());
    this.context.store.setMeta("pool", entries); this.context.store.advanceRevision();
    void this.context.wakeAndSettlePostBootstrapTimeout(); return { ok: true as const };
  }

  configureProfile(settings: ProfileSettings) { return this.configurePool({ entries: saveProfileSettings(this.context.store.pool(), settings) }); }

  /**
   * Nucleus's own profile list (Spec 052). These are records Nucleus keeps and
   * edits; routing combines them with the host catalog.
   */
  profileList() { return { profiles: this.context.store.profiles() }; }

  profileCreate(input: z.infer<typeof import("../../shared/contracts").createNucleusProfile.input>) {
    const profiles = this.context.store.profiles();
    const id = input.id ?? randomUUID();
    if (profiles.some(profile => profile.id === id)) throw new Error(`Profile ${id} already exists`);
    const profile = nucleusProfileSchema.parse({ ...input, id, model: input.model ?? "", notes: input.notes ?? "" });
    this.context.store.setProfiles([...profiles, profile]);
    return { profile };
  }

  profileUpdate(input: z.infer<typeof import("../../shared/contracts").updateNucleusProfile.input>) {
    const profiles = this.context.store.profiles();
    const index = profiles.findIndex(profile => profile.id === input.id);
    if (index < 0) throw new Error(`Profile ${input.id} does not exist`);
    const merged: Record<string, unknown> = { ...profiles[index] };
    // A null clears an optional field; an absent field is left as stored.
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (key === "id") continue;
      if (value === null) delete merged[key];
      else if (value !== undefined) merged[key] = value;
    }
    const profile = nucleusProfileSchema.parse(merged);
    const next = [...profiles]; next[index] = profile;
    this.context.store.setProfiles(next);
    return { profile };
  }

  profileRemove(input: { id: string }) {
    const profiles = this.context.store.profiles();
    const next = profiles.filter(profile => profile.id !== input.id);
    if (next.length === profiles.length) return { removed: false };
    this.context.store.setProfiles(next);
    return { removed: true };
  }

  /** The host provider key to normalised key map a profile's provider is read through. */
  profileProviders() { return { providers: this.context.store.providerMap() }; }

  /**
   * Settings' provider-map editor replaces the whole map; `{}` restores identity,
   * so a host that spells a provider differently needs only the differing keys.
   */
  profileSetProviders(input: { providers: ProviderMap }) {
    this.context.store.setProviderMap(input.providers);
    return { providers: this.context.store.providerMap() };
  }

  /**
   * The host catalog (shared/host.ts), answered from the copy Nucleus stored for
   * this host and directory (nucleus#970): the Profiles page opens with its lists
   * at once instead of waiting on a slow host read. A stored copy is a record with
   * its read time, not a live claim, so it answers while the daemon is
   * disconnected. The first read with nothing stored, and `refresh`, read the host
   * live and replace the stored copy; a live read refuses on a disconnected daemon
   * rather than answering an empty list that would read as "this host offers
   * nothing", and a failed refresh leaves the stored copy as it was. Dispatch and
   * routing never read this copy: the engine reads the host's catalog itself.
   */
  async hostCatalog(input: { cwd?: string; refresh?: boolean }) {
    await this.context.started;
    const hostId = this.context.hostId;
    const key = `${HOST_CATALOG_META_PREFIX}${JSON.stringify([hostId, input.cwd ?? ""])}`;
    if (!input.refresh) {
      const stored = storedHostCatalogSchema.safeParse(this.context.store.getMeta(key));
      if (stored.success) return stored.data;
    }
    if (!this.context.connected() || this.context.startError) throw new Error(this.context.startError || "Daemon is disconnected");
    if (!this.context.adapter.catalog) throw new Error("This host does not report a catalog");
    const catalog = hostCatalogSchema.parse(await this.context.adapter.catalog(input.cwd ? { cwd: input.cwd } : {}));
    const answer = storedHostCatalogSchema.parse({ ...catalog, readAt: new Date().toISOString() });
    // A store in maintenance still answers the live read; the next read stores it.
    try { this.context.store.setMeta(key, answer); } catch (error) { if (!(error instanceof StoreMaintenanceError)) throw error; }
    return answer;
  }

  queueControl({ paused, dispatchHeld }: { paused?: boolean; dispatchHeld?: boolean }) {
    if (paused !== undefined) this.context.store.setMeta("paused", paused);
    if (dispatchHeld !== undefined) this.context.store.setMeta("dispatchHeld", dispatchHeld);
    this.context.store.advanceRevision(); void this.context.wakeAndSettlePostBootstrapTimeout();
    // Queue #650: unpausing resumes every thread the operator stopped while
    // paused; the audit pass settles any the resume could not finish at once.
    if (paused === false) void this.context.engine.resumePausedStops().catch(() => {});
    return { ok: true as const };
  }

  availabilityControl(input: z.infer<typeof import("../../shared/contracts").availabilityControl.input>) {
    if (input.action === "remove") {
      if (this.context.store.pool().some(entry => entry.group === input.group))
        throw new Error(`Subscription group ${input.group} is still in the profile pool; remove or regroup its profiles before removing its availability record`);
      const task = this.context.store.db.prepare("SELECT id FROM tasks WHERE json_extract(data, '$.profileGroup') = ? AND json_extract(data, '$.phase') NOT IN ('done', 'cancelled') AND json_extract(data, '$.removedAt') IS NULL LIMIT 1").get(input.group);
      if (task) throw new Error(`Subscription group ${input.group} is still referenced by an unfinished task (${task.id}); its availability record is retained`);
      const run = this.context.store.db.prepare("SELECT id FROM runs WHERE json_extract(data, '$.released') = 0 AND json_extract(data, '$.profileGroup') = ? LIMIT 1").get(input.group);
      if (run) throw new Error(`Subscription group ${input.group} still has an unreleased run (${run.id}); its availability record is retained`);
      if (!this.context.store.deleteAvailability(input.group)) return { ok: true as const };
    } else {
      const { action: _action, ...mark } = input;
      const availability = { ...mark, retryAt: normalizeRetryAt(mark.retryAt) };
      this.context.store.setAvailability(input.group, JSON.stringify(availability));
    }
    this.context.store.advanceRevision();
    void this.context.wakeAndSettlePostBootstrapTimeout(); return { ok: true as const };
  }

  /** Spec 052: a planner asks for a standing frontier grant; the operator answers on the board. */
  routingGrant(input: { action: "request" | "end" | "revoke"; caller: string; reason?: string; profiles?: string[]; until?: string | null; grantId?: string }) {
    const result = applyRoutingGrant(this.context.store, this.context.decisions, input);
    void this.context.engine.wake().catch(() => { /* a failed drain is recorded as engineError */ });
    return result;
  }

  /** Spec 052: the operator's usage level, read live by every automatic selection. */
  async configureUsage(input: { level: UsageLevel; until?: string | null }) {
    const until = input.until ?? null;
    if (until && Date.parse(until) <= Date.now()) throw new Error("`until` must be in the future");
    this.context.store.transaction(() => {
      this.context.store.setMeta("usageLevel", { level: input.level, until, setAt: new Date().toISOString() });
      this.context.store.advanceRevision();
    });
    void this.context.engine.wake().catch(() => { /* a failed drain is recorded as engineError */ });
    return this.context.store.usageView();
  }

  /** Spec 053: the host-wide role offsets every automatic selection and the board preview read. */
  async configureDemandOffsets(input: DemandRoleOffsets) {
    this.context.store.transaction(() => {
      this.context.store.setMeta("demandRoleOffsets", input);
      this.context.store.advanceRevision();
    });
    void this.context.engine.wake().catch(() => { /* a failed drain is recorded as engineError */ });
    return this.context.store.demandRoleOffsets();
  }

  /**
   * `queue.capacity-state` is the operator's read of the Settings-only boundary:
   * the values every live reader sees and the durable record of applied changes
   * (time, surface, version and the full before and after states). It is also the
   * confirmation read after a lost reply. It takes no input, derives nothing and
   * invents nothing, so it can never write over a change the operator made.
   */
  capacityAuthorityState() {
    this.context.markStoreAccess();
    return this.context.capacityChanges.state();
  }

  /**
   * Settings-only capacity writes (service-boundary contract, "Settings-only
   * capacity writes"). The service's dispatch point refuses every surface except
   * the Paseo plugin bridge before this handler runs, so an internal caller cannot
   * use it as a second route either — and this handler refuses a missing surface
   * itself in case a future seam forgets to pass one.
   *
   * An omitted field keeps the value in force; writing the values already in force
   * is a no-op and records nothing. An applied change commits its limits and its
   * record entry in one transaction.
   */
  async configureCapacity(input: z.infer<typeof capacitySchema>, _accepted?: unknown, context?: { via?: string | null }) {
    const surface = capacityWriteSurface(context?.via);
    if (!surface) throw new Error(capacityWriteRefusalMessage());
    const result = this.context.capacityChanges.apply(input, surface);
    if (result.changed) void this.context.wakeAndSettlePostBootstrapTimeout();
    return { ok: true as const };
  }

  async configureProjectDispatchLimit(input: z.infer<typeof projectDispatchLimitSchema>) {
    const parsed = projectDispatchLimitSchema.parse(input);
    this.context.store.transaction(() => {
      if (parsed.limit !== null && !this.context.store.projectByKey(parsed.projectKey)) throw new Error(`Unknown project ${parsed.projectKey}`);
      this.context.store.setProjectDispatchLimitOverride(parsed.projectKey, parsed.limit);
      this.context.store.advanceRevision();
    });
    void this.context.wakeAndSettlePostBootstrapTimeout(); return { ok: true as const };
  }
}
