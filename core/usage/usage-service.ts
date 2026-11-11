/**
 * The subscription usage service (Spec 059): maps the provider usage readers
 * onto Nucleus's existing subscription groups, paces their reads with backoff,
 * stores the samples with bounded retention, and answers `usage.state` with
 * the latest reading and the pressure projection. Read-only toward providers:
 * no credential handling, no model turns, no provider endpoint calls.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { doublingDelay } from "../../shared/backoff";
import type { PoolEntry } from "../../shared/schema/settings";
import {
  usageProviderSchema,
  usageReadingSchema,
  type UsageProvider,
  type UsageReading,
  type UsageStateOutput,
  type UsageSubscription,
} from "../../shared/schema/usage";
import { projectUsage } from "../../shared/usage-projection";
import type { Store } from "../store/store";
import { readClaudeUsage } from "./claude-reader";
import { readCodexUsage } from "./codex-reader";
import { readGrokUsage } from "./grok-reader";
import {
  unreadableReading,
  type ProviderUsageReader,
  type UsageSource,
} from "./readers";
import type { NucleusProfile } from "../../shared/profiles";

/** Steady read cadence per provider: Codex and Grok every few minutes, Claude following its cache. */
export const USAGE_READ_INTERVAL_MS: Record<UsageProvider, number> = {
  codex: 5 * 60_000,
  claude: 2 * 60_000,
  grok: 5 * 60_000,
};

/** Errors back off from this base, capped at an hour (Spec 059). */
export const USAGE_BACKOFF_BASE_MS = 60_000;
export const USAGE_BACKOFF_MAX_MS = 60 * 60_000;
/** Sample retention is bounded (Spec 059: for example 14 days). */
export const USAGE_SAMPLE_RETENTION_MS = 14 * 24 * 60 * 60_000;
/** How often the runtime checks which subscriptions are due for a read. */
export const USAGE_TICK_INTERVAL_MS = 60_000;

/** The subscription kind a stored provider key reads as, or null when no reader covers it. */
export function providerUsageKind(provider: string): UsageProvider | null {
  const key = provider.toLowerCase();
  if (key.includes("codex")) return "codex";
  if (key.includes("claude")) return "claude";
  if (key.includes("grok")) return "grok";
  return null;
}

/** Codex reads run against this subscription's CODEX_HOME (default under the home directory). */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  return configured || join(homedir(), ".codex");
}

/** Claude's config dir: CLAUDE_CONFIG_DIR when set, else the home directory. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured || homedir();
}

/** One subscription the service tracks: a group whose profiles name one readable provider. */
export interface UsageSubscriptionTarget {
  group: string;
  provider: UsageProvider;
  profileIds: string[];
  sourcePath: string | null;
}

interface StoredReadState {
  nextReadAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  failures: number;
  reading: UsageReading | null;
}

const readStateKey = (target: UsageSubscriptionTarget) =>
  JSON.stringify([target.group, target.provider]);
const META_PRUNED_AT = "usagePrunedAt";

export interface UsageServiceOptions {
  readers?: Partial<Record<UsageProvider, ProviderUsageReader>>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  sampleRetentionMs?: number;
  /** Cadence overrides per provider; tests and deployments may slow a provider down. */
  readIntervalMs?: Partial<Record<UsageProvider, number>>;
}

export class UsageService {
  private stopped = false;
  private reading = false;
  private readonly retentionMs: number;
  private readonly intervals: Record<UsageProvider, number>;
  private readonly now: () => Date;
  private readonly readers: Record<UsageProvider, ProviderUsageReader>;

  constructor(
    private readonly store: Store,
    private readonly options: UsageServiceOptions = {},
  ) {
    this.retentionMs = options.sampleRetentionMs ?? USAGE_SAMPLE_RETENTION_MS;
    this.intervals = { ...USAGE_READ_INTERVAL_MS, ...options.readIntervalMs };
    this.now = options.now ?? (() => new Date());
    const codex: ProviderUsageReader = {
      provider: "codex",
      read: (source) =>
        readCodexUsage(source, { env: options.env, now: this.now }),
    };
    const claude: ProviderUsageReader = {
      provider: "claude",
      read: (source) =>
        readClaudeUsage(source, { env: options.env, now: this.now }),
    };
    const grok: ProviderUsageReader = {
      provider: "grok",
      read: () => readGrokUsage({ env: options.env, now: this.now }),
    };
    this.readers = {
      codex: options.readers?.codex ?? codex,
      claude: options.readers?.claude ?? claude,
      grok: options.readers?.grok ?? grok,
    };
  }

