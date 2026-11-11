/**
 * The Codex usage reader (Spec 059): `codex app-server` JSON-RPC
 * `account/rateLimits/read` with `excludeResetCreditDetails` for background
 * reads, run against the subscription's `CODEX_HOME`; the fallback tails the
 * latest `token_count` `rate_limits` in that home's rollout files, marked as
 * of the event. The app-server owns the credentials; Nucleus never reads them.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
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

/** A `codex app-server` read is bounded: initialize, one read, then the child goes. */
const APP_SERVER_TIMEOUT_MS = 12_000;
const ROLLOUT_MAX_FILES = 10;
const ROLLOUT_TAIL_BYTES = 256 * 1024;

export interface CodexReaderOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => Date;
}

interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { message?: string };
}

interface RateLimitWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface RateLimitSnapshot {
  limitId?: unknown;
  limitName?: unknown;
  primary?: unknown;
  secondary?: unknown;
}

/** One window from the app-server's camelCase shape, or null when the shape says nothing usable. */
function appServerWindow(
  which: "primary" | "secondary",
  raw: unknown,
  label: string,
): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const window = raw as RateLimitWindow;
  const usedFraction = fractionFromPercent(window.usedPercent);
  if (usedFraction === null) return null;
  const minutes =
    typeof window.windowDurationMins === "number" &&
    Number.isFinite(window.windowDurationMins) &&
    window.windowDurationMins > 0
      ? window.windowDurationMins
      : null;
  return {
    windowId: `${label}:${which}`,
    name: `${label} ${which}`,
    usedFraction,
    windowSeconds: minutes === null ? null : Math.round(minutes * 60),
    windowStartsAt: null,
    resetsAt:
      typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
        ? new Date(window.resetsAt * 1000).toISOString()
        : null,
  };
}

/** Turn one app-server snapshot (single-bucket or by-limit) into windows. */
function snapshotWindows(snapshot: RateLimitSnapshot): UsageWindow[] {
  const label =
    typeof snapshot.limitName === "string" && snapshot.limitName.trim()
      ? snapshot.limitName.trim().slice(0, 60)
      : typeof snapshot.limitId === "string" && snapshot.limitId.trim()
        ? snapshot.limitId.trim().slice(0, 60)
        : "usage";
  return [
    appServerWindow("primary", snapshot.primary, label),
    appServerWindow("secondary", snapshot.secondary, label),
  ].filter((window): window is UsageWindow => window !== null);
}

