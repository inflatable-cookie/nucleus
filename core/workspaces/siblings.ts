import { basename, join } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { git as defaultGit } from "../git/index";
import { removeTree } from "./tree-removal";
import type { Project, SiblingFinding, SiblingPin, Task } from "../../shared/contracts";

type GitFn = (cwd: string, ...args: string[]) => Promise<string>;

/** Queue-owned root for sibling worktrees under the Queue data directory. */
export const SIBLING_DIR = "siblings";
export const siblingRootFor = (dataDir: string) => join(dataDir, SIBLING_DIR);
export const siblingTaskRootFor = (dataDir: string, taskId: string) => join(siblingRootFor(dataDir), taskId);
export const siblingPathFor = (dataDir: string, taskId: string, name: string) => join(siblingTaskRootFor(dataDir, taskId), name);

/** Filesystem-safe sibling directory name for a project repository row. */
export function siblingNameFor(repo: { origin: string | null; path: string }): string {
  const raw = repo.origin?.split("/").at(-1) || basename(repo.path) || "sibling";
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "sibling";
}

/** Identity shown on pins, prompts and findings: the normalised origin, else the path hint. */
export const siblingIdentity = (repo: { origin: string | null; path: string }) => repo.origin || repo.path;

/** Shared task and project-QA policy for an optional member without a checkout. */
export function missingSiblingCheckout(member: { path: string }): string | null {
  return !member.path || !existsSync(member.path) ? "No recorded local checkout for this sibling repository" : null;
}

/** True when a project row names the task's own repository. */
function isOwnRepository(row: { origin: string | null; path: string }, task: Pick<Task, "repoPath" | "repository">): boolean {
  if (row.origin && task.repository && row.origin === task.repository) return true;
  return Boolean(row.path) && row.path === task.repoPath;
}

/**
 * The sibling repositories of a task's project: every member except the task's
 * own repository. A single-repository project (or a missing project) has none.
 */
export function siblingMembers(task: Pick<Task, "repoPath" | "repository">, project: Project | null): { origin: string | null; path: string }[] {
  if (!project) return [];
  return project.repositories.filter(repo => !isOwnRepository(repo, task));
}

/** `queue.siblings: false` skips sibling worktrees; prompts are then unchanged. */
export const siblingsEnabled = (task: Pick<Task, "siblings">) => task.siblings !== false;

export interface SiblingCreation {
  pins: SiblingPin[];
  /** Members with no usable local checkout: named in the creation event, never fabricated. */
  skipped: { repository: string; reason: string }[];
}

/**
 * Create one detached sibling worktree per project member, pinned at
 * `origin/<base>` as fetched at task start from each sibling's own recorded
 * checkout. Paths live under the Queue data directory, never in an operator
 * checkout, and nothing is merged or pushed.
 *
 * Creation is recorded as intent first by the caller (`siblingIntent`); an
 * uncertain creation reconciles by path and commit below and is never
 * recreated blindly: a path whose HEAD already equals the freshly fetched
 * base is reused as-is.
 */
