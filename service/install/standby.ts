import { writeOwnedJson } from "../../core/machine/owned-file.mjs";
/**
 * Warm standby for a service roll (Spec 035, endpoint availability).
 *
 * The bridge spawns the replacement before it drains the old service. The
 * replacement loads its modules, binds a staged host-run socket and swaps it
 * onto `run/scheduler.sock`, signals readiness, then waits for the old pid
 * to exit before it takes the writable lease: a read-only sequential file touch during that wait warm the page cache, but they take no
 * processOwner lease and issue no writes, so there is still exactly one
 * writable owner. The staged swap happens before the ready marker, so the
 * bridge's drain never unbinds the live path until the incoming process already
 * answers it. The writable open still waits for the old pid.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../transport/identity";

export * from "../../shared/service/standby-wait";
import { STANDBY_ENV, STANDBY_WAIT_MS, SPAWN_TOKEN_ENV as SHARED_SPAWN_TOKEN_ENV } from "../../shared/service/standby-wait";

const STANDBY_POLL_MS = 10;

export function standbyForPid(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const value = Number(env[STANDBY_ENV]);
  return Number.isInteger(value) && value > 0 && value !== process.pid ? value : undefined;
}

/** Block this thread until the pid exits. Only a caller that owns no event-loop work may use it. */
export function waitForPidExitSync(pid: number, timeoutMs = STANDBY_WAIT_MS, tick?: () => void): void {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Standby gave up waiting for service pid ${pid} to exit`);
    tick?.();
    Atomics.wait(gate, 0, 0, STANDBY_POLL_MS);
  }
}

/**
 * Await the same exit without blocking the event loop. A warm standby's swapped
 * listen socket is owned by the executor worker's event loop, so a synchronous
 * wait stops accepting while the old service drains; under client churn the
 * kernel accept queue then fills and the live path returns `ECONNREFUSED`
 * (2026-10-06 milestone QA: a 1.6 s gap on a warm standby that had reported
 * loaded). `tick` runs on every poll so the read-only store prewarm stays
 * interleaved.
 */
export async function waitForPidExit(pid: number, timeoutMs = STANDBY_WAIT_MS, tick?: () => void): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Standby gave up waiting for service pid ${pid} to exit`);
    tick?.();
    await new Promise<void>(resolve => setTimeout(resolve, STANDBY_POLL_MS));
  }
}

/**
 * Owner-only readiness marker a standby writes once its worker has loaded and is
 * parked on the old pid. It names the standby pid, so a later roll's marker never
 * aliases an earlier one, and it is removed when the standby stops waiting, on
 * abandon, or when the process exits.
 */
export function standbyReadyPath(dataDir: string, pid: number): string {
  return join(dataDir, `queue-standby-${pid}.ready`);
}

export function markStandbyReady(dataDir: string, pid: number): void {
  const path = standbyReadyPath(dataDir, pid);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeOwnedJson(path, { pid, at: new Date().toISOString() });
  } catch {
    // Readiness is advisory: the bridge falls back to its bounded wait and drains anyway.
  }
}

export function standbyIsReady(dataDir: string, pid: number): boolean {
  return existsSync(standbyReadyPath(dataDir, pid));
}

export function clearStandbyReady(dataDir: string, pid: number): void {
  rmSync(standbyReadyPath(dataDir, pid), { force: true });
}

/** A starting service that must migrate its store may take this long past the readiness budget. */
export const MIGRATION_READINESS_CAP_MS = 10 * 60_000;
/** Env var naming one spawn; a migration marker counts only for the spawn that wrote it. */
export const SPAWN_TOKEN_ENV = SHARED_SPAWN_TOKEN_ENV;

export { defaultDataDir } from "../../shared/service/default-data-dir";

/**
 * Owner-only marker a starting service writes while it migrates its store: the
 * pre-migration snapshot and the schema steps. It names the service pid and the
 * spawn token the bridge gave it, and records when the migration started and,
 * once the store is open, when it finished. The bridge's readiness wait and the
 * executor's boot wait do not count that time, so a migrating start is not
 * mistaken for a hung one and no second service is spawned beside it. A marker
 * counts only for the same pid and token, so one a crashed process left behind
 * never extends a later process that reuses its pid.
 */
