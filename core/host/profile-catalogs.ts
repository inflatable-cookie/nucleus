import {
  hostProviderFor,
  profileCompatibility,
  routingProfiles,
} from "../../shared/profiles";
import {
  canonicalCatalog,
  canonicalVocabulary,
  type HostVocabulary,
} from "../../shared/profile-vocabulary";
import { HOST_KIND_LABELS, hostKindOf } from "../../shared/host-kind";
import type { HostCatalog } from "../../shared/host";
import type { Profile } from "../../shared/contracts";
import type { NucleusProfile } from "../../shared/profiles";
import type {
  ProfileCompatibilityHost,
  ProfileCompatibilityRow,
} from "../../shared/rpc/settings";
import { hostConnected, type Adapter } from "./adapter";

/** The primary host's catalog key, before (or without) a registered id for it. */
const PRIMARY_CATALOG = "\u0000primary";

/** The engine ports profile-catalog snapshots read at each call. */
export interface ProfileCatalogsOwner {
  store: { profiles(): NucleusProfile[] };
  adapter: Adapter;
  primaryAdapter: Adapter;
  resolveHostAdapter: (id: string) => Adapter | undefined;
  hostIds: () => readonly string[];
  hostOnline: (id: string) => boolean;
  profiles: Profile[];
}

/**
 * Per-host routing-profile snapshots from the catalogs Nucleus last read.
 * Engine keeps the public `profiles` field tests assign; this owner is the
 * single place those snapshots are refreshed, rebuilt and queried.
 */
export class ProfileCatalogs {
  private readonly hostProfiles = new Map<string, Profile[]>();
  private readonly hostCatalogRefreshed = new Set<string>();
  /** Tests seed a primary snapshot on Engine.hostCatalogs the way they did before the split. */
  readonly hostCatalogs = new Map<
    string,
    { catalog: HostCatalog; readAt: string }
  >();
  private primaryHostId: string | undefined;
  private profileCatalogRefreshed = false;

  constructor(private readonly owner: ProfileCatalogsOwner) {}

  async refresh(): Promise<void> {
    if (!this.owner.adapter.catalog)
      throw new Error("Host profile catalog is unavailable");
    // A host that positively reports itself offline answers no catalog, and that is
    // that host's own absence rather than a failure of the pass (nucleus#1449): its
    // previous snapshot stays, dispatch on it waits on its own gates, and every
    // online host below still reads its own catalog. An adapter that cannot report
    // its connection at all is read as before, and a connected host whose read
    // fails is a real fault that still rejects.
    const primaryReadable = this.owner.primaryAdapter.isConnected
      ? hostConnected(this.owner.primaryAdapter)
      : true;
    if (primaryReadable) {
      const catalog = await this.owner.adapter.catalog();
      this.hostCatalogs.set(PRIMARY_CATALOG, {
        catalog,
        readAt: new Date().toISOString(),
      });
      this.profileCatalogRefreshed = true;
    }
    // Each secondary host's availability is its own catalog's answer: a profile
    // whose thinking level or feature values that host does not report stays
    // ineligible there, so selection never sends a launch the host must refuse
    // (nucleus#1139). A failed read keeps the previous snapshot.
    for (const id of this.owner.hostIds()) {
      const selected = this.owner.resolveHostAdapter(id);
      if (!selected || !selected.catalog) continue;
      // The primary host's catalog is the profile set read above; only a
      // secondary host reads its own.
      if (selected === this.owner.primaryAdapter) {
        this.primaryHostId = id;
        this.hostCatalogRefreshed.add(id);
        continue;
      }
      try {
        this.hostCatalogs.set(id, {
          catalog: await selected.catalog(),
          readAt: new Date().toISOString(),
        });
        this.hostCatalogRefreshed.add(id);
      } catch {
        /* keep any previous snapshot; dispatch waits through its own gates */
      }
    }
    this.rebuildProfiles();
  }

  /**
   * One host's profile vocabulary table: the adapter's own (Tom, 2026-11-12). An
   * adapter without one, a test double, speaks canonical values as they are.
   */
  vocabularyFor(id: string | undefined): HostVocabulary {
    const selected = id
      ? this.owner.resolveHostAdapter(id)
      : this.owner.primaryAdapter;
    const kind = hostKindOf(id);
    return (
      (selected ?? this.owner.primaryAdapter).vocabulary ??
      canonicalVocabulary(kind, HOST_KIND_LABELS[kind])
    );
  }

  /**
   * The routing snapshots from the catalogs last read and the stored canonical
   * profiles, each translated with its host's table. A Settings edit calls this so
   * selection follows it at once; no host is read.
   */
  rebuildProfiles(): void {
    const profiles = this.owner.store.profiles();
    const primary = this.hostCatalogs.get(PRIMARY_CATALOG);
    if (primary)
      this.owner.profiles = routingProfiles(
        profiles,
        primary.catalog,
        this.owner.primaryAdapter.vocabulary ??
          this.vocabularyFor(this.primaryHostId),
      );
    for (const [id, read] of this.hostCatalogs)
      if (id !== PRIMARY_CATALOG)
        this.hostProfiles.set(
          id,
          routingProfiles(profiles, read.catalog, this.vocabularyFor(id)),
        );
  }

