import { randomUUID } from "node:crypto";
import { copyFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { normalizeRepoRelativePath, pathIsAllowed } from "../../shared/hooks";
import { parseCheckoutStatus, queueCheckoutStatusEntries } from "./git-checkout";
import { formatGitError, gitRun, gitText } from "./git-command";
export { gitText } from "./git-command";

/** Prefix of the per-invocation scratch index the read-only baseline snapshots through. */
export const SCRATCH_INDEX_PREFIX = "nucleus-index-";

/** Git text with an explicit extra environment, used for deterministic synthetic commits. */
export async function gitTextEnv(cwd: string, env: Record<string, string>, ...args: string[]): Promise<string> {
  const result = await gitRun(cwd, args, undefined, env);
  if (result.code !== 0) throw new Error(formatGitError(args, result.code, result.signal, result.stderr));
  return result.stdout.toString("utf8").trim();
}

export const parsePorcelain = parseCheckoutStatus;
type StatusEntry = ReturnType<typeof parseCheckoutStatus>[number];

/**
 * Read the bounded shared status inventory. Callers that do not need ignored
 * material skip it entirely. When ignored paths are requested, matching mode
 * reports an ignored directory as one branch boundary instead of every leaf
 * below it, so a large runtime cache cannot exhaust the Git safety buffer.
 * Non-ignored tracked, staged, renamed, deleted and untracked state stays
 * exhaustive either way.
 */
export async function statusEntries(root: string, includeIgnored = true): Promise<StatusEntry[]> {
  return queueCheckoutStatusEntries(root, { includeIgnored });
}

/** Read comparison-only status without refreshing or locking the shared index. */
async function snapshotStatusEntries(root: string): Promise<StatusEntry[]> {
  return queueCheckoutStatusEntries(root, { includeIgnored: false, noOptionalLocks: true });
}

/**
 * True when a publishable path collides with a reported ignored entry. Git
 * reports an ignored directory as a branch boundary (`dir/`), so the branch
 * itself is compared: a path equal to, below, or above it would be overwritten
 * by synchronization and must hold the transition.
 */
export function ignoredPathCollides(changed: string, entry: string): boolean {
  const branch = entry.replace(/\/+$/, "");
  if (!branch) return false;
  return changed === branch || changed.startsWith(`${branch}/`) || branch.startsWith(`${changed}/`);
}

export interface GitSnapshot { head: string; indexTree: string; status: string }

/**
 * Record the tree of the staged index. `write-tree` writes its cache-tree back
 * through the index it reads, so it locks that file. Every task in a repository
 * shares one integration checkout whose index is also written by lane
 * integration and concurrent baselines; locking it makes a good submission read
 * as a failed baseline. Copying the index to a per-invocation scratch path and
 * pointing this one command's `GIT_INDEX_FILE` at the copy keeps the checkout's
 * own index untouched and unlocked.
 *
 * The index is copied rather than re-derived from HEAD because capturing what is
 * actually staged is the comparison's whole purpose. Git writes its index by
 * atomic rename, so a copy cannot observe a half-written one; it may be a moment
 * stale, which the before/after comparison tolerates.
 */
async function snapshotIndexTree(root: string): Promise<string> {
  const scratch = join(tmpdir(), `${SCRATCH_INDEX_PREFIX}${randomUUID()}`);
  try {
    const reported = await gitText(root, "rev-parse", "--git-path", "index");
    const index = isAbsolute(reported) ? reported : resolve(root, reported);
    // A checkout with no index yet has an empty index; the copy is then absent.
    await copyFile(index, scratch).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    return await gitTextEnv(root, { GIT_INDEX_FILE: scratch }, "write-tree");
  } finally {
    await rm(scratch, { force: true }).catch(() => { /* cleanup must never mask the snapshot outcome */ });
  }
}

export async function snapshotGit(root: string): Promise<GitSnapshot> {
  const head = await gitText(root, "rev-parse", "HEAD");
  const indexTree = await snapshotIndexTree(root);
  // Git-ignored files are runtime-local by repository contract. Hooks may
  // update them, but Queue never stages or publishes them.
  const entries = await snapshotStatusEntries(root);
  const status = entries.map(entry => `${entry.index}${entry.worktree} ${entry.path}`).sort().join("\n");
  return { head, indexTree, status };
}

export async function repositoryIsCleanAt(root: string, commit: string): Promise<boolean> {
  const entries = await statusEntries(root, false);
  if (entries.length) return false;
  return await gitText(root, "rev-parse", "HEAD") === commit;
}

/** True when an isolated repository is on the declared branch at the base with no changed files. */
export async function isolatedRepositoryIsCleanAt(path: string, commit: string, branch: string): Promise<boolean> {
  if (await gitText(path, "rev-parse", "HEAD") !== commit) return false;
  if (await gitText(path, "branch", "--show-current") !== branch) return false;
  return (await statusEntries(path, false)).length === 0;
}

interface ChangedPathInspection { paths: string[]; extra: string[] }
interface ChangedPathOptions { ignored?: "reject" | "runtime" }

/**
 * Inspect actual changes; reject staged, symlinked, special, submodule and
 * undeclared paths. The default keeps ignored mutation fatal, which is the
 * read-only canonical-checkout rule. An integration write passes
 * `{ ignored: "runtime" }` because ignored artifacts in Queue's disposable
 * isolated checkout never enter the publication diff or allowed-path equality.
 */
export async function inspectChangedPaths(root: string, declared: string[], allowed: string[], options: ChangedPathOptions = {}): Promise<ChangedPathInspection> {
  const entries = await statusEntries(root, options.ignored !== "runtime");
  const actual = new Set<string>();
  for (const entry of entries) {
    if (entry.ignored) {
      if (options.ignored === "runtime") continue;
      throw new Error(`Ignored path changed: ${entry.path}`);
    }
    const path = normalizeRepoRelativePath(entry.path);
    if (entry.index !== " " && entry.index !== "?") throw new Error(`Hook staged a path: ${path}`);
    if (!pathIsAllowed(path, allowed)) throw new Error(`Changed path is not declared as allowed: ${path}`);
    const info = await lstat(join(root, path)).catch(() => null);
    if (info && !info.isFile()) throw new Error(`Changed path is not a regular file: ${path}`);
    if (!info) {
      const entryInfo = await gitRun(root, ["ls-tree", "HEAD", "--", path]);
      const mode = entryInfo.stdout.toString("utf8").trim().match(/^(\d{6}) blob /)?.[1];
      if (!mode || !/^100(644|755)$/.test(mode)) throw new Error(`Deleted path was not a regular committed file: ${path}`);
    }
    if ((await gitRun(root, ["ls-files", "--stage", "--", path])).stdout.toString("utf8").startsWith("160000")) throw new Error(`Submodule changes are rejected: ${path}`);
    actual.add(path);
  }
  const paths = [...actual].sort();
  const extra = paths.filter(path => !declared.includes(path));
  return { paths, extra };
}

