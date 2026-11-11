/**
 * Provider usage readers (Spec 059): one per provider, none handles
 * credentials and none starts a model turn. Every reader returns a reading —
 * an unreadable or unexpected shape is an `unknown` reading with the reason,
 * never a zero. The store keeps the samples; the projection is pure.
 */
import {
  usageReadingSchema,
  type UsageProvider,
  type UsageReading,
  type UsageWindow,
} from "../../shared/schema/usage";
import {
  projectUsage,
  type UsageProjectionInput,
  type UsageProjectionWindow,
} from "../../shared/usage-projection";

export type { UsageProvider, UsageProjectionWindow };
export type { UsageProjectionInput };

export interface UsageSource {
  /** Codex: the subscription's CODEX_HOME. Claude: the config dir (home by default). Grok: unused. */
  home: string;
}

export interface ProviderUsageReader {
  provider: UsageProvider;
  read(source: UsageSource): Promise<UsageReading>;
}

/** Build an `unknown` (or `not_available`) reading from a failure reason. */
export function unreadableReading(
  reason: string,
  status: "unknown" | "not_available",
  source: string,
  now: Date,
): UsageReading {
  return usageReadingSchema.parse({
    status,
    reason: reason.slice(0, 500),
    asOf: now.toISOString(),
    source,
    accountId: null,
    windows: [],
  });
}

/**
 * Clamp a provider's percent (0..100, possibly fractional) into a 0..1
 * fraction; non-finite values are absent, not zero.
 */
export function fractionFromPercent(percent: unknown): number | null {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return Math.min(1, Math.max(0, percent / 100));
}

/** Accept either an ISO string or a unix-seconds/ms number as an instant. */
export function instantFrom(value: unknown): string | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  return null;
}

export { buildWindows as normalizeWindows };

/** Keep only windows whose fraction parsed; ids and names stay as produced. */
function buildWindows(windows: (UsageWindow | null)[]): UsageWindow[] {
  return windows.filter((window): window is UsageWindow => window !== null);
}
