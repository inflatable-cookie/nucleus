import type { WorkspaceDiscard } from '../host/types';
export type { WorkspaceDiscard } from '../host/types';
/**
 * Orphaned task worktree classification (papercut c7643943; Tom, 2026-10-22:
 * "Retire the stuck workspaces"). A linked worktree whose administrative
 * directory under the repository's common dir is gone is detached from Git:
 * `rev-parse`, `status` and `worktree remove` cannot run in it. An owner
 * discard may retire such a workspace only after this proves, positively,
 * that the directory is the exact Queue-allocated path under the intact main
 * repository's common dir, that its `.git` is a regular file naming exactly
 * that repository's admin directory for it, that the admin directory is
 * absent (ENOENT, not an I/O or permission error), and that `git worktree
 * list` succeeds and does not list it. The `.git` text only corroborates the
 * shape; deletion authority comes from the durable task binding and the
 * owned path. Every ambiguity throws, so it can never reach a delete.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../git/index";
import { ownedWorkspacePath, ownedWorkspaceRoot, parseWorktreeList, repoCommonDir, WORKSPACES_DIR } from "./workspace-allocation";

/**
 * The canonical owned path, with no redirect below Queue's data dir: the
 * workspaces dir, the repository's owned root and the workspace itself are each
 * a real directory (never a symlink), and the bound directory resolves to
 * exactly that path. Synchronous, so it runs at the mutation boundary with no
 * await between it and the delete. Throws on any redirect or read failure.
 */
export function assertCanonicalOwnedPath(directory: string, dataDir: string, commonDir: string, taskId: string): void {
  const data = realpathSync(dataDir);
  const expected = ownedWorkspacePath(data, commonDir, taskId);
  for (const component of [join(data, WORKSPACES_DIR), ownedWorkspaceRoot(data, commonDir), expected]) {
    const stat = lstatSync(component);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("Preserving workspace: its owned path is redirected or is not a real directory");
  }
  if (realpathSync(directory) !== expected) throw Error("Preserving workspace: the directory is not the exact Queue-owned path for this task");
}

/**
 * Under a recorded owner discard only: give the owner write and search on every
 * directory inside the exact owned root, so removal can unlink entries in
 * read-only directories (sealed fixture objects). Directories only, never
 * through a link, never outside the root.
 *
 * Node has no descriptor-relative open, so a path walk cannot rule out an
 * ancestor swapped for a link and restored (review #610). The walk therefore
 * runs in BSD `find`, whose fts traversal descends by fchdir and checks each
 * directory's device and inode: a child shell enters the root once, proves its
 * working directory is the inode this process opened no-follow, and only then
 * runs `find -P . -type d ! -perm -300 -execdir <helper>`. `-P` never follows a
 * link and `-execdir` acts in the directory fts is already in, where the helper
 * opens each entry by name with O_DIRECTORY|O_NOFOLLOW (a file, a hard link to
 * one or a symlink put in its place fails to open), checks it, and changes it
 * through that descriptor. File modes are untouched. A failure part-way says how
 * many directories it had normalized; removal must not start after one. Darwin
 * only; elsewhere it refuses.
 */
