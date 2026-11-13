import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
 * What a detach leaves behind.
 *
 * It is durable evidence of two things a name cannot carry: which task and
 * workspace detached the tree, and which filesystem object it was. `device` and
 * `inode` are the detached directory's own identity, taken immediately before the
 * rename, and a rename preserves them — so a later pass can prove that the
 * directory standing at the quarantine name is the very object this record
 * describes, not an unrelated directory that happens to share the name. `parent`
 * is the canonical parent both names must still resolve to.
 */
const removalDetachRecordSchema = z.object({
  taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/),
  workspaceId: z.string().min(1).max(200),
  head: z.string().nullable(),
  at: z.string(),
  device: z.number(),
  inode: z.number(),
  parent: z.string().min(1),
}).strict();
export type RemovalDetachRecord = z.infer<typeof removalDetachRecordSchema>;

/** The recorded detach, or null when there is none or it does not parse. */
export function readRemovalDetach(path: string): RemovalDetachRecord | null {
  const marker = removalDetachMarkerPath(path);
  const info = lstatSync(marker, { throwIfNoEntry: false });
  if (!info || info.isSymbolicLink() || !info.isFile() || info.size > 4_096) return null;
  try { return removalDetachRecordSchema.parse(JSON.parse(readFileSync(marker, "utf8"))); }
  catch { return null; }
}

/**
 * Record the tree's identity and detach it, all synchronously.
 *
 * The caller has just re-proved ownership of `path`; nothing may interleave
 * between that proof, this record and the rename. The record is created
 * exclusively (`wx`), so an existing file or symlink at the marker name is
 * refused instead of followed and truncated, and it is fsynced before the rename
 * so the evidence is on disk before the tree can disappear under it. The rename
 * carries the same inode the record names, which is what lets a later pass tell
 * this tree apart from any other directory at the quarantine name
 * (nucleus#1179, planner ruling 2026-11-13).
 */
export function detachForRemoval(path: string, input: { taskId: string; workspaceId: string; head: string | null }): string {
  if (resolve(path) !== path) throw new Error(`${path} is not a canonical absolute path; refusing to detach it`);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) throw new Error(`${path} is gone; there is nothing to detach`);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${path} is not a directory a Queue removal can detach`);
  const parent = realpathSync(dirname(path));
  const quarantine = removalQuarantinePath(path);
  const record: RemovalDetachRecord = {
    taskId: input.taskId, workspaceId: input.workspaceId, head: input.head, at: new Date().toISOString(),
    device: info.dev, inode: info.ino, parent,
  };
  const marker = removalDetachMarkerPath(path);
  const fd = openSync(marker, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(path, quarantine);
  return quarantine;
}

/**
 * Remove the tree an interrupted detach left behind, under the same authority the
 * teardown itself needs.
 *
 * The caller has already proved this task owns the recorded directory. Beyond
 * that, the detach record must name this task and workspace *and* the filesystem
 * object standing at the quarantine name: same device, same inode, and the same
 * canonical parent. A pre-existing unrelated sibling, a replacement, a symlink or
 * a tree with no record is refused, never followed and never deleted, and the
 * archive fails closed for a human to inspect (nucleus#1179 acceptance 2b,
 * reviews 5890648389, 5891444157 and 5893989674).
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
  if (record.device !== info.dev || record.inode !== info.ino)
    throw new Error(`${quarantine} is not the directory this task detached (recorded identity ${record.device}:${record.inode}, found ${info.dev}:${info.ino}); refusing to remove it`);
  if (realpathSync(dirname(path)) !== record.parent)
    throw new Error(`${dirname(path)} is no longer the canonical parent recorded for ${quarantine}; refusing to remove it`);
  await removeTree(quarantine, { force: false });
  rmSync(removalDetachMarkerPath(path), { force: true });
  return true;
}
