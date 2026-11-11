import { z } from "zod";
import type { PoolEntry } from "../../shared/contracts";
import { availabilitySchema,demandRoleOffsetsSchema,poolSchema,routingGrantSchema,usageSettingSchema,type DemandRoleOffsets,type RoutingGrant,type RoutingPolicy,type Task,type UsageLevel,type UsageSetting,type UsageView } from "../../shared/contracts";
import { DEMAND_ROLE_OFFSETS } from "../../shared/demand";
import { nucleusProfileSchema,profileImportRecordSchema,providerMapSchema,type NucleusProfile,type ProfileImportRecord,type ProviderMap } from "../../shared/profiles";
import { taskRoutingPolicy } from "../dispatch/routing";
import { now,StoreCore } from "./store-core";
import { ASSIGNMENT_HISTORY_KEEP } from "./store-maintenance";

/** Nucleus's own profile list, its provider map and the one-time import record (Spec 052). */
const PROFILES_META_KEY = "profiles";

const PROFILE_IMPORT_META_KEY = "profileImport";

const PROVIDER_MAP_META_KEY = "providerMap";
interface Ports {
  availability: () => Array<z.infer<typeof availabilitySchema>>;
}
export class StoreConfig {
  constructor(private readonly core: StoreCore, private readonly ports: Ports) {}
  private get db() { return this.core.db; }
  private getMeta<T>(key: string): T | undefined { return this.core.getMeta<T>(key); }
  private setMeta(key: string, value: unknown) { return this.core.setMeta(key, value); }
  private advanceRevision() { return this.core.advanceRevision(); }
  private availability = (...args: Parameters<Ports["availability"]>) => this.ports.availability(...args);

  pool(): PoolEntry[] { return (this.getMeta<unknown[]>("pool") ?? []).map(p => poolSchema.parse(p)); }

  /**
   * Nucleus-owned profile records (Tom, 2026-11-07). The host's own profile list
   * was copied once into these records. Selection uses this stored list and
   * availability from the host catalog (Spec 052).
   */
  profiles(): NucleusProfile[] { return (this.getMeta<unknown[]>(PROFILES_META_KEY) ?? []).map(profile => nucleusProfileSchema.parse(profile)); }

  setProfiles(profiles: readonly NucleusProfile[]) { this.setMeta(PROFILES_META_KEY, nucleusProfileSchema.array().parse(profiles)); }

  /** The durable record that the one-time host-profile import ran. */
  profileImportRecord(): ProfileImportRecord | null {
    const parsed = profileImportRecordSchema.safeParse(this.getMeta<unknown>(PROFILE_IMPORT_META_KEY));
    return parsed.success ? parsed.data : null;
  }

  recordProfileImport(record: ProfileImportRecord) { this.setMeta(PROFILE_IMPORT_META_KEY, profileImportRecordSchema.parse(record)); }

  /** Each host's provider key to the normalised key a profile names; identity when absent. */
  providerMap(): ProviderMap {
    const parsed = providerMapSchema.safeParse(this.getMeta<unknown>(PROVIDER_MAP_META_KEY) ?? {});
    return parsed.success ? parsed.data : {};
  }

  setProviderMap(providerMap: ProviderMap) { this.setMeta(PROVIDER_MAP_META_KEY, providerMapSchema.parse(providerMap)); }

  counts(): Record<string, number> { return Object.fromEntries(this.db.prepare("SELECT * FROM assignments").all().map(r => [String(r.group_id), Number(r.count)])); }

  recentCounts(limit=50):Record<string,number>{
    const counts:Record<string,number>={};
    for(const row of this.db.prepare("SELECT group_id,profile_id FROM assignment_history ORDER BY id DESC LIMIT ?").all(limit)){
      const group=String(row.group_id),profile=`profile:${String(row.profile_id)}`;counts[group]=(counts[group]??0)+1;counts[profile]=(counts[profile]??0)+1;
    }
    return counts;
  }

  chargeAssignment(group:string,profileId:string){
    const charge=(key:string)=>this.db.prepare("INSERT INTO assignments VALUES(?,1) ON CONFLICT(group_id) DO UPDATE SET count=count+1").run(key);
    charge(group);charge(`profile:${profileId}`);
    this.db.prepare("INSERT INTO assignment_history(group_id,profile_id,at) VALUES(?,?,?)").run(group,profileId,now());
    this.db.prepare("DELETE FROM assignment_history WHERE id NOT IN (SELECT id FROM assignment_history ORDER BY id DESC LIMIT ?)").run(ASSIGNMENT_HISTORY_KEEP);
  }

  nextIntegrationSequence(repoPath: string) {
    const key = `integrationTurnSeq:${repoPath}`;
    const next = (this.getMeta<number>(key) ?? 0) + 1;
    this.setMeta(key, next);
    return next;
  }

  /** Spec 052 diagnostics: the usage policy for the profiles this task's routing names, from fresh usage. */
  routingPolicy(task: Task, at = Date.now()): RoutingPolicy {
    return taskRoutingPolicy(task, this.pool(), this.usageView(at), this.availability(), at);
  }

  /** Spec 053: the host-wide role offsets, defaulting to worker 0, reviewer 0, coordinator −2. */
  demandRoleOffsets(): DemandRoleOffsets {
    const parsed = demandRoleOffsetsSchema.safeParse(this.getMeta<unknown>("demandRoleOffsets"));
    return parsed.success ? parsed.data : { ...DEMAND_ROLE_OFFSETS };
  }

  /** Spec 052: the stored usage setting, if the operator set one. */
  usageSetting(): UsageSetting | null {
    const parsed = usageSettingSchema.safeParse(this.getMeta<unknown>("usageLevel"));
    return parsed.success ? parsed.data : null;
  }

  /** The usage level in force: the stored level until its `until` passes, else `normal`. */
  usageLevel(at = Date.now()): UsageLevel {
    const setting = this.usageSetting();
    return setting && (!setting.until || Date.parse(setting.until) > at) ? setting.level : "normal";
  }

  usageView(at = Date.now()): UsageView {
    const setting = this.usageSetting(), level = this.usageLevel(at);
    return { level, setLevel: setting?.level ?? "normal", until: setting?.until ?? null, expired: Boolean(setting && setting.level !== level) };
  }

  /** Spec 052 planner grants stored in meta, like usage. */
  routingGrants(): RoutingGrant[] {
    const parsed = routingGrantSchema.array().safeParse(this.getMeta<unknown>("routingGrants") ?? []);
    return parsed.success ? parsed.data : [];
  }

  noteGrantRun(task: Task, role: "worker" | "reviewer" | "coordinator"): void {
    const grantId = task.profileRequests?.[role]?.signoff?.grantId;
    if (!grantId) return;
    const at = Date.now();
    let changed = false;
    const next = this.routingGrants().map(grant => {
      if (grant.id !== grantId || grant.status !== "active" || (grant.until && Date.parse(grant.until) <= at)) return grant;
      changed = true;
      return { ...grant, runCount: grant.runCount + 1 };
    });
    if (!changed) return;
    this.setMeta("routingGrants", next);
    this.advanceRevision();
  }
}
