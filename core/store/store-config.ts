import { z } from "zod";
import type { PoolEntry, Profile } from "../../shared/contracts";
import type { AssignmentRole } from "../../shared/schema/state";
import {
  availabilitySchema,
  poolRecordFromLegacy,
  poolSchema,
  usageSettingSchema,
  type RoutingPolicy,
  type Task,
  type UsageLevel,
  type UsageSetting,
  type UsageView,
} from "../../shared/contracts";
import {
  nucleusProfileSchema,
  profileImportRecordSchema,
  type NucleusProfile,
  type ProfileImportRecord,
} from "../../shared/profiles";
import { taskRoutingPolicy } from "../dispatch/routing";
import { now, StoreCore } from "./store-core";
import {
  ASSIGNMENT_HISTORY_KEEP,
  ASSIGNMENT_ROLE_HISTORY_KEEP,
} from "./store-retention";

/** Nucleus's own profile list and the one-time import record (Spec 052). */
const PROFILES_META_KEY = "profiles";

const PROFILE_IMPORT_META_KEY = "profileImport";

interface Ports {
  availability: () => Array<z.infer<typeof availabilitySchema>>;
}
/** The lifetime row a role's charge to a profile increments: its rotation counts a role apart from the others. */
const roleLifetimeKey = (role: AssignmentRole, profileId: string) =>
  `role:${role}:profile:${profileId}`;

export class StoreConfig {
  constructor(
    private readonly core: StoreCore,
    private readonly ports: Ports,
  ) {}
  private get db() {
    return this.core.db;
  }
  private getMeta<T>(key: string): T | undefined {
    return this.core.getMeta<T>(key);
  }
  private setMeta(key: string, value: unknown) {
    return this.core.setMeta(key, value);
  }
  private advanceRevision() {
    return this.core.advanceRevision();
  }
  private availability = (...args: Parameters<Ports["availability"]>) =>
    this.ports.availability(...args);

  pool(): PoolEntry[] {
    return (this.getMeta<unknown[]>("pool") ?? []).map((p) =>
      poolSchema.parse(poolRecordFromLegacy(p)),
    );
  }

  /**
   * Nucleus-owned profile records (Tom, 2026-11-07). The host's own profile list
   * was copied once into these records. Selection uses this stored list and
   * availability from the host catalog (Spec 052).
   */
  profiles(): NucleusProfile[] {
    return (this.getMeta<unknown[]>(PROFILES_META_KEY) ?? []).map((profile) =>
      nucleusProfileSchema.parse(profile),
    );
  }

  setProfiles(profiles: readonly NucleusProfile[]) {
    this.setMeta(
      PROFILES_META_KEY,
      nucleusProfileSchema.array().parse(profiles),
    );
  }

  /** The durable record that the one-time host-profile import ran. */
  profileImportRecord(): ProfileImportRecord | null {
    const parsed = profileImportRecordSchema.safeParse(
      this.getMeta<unknown>(PROFILE_IMPORT_META_KEY),
    );
    return parsed.success ? parsed.data : null;
  }

  recordProfileImport(record: ProfileImportRecord) {
    this.setMeta(
      PROFILE_IMPORT_META_KEY,
      profileImportRecordSchema.parse(record),
    );
  }

  /** Lifetime charges per group and per profile. Role-keyed rotation rows (`roleLifetimeKey`) stay out of this read. */
  counts(): Record<string, number> {
    return Object.fromEntries(
      this.db
        .prepare(
          "SELECT * FROM assignments WHERE substr(group_id,1,5)<>'role:'",
        )
        .all()
        .map((r) => [String(r.group_id), Number(r.count)]),
    );
  }

  /**
   * The counts one role's selection rotates on (Spec 053, nucleus#1558). Group pacing reads
   * every role as before. A profile's rotation reads its own role only: that role's recent
   * window (`recentRoleUsage`) and its lifetime charges, so a reviewer run never weighs
   * against a worker turn.
   */
  rotationCounts(role: AssignmentRole): {
    counts: Record<string, number>;
    recent: Record<string, number>;
  } {
    const groupsOnly = (record: Record<string, number>) =>
      Object.fromEntries(
        Object.entries(record).filter(([key]) => !key.startsWith("profile:")),
      );
    const prefix = roleLifetimeKey(role, "");
    const lifetime: Record<string, number> = {};
    for (const row of this.db
      .prepare(
        "SELECT group_id,count FROM assignments WHERE substr(group_id,1,5)='role:'",
      )
      .all()) {
      const key = String(row.group_id);
      if (key.startsWith(prefix))
        lifetime[`profile:${key.slice(prefix.length)}`] = Number(row.count);
    }
    return {
      counts: { ...groupsOnly(this.counts()), ...lifetime },
      recent: {
        ...groupsOnly(this.recentCounts()),
        ...this.recentRoleUsage(role).counts,
      },
    };
  }