  /** Each secondary host's last catalog in canonical values, for Settings' profile form. */
  secondaryCanonicalCatalogs(): HostCatalog[] {
    return [...this.hostCatalogs]
      .filter(
        ([id]) =>
          id !== PRIMARY_CATALOG &&
          this.owner.resolveHostAdapter(id) !== this.owner.primaryAdapter,
      )
      .map(([id, read]) =>
        canonicalCatalog(this.vocabularyFor(id), read.catalog),
      );
  }

  /**
   * Each stored profile on each known host: computed on read from the catalog
   * Nucleus last read from that host and that host's table, so a catalog change or
   * a Settings edit shows at once. A host never read answers `unknown`.
   */
  profileCompatibility(): {
    hosts: ProfileCompatibilityHost[];
    rows: ProfileCompatibilityRow[];
  } {
    const profiles = this.owner.store.profiles();
    const ids = [
      ...new Set([
        ...(this.primaryHostId ? [this.primaryHostId] : []),
        ...this.owner.hostIds(),
      ]),
    ];
    const hosts: ProfileCompatibilityHost[] = [],
      rows: ProfileCompatibilityRow[] = [];
    for (const id of ids) {
      const selected = this.owner.resolveHostAdapter(id);
      const primary =
        id === this.primaryHostId ||
        (selected !== undefined && selected === this.owner.primaryAdapter);
      const read =
        this.hostCatalogs.get(primary ? PRIMARY_CATALOG : id) ?? null;
      const kind = hostKindOf(id);
      const vocabulary = primary
        ? (this.owner.primaryAdapter.vocabulary ?? this.vocabularyFor(id))
        : this.vocabularyFor(id);
      hosts.push({
        hostId: id,
        kind,
        label: vocabulary.label,
        online: this.owner.hostOnline(id),
        readAt: read?.readAt ?? null,
      });
      for (const profile of profiles) {
        if (!read) {
          rows.push({
            profileId: profile.id,
            hostId: id,
            status: "unknown",
            reason: `${vocabulary.label}'s catalog has not been read yet`,
            translated: [],
            launch: null,
          });
          continue;
        }
        const answer = profileCompatibility(profile, read.catalog, vocabulary);
        rows.push({
          profileId: profile.id,
          hostId: id,
          status: answer.status,
          reason: answer.reason,
          translated: answer.translated,
          launch: answer.launch,
        });
      }
    }
    return { hosts, rows };
  }

  /**
   * Whether the daemon profile catalog is known. A service starts with an empty
   * catalog until its first refresh; until then a profile's availability is
   * unknown, not unavailable, so launches, dispatch and named-profile controls
   * wait instead of parking or refusing (consumer #660: a restart processed 1.4 s
   * after a roll parked "profile Sol oracle is unavailable").
   */
  profileCatalogKnown(): boolean {
    return this.profileCatalogRefreshed || this.owner.profiles.length > 0;
  }

  /** A known host catalog distinguishes provider loss from an invalid model or configuration. */
  workerProviderUnavailable(task: {
    profile?: Profile | null;
    hostId?: string | null;
  }): boolean {
    if (!task.profile) return false;
    const primary = this.isPrimaryHost(task.hostId);
    const read = this.hostCatalogs.get(
      primary ? PRIMARY_CATALOG : task.hostId!,
    );
    if (!read) return false;
    const vocabulary = primary
      ? (this.owner.primaryAdapter.vocabulary ??
        this.vocabularyFor(task.hostId ?? undefined))
      : this.vocabularyFor(task.hostId!);
    const provider = hostProviderFor(
      task.profile.provider,
      canonicalCatalog(vocabulary, read.catalog),
    );
    return !provider || !provider.available;
  }

  /**
   * The routing profiles a task's own host reports. A host with its own adapter
   * answers only from its own catalog snapshot: an unread or unreachable host
   * waits on its own catalog instead of selecting from another host's profiles,
   * so a task hosted on T3 never launches a profile only Paseo's catalog judges
   * (nucleus#1364). Only a host known to be the primary uses its profile set.
   */
  profilesFor(hostId?: string | null): Profile[] {
    if (this.isPrimaryHost(hostId)) return this.owner.profiles;
    return this.hostProfiles.get(hostId!) ?? [];
  }

  /**
   * Whether a host id is this engine's primary host: no id, the primary adapter,
   * or an id the primary was registered under. A removed host is not primary.
   */
  private isPrimaryHost(hostId?: string | null): boolean {
    if (!hostId) return true;
    if (hostId === this.primaryHostId) return true;
    const selected = this.owner.resolveHostAdapter(hostId);
    return selected !== undefined && selected === this.owner.primaryAdapter;
  }

  /**
   * Dispatch waits until the task's host's catalog is known, not only the primary's.
   * The primary host's catalog is the primary profile set; only a host with its own
   * adapter waits for its own snapshot, and an unknown host never borrows another
   * host's answer.
   */
  profileCatalogKnownFor(hostId?: string | null): boolean {
    if (this.isPrimaryHost(hostId)) return this.profileCatalogKnown();
    return this.hostCatalogRefreshed.has(hostId!);
  }
}
