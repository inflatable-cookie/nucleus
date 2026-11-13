import { rm } from "node:fs/promises";

/**
 * Remove one directory tree without holding the event loop.
 *
 * `rmSync(path, { recursive: true })` runs the whole recursion — readdir, lstat,
 * unlink, rmdir — synchronously on the caller's thread. Inside the persistence
 * executor that thread also serves every board, `task.next` and `queue.detail`
 * read, so removing one large checkout blocked every client until it finished.
 * That is the shape of the 2026-11-13 09:55Z sample: one thread sampled for the
 * whole window inside `node::fs::LStat`/`Unlink`/`RMDir` builtins while every
 * read timed out at the client. `rm` runs the same walk on libuv's pool, so the
 * thread yields between entries and queued reads answer.
 *
 * Nothing else changes: the caller proves the path is the one it may remove
 * immediately before calling this, exactly as the synchronous removal did, and an
 * interrupted walk leaves a partial directory that the next attempt removes after
 * re-proving the same path. There is no quarantine, no rename and no side record
 * (planner ruling, 2026-11-13).
 *
 * This is the one owner of "remove a tree without starving a read". Call it with
 * `await`; never reintroduce a recursive `rmSync` on a thread that serves reads.
 */
export async function removeTree(path: string, options: { force?: boolean; maxRetries?: number } = {}): Promise<void> {
  await rm(path, { recursive: true, force: options.force ?? true, maxRetries: options.maxRetries ?? 2, retryDelay: 100 });
}
