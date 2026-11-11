import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { serviceRollSchema, type ServiceRoll } from "../service-roll";
/**
 * Local service identity and owner-only bootstrap files (Contract 007).
 *
 * The service owns its socket and credential under the existing Queue data
 * directory. All files are owner-only; a credential leak never crosses a user
 * boundary because the socket itself is owner-only too.
 */
export const SERVICE_SOCKET_FILE = "queue-service.sock";
export const SERVICE_INFO_FILE = "queue-service.json";
export const SERVICE_ROLL_FILE = "queue-service-roll.json";
export const SERVICE_STARTUP_FAILURE_FILE = "queue-service-startup-failure.json";
export const SERVICE_EXECUTOR_FAULT_FILE = "queue-service-executor-fault.json";

export const serviceStartupFailureSchema = z.object({
  at: z.string(),
  reason: z.string().max(256),
  pid: z.number().int().positive().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(32).nullable(),
  spawnError: z.string().max(100).nullable(),
  output: z.string().max(2_000),
}).strict();
export type ServiceStartupFailure = z.infer<typeof serviceStartupFailureSchema>;

export const serviceInfoSchema = z.object({
  protocolVersion: z.number().int(),
  buildId: z.string().min(8).max(64),
  socketPath: z.string().min(1),
  credential: z.string().regex(/^[a-f0-9]{64}$/),
  pid: z.number().int().positive(),
  startedAt: z.string(),
  /** Login session the service was spawned under; absent on pre-session identity files. */
  sessionId: z.string().min(1).max(128).optional(),
  /** The loopback port of the local web board; absent when the board server did not start. */
  httpPort: z.number().int().min(1).max(65535).optional(),
}).strict();

export type ServiceInfo = z.infer<typeof serviceInfoSchema>;

/**
 * Host login-session identity. macOS uses SECURITYSESSIONID; Linux uses
 * XDG_SESSION_ID. The POSIX fallback is `getsid` / `/proc/self/sessionid`
 * (shared by every process in the login session), never the process pid.
 * A missing recorded session is a mismatch so an upgraded bridge drains the
 * old service.
 */
export function currentLoginSession(env: NodeJS.ProcessEnv = process.env): string {
  if (env.QUEUE_LOGIN_SESSION) return env.QUEUE_LOGIN_SESSION;
  if (env.SECURITYSESSIONID) return `macos:${env.SECURITYSESSIONID}`;
  if (env.XDG_SESSION_ID) return `linux:${env.XDG_SESSION_ID}`;
  return posixLoginSession();
}

function posixLoginSession(): string {
  const proc = process as NodeJS.Process & { getsid?: (pid?: number) => number };
  if (typeof proc.getsid === "function") {
    try { return `sid:${proc.getsid()}`; } catch { /* EPERM: fall through */ }
  }
  try {
    const text = readFileSync("/proc/self/sessionid", "utf8").trim();
    if (/^\d+$/.test(text)) return `sid:${text}`;
  } catch { /* not Linux, or unreadable */ }
  return "sid:unknown";
}

export function sessionsDiffer(recorded: string | undefined, current: string): boolean {
  return recorded !== current;
}

export function serviceSocketPath(dataDir: string) { return join(dataDir, SERVICE_SOCKET_FILE); }
export function serviceInfoPath(dataDir: string) { return join(dataDir, SERVICE_INFO_FILE); }

export function readServiceInfo(dataDir: string): ServiceInfo | null {
  try {
    return serviceInfoSchema.parse(JSON.parse(readFileSync(serviceInfoPath(dataDir), "utf8")));
  } catch {
    return null; // A missing, unreadable or invalid identity file is not a running service.
  }
}

/** The bridge's latest automatic roll; the local CLI reads it to explain a build mismatch. */

export function readServiceRoll(dataDir: string): ServiceRoll | null {
  try {
    return serviceRollSchema.parse(JSON.parse(readFileSync(join(dataDir, SERVICE_ROLL_FILE), "utf8")));
  } catch {
    return null;
  }
}

/** Read the latest bounded child startup failure, if one was recorded. */
export function readServiceStartupFailure(dataDir: string): ServiceStartupFailure | null {
  try { return serviceStartupFailureSchema.parse(JSON.parse(readFileSync(join(dataDir, SERVICE_STARTUP_FAILURE_FILE), "utf8"))); }
  catch { return null; }
}

export const serviceExecutorFaultSchema = z.object({
  at: z.string(),
  kind: z.enum(["exited", "error"]),
  exitCode: z.number().int().nullable(),
  pid: z.number().int().positive(),
  buildId: z.string().min(8).max(64),
  message: z.string().max(512),
  stack: z.string().max(2_000),
}).strict();
export type ServiceExecutorFault = z.infer<typeof serviceExecutorFaultSchema>;

/**
 * The latest persistence-executor death, kept beyond the service that observed it.
 * Each death overwrites the previous record; readers match `pid` to the service they
 * are talking to, so an older record never explains a newer process.
 */
export function readServiceExecutorFault(dataDir: string): ServiceExecutorFault | null {
  try { return serviceExecutorFaultSchema.parse(JSON.parse(readFileSync(join(dataDir, SERVICE_EXECUTOR_FAULT_FILE), "utf8"))); }
  catch { return null; }
}

export const SERVICE_ROLL_REQUEST_FILE = "queue-service-roll-request";
