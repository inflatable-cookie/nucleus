import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gitRun, } from "../git/git-command";
import { findGitWorktreeAdd } from "../machine/process-identity";
import { worktreeManifestBlock } from "../workspaces/worktree-links";
import { removeTree } from "../workspaces/tree-removal";
import { parseWorktreeList, repoCommonDir } from "../workspaces/workspace-allocation";
import type { ProjectQaWorktreeHooks } from "./project-qa-supervision-files";
import type { QaPipelineRun } from "./project-qa-pipeline";

/**
 * The one run's Queue-owned QA checkout and the repository's worktree hooks.
 *
 * One owner for creating the run's linked worktree at its base, placing its
 * sibling links, reading the optional `worktree.setup`/`worktree.teardown` from
 * the checkout's `paseo.json`, and removing the checkout through Git with its
 * creation identity re-proven first. A directory this module did not create is
 * never touched.
 */
async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitRun(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout.toString("utf8").trim();
}
export { gitText as projectQaGitText };

/** Read the optional `worktree.setup` and `worktree.teardown` from a manifest's parsed bytes. */
export function parseProjectQaWorktreeHooks(source: string): ProjectQaWorktreeHooks {
  const worktree = worktreeManifestBlock(source);
  for (const key of ["setup", "teardown"] as const) {
    if (worktree[key] !== undefined && typeof worktree[key] !== "string")
      throw new Error(`paseo.json worktree.${key} must be a string`);
  }
  return { setup: (worktree.setup as string | undefined) ?? null, teardown: (worktree.teardown as string | undefined) ?? null };
}

/** Read a checkout's manifest worktree hooks; a missing manifest is no hooks. */
export async function projectQaWorktreeHooks(root: string): Promise<ProjectQaWorktreeHooks> {
  let source: string;
  try { source = readFileSync(join(root, "paseo.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { setup: null, teardown: null };
    throw error;
  }
  return parseProjectQaWorktreeHooks(source);
}

/**
 * Place one sibling link in the run root, matching the path the repository's
 * own `nucleus worktree prepare` derives from the primary checkout. Queue owns
 * this link namespace for the repository's QA root, so a link left by an
 * earlier run (or by a failed teardown of one) is replaced when its source
 * moved; the source checkout itself is never touched.
 */
export async function installQaSiblingLink(runRoot: string, name: string, target: string): Promise<void> {
  const linkPath = join(runRoot, name);
  const existing = await lstat(linkPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isSymbolicLink())
      throw new Error(`Project QA sibling path is occupied by a non-symlink: ${linkPath}`);
    const current = await realpath(linkPath).catch(() => null);
    const wanted = await realpath(target).catch(() => resolve(target));
    if (current === wanted) return;
    await rm(linkPath, { force: true });
  }
  await symlink(target, linkPath);
}

/**
 * Remove one run's Queue-owned checkout. The checkout is a linked worktree of
 * the registered repository, so it is detached through Git first and this
 * run's administrative worktree entry is pruned; a lost run's directory is
 * already gone and only the registration remains. Registered checkout
 * contents are never touched.
 */
export async function removeQaWorkspace(paths: { registeredPath: string; checkoutPath: string; admission?: () => void; expectedHead?: string }): Promise<void> {
  paths.admission?.();
  if (paths.admission) {
    if (!paths.expectedHead || findGitWorktreeAdd(paths.checkoutPath).state !== "absent") throw Error("Project QA creation identity is uncertain");
    const trees = parseWorktreeList(await gitText(paths.registeredPath, "worktree", "list", "--porcelain"))
      .filter(tree => tree.path === paths.checkoutPath);
    if (existsSync(paths.checkoutPath)) {
      if (trees.length !== 1 || trees[0].head !== paths.expectedHead || trees[0].branch ||
          await repoCommonDir(paths.checkoutPath) !== await repoCommonDir(paths.registeredPath))
        throw Error("Project QA checkout identity changed; preserving it");
    } else if (trees.length) throw Error("Project QA checkout disappearance is uncertain");
    paths.admission();
  }
  // A run from the pre-Spec-022 layout left a private source tree here.
  const marker = await lstat(join(paths.checkoutPath, ".git")).catch(() => null);
  if (existsSync(paths.checkoutPath)) {
    const removed = marker?.isFile() ? await gitRun(paths.registeredPath, ["worktree", "remove", "--force", paths.checkoutPath]) : null;
    if (!removed || removed.code !== 0) {
      if (paths.admission) throw new Error("Project QA checkout removal is uncertain; preserving it");
      await removeTree(paths.checkoutPath);
    }
  }
  if (!paths.admission) await gitRun(paths.registeredPath, ["worktree", "prune"]).catch(() => { /* Legacy cleanup. */ });
}

/**
 * Remove a checkout that died mid-creation: a partial directory and possibly a
 * half-registration whose HEAD cannot equal the run's base. The caller proves
 * the same ownership first (the run's own allocation identity); a live `git
 * worktree add` still targeting the path is never touched. A half-registration
 * is removed without requiring its HEAD to match, which is exactly what
 * distinguishes a partial checkout from a completed one. Afterwards the run
 * retries creation once; whatever is left after that is reaped by retention.
 */
export async function removePartialPipelineCheckout(paths: { registeredPath: string; checkoutPath: string; admission?: () => void }): Promise<void> {
  paths.admission?.();
  if (paths.admission && findGitWorktreeAdd(paths.checkoutPath).state !== "absent")
    throw new Error("Project QA checkout creation may still be running; preserving it");
  if (existsSync(paths.checkoutPath)) {
    const trees = parseWorktreeList(await gitText(paths.registeredPath, "worktree", "list", "--porcelain"))
      .filter(tree => tree.path === paths.checkoutPath);
    let removed = false;
    if (trees.length) removed = (await gitRun(paths.registeredPath, ["worktree", "remove", "--force", paths.checkoutPath])).code === 0;
    if (!removed) await removeTree(paths.checkoutPath);
    await gitRun(paths.registeredPath, ["worktree", "prune"]).catch(() => { /* A stale half-registration is best effort. */ });
  } else {
    await gitRun(paths.registeredPath, ["worktree", "prune"]).catch(() => { /* Nothing to remove. */ });
  }
  paths.admission?.();
}


/** Create the run's checkout as a linked worktree and place its sibling links. */
export async function preparePipelineCheckout(run: QaPipelineRun): Promise<void> {
  await mkdir(run.runRoot, { recursive: true, mode: 0o700 });
  run.checkoutAdmission?.();
  // The run ID is fresh, so this only clears a directory left by an earlier
  // attempt at this exact ID; the registration below is still authoritative.
  if (run.checkoutAdmission) {
    if (existsSync(run.checkoutPath)) throw new Error("Project QA checkout already exists; creation is uncertain");
    await mkdir(dirname(run.checkoutPath), { recursive: true, mode: 0o700 });
    run.checkoutAdmission();
  } else await removeTree(run.checkoutPath);
  await gitText(run.registeredPath, "worktree", "add", "--detach", "--", run.checkoutPath, run.base);
  for (const link of run.links) await installQaSiblingLink(dirname(run.checkoutPath), link.name, link.target);
  const head = await gitText(run.checkoutPath, "rev-parse", "HEAD");
  if (head !== run.base) throw new Error("QA checkout HEAD differs from the fetched integration head");
}

