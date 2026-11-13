import { lstatSync } from "node:fs";
import { rm } from "node:fs/promises";

/**
 * Remove one directory tree without holding the event loop.
 *
 * `rmSync(path, { recursive: true })` runs the whole recursion — readdir, lstat,
 * unlink, rmdir — synchronously on the caller's thread. Inside the persistence
 * executor that thread also serves every board, `task.next` and `queue.detail`
 * read, so removing one large checkout blocked every client until it finished.
 * That is the shape of the 2026-11-13 09:55Z wedge: one thread sampled for the
 * whole window inside `node::fs::LStat`/`Unlink`/`RMDir` builtins while every
 * read timed out at the client. `rm` runs the same walk on libuv's pool, so the
 * thread yields between entries and queued reads answer.
 *
 * This is the one owner of "remove a tree without starving a read". Call it with
 * `await`; never reintroduce a recursive `rmSync` on a thread that serves reads.
 */
export async function removeTree(path: string, options: { force?: boolean; maxRetries?: number } = {}): Promise<void> {
  await rm(path, { recursive: true, force: options.force ?? true, maxRetries: options.maxRetries ?? 2, retryDelay: 100 });
}

/** The one name a checkout removal detaches its target to before walking it. */
export const REMOVAL_QUARANTINE_SUFFIX = ".queue-removing";
/** The sibling name a checkout is detached to before its asynchronous walk. */
export function removalQuarantinePath(path: string): string {
  return `${path}${REMOVAL_QUARANTINE_SUFFIX}`;
}

/**
 * Remove the tree an interrupted detach left behind.
 *
 * A detach renames the checkout to the deterministic sibling name, then walks it.
 * If the walk fails or the process dies, the original path is gone and the
 * sibling survives: a retry that only looks at the original path would report the
 * archive complete while that tree still holds the storage the archive was meant
 * to release. Only this module creates the name, always for the path it was
 * given, so a real directory at `<path>.queue-removing` is exactly that leftover.
 * A symlink or a file at the name is refused rather than followed, and nothing is
 * removed unless it is a directory this module could have detached.
 */
export async function finishInterruptedRemoval(path: string): Promise<boolean> {
  const quarantine = removalQuarantinePath(path);
  const info = lstatSync(quarantine, { throwIfNoEntry: false });
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`${quarantine} is not the directory an interrupted removal detached; inspect it before retrying`);
  await removeTree(quarantine, { force: false });
  return true;
}
