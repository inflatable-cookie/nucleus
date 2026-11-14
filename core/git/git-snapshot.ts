import { randomUUID } from "node:crypto";
import { copyFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { normalizeRepoRelativePath, pathIsAllowed, type MergeCandidate } from "../../shared/hooks";
import { isOsMetadataPath, isQueueRetainedNodeModulesLink } from "./index";
import { gitRun, formatGitError } from "./git-command";

/** Prefix of the per-invocation scratch index the read-only baseline snapshots through. */
export const SCRATCH_INDEX_PREFIX = "nucleus-index-";

export async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitRun(cwd, args);
  if (result.code !== 0) throw new Error(formatGitError(args, result.code, result.signal, result.stderr));
  return result.stdout.toString("utf8").trim();
}

/** Git text with an explicit extra environment, used for deterministic synthetic commits. */
export async function gitTextEnv(cwd: string, env: Record<string, string>, ...args: string[]): Promise<string> {
  const result = await gitRun(cwd, args, undefined, env);
  if (result.code !== 0) throw new Error(formatGitError(args, result.code, result.signal, result.stderr));
  return result.stdout.toString("utf8").trim();
}

interface StatusEntry { index: string; worktree: string; path: string; ignored: boolean }
export function parsePorcelain(bytes: Buffer): StatusEntry[] {
  const tokens = bytes.toString("utf8").split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") index++;
    entries.push({ index: status[0], worktree: status[1], path, ignored: status === "!!" });
  }
  return entries;
}

/**
 * Read the bounded shared status inventory. Callers that do not need ignored
 * material skip it entirely. When ignored paths are requested, matching mode
 * reports an ignored directory as one branch boundary instead of every leaf
 * below it, so a large runtime cache cannot exhaust the Git safety buffer.
 * Non-ignored tracked, staged, renamed, deleted and untracked state stays
 * exhaustive either way.
 */
export async function statusEntries(root: string, includeIgnored = true): Promise<StatusEntry[]> {
  const result = await gitRun(root, ["status", "--porcelain=v1", "-z", ...(includeIgnored ? ["--ignored=matching"] : []), "--untracked-files=all"]);
  if (result.code !== 0) throw new Error(formatGitError(["status"], result.code, result.signal, result.stderr));
  const entries = parsePorcelain(result.stdout);
  return entries.filter(entry => {
    if (((entry.index === "?" || entry.worktree === "?") || entry.ignored) && isOsMetadataPath(entry.path)) return false;
    return !(isQueueRetainedNodeModulesLink(root) && entry.index === "?" && entry.worktree === "?"
      && (entry.path === "node_modules" || entry.path === "node_modules/"));
  });
}

/** Read comparison-only status without refreshing or locking the shared index. */
async function snapshotStatusEntries(root: string): Promise<StatusEntry[]> {
  const result = await gitRun(root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (result.code !== 0) throw new Error(formatGitError(["status"], result.code, result.signal, result.stderr));
  return parsePorcelain(result.stdout).filter(entry => !(((entry.index === "?" || entry.worktree === "?") || entry.ignored) && isOsMetadataPath(entry.path)));
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
  try {
    const entries = await statusEntries(root, false);
    if (entries.length) return false;
    return await gitText(root, "rev-parse", "HEAD") === commit;
  } catch { return false; }
}

/** True when an isolated repository is on the declared branch at the base with no changed files. */
export async function isolatedRepositoryIsCleanAt(path: string, commit: string, branch: string): Promise<boolean> {
  try {
    if (await gitText(path, "rev-parse", "HEAD") !== commit) return false;
    if (await gitText(path, "branch", "--show-current") !== branch) return false;
    return (await statusEntries(path, false)).length === 0;
  } catch { return false; }
}

/**
 * Prove the retained task workspace still holds the accepted reviewed head on
 * the queue-owned branch with a clean worktree and a matching published remote
 * branch. Any drift is an operational hold, never a semantic finding.
 */
export async function verifyReviewedHead(root: string, branch: string, baseCommit: string): Promise<void> {
  if (await gitText(root, "branch", "--show-current") !== branch) throw new Error(`Reviewed-head gate requires the queue-owned branch ${branch}`);
  if ((await statusEntries(root, false)).length) throw new Error("Reviewed-head gate requires a clean retained workspace");
  const head = await gitText(root, "rev-parse", "HEAD");
  if (head !== baseCommit) throw new Error("Reviewed-head gate local HEAD differs from the accepted PR head");
  await gitText(root, "fetch", "origin", branch);
  if (await gitText(root, "rev-parse", `refs/remotes/origin/${branch}`) !== head) throw new Error("Reviewed-head gate remote branch differs from the accepted PR head");
}

export async function verifyRetainedWorktree(root: string, head: string): Promise<void> {
  const info = await lstat(root).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new Error("Retention gate requires the retained task worktree");
  if (await gitText(root, "rev-parse", "HEAD") !== head) throw new Error("Retention gate worktree HEAD changed");
}

/**
 * Prove a Queue-owned prospective merge candidate is still at its pinned
 * synthetic commit and tree with a clean worktree. Any drift is an operational
 * hold: Queue never converts a displaced candidate into a policy finding.
 */
export async function verifyMergeCandidate(root: string, candidate: MergeCandidate | null): Promise<void> {
  if (!candidate) throw new Error("the prospective-merge occurrence has no pinned candidate identity");
  if ((await statusEntries(root, false)).length) throw new Error("the Queue-owned candidate checkout is not clean");
  const head = await gitText(root, "rev-parse", "HEAD");
  if (head !== candidate.commit) throw new Error("the Queue-owned candidate commit changed");
  if (await gitText(root, "rev-list", "--parents", "-n", "1", "HEAD") !== `${candidate.commit} ${candidate.integrationBase} ${candidate.reviewedHead}`)
    throw new Error("the Queue-owned candidate parents changed");
  const tree = await gitText(root, "rev-parse", "HEAD^{tree}");
  if (tree !== candidate.tree) throw new Error("the Queue-owned candidate tree changed");
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

