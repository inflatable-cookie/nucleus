import { readdir } from "node:fs/promises";
import { dirname, join, parse as parsePath } from "node:path";
import { git as defaultGit } from "../git/index";
import { missingAlternatesTarget, repairSiblingStore, shareSiblingInStore, type CheckoutShare } from "../store/sibling-store";
import type { CheckoutSiblingFinding, Task } from "../../shared/contracts";

type GitFn = (cwd: string, ...args: string[]) => Promise<string>;

/** Paseo worktree slugs: `ns-<uuid>`, collision `ns-<uuid>-N`, closeout `ns-closeout-<uuid>`. */
export const QUEUE_WORKTREE_DIR = /^ns-(?:closeout-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[0-9]+)?$/i;

export const isQueueTaskWorktreeName = (name: string) => QUEUE_WORKTREE_DIR.test(name);

export interface CheckoutForward {
  path: string;
  name: string;
  from: string;
  to: string;
}

export interface CheckoutRefresh {
  forwarded: CheckoutForward[];
  findings: CheckoutSiblingFinding[];
  /** Siblings whose Git objects now share the host-level store (Spec 028). */
  shared: CheckoutShare[];
}

/**
 * Parent of the task worktree, or of another live task of the same repository
 * that already has a directory. Never a filesystem root.
 */
export function worktreeRootFor(task: Pick<Task, "directory" | "repoPath">, others: Pick<Task, "directory" | "repoPath">[]): string | null {
  const candidate = task.directory || others.find(other => other.repoPath === task.repoPath && other.directory)?.directory;
  if (!candidate) return null;
  const root = dirname(candidate);
  if (!root || root === parsePath(root).root) return null;
  return root;
}

async function isGitCheckoutRoot(path: string, git: GitFn): Promise<boolean> {
  try {
    return await git(path, "rev-parse", "--path-format=absolute", "--show-toplevel") === path;
  } catch {
    return false;
  }
}

/** Git checkouts beside the task worktree that are not Queue task worktrees. */
export async function discoverCheckoutSiblings(root: string, ownDirectory: string | null | undefined, git: GitFn = defaultGit): Promise<string[]> {
  let names: { name: string; directory: boolean }[];
  try {
    names = (await readdir(root, { withFileTypes: true })).map(entry => ({ name: String(entry.name), directory: entry.isDirectory() || entry.isSymbolicLink() }));
  } catch { return []; }
  const siblings: string[] = [];
  for (const entry of names) {
    if (!entry.directory) continue;
    if (entry.name.startsWith(".") || isQueueTaskWorktreeName(entry.name)) continue;
    const path = join(root, entry.name);
    if (ownDirectory && path === ownDirectory) continue;
    if (await isGitCheckoutRoot(path, git)) siblings.push(path);
  }
  return siblings;
}

function finding(path: string, state: CheckoutSiblingFinding["state"], detail: string, extra: Partial<Pick<CheckoutSiblingFinding, "head" | "origin" | "branch">> = {}): CheckoutSiblingFinding {
  return { path, name: path.split("/").pop() || path, state, detail, head: extra.head ?? null, origin: extra.origin ?? null, branch: extra.branch ?? null, at: new Date().toISOString() };
}