export function normalizeOwnedDirectoryPermissions(root: string, expected?: { dev: number; ino: number }): number {
  if (process.platform !== "darwin") throw Error("Directory permission normalization needs BSD find and chmod -h; removal was not started");
  let identity = expected;
  if (!identity) {
    let fd: number;
    try { fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch (error) { throw Error(`Directory permission normalization could not open the owned root without following links; removal was not started: ${error instanceof Error ? error.message : String(error)}`); }
    try { const stat = fstatSync(fd); identity = { dev: stat.dev, ino: stat.ino }; } finally { closeSync(fd); }
  }
  const helper = join(dirname(fileURLToPath(import.meta.url)), "normalize-directory-helper.mjs");
  const script = 'cd -P -- "$1" || exit 3\n'
    + 'here=$(/usr/bin/stat -f "%d %i" .) || exit 4\n'
    + '[ "$here" = "$2 $3" ] || { echo "the owned root changed identity before the walk" >&2; exit 5; }\n'
    + 'exec /usr/bin/find -P . -type d ! -perm -300 -execdir "$4" "$5" {} +';
  const result = spawnSync("/bin/sh", ["-c", script, "sh", root, String(identity.dev), String(identity.ino), process.execPath, helper],
    { encoding: "utf8", timeout: 120_000 });
  // One JSON line per entry the helper handled: newline-safe, and a failed
  // change is reported by the helper itself, since `find` may not propagate it.
  const lines = (result.stdout ?? "").split("\n").filter(Boolean);
  const records = lines.map(line => { try { return JSON.parse(line) as { ok?: string; fail?: string; reason?: string }; } catch { return { fail: line, reason: "unreadable helper output" }; } });
  const reached = records.filter(record => record.ok !== undefined).length;
  const failure = records.find(record => record.fail !== undefined);
  if (failure || result.status !== 0 || result.error) {
    const why = failure ? `${failure.fail}: ${failure.reason}` : (result.stderr ?? "").trim() || result.error?.message || `exit ${result.status ?? result.signal}`;
    throw Error(`Directory permission normalization stopped after normalizing ${reached} director${reached === 1 ? "y" : "ies"}; removal was not started: ${why}`);
  }
  return reached;
}

/** Read `.git` without following a link: open no-follow, verify that descriptor is a regular file, read it. */
function readWorktreeMarker(path: string): string | "directory" {
  if (lstatSync(path).isDirectory()) return "directory";
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw Error(`Preserving workspace: its .git could not be opened without following links: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    if (!fstatSync(fd).isFile()) throw Error("Preserving workspace: its .git is neither a worktree file nor a repository");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

export type OrphanWorktree =
  | { orphaned: true; adminDir: string; detail: string }
  | { orphaned: false };

export async function classifyOrphanWorktree(input: { directory: string; repoPath: string; dataDir: string; taskId: string; continuing?: boolean }): Promise<OrphanWorktree> {
  const commonDir = await repoCommonDir(input.repoPath);
  const self = lstatSync(input.directory);
  if (self.isSymbolicLink() || !self.isDirectory()) throw Error("Preserving workspace: the directory is not a real directory");
  // The exact owned path, with no symlink at the directory or any ancestor below the data dir.
  assertCanonicalOwnedPath(input.directory, input.dataDir, commonDir, input.taskId);
  const adminDir = join(commonDir, "worktrees", basename(input.directory));
  let marker: string | "directory" | null;
  try { marker = readWorktreeMarker(join(input.directory, ".git")); }
  catch (error) {
    // Its own earlier discard removal may already have deleted `.git`: only a
    // recorded archive intent under that discard continues without it.
    if (!input.continuing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    marker = null;
  }
  if (marker === "directory") return { orphaned: false };
  if (marker !== null && marker.trim() !== `gitdir: ${adminDir}`)
    throw Error("Preserving workspace: its .git does not name this repository's worktree record for it");
  try {
    lstatSync(adminDir);
    return { orphaned: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw Error(`Preserving workspace: its worktree record could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Git must positively not know this worktree: a failed listing is not absence.
  const listed = parseWorktreeList(await git(input.repoPath, "worktree", "list", "--porcelain"));
  const real = realpathSync(input.directory);
  if (listed.some(tree => { try { return realpathSync(tree.path) === real; } catch { return tree.path === input.directory; } }))
    throw Error("Preserving workspace: Git still lists the worktree although its record is missing");
  return { orphaned: true, adminDir, detail: marker === null
    ? `continuing its own discard removal: .git already removed, its record ${adminDir} is missing and git worktree list omits it; branch identity unproven`
    : `worktree orphaned: its record ${adminDir} is missing and git worktree list omits it; branch identity unproven` };
}
export const workspaceDiscardKey = (taskId: string, workspaceId: string) => `workspaceDiscard:${taskId}:${workspaceId}`;
