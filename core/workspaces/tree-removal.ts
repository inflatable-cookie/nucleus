import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { z } from "zod";

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
/** The detach record beside the quarantine: what was detached, for which task. */
export function removalDetachMarkerPath(path: string): string {
  return `${removalQuarantinePath(path)}.json`;
}

/**
 * What a detach leaves behind. It is the durable evidence that the tree under the
 * quarantine name is this task's checkout and not a directory that merely shares
 * the name, so a later pass can finish the removal without trusting the name.
 */
const removalDetachRecordSchema = z.object({
  taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/),
  workspaceId: z.string().min(1).max(200),
  head: z.string().nullable(),
  at: z.string(),
}).strict();
export type RemovalDetachRecord = z.infer<typeof removalDetachRecordSchema>;

/**
 * Record the detach right before it happens. Synchronous on purpose: the caller
 * has just re-proved ownership, so nothing may interleave between the proof, this
 * record and the rename.
 */
export function recordRemovalDetach(path: string, record: RemovalDetachRecord): void {
  writeFileSync(removalDetachMarkerPath(path), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** The recorded detach, or null when there is none or it does not parse. */
export function readRemovalDetach(path: string): RemovalDetachRecord | null {
  const marker = removalDetachMarkerPath(path);
  const info = lstatSync(marker, { throwIfNoEntry: false });
  if (!info || info.isSymbolicLink() || !info.isFile() || info.size > 4_096) return null;
  try { return removalDetachRecordSchema.parse(JSON.parse(readFileSync(marker, "utf8"))); }
  catch { return null; }
}

/**
 * Remove the tree an interrupted detach left behind, under the same authority the
 * teardown itself needs.
 *
 * A detach records what it is about to detach, renames the checkout to the
 * deterministic sibling name and then walks it. If the walk fails or the process
 * dies, the original path is gone and the sibling survives: a retry that only
 * looked at the original path would report the archive complete while that tree
 * still holds the storage the archive was meant to release. The name and the type
 * are not authority — `authority` is the task and workspace this pass has already
 * proved own the checkout, and the record must name exactly those. A symlink, a
 * file, or a tree without this pass's record is refused, never followed and never
 * deleted (nucleus#1179 reviews 5890648389 and 5891444157).
 */
export async function finishInterruptedRemoval(path: string, authority: { taskId: string; workspaceId: string }): Promise<boolean> {
  const quarantine = removalQuarantinePath(path);
  const info = lstatSync(quarantine, { throwIfNoEntry: false });
  if (!info) {
    // No detached tree. A record left behind by a completed detach is this pass's
    // own file for this same path, so it is removed; anything else is left alone.
    const record = readRemovalDetach(path);
    if (record && record.taskId === authority.taskId && record.workspaceId === authority.workspaceId) rmSync(removalDetachMarkerPath(path), { force: true });
    return false;
  }
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`${quarantine} is not a directory this Queue removal could have detached; inspect it before retrying`);
  const record = readRemovalDetach(path);
  if (!record || record.taskId !== authority.taskId || record.workspaceId !== authority.workspaceId)
    throw new Error(`${quarantine} has no detach record naming this task and workspace; refusing to remove a directory this pass did not detach — inspect it before retrying`);
  await removeTree(quarantine, { force: false });
  rmSync(removalDetachMarkerPath(path), { force: true });
  return true;
}