  /** Halt further reads and sample writes; the runtime calls this before the store closes. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * The subscription groups with a readable provider, from the stored pool and
   * profiles. Two groups never merge, and a group naming two readable
   * providers tracks each as its own subscription.
   */
  targets(
    pool: readonly PoolEntry[] = this.store.pool(),
    profiles: readonly NucleusProfile[] = this.store.profiles(),
  ): UsageSubscriptionTarget[] {
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    const collected = new Map<string, UsageSubscriptionTarget>();
    for (const entry of pool) {
      const profile = byId.get(entry.profileId);
      const provider = profile ? providerUsageKind(profile.provider) : null;
      if (!provider) continue;
      const key = readStateKey({
        group: entry.group,
        provider,
        profileIds: [],
        sourcePath: null,
      });
      const existing = collected.get(key);
      if (existing) {
        if (!existing.profileIds.includes(entry.profileId))
          existing.profileIds.push(entry.profileId);
      } else {
        collected.set(key, {
          group: entry.group,
          provider,
          profileIds: [entry.profileId],
          sourcePath: this.sourcePath(provider),
        });
      }
    }
    return [...collected.values()].sort(
      (a, b) =>
        a.group.localeCompare(b.group) || a.provider.localeCompare(b.provider),
    );
  }

  /** The `usage.state` answer: every subscription's latest reading, projection and freshness. */
  state(
    pool?: readonly PoolEntry[],
    profiles?: readonly NucleusProfile[],
  ): UsageStateOutput {
    const now = this.now();
    const subscriptions: UsageSubscription[] = this.targets(pool, profiles).map(
      (target) => {
        const stored = this.readState(target);
        const reading = stored?.reading ?? notSampledReading();
        const projection = projectUsage({
          now: now.getTime(),
          windows: reading.windows,
        });
        return {
          group: target.group,
          provider: target.provider,
          profileIds: target.profileIds,
          sourcePath: target.sourcePath,
          reading,
          projection,
          nextReadAt: stored?.nextReadAt ?? null,
          lastAttemptAt: stored?.lastAttemptAt ?? null,
          lastError: stored?.lastError ?? null,
        };
      },
    );
    return { generatedAt: now.toISOString(), subscriptions };
  }

  /** Read every subscription that is due; `force` reads regardless of the schedule. */
  async refresh(options: { dueOnly?: boolean } = {}): Promise<void> {
    if (this.stopped || this.reading) return;
    this.reading = true;
    try {
      const now = this.now();
      for (const target of this.targets()) {
        if (this.stopped) return;
        const stored = this.readState(target);
        const due =
          !stored?.nextReadAt || Date.parse(stored.nextReadAt) <= now.getTime();
        if (options.dueOnly !== false && !due) continue;
        const reading = await this.readTarget(target);
        this.record(target, reading, this.now());
      }
    } finally {
      this.reading = false;
    }
  }

  /** The paced pass the runtime ticks: due reads, then the daily retention prune. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    await this.refresh({ dueOnly: true });
    this.pruneSamples();
  }

  /** One provider read, never throwing: a failure is an `unknown` reading with the reason. */
  private async readTarget(
    target: UsageSubscriptionTarget,
  ): Promise<UsageReading> {
    try {
      return await this.readers[target.provider].read({
        home: target.sourcePath ?? "",
      });
    } catch (error) {
      return unreadableReading(
        `${target.provider} usage read failed: ${(error as Error).message}`,
        "unknown",
        "none",
        this.now(),
      );
    }
  }

  private sourcePath(provider: UsageProvider): string | null {
    const env = this.options.env ?? process.env;
    if (provider === "codex") return codexHome(env);
    if (provider === "claude") return claudeConfigDir(env);
    return null;
  }

  private readState(target: UsageSubscriptionTarget): StoredReadState | null {
    try {
      const row = this.store.db
        .prepare("SELECT data FROM usage_read_state WHERE group_key=?")
        .get(readStateKey(target)) as { data: string } | undefined;
      return row ? parseReadState(row.data) : null;
    } catch {
      return null;
    }
  }

