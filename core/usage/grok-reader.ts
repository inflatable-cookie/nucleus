/**
 * The Grok usage reader (Spec 059): read the CLI-owned billing snapshot via
 * `grok agent stdio`, then fall back to `grok usage --json` if stdio cannot
 * start. The CLI holds the login; Nucleus never reads credentials or starts a
 * model turn.
 */
import { spawn } from "node:child_process";
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

export const GROK_INITIALIZE_TIMEOUT_MS = 15_000;
export const GROK_BILLING_TIMEOUT_MS = 10_000;
const GROK_FALLBACK_TIMEOUT_MS = 20_000;
const OUTPUT_EXCERPT_BYTES = 400;

export interface GrokReaderOptions {
  command?: string;
  args?: string[];
  fallbackArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  initializeTimeoutMs?: number;
  now?: () => Date;
}

interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface RpcReply {
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export async function readGrokUsage(
  source: UsageSource = { home: "" },
  options: GrokReaderOptions = {},
): Promise<UsageReading> {
  const now = (options.now ?? (() => new Date()))();
  const env = { ...(options.env ?? process.env) };
  if (source.home) env.GROK_HOME = source.home;
  try {
    const billing = await readBilling(options, env);
    return billingReading(billing, now);
  } catch (error) {
    const reason = (error as Error).message;
    if (!reason.startsWith("grok agent stdio failed to start:") &&
      !reason.startsWith("grok agent stdio initialize failed:")) {
      return unreadableReading(reason, "unknown", "grok-cli", now);
    }
    try {
      const fallback = await runCli(options, env);
      if (fallback.code !== 0) {
        const detail = (fallback.stderr.trim() || fallback.stdout.trim()).slice(
          0,
          OUTPUT_EXCERPT_BYTES,
        );
        return unreadableReading(
          `grok usage exited ${fallback.code}${detail ? `: ${detail}` : ""}`,
          "unknown",
          "grok-cli",
          now,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(fallback.stdout);
      } catch {
        return unreadableReading(
          `grok usage printed no JSON: ${fallback.stdout.slice(0, OUTPUT_EXCERPT_BYTES)}`,
          "unknown",
          "grok-cli",
          now,
        );
      }
      return billingReading(parsed, now);
    } catch (fallbackError) {
      return unreadableReading(
        `${reason}; fallback failed: ${(fallbackError as Error).message}`,
        "unknown",
        "grok-cli",
        now,
      );
    }
  }
}

function billingReading(raw: unknown, now: Date): UsageReading {
  if (!raw || typeof raw !== "object") {
    return unreadableReading("grok billing result is not an object", "unknown", "grok-cli", now);
  }
  const result = raw as Record<string, unknown>;
  const config = result.config && typeof result.config === "object"
    ? result.config as Record<string, unknown>
    : null;
  let usedPercent = config?.creditUsagePercent;
  let periodStart: unknown;
  let periodEnd: unknown;
  if (config) {
    const currentPeriod = config.currentPeriod && typeof config.currentPeriod === "object"
      ? config.currentPeriod as Record<string, unknown>
      : {};
    const currentPeriodEnd = instantFrom(currentPeriod.end);
    periodStart = currentPeriodEnd === null
      ? config.billingPeriodStart
      : currentPeriod.start;
    periodEnd = currentPeriodEnd ?? config.billingPeriodEnd;
  } else if (result.creditUsagePercent !== undefined) {
    // Older `grok usage --json` builds returned the credits fields at the root.
    usedPercent = result.creditUsagePercent;
    const currentPeriod = result.currentPeriod && typeof result.currentPeriod === "object"
      ? result.currentPeriod as Record<string, unknown>
      : {};
    periodStart = currentPeriod.start;
    periodEnd = currentPeriod.end;
  } else {
    // Legacy `_x.ai/billing` shape: monthly usage is reported in cents.
    const legacy = result as {
      monthlyLimit?: { val?: unknown };
      usage?: { totalUsed?: { val?: unknown } };
      billingCycle?: { billingPeriodStart?: unknown; billingPeriodEnd?: unknown };
    };
    const limit = legacy.monthlyLimit?.val;
    const used = legacy.usage?.totalUsed?.val;
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0 &&
      typeof used === "number" && Number.isFinite(used)) {
      usedPercent = (used / limit) * 100;
    }
    periodStart = legacy.billingCycle?.billingPeriodStart;
    periodEnd = legacy.billingCycle?.billingPeriodEnd;
  }
  const usedFraction = fractionFromPercent(usedPercent);
  if (usedFraction === null) {
    return unreadableReading(
      "grok billing result carries no numeric credit usage percent",
      "unknown",
      "grok-cli",
      now,
    );
  }
  const window: UsageWindow = {
    windowId: "credits",
    name: "Credits",
    usedFraction,
    windowSeconds: null,
    windowStartsAt: instantFrom(periodStart),
    resetsAt: instantFrom(periodEnd),
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

async function readBilling(
  options: GrokReaderOptions,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const child = spawn(
    options.command ?? "grok",
    options.args ?? ["agent", "stdio"],
    { env, stdio: ["pipe", "pipe", "ignore"] },
  );
  const buffer = { value: "" };
  const pending = new Map<number, (reply: RpcReply) => void>();
  let nextId = 1;
  const processState: { spawnFailure: Error | null } = { spawnFailure: null };
  child.on("error", (error) => { processState.spawnFailure = error; });
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer.value += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.value.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.value.slice(0, newline).trim();
      buffer.value = buffer.value.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined || message.id === null) continue;
      const settle = pending.get(Number(message.id));
      if (settle) {
        pending.delete(Number(message.id));
        settle(message);
      }
    }
  });
  const timeoutMs = options.timeoutMs ?? GROK_BILLING_TIMEOUT_MS;
  const finish = async <T>(promise: Promise<T>, duration: number, label: string): Promise<T> => {
    let timer: NodeJS.Timeout;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`grok agent stdio ${label} timed out after ${duration / 1000}s`)), duration);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  };
  const request = (method: string, params: unknown): Promise<RpcReply> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error) {
          pending.delete(id);
          reject(error);
        }
      });
      child.once("error", (error) => {
        pending.delete(id);
        reject(processState.spawnFailure ?? error);
      });
    });
  };
  try {
    let initialized: RpcReply;
    try {
      initialized = await finish(
        request("initialize", {
          protocolVersion: "1",
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        }),
        options.initializeTimeoutMs ?? GROK_INITIALIZE_TIMEOUT_MS,
        "initialize",
      );
    } catch (error) {
      if (processState.spawnFailure) throw new Error(`grok agent stdio failed to start: ${processState.spawnFailure.message}`);
      throw error;
    }
    if (initialized.error) throw new Error(`grok agent stdio initialize failed: ${initialized.error.message ?? "unknown error"}`);
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    const reply = await finish(request("_x.ai/billing", {}), timeoutMs, "billing");
    if (reply.error) {
      throw new Error(`grok billing method failed (${reply.error.code ?? "unknown"}): ${reply.error.message ?? "unknown error"}`);
    }
    return reply.result;
  } catch (error) {
    if (processState.spawnFailure) throw new Error(`grok agent stdio failed to start: ${processState.spawnFailure.message}`);
    throw error;
  } finally {
    pending.clear();
    child.stdin?.end();
    child.kill();
  }
}

function runCli(
  options: GrokReaderOptions,
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command ?? "grok", options.fallbackArgs ?? ["usage", "--json"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`grok usage did not finish within ${(options.timeoutMs ?? GROK_FALLBACK_TIMEOUT_MS) / 1000}s`));
    }, options.timeoutMs ?? GROK_FALLBACK_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code });
    });
  });
}