async function originDefault(path: string, git: GitFn): Promise<{ ref: string; commit: string } | null> {
  try {
    const ref = await git(path, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
    return { ref, commit: await git(path, "rev-parse", ref) };
  } catch {
    return null;
  }
}

const isAncestor = (git: GitFn, cwd: string, ancestor: string, head: string) =>
  git(cwd, "merge-base", "--is-ancestor", ancestor, head).then(() => true, () => false);

async function refreshOne(path: string, git: GitFn): Promise<{ forward?: CheckoutForward; finding?: CheckoutSiblingFinding }> {
  const name = path.split("/").pop() || path;
  let head: string;
  try { head = await git(path, "rev-parse", "HEAD"); }
  catch (error) {
    return { finding: finding(path, "fetch_failed", `${name} is unreadable: ${error instanceof Error ? error.message : String(error)}`) };
  }
  let dirty = false, branch = "";
  try { dirty = Boolean(await git(path, "status", "--porcelain")); }
  catch (error) {
    return { finding: finding(path, "fetch_failed", `${name} status failed: ${error instanceof Error ? error.message : String(error)}`, { head }) };
  }
  try { branch = await git(path, "branch", "--show-current"); }
  catch { branch = ""; }
  if (dirty) return { finding: finding(path, "dirty", `${name} is dirty${branch ? ` on branch ${branch}` : " (detached)"}; left untouched`, { head, branch: branch || null }) };
  if (branch) return { finding: finding(path, "branched", `${name} is on branch ${branch}; left untouched`, { head, branch }) };
  try { await git(path, "fetch", "origin"); }
  catch (error) {
    return { finding: finding(path, "fetch_failed", `${name} fetch failed: ${error instanceof Error ? error.message : String(error)}`, { head }) };
  }
  const origin = await originDefault(path, git);
  if (!origin) return { finding: finding(path, "fetch_failed", `${name} has no origin default branch; left untouched`, { head }) };
  if (head === origin.commit) return {};
  if (!await isAncestor(git, path, head, origin.commit)) {
    return { finding: finding(path, "diverged", `${name} detached HEAD ${head} is not an ancestor of origin default ${origin.commit}; left untouched`, { head, origin: origin.commit }) };
  }
  try {
    await git(path, "checkout", "--quiet", "--detach", origin.commit);
  } catch (error) {
    return { finding: finding(path, "fast_forward_failed", `${name} fast-forward failed: ${error instanceof Error ? error.message : String(error)}`, { head, origin: origin.commit }) };
  }
  const next = await git(path, "rev-parse", "HEAD");
  if (next !== origin.commit) {
    return { finding: finding(path, "fast_forward_failed", `${name} HEAD ${next} is not origin default ${origin.commit} after checkout; left as-is`, { head: next, origin: origin.commit }) };
  }
  return { forward: { path, name, from: head, to: next } };
}

/**
 * Fetch and fast-forward clean detached siblings; report dirty, branched,
 * diverged or failed checkouts without moving them. When `storeDir` is set,
 * each successfully refreshed sibling is also shared into the host-level
 * object store for its origin, and a checkout whose recorded store vanished
 * is repaired and re-refreshed once in the same pass.
 */
export async function refreshCheckoutSiblings(root: string, ownDirectory: string | null | undefined, options: { storeDir?: string | null; git?: GitFn } = {}): Promise<CheckoutRefresh> {
  const git = options.git ?? defaultGit;
  const storeDir = options.storeDir ?? null;
  const forwarded: CheckoutForward[] = [];
  const findings: CheckoutSiblingFinding[] = [];
  const shared: CheckoutShare[] = [];
  for (const path of await discoverCheckoutSiblings(root, ownDirectory, git)) {
    let result = await refreshOne(path, git);
    if (storeDir) {
      try {
        if (result.finding && await missingAlternatesTarget(path, storeDir, git)) {
          await repairSiblingStore(path, storeDir, git);
          result = await refreshOne(path, git);
        }
        if (!result.finding) {
          const share = await shareSiblingInStore(path, storeDir, git);
          if (share.kind === "shared")
            shared.push({ path, name: path.split("/").pop() || path, store: share.store, head: share.head });
        }
      } catch (error) {
        const name = path.split("/").pop() || path;
        const head = result.finding?.head ?? result.forward?.to ?? null;
        const detail = `${name} shared object store: ${error instanceof Error ? error.message : String(error)}`;
        result = { forward: result.forward, finding: finding(path, "store_failed", detail.slice(0, 2000), { head }) };
      }
    }
    if (result.forward) forwarded.push(result.forward);
    if (result.finding) findings.push(result.finding);
  }
  return { forwarded, findings, shared };
}
