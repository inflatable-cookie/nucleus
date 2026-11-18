/**
 * The T3Code connection Nucleus keeps for one environment (nucleus#1330).
 *
 * One owner per fact: this module owns where the connection is stored, what
 * shape it has, how it is read and how it is written; the operator route
 * (`nucleus t3 install` / `uninstall`) and the service's settings watch both
 * read and write through it, so they can never disagree about the file or its
 * permissions.
 *
 * The bearer is a secret. It lives only in the owner-only settings file, is
 * never returned by a status read and is never logged: every reader here
 * returns the parsed shape to a caller that decides what it may print.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const T3_SETTINGS_FILE = "settings.json";
/** The service's own daemon default; the file it writes when it first starts. */
export const T3_DEFAULT_DAEMON_URL = "ws://127.0.0.1:6767/ws";
/** The running server's descriptor, under T3Code's base directory. */
export const T3_RUNTIME_DESCRIPTOR_SEGMENTS = [
  "userdata",
  "server-runtime.json",
] as const;

/**
 * `t3code` in Nucleus's settings file. `sessionId` and `expiresAt` are the
 * session the bearer came from, recorded so status can report its scope,
 * expiry and rotation without keeping the minting command's output anywhere.
 * Unknown keys are kept, so a hand edit that adds one is never silently lost.
 */
export const t3ConnectionSchema = z
  .object({
    endpoint: z.string().url(),
    bearer: z.string().min(1),
    probeThreadId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    environmentId: z.string().min(1).optional(),
    baseDir: z.string().min(1).optional(),
    expiresAt: z.string().min(1).optional(),
  })
  .passthrough();
export type T3ConnectionSettings = z.infer<typeof t3ConnectionSchema>;

/** The parts of `userdata/server-runtime.json` this route reads. */
export interface T3RuntimeDescriptor {
  origin: string;
  pid: number;
  serverVersion: string;
  startedAt?: string;
}

export function t3SettingsPath(dataDir: string): string {
  return join(dataDir, T3_SETTINGS_FILE);
}

export function t3RuntimeDescriptorPath(baseDir: string): string {
  return join(baseDir, ...T3_RUNTIME_DESCRIPTOR_SEGMENTS);
}

/**
 * A cheap change token for the one file both writers touch: the service compares
 * it on its own tick instead of re-reading and re-parsing the file every pass.
 */
export function settingsFileStamp(path: string): string {
  try {
    const stats = statSync(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "missing";
  }
}

function readSettingsObject(path: string): Record<string, unknown> | null {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(source);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${path} is not a settings object`);
  return parsed as Record<string, unknown>;
}

/** The stored connection, or null when this environment has none. */
export function readT3Connection(dataDir: string): T3ConnectionSettings | null {
  const settings = readSettingsObject(t3SettingsPath(dataDir));
  if (!settings || settings.t3code === undefined) return null;
  const result = t3ConnectionSchema.safeParse(settings.t3code);
  if (!result.success)
    throw new Error(
      `T3Code settings in ${t3SettingsPath(dataDir)} are not usable: ${result.error.issues[0]?.path.join(".") || "shape"}`,
    );
  return result.data;
}

/**
 * Record (or, with null, clear) this environment's connection. Owner-only and
 * atomic: the file is written beside the original and renamed over it, so a
 * reader never sees a half-written settings file and a failed write leaves the
 * previous one exactly as it was. Every other key is preserved.
 */
export function writeT3Connection(
  dataDir: string,
  connection: T3ConnectionSettings | null,
): void {
  const path = t3SettingsPath(dataDir);
  const settings = readSettingsObject(path) ?? {
    daemonUrl: T3_DEFAULT_DAEMON_URL,
  };
  if (connection) settings.t3code = connection;
  else delete settings.t3code;
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The running server's own descriptor, or null when it is not there. */
export function readT3RuntimeDescriptor(
  baseDir: string,
): T3RuntimeDescriptor | null {
  const path = t3RuntimeDescriptorPath(baseDir);
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.origin !== "string" ||
    typeof value.pid !== "number" ||
    typeof value.serverVersion !== "string"
  )
    return null;
  return {
    origin: value.origin,
    pid: value.pid,
    serverVersion: value.serverVersion,
    ...(typeof value.startedAt === "string"
      ? { startedAt: value.startedAt }
      : {}),
  };
}

/** Whether two stored connections would connect the same service the same way. */
export function sameT3Connection(
  a: { endpoint: string; bearer: string; probeThreadId?: string } | null,
  b: { endpoint: string; bearer: string; probeThreadId?: string } | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.endpoint === b.endpoint &&
    a.bearer === b.bearer &&
    a.probeThreadId === b.probeThreadId
  );
}