/** Read one Codex home's latest rollout `token_count` `rate_limits`, or null when none is found. */
export function readCodexRollout(
  home: string,
  options: CodexReaderOptions = {},
): UsageReading | null {
  const now = (options.now ?? (() => new Date()))();
  const sessionsDir = join(home, "sessions");
  let files: string[] = [];
  try {
    const walk = (dir: string, depth: number): void => {
      if (depth > 6 || files.length > 500) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path, depth + 1);
        else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name))
          files.push(path);
      }
    };
    walk(sessionsDir, 0);
  } catch {
    return null;
  }
  const newest = files
    .map((path) => {
      try {
        return { path, mtime: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { path: string; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, ROLLOUT_MAX_FILES);
  for (const file of newest) {
    const found = rolloutReadingFromFile(file.path, now);
    if (found) return found;
  }
  return null;
}

/** The last `rate_limits` event in one rollout file, reading the file tail only. */
function rolloutReadingFromFile(path: string, now: Date): UsageReading | null {
  let bytes: Buffer;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - ROLLOUT_TAIL_BYTES);
    const length = size - start;
    const handle = openSync(path, "r");
    try {
      bytes = Buffer.alloc(length);
      const read = readSync(handle, bytes, 0, length, start);
      bytes = bytes.subarray(0, read);
    } finally {
      closeSync(handle);
    }
  } catch {
    return null;
  }
  const lines = bytes.toString("utf8").split("\n").reverse();
  for (const line of lines) {
    if (!line.includes("rate_limits")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const event = parsed as { timestamp?: unknown; payload?: unknown };
    const payload = event.payload as
      | { type?: unknown; rate_limits?: unknown }
      | undefined;
    if (
      payload?.type !== "token_count" ||
      !payload.rate_limits ||
      typeof payload.rate_limits !== "object"
    )
      continue;
    const limits = payload.rate_limits as {
      limit_id?: unknown;
      limit_name?: unknown;
      primary?: unknown;
      secondary?: unknown;
    };
    const label =
      typeof limits.limit_name === "string" && limits.limit_name.trim()
        ? limits.limit_name.trim().slice(0, 60)
        : typeof limits.limit_id === "string" && limits.limit_id.trim()
          ? limits.limit_id.trim().slice(0, 60)
          : "usage";
    const windows = [
      rolloutWindow("primary", limits.primary, label),
      rolloutWindow("secondary", limits.secondary, label),
    ].filter((window): window is UsageWindow => window !== null);
    if (!windows.length) continue;
    const asOf =
      typeof event.timestamp === "string" &&
      Number.isFinite(Date.parse(event.timestamp))
        ? new Date(Date.parse(event.timestamp)).toISOString()
        : now.toISOString();
    return usageReadingSchema.parse({
      status: "ok",
      reason: null,
      asOf,
      source: "rollout",
      accountId: null,
      windows,
    });
  }
  return null;
}

/** One window from the rollout's snake_case shape, or null when unusable. */
function rolloutWindow(
  which: "primary" | "secondary",
  raw: unknown,
  label: string,
): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const window = raw as {
    used_percent?: unknown;
    window_minutes?: unknown;
    resets_at?: unknown;
  };
  const usedFraction = fractionFromPercent(window.used_percent);
  if (usedFraction === null) return null;
  const minutes =
    typeof window.window_minutes === "number" &&
    Number.isFinite(window.window_minutes) &&
    window.window_minutes > 0
      ? window.window_minutes
      : null;
  return {
    windowId: `${label}:${which}`,
    name: `${label} ${which}`,
    usedFraction,
    windowSeconds: minutes === null ? null : Math.round(minutes * 60),
    windowStartsAt: null,
    resetsAt: instantFrom(window.resets_at),
  };
}

/**
 * One `account/rateLimits/read` against this home's app-server. Any failure
 * (spawn, timeout, error reply, unexpected shape) falls through to the
 * rollout; a read that found neither is an `unknown` reading with the reason.
 */
export async function readCodexUsage(
  source: UsageSource,
  options: CodexReaderOptions = {},
): Promise<UsageReading> {
  const now = (options.now ?? (() => new Date()))();
  const env = { ...(options.env ?? process.env), CODEX_HOME: source.home };
  const appServer = await appServerReading(
    source.home,
    env,
    options,
    now,
  ).catch(() => null);
  if (appServer) return appServer;
  const rollout = readCodexRollout(source.home, options);
  if (rollout) return rollout;
  return unreadableReading(
    "codex app-server read failed and no rollout event carries rate limits",
    "unknown",
    "none",
    now,
  );
}

/** The JSON-RPC exchange; resolves null on any failure and never throws. */
async function appServerReading(
  home: string,
  env: NodeJS.ProcessEnv,
  options: CodexReaderOptions,
  now: Date,
): Promise<UsageReading | null> {
  const timeoutMs = options.timeoutMs ?? APP_SERVER_TIMEOUT_MS;
  return await new Promise<UsageReading | null>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        options.command ?? "codex",
        options.args ?? ["-s", "read-only", "-a", "never", "app-server"],
        { env, stdio: ["pipe", "pipe", "ignore"] },
      );
    } catch {
      resolve(null);
      return;
    }
    let buffer = "";
    const pending = new Map<number, (message: JsonRpcMessage) => void>();
    let nextId = 1;
    const finish = (reading: UsageReading | null) => {
      pending.clear();
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(reading);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const id = typeof message.id === "number" ? message.id : null;
        if (id === null) continue;
        const settle = pending.get(id);
        if (settle) {
          pending.delete(id);
          settle(message);
        }
      }
    });
    const request = (
      method: string,
      params: unknown,
    ): Promise<JsonRpcMessage> =>
      new Promise((settle, reject) => {
        const id = nextId++;
        pending.set(id, settle);
        try {
          child.stdin?.write(
            `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
          );
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    void (async () => {
      try {
        const init = await request("initialize", {
          clientInfo: { name: "nucleus", version: "0.1.0" },
        });
        if (init.error) {
          finish(null);
          return;
        }
        child.stdin?.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
        );
        const reply = await request("account/rateLimits/read", {
          excludeResetCreditDetails: true,
        });
        clearTimeout(timer);
        if (reply.error || !reply.result || typeof reply.result !== "object") {
          finish(null);
          return;
        }
        const result = reply.result as {
          accountId?: unknown;
          rateLimits?: unknown;
          rateLimitsByLimitId?: unknown;
        };
        const snapshots: RateLimitSnapshot[] = [];
        if (
          result.rateLimitsByLimitId &&
          typeof result.rateLimitsByLimitId === "object"
        ) {
          for (const value of Object.values(result.rateLimitsByLimitId)) {
            if (value && typeof value === "object")
              snapshots.push(value as RateLimitSnapshot);
          }
        }
        if (
          !snapshots.length &&
          result.rateLimits &&
          typeof result.rateLimits === "object"
        ) {
          snapshots.push(result.rateLimits as RateLimitSnapshot);
        }
        const windows = snapshots.flatMap((snapshot) =>
          snapshotWindows(snapshot),
        );
        if (!windows.length) {
          finish(null);
          return;
        }
        finish(
          usageReadingSchema.parse({
            status: "ok",
            reason: null,
            asOf: now.toISOString(),
            source: "app-server",
            accountId:
              typeof result.accountId === "string" && result.accountId
                ? result.accountId.slice(0, 240)
                : null,
            windows,
          }),
        );
      } catch {
        clearTimeout(timer);
        finish(null);
      }
    })();
  });
}
