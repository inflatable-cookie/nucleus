/**
 * The Grok usage reader (Spec 059): `grok usage --json`, a single credit
 * gauge — used percent plus the billing period when the CLI reports it. The
 * CLI holds the login; Nucleus runs the command and reads its output, never a
 * provider endpoint.
 */
import { spawn } from "node:child_process";
import {
  usageReadingSchema,
  type UsageReading,
  type UsageWindow,
} from "../../shared/schema/usage";
import { fractionFromPercent, instantFrom, unreadableReading } from "./readers";

const GROK_TIMEOUT_MS = 20_000;
const OUTPUT_EXCERPT_BYTES = 400;

export interface GrokReaderOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => Date;
}

export async function readGrokUsage(
  options: GrokReaderOptions = {},
): Promise<UsageReading> {
  const now = (options.now ?? (() => new Date()))();
  let stdout: string;
  let stderr: string;
  let code: number | null;
  try {
    ({ stdout, stderr, code } = await runGrok(options));
  } catch (error) {
    return unreadableReading(
      `grok usage failed to run: ${(error as Error).message}`,
      "unknown",
      "grok-cli",
      now,
    );
  }
  if (code !== 0) {
    const detail = (stderr.trim() || stdout.trim()).slice(
      0,
      OUTPUT_EXCERPT_BYTES,
    );
    return unreadableReading(
      `grok usage exited ${code}${detail ? `: ${detail}` : ""}`,
      "unknown",
      "grok-cli",
      now,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unreadableReading(
      `grok usage printed no JSON: ${stdout.slice(0, OUTPUT_EXCERPT_BYTES)}`,
      "unknown",
      "grok-cli",
      now,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    return unreadableReading(
      "grok usage JSON is not an object",
      "unknown",
      "grok-cli",
      now,
    );
  }
  const report = parsed as {
    creditUsagePercent?: unknown;
    currentPeriod?: unknown;
  };
  const usedFraction = fractionFromPercent(report.creditUsagePercent);
  if (usedFraction === null) {
    return unreadableReading(
      `grok usage carries no numeric creditUsagePercent: ${stdout.slice(0, OUTPUT_EXCERPT_BYTES)}`,
      "unknown",
      "grok-cli",
      now,
    );
  }
  const period =
    report.currentPeriod && typeof report.currentPeriod === "object"
      ? (report.currentPeriod as { start?: unknown; end?: unknown })
      : {};
  const window: UsageWindow = {
    windowId: "credits",
    name: "Credits",
    usedFraction,
    windowSeconds: null,
    windowStartsAt: instantFrom(period.start),
    resetsAt: instantFrom(period.end),
  };
  return usageReadingSchema.parse({
    status: "ok",
    reason: null,
    asOf: now.toISOString(),
    source: "grok-cli",
    accountId: null,
    windows: [window],
  });
}

/** Collect one bounded `grok usage --json` run; the child is killed at the timeout. */
function runGrok(
  options: GrokReaderOptions,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        options.command ?? "grok",
        options.args ?? ["usage", "--json"],
        { env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      reject(
        new Error(
          `grok usage did not finish within ${(options.timeoutMs ?? GROK_TIMEOUT_MS) / 1000}s`,
        ),
      );
    }, options.timeoutMs ?? GROK_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
      });
    });
  });
}