export function migrationMarkerPath(dataDir: string, pid: number): string {
  return join(dataDir, `queue-service-${pid}.migrating`);
}

export function markMigration(dataDir: string, pid: number, token: string | undefined, startedAt: number, finishedAt?: number): void {
  if (!token) return; // Only a bridge spawn can be extended, and it always carries a token.
  const path = migrationMarkerPath(dataDir, pid);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeOwnedJson(path, { pid, token, startedAt, ...(finishedAt === undefined ? {} : { finishedAt }) });
  } catch {
    // Advisory: without the marker the bridge keeps its ordinary bounded wait.
  }
}

/** Milliseconds this spawn has spent migrating so far (or in total, once finished); 0 without its marker. */
export function migrationMs(dataDir: string, pid: number, token: string | undefined, now = Date.now()): number {
  return markerMs(migrationMarkerPath(dataDir, pid), pid, token, MIGRATION_READINESS_CAP_MS, now);
}

export function clearMigration(dataDir: string, pid: number): void {
  rmSync(migrationMarkerPath(dataDir, pid), { force: true });
}

/**
 * The bounded store-maintenance window a starting service may run before it serves: the
 * one-shot compaction's own 120 s bound (`COMPACTION_MAX_BLOCKED_MS`) plus an allowance for
 * the verified snapshot it takes first and the service-start work around it. It is stated
 * here, without importing the SQLite module the bridge must never load, and a test asserts
 * the relationship to `COMPACTION_MAX_BLOCKED_MS`.
 */
export const MAINTENANCE_READINESS_CAP_MS = 180_000;

/**
 * Owner-only marker a starting service writes for the whole bounded store-maintenance
 * window — the verified snapshot, the rewrite and its verification. Same identity rule as a
 * migration marker: it names the service pid and the spawn token, records when the window
 * started and when it finished, and never extends a later process that reuses the pid. The
 * roll's readiness wait counts this time, so a conversion the service is allowed to take is
 * waited for instead of being mistaken for a hung start, and its own dead-or-alive question
 * is answered by the bounded marker rather than by the readiness deadline alone.
 */
export function maintenanceMarkerPath(dataDir: string, pid: number): string {
  return join(dataDir, `queue-service-${pid}.maintenance`);
}

export function markMaintenance(dataDir: string, pid: number, token: string | undefined, startedAt: number, finishedAt?: number): void {
  if (!token) return; // Only a bridge spawn is waited for, and it always carries a token.
  const path = maintenanceMarkerPath(dataDir, pid);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeOwnedJson(path, { pid, token, startedAt, ...(finishedAt === undefined ? {} : { finishedAt }) });
  } catch {
    // Advisory, like the migration marker: without it the bridge keeps its ordinary bounded wait.
  }
}

/** Milliseconds this spawn has spent in its maintenance window so far (or in total); 0 without its marker. */
export function maintenanceMs(dataDir: string, pid: number, token: string | undefined, now = Date.now()): number {
  return markerMs(maintenanceMarkerPath(dataDir, pid), pid, token, MAINTENANCE_READINESS_CAP_MS, now);
}

export function clearMaintenance(dataDir: string, pid: number): void {
  rmSync(maintenanceMarkerPath(dataDir, pid), { force: true });
}

/**
 * What a roll's readiness wait may add to its own budget for this spawn: the migration it is
 * running and, after that, the bounded store-maintenance window. Both are capped, both count
 * only for the pid and spawn token that wrote them, and each is counted once.
 */
export function startupExtensionMs(dataDir: string, pid: number, token: string | undefined, now = Date.now()): number {
  return migrationMs(dataDir, pid, token, now) + maintenanceMs(dataDir, pid, token, now);
}

/** One marker's own bounded contribution; a marker for another pid or spawn never counts. */
function markerMs(path: string, pid: number, token: string | undefined, capMs: number, now: number): number {
  if (!token) return 0;
  try {
    const marker = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; token?: unknown; startedAt?: unknown; finishedAt?: unknown };
    if (marker.pid !== pid || marker.token !== token || typeof marker.startedAt !== "number") return 0;
    const end = typeof marker.finishedAt === "number" ? marker.finishedAt : now;
    return Math.max(0, Math.min(end - marker.startedAt, capMs));
  } catch {
    return 0;
  }
}
