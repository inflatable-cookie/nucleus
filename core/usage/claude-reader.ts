/**
 * The Claude usage reader (Spec 059): `cachedUsageUtilization` from the
 * subscription's Claude config (`CLAUDE_CONFIG_DIR/.claude.json`, else the
 * home's `.claude.json`), read only and never written, with `fetchedAtMs` as
 * the sample time. Claude Code owns the file and the credentials; polling its
 * endpoint directly is exactly what this reader avoids.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  usageReadingSchema,
  type UsageReading,
  type UsageWindow,
} from "../../shared/schema/usage";
import {
  fractionFromPercent,
  instantFrom,
  unreadableReading,
  type UsageSource,
} from "./readers";

export interface ClaudeReaderOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

interface CachedUtilizationWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

const CLAUDE_WINDOWS: ReadonlyArray<{
  id: string;
  name: string;
  seconds: number;
}> = [
  { id: "five_hour", name: "5-hour", seconds: 5 * 60 * 60 },
  { id: "seven_day", name: "Weekly", seconds: 7 * 24 * 60 * 60 },
];

/** One named utilization window, or null when this cache read says nothing usable. */
function claudeWindow(
  entry: { id: string; name: string; seconds: number },
  raw: unknown,
): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const window = raw as CachedUtilizationWindow;
  const usedFraction = fractionFromPercent(window.utilization);
  if (usedFraction === null) return null;
  return {
    windowId: entry.id,
    name: entry.name,
    usedFraction,
    windowSeconds: entry.seconds,
    windowStartsAt: null,
    resetsAt: instantFrom(window.resets_at),
  };
}

export async function readClaudeUsage(
  source: UsageSource,
  options: ClaudeReaderOptions = {},
): Promise<UsageReading> {
  const now = (options.now ?? (() => new Date()))();
  const configPath = join(source.home, ".claude.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    return unreadableReading(
      `Claude config ${configPath} is unreadable: ${(error as Error).message}`,
      "not_available",
      "none",
      now,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    return unreadableReading(
      `Claude config ${configPath} is not an object`,
      "unknown",
      "claude-config",
      now,
    );
  }
  const cached = (parsed as { cachedUsageUtilization?: unknown })
    .cachedUsageUtilization;
  if (!cached || typeof cached !== "object") {
    return unreadableReading(
      "no cachedUsageUtilization in the Claude config; Claude Code has not reported usage here",
      "unknown",
      "claude-config",
      now,
    );
  }
  const cache = cached as {
    fetchedAtMs?: unknown;
    accountUuid?: unknown;
    utilization?: unknown;
  };
  const fetchedAtMs =
    typeof cache.fetchedAtMs === "number" && Number.isFinite(cache.fetchedAtMs)
      ? cache.fetchedAtMs
      : null;
  if (fetchedAtMs === null) {
    return unreadableReading(
      "cached usage carries no fetchedAtMs sample time",
      "unknown",
      "claude-config",
      now,
    );
  }
  const utilization =
    cache.utilization && typeof cache.utilization === "object"
      ? (cache.utilization as Record<string, unknown>)
      : {};
  const windows = CLAUDE_WINDOWS.map((entry) =>
    claudeWindow(entry, utilization[entry.id]),
  ).filter((window): window is UsageWindow => window !== null);
  if (!windows.length) {
    return unreadableReading(
      "cached usage reports no usable window",
      "unknown",
      "claude-config",
      now,
    );
  }
  return usageReadingSchema.parse({
    status: "ok",
    reason: null,
    asOf: new Date(fetchedAtMs).toISOString(),
    source: "claude-config",
    accountId:
      typeof cache.accountUuid === "string" && cache.accountUuid
        ? cache.accountUuid.slice(0, 240)
        : null,
    windows,
  });
}