  recentCounts(limit = 50): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of this.db
      .prepare(
        "SELECT group_id,profile_id FROM assignment_history ORDER BY id DESC LIMIT ?",
      )
      .all(limit)) {
      const group = String(row.group_id),
        profile = `profile:${String(row.profile_id)}`;
      counts[group] = (counts[group] ?? 0) + 1;
      counts[profile] = (counts[profile] ?? 0) + 1;
    }
    return counts;
  }

  /** The size of the All window `recentCounts` reads: its real sample, below `limit` while history is short (nucleus#1502). */
  recentSample(limit = ASSIGNMENT_HISTORY_KEEP): number {
    return Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM (SELECT id FROM assignment_history ORDER BY id DESC LIMIT ?)",
        )
        .get(limit)?.n ?? 0,
    );
  }

  /**
   * One role's rolling window for the Profiles usage view (nucleus#1502): its own most
   * recent charged assignments, per profile (`profile:<id>` keys), and the window's size.
   * Only charges recorded with this role count; untagged history never reaches a role.
   */
  recentRoleUsage(
    role: AssignmentRole,
    limit = ASSIGNMENT_ROLE_HISTORY_KEEP,
  ): { counts: Record<string, number>; sample: number } {
    const counts: Record<string, number> = {};
    let sample = 0;
    for (const row of this.db
      .prepare(
        "SELECT profile_id FROM assignment_role_history WHERE role=? ORDER BY id DESC LIMIT ?",
      )
      .all(role, limit)) {
      const profile = `profile:${String(row.profile_id)}`;
      counts[profile] = (counts[profile] ?? 0) + 1;
      sample += 1;
    }
    return { counts, sample };
  }

  /**
   * Record one charge. `role` is the routing purpose at the call site; a charge with no
   * role (a distinct internal purpose) still counts in the group, profile and All windows.
   */
  chargeAssignment(group: string, profileId: string, role?: AssignmentRole) {
    const charge = (key: string) =>
      this.db
        .prepare(
          "INSERT INTO assignments VALUES(?,1) ON CONFLICT(group_id) DO UPDATE SET count=count+1",
        )
        .run(key);
    charge(group);
    charge(`profile:${profileId}`);
    if (role) charge(roleLifetimeKey(role, profileId));
    this.db
      .prepare(
        "INSERT INTO assignment_history(group_id,profile_id,at) VALUES(?,?,?)",
      )
      .run(group, profileId, now());
    this.db
      .prepare(
        "DELETE FROM assignment_history WHERE id NOT IN (SELECT id FROM assignment_history ORDER BY id DESC LIMIT ?)",
      )
      .run(ASSIGNMENT_HISTORY_KEEP);
    if (role) {
      this.db
        .prepare(
          "INSERT INTO assignment_role_history(role,profile_id,at) VALUES(?,?,?)",
        )
        .run(role, profileId, now());
      this.db
        .prepare(
          "DELETE FROM assignment_role_history WHERE role=? AND id NOT IN (SELECT id FROM assignment_role_history WHERE role=? ORDER BY id DESC LIMIT ?)",
        )
        .run(role, role, ASSIGNMENT_ROLE_HISTORY_KEEP);
    }
  }

  nextIntegrationSequence(repoPath: string) {
    const key = `integrationTurnSeq:${repoPath}`;
    const next = (this.getMeta<number>(key) ?? 0) + 1;
    this.setMeta(key, next);
    return next;
  }

  /**
   * Spec 052 diagnostics: the usage policy for the profiles this task's routing
   * names, from fresh usage. A caller that knows the task's host passes that
   * host's routing profiles, so an ineligible-on-that-host profile carries its
   * reason (nucleus#1143).
   */
  routingPolicy(
    task: Task,
    at = Date.now(),
    profiles: readonly Profile[] = [],
  ): RoutingPolicy {
    return taskRoutingPolicy(
      task,
      this.pool(),
      this.usageView(at),
      this.availability(),
      at,
      profiles,
      this.rotationCounts("worker"),
    );
  }

  /** Spec 052: the stored usage setting, if the operator set one. */
  usageSetting(): UsageSetting | null {
    const parsed = usageSettingSchema.safeParse(
      this.getMeta<unknown>("usageLevel"),
    );
    return parsed.success ? parsed.data : null;
  }

  /** The usage level in force: the stored level until its `until` passes, else `normal`. */
  usageLevel(at = Date.now()): UsageLevel {
    const setting = this.usageSetting();
    return setting && (!setting.until || Date.parse(setting.until) > at)
      ? setting.level
      : "normal";
  }

  usageView(at = Date.now()): UsageView {
    const setting = this.usageSetting(),
      level = this.usageLevel(at);
    return {
      level,
      setLevel: setting?.level ?? "normal",
      until: setting?.until ?? null,
      expired: Boolean(setting && setting.level !== level),
    };
  }
}
