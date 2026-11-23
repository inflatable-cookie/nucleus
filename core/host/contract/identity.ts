import type { HostCatalog, HostCatalogOptions } from '../../../shared/host';
import type { Profile, Run } from '../../../shared/contracts';
import type { NucleusProfile } from '../../../shared/profiles';
import type { HostVocabulary } from '../../../shared/profile-vocabulary';
import type { OriginAgent } from '../../../shared/host';

export type { OriginAgent };

/** What a host is and how Nucleus reads and reports through it: its capabilities, host and profile catalogs, report route and load. */
export interface HostAdapterIdentity {
  readonly hostId?: string;
  /** Explicit host capabilities when the native adapter has more than the legacy flags. */
  capabilities?(): import('../../../shared/host').HostCapabilities;
  /** Host-specific workspace registration identity validation. */
  workspaceIdAccepted?(id: unknown): boolean;
  originAgent?(id:string):Promise<OriginAgent|null>;
  /**
   * `originAgent` answered from what the host already holds, with no host call
   * (T3's live shell inside its freshness bounds), so admission serves it without
   * a slot. `undefined` means "not held": admission runs the exact read. It never
   * answers absent.
   */
  originAgentHeld?(id:string):Promise<OriginAgent|undefined>;
  /**
   * The gap admission keeps between the starts of this host's calls. A host that
   * multiplexes calls over one connection declares 0; absent keeps the default
   * (125 ms), which Paseo and BB use.
   */
  readonly admissionStartIntervalMs?: number;
  supportsCoordinatorRecovery?: boolean;
  reportingFallback?(run:Run):string;
  reportingViaMcp?: boolean;
  /** Absolute path of the packaged nucleus helper; named in helper-route prompts. */
  helperPath?: string;
  /** Unix-socket path the helper ticket names; required to re-issue a T3 consult ticket. */
  socketPath?: string;
  profiles?(): Promise<Profile[]>;
  /** The host catalog: the first method of the `Host` interface in `shared/host.ts`. */
  catalog?(options?: HostCatalogOptions): Promise<HostCatalog>;
  /** The host's profile vocabulary table (`shared/profile-vocabulary.ts`); absent on test doubles, which speak canonical values. */
  readonly vocabulary?: HostVocabulary;
  /**
   * The host's own profile list, read once into Nucleus's store (Spec 052). A
   * host with its own profile system answers with it; a host without one has no
   * method, so nothing is imported from it.
   */
  hostProfiles?(): Promise<NucleusProfile[]>;
  /** One-minute load average and logical CPU count; creation defers while load exceeds CPUs. */
  hostLoad?(): { load: number; cpus: number };
}
