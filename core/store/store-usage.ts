import { StoreCore } from "./store-core";
import type { UsageProvider } from "../../shared/schema/usage";

export interface UsageSample {
  group: string;
  provider: UsageProvider;
  accountId: string | null;
  windowId: string;
  usedFraction: number;
  windowSeconds: number | null;
  windowStartsAt: string | null;
  resetsAt: string | null;
  sampledAt: string;
  source: string;
}

/** Persistence owner for provider usage state and its bounded sample history. */
export class StoreUsage {
  constructor(private readonly core: StoreCore) {}

  readState(key: string): string | null {
    const row = this.core.db
      .prepare("SELECT data FROM usage_read_state WHERE group_key=?")
      .get(key) as { data: string } | undefined;
    return row?.data ?? null;
  }

  recordRead(key: string, data: string, samples: readonly UsageSample[]): void {
    this.core.transaction(() => {
      this.core.db
        .prepare("INSERT INTO usage_read_state(group_key,data) VALUES(?,?) ON CONFLICT(group_key) DO UPDATE SET data=excluded.data")
        .run(key, data);
      for (const sample of samples) this.insertSampleUnlessDuplicate(sample);
    });
  }

  pruneSamples(before: string): void {
    this.core.db.prepare("DELETE FROM usage_samples WHERE sampled_at < ?").run(before);
  }

  private insertSampleUnlessDuplicate(sample: UsageSample): void {
    const latest = this.core.db
      .prepare("SELECT used_fraction,resets_at,sampled_at FROM usage_samples WHERE group_id=? AND provider=? AND account_id IS ? AND window_id=? ORDER BY id DESC LIMIT 1")
      .get(sample.group, sample.provider, sample.accountId, sample.windowId) as
        | { used_fraction: number; resets_at: string | null; sampled_at: string }
        | undefined;
    if (
      latest && latest.sampled_at === sample.sampledAt &&
      latest.used_fraction === sample.usedFraction && latest.resets_at === sample.resetsAt
    ) return;
    this.core.db
      .prepare("INSERT INTO usage_samples(group_id,provider,account_id,window_id,used_fraction,window_seconds,window_starts_at,resets_at,sampled_at,source) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        sample.group, sample.provider, sample.accountId, sample.windowId,
        sample.usedFraction, sample.windowSeconds, sample.windowStartsAt,
        sample.resetsAt, sample.sampledAt, sample.source,
      );
  }
}