  /** Store the reading, its samples and the next due time; a lost write never fails a read. */
  private record(
    target: UsageSubscriptionTarget,
    reading: UsageReading,
    at: Date,
  ): void {
    if (this.stopped) return;
    const stored = this.readState(target);
    const failures = reading.status === "ok" ? 0 : (stored?.failures ?? 0) + 1;
    const waitMs =
      reading.status === "ok"
        ? this.intervals[target.provider]
        : doublingDelay(USAGE_BACKOFF_BASE_MS, USAGE_BACKOFF_MAX_MS, failures);
    const next: StoredReadState = {
      nextReadAt: new Date(at.getTime() + waitMs).toISOString(),
      lastAttemptAt: at.toISOString(),
      lastError: reading.status === "ok" ? null : reading.reason,
      failures,
      reading,
    };
    try {
      this.store.transaction(() => {
        this.store.db
          .prepare(
            "INSERT INTO usage_read_state(group_key,data) VALUES(?,?) ON CONFLICT(group_key) DO UPDATE SET data=excluded.data",
          )
          .run(readStateKey(target), JSON.stringify(next));
        if (reading.status === "ok") this.insertSamples(target, reading);
      });
    } catch {
      /* the store closed or refused; the next paced read rewrites both */
    }
  }

  /** One sample per window unless the latest stored row already carries exactly this reading. */
  private insertSamples(
    target: UsageSubscriptionTarget,
    reading: UsageReading,
  ): void {
    for (const window of reading.windows) {
      const latest = this.store.db
        .prepare(
          "SELECT used_fraction,resets_at,sampled_at FROM usage_samples WHERE group_id=? AND provider=? AND account_id IS ? AND window_id=? ORDER BY id DESC LIMIT 1",
        )
        .get(
          target.group,
          target.provider,
          reading.accountId,
          window.windowId,
        ) as
        | {
            used_fraction: number;
            resets_at: string | null;
            sampled_at: string;
          }
        | undefined;
      if (
        latest &&
        latest.sampled_at === reading.asOf &&
        latest.used_fraction === window.usedFraction &&
        latest.resets_at === window.resetsAt
      )
        continue;
      this.store.db
        .prepare(
          "INSERT INTO usage_samples(group_id,provider,account_id,window_id,used_fraction,window_seconds,window_starts_at,resets_at,sampled_at,source) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          target.group,
          target.provider,
          reading.accountId,
          window.windowId,
          window.usedFraction,
          window.windowSeconds,
          window.windowStartsAt,
          window.resetsAt,
          reading.asOf,
          reading.source,
        );
    }
  }

  /** Drop samples past the retention window, at most once a day. */
  private pruneSamples(): void {
    if (this.stopped) return;
    try {
      const last = this.store.getMeta<number>(META_PRUNED_AT);
      const nowMs = this.now().getTime();
      if (typeof last === "number" && nowMs - last < 24 * 60 * 60_000) return;
      this.store.db
        .prepare("DELETE FROM usage_samples WHERE sampled_at < ?")
        .run(new Date(nowMs - this.retentionMs).toISOString());
      this.store.setMeta(META_PRUNED_AT, nowMs);
    } catch {
      /* retried the next tick */
    }
  }
}

/** The reading a subscription reports before its first paced read. */
function notSampledReading(): UsageReading {
  return usageReadingSchema.parse({
    status: "unknown",
    reason: "not sampled yet",
    asOf: "1970-01-01T00:00:00.000Z",
    source: "none",
    accountId: null,
    windows: [],
  });
}

function parseReadState(data: string): StoredReadState | null {
  try {
    const parsed = JSON.parse(data) as Partial<StoredReadState>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      nextReadAt:
        typeof parsed.nextReadAt === "string" ? parsed.nextReadAt : null,
      lastAttemptAt:
        typeof parsed.lastAttemptAt === "string" ? parsed.lastAttemptAt : null,
      lastError:
        typeof parsed.lastError === "string"
          ? parsed.lastError.slice(0, 500)
          : null,
      failures:
        typeof parsed.failures === "number" && Number.isFinite(parsed.failures)
          ? parsed.failures
          : 0,
      reading: parsed.reading ? usageReadingSchema.parse(parsed.reading) : null,
    };
  } catch {
    return null;
  }
}
