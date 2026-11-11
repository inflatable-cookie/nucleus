/**
 * Prewarm for a warm standby (Spec 035). Kept out of standby.ts so the bridge,
 * which imports standby.ts for its readiness marker, never loads node:sqlite
 * (layout guard: the bridge imports no Store, Git, hook or SQLite module).
 * Only the executor worker imports this.
 */
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { STANDBY_WAIT_MS, waitForPidExit, waitForPidExitSync } from "./standby";

/**
 * One tick's synchronous read. The standby's swapped live host-run socket is
 * owned by this event loop for the whole wait, so a tick's synchronous stretch
 * is an accept gap: at macOS's 128-slot backlog a few hundred milliseconds of
 * blocking refusing connects is a roll outage (2026-10-20). 256 KiB warms the
 * same pages across ticks while keeping each stretch to a few milliseconds.
 */
const TOUCH_CHUNK = 256 * 1024;

/**
 * Read the store files as bytes to warm the OS cache while the previous owner
 * is alive. Do not open SQLite here: a read-only SQLite open can create a
 * shared-memory sidecar before the store schema has been admitted.
 */
export function prewarmStore(path: string): { tick: () => void; close: () => void } {
  const idle = { tick() {}, close() {} };
  if (!path || path === ":memory:" || !existsSync(path)) return idle;
  const files: Array<{ fd: number; done: boolean }> = [];
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try { files.push({ fd: openSync(candidate, "r"), done: false }); } catch { /* wal/shm appear with the first writer */ }
  }
  const buf = Buffer.alloc(TOUCH_CHUNK);
  const close = () => {
    for (const file of files) try { closeSync(file.fd); } catch { /* already closed */ }
    files.length = 0;
  };
  return {
    tick() {
      for (const file of files) {
        if (file.done) continue;
        try { if (readSync(file.fd, buf, 0, buf.length, null) <= 0) file.done = true; }
        catch { file.done = true; }
      }
    },
    close,
  };
}

/** Prewarm the store read-only, then wait for the old pid. Closes the reader before return. */
export function waitForStandbyHandoff(pid: number, storePath: string, timeoutMs = STANDBY_WAIT_MS): void {
  const prewarm = prewarmStore(storePath);
  try { waitForPidExitSync(pid, timeoutMs, prewarm.tick); }
  finally { prewarm.close(); }
}

/**
 * Await the handoff without blocking the event loop. A warm standby already
 * listens on the swapped live host-run socket from this same worker thread, so
 * the wait must stay cooperative or that socket stops accepting while the old
 * service drains. Closes the read-only prewarm before the writable open.
 */
export async function waitForStandbyHandoffAsync(pid: number, storePath: string, timeoutMs = STANDBY_WAIT_MS): Promise<void> {
  const prewarm = prewarmStore(storePath);
  try { await waitForPidExit(pid, timeoutMs, prewarm.tick); }
  finally { prewarm.close(); }
}