export async function createSiblingWorktrees(options: {
  dataDir: string;
  taskId: string;
  baseBranch: string;
  members: { origin: string | null; path: string }[];
  git?: GitFn;
}): Promise<SiblingCreation> {
  const git = options.git ?? defaultGit;
  const pins: SiblingPin[] = [];
  const skipped: SiblingCreation["skipped"] = [];
  const usedNames = new Set<string>();
  for (const member of options.members) {
    const repository = siblingIdentity(member);
    const missingCheckout = missingSiblingCheckout(member);
    if (missingCheckout) {
      skipped.push({ repository, reason: missingCheckout });
      continue;
    }
    let base: string;
    try {
      await git(member.path, "fetch", "origin", options.baseBranch);
      base = await git(member.path, "rev-parse", `refs/remotes/origin/${options.baseBranch}`);
    } catch (error) {
      skipped.push({ repository, reason: `Sibling base is unavailable: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    let name = siblingNameFor(member);
    for (let suffix = 2; usedNames.has(name); suffix++) name = `${siblingNameFor(member)}-${suffix}`;
    usedNames.add(name);
    const path = siblingPathFor(options.dataDir, options.taskId, name);
    const reconciled = await reconcileSiblingWorktree(member.path, path, base, git);
    if (!reconciled.reused) {
      mkdirSync(join(options.dataDir, SIBLING_DIR, options.taskId), { recursive: true });
      try {
        await git(member.path, "worktree", "add", "--detach", path, base);
      } catch (error) {
        // An existing path that is not reusable at the fetched base (a stale
        // worktree, a foreign directory, a file) is left untouched and the
        // member is skipped. Creation never recreates blindly and never parks
        // dispatch for one sibling: the skip is named in the creation event.
        skipped.push({ repository, reason: `Sibling worktree path is unusable: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
    }
    pins.push({ repository, path, commit: base });
  }
  return { pins, skipped };
}

/**
 * Reconcile an uncertain sibling creation by path and commit: a worktree path
 * that already exists at exactly the fetched base is reused, never recreated.
 */
async function reconcileSiblingWorktree(repoPath: string, path: string, base: string, git: GitFn): Promise<{ reused: boolean }> {
  if (!existsSync(path)) return { reused: false };
  try {
    const head = await git(path, "rev-parse", "HEAD");
    if (head !== base) return { reused: false };
    const common = await git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const canonical = await git(repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (common !== canonical) return { reused: false };
    if (await git(path, "status", "--porcelain")) return { reused: false };
    return { reused: true };
  } catch {
    return { reused: false };
  }
}

export interface SiblingInspection {
  repository: string;
  path: string;
  expected: string;
  /** Null when the worktree is gone or unreadable; the path evidence still records the finding. */
  actual: string | null;
  dirty: boolean;
  changed: boolean;
}

/**
 * Compare every sibling worktree with its recorded commit. A moved head, a new
 * commit or dirty files is a change; the worktree is never merged or pushed.
 */
export async function inspectSiblingWorktrees(pins: SiblingPin[], git: GitFn = defaultGit): Promise<SiblingInspection[]> {
  const inspections: SiblingInspection[] = [];
  for (const pin of pins) {
    let actual: string | null = null;
    let dirty = false;
    try {
      if (existsSync(pin.path)) {
        actual = await git(pin.path, "rev-parse", "HEAD");
        dirty = Boolean(await git(pin.path, "status", "--porcelain"));
      }
    } catch {
      actual = null;
    }
    inspections.push({ repository: pin.repository, path: pin.path, expected: pin.commit, actual, dirty, changed: actual !== pin.commit || dirty });
  }
  return inspections;
}

/** A changed inspection becomes a durable sibling-change finding. */
export function findingFor(inspection: SiblingInspection, at: string): SiblingFinding | null {
  if (!inspection.changed) return null;
  return { repository: inspection.repository, path: inspection.path, expected: inspection.expected, actual: inspection.actual, dirty: inspection.dirty, at };
}

/**
 * Remove a task's sibling worktrees with the task's own, through the same
 * retention and disposition paths. Only paths under this task's Queue-owned
 * sibling root are touched; operator checkouts are never affected.
 */
export async function removeSiblingWorktrees(dataDir: string, taskId: string, git: GitFn = defaultGit): Promise<{ removed: string[] }> {
  const root = siblingTaskRootFor(dataDir, taskId);
  const removed: string[] = [];
  if (!existsSync(root)) return { removed };
  // Detach each worktree from its own repository first so no administrative
  // Git state lingers; a missing checkout then falls back to directory removal.
  const entries = readdirSync(root, { withFileTypes: true }).map(entry => join(root, entry.name));
  for (const path of entries) {
    try {
      const toplevel = await git(path, "rev-parse", "--path-format=absolute", "--show-toplevel").catch(() => null);
      const common = toplevel ? await git(path, "rev-parse", "--path-format=absolute", "--git-common-dir").catch(() => null) : null;
      if (toplevel && common) {
        const admin = join(common, "worktrees", basename(path));
        await git(toplevel, "worktree", "remove", "--force", path).catch(() => removeTree(path));
        void admin;
      } else {
        await removeTree(path);
      }
    } catch {
      // A checkout's own removal must never starve the reads this thread serves.
      await removeTree(path);
    }
    removed.push(path);
  }
  await removeTree(root);
  return { removed };
}
