import type { OrphanWorkspace, WorkspaceCreationState } from '../host/types';
export type { OrphanWorkspace, WorkspaceCreationState } from '../host/types';
/**
 * Queue-owned initial workspace allocation. Git populates the linked worktree
 * under the bulk ceiling; Paseo then registers the existing directory. A
 * timeout is a partial leftover, never absence and never permission to replay.
 */
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Task } from "../../shared/contracts";
import { GIT_SLOW_TIMEOUT_MS, git, gitBulk, gitSlow, queueCheckoutStatus } from "../git/index";
import { findGitWorktreeAdd, type ProcessSearch } from "../machine/process-identity";
import { digest } from "../store/store";
import { taskCheckoutTarget } from "./checkout-target";

export { taskCheckoutTarget };

export const WORKSPACES_DIR = "workspaces";
export const WORKSPACE_POPULATE_BUDGET_MS = GIT_SLOW_TIMEOUT_MS;
/** Exact lock reason Paseo leaves on a worktree it was still creating. */
export const PASEO_INIT_LOCK_REASON = "initializing";

export interface ListedWorktree {
  path: string;
  head: string;
  branch: string;
  locked: boolean;
  lockReason: string;
}

export const workspaceDataDirFor = (helperPath: string) => dirname(helperPath);

/** Reuse a retained project's installed Node dependencies in an isolated checkout. */
export function retainNodeModules(sourceDirectory: string, checkoutDirectory: string): boolean {
  const source = join(sourceDirectory, "node_modules");
  const destination = join(checkoutDirectory, "node_modules");
  try { if (!statSync(source).isDirectory()) return false; }
  catch { return false; }
  try { statSync(destination); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
  if (source === destination) return false;
  try { symlinkSync(source, destination, "dir"); return true; }
  catch (error) {
    // A concurrent creator or an existing dangling link owns the destination;
    // never replace it as part of dependency retention.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export const ownedWorkspaceRoot = (dataDir: string, gitCommonDir: string) =>
  join(dataDir, WORKSPACES_DIR, digest(gitCommonDir));

export const ownedWorkspacePath = (dataDir: string, gitCommonDir: string, taskId: string) =>
  join(ownedWorkspaceRoot(dataDir, gitCommonDir), `ns-${taskId}`);

export class WorkspaceObservationUnavailableError extends Error {}

/** Resolve existing ancestors too: a temporarily absent leaf does not erase a root alias. */
function observedWorkspacePath(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw error;
    return join(observedWorkspacePath(parent), basename(path));
  }
}

export function sameWorkspacePath(a: string, b: string): boolean {
  if (a === b) return true;
  try { return observedWorkspacePath(a) === observedWorkspacePath(b); }
  catch (error) {
    throw new WorkspaceObservationUnavailableError(`Workspace identity could not be checked: ${String(error)}`);
  }
}

export function isOwnedWorkspacePath(path: string, dataDir: string, gitCommonDir: string, taskId: string): boolean {
  return sameWorkspacePath(path, ownedWorkspacePath(dataDir, gitCommonDir, taskId));
}

export function parseWorktreeList(porcelain: string): ListedWorktree[] {
  const trees: ListedWorktree[] = [];
  for (const block of porcelain.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find(line => line.startsWith("worktree "))?.slice(9);
    if (!path) continue;
    const lock = lines.find(line => line === "locked" || line.startsWith("locked "));
    trees.push({
      path,
      head: lines.find(line => line.startsWith("HEAD "))?.slice(5) ?? "",
      branch: lines.find(line => line.startsWith("branch "))?.slice(7) ?? "",
      locked: Boolean(lock),
      lockReason: lock?.slice(7).trim() ?? "",
    });
  }
  return trees;
}

export async function repoCommonDir(repoPath: string): Promise<string> {
  try {
    const common = await git(repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (!common || !isAbsolute(common)) throw new Error('Git returned no absolute common directory');
    return realpathSync(common);
  } catch (error) {
    throw new WorkspaceObservationUnavailableError(`Repository identity could not be checked: ${String(error)}`);
  }
}

async function sameCommonDir(repoPath: string, directory: string): Promise<boolean> {
  return await repoCommonDir(repoPath) === await repoCommonDir(directory);
}

type InspectionStep = <T>(name: string, work: () => Promise<T>) => Promise<T>;

async function inspectionStep<T>(step: InspectionStep | undefined, name: string, work: () => Promise<T>): Promise<T> {
  return step ? step(name, work) : work();
}

async function pushRemote(task: Pick<Task, "repoPath" | "branch">, step?: InspectionStep): Promise<string | null> {
  const config = async (key: string) => inspectionStep(step, "git_config", () =>
    git(task.repoPath, "config", "--get", key).catch(() => ""));
  const configured = await config(`branch.${task.branch}.pushRemote`)
    || await config("remote.pushDefault")
    || await config(`branch.${task.branch}.remote`)
    || "origin";
  const remotes = (await inspectionStep(step, "git_remote", () => git(task.repoPath, "remote"))).split("\n").filter(Boolean);
  return remotes.includes(configured) ? configured : null;
}

async function unpublishedBaseIdentical(
  task: Pick<Task, "repoPath" | "branch" | "baseBranch">,
  head: string,
  options: { skipRemoteCheck?: boolean; step?: InspectionStep } = {},
): Promise<string | null> {
  if (Number(await inspectionStep(options.step, "git_rev_list", () =>
    git(task.repoPath, "rev-list", "--count", `refs/heads/${task.baseBranch}..${head}`))) !== 0)
    return "the branch has commits beyond base";
  if (await inspectionStep(options.step, "git_remote_ref_scan", () =>
    git(task.repoPath, "for-each-ref", "--format=%(refname)", `refs/remotes/*/${task.branch}`)))
    return "the branch exists on a remote";
  if (!options.skipRemoteCheck) {
    const remote = await pushRemote(task, options.step);
    if (remote && await inspectionStep(options.step, "git_ls_remote", () =>
      git(task.repoPath, "ls-remote", "--heads", remote, task.branch)))
      return `the branch is published to ${remote}`;
  }
  return null;
}

export function workspaceCreationRefusal(state: WorkspaceCreationState): string {
  switch (state.kind) {
    case "still_running":
      return `Workspace creation is still running (${state.evidence}); awaiting that process, not retrying creation`;
    case "unknown":
      return `Workspace creation is uncertain (${state.evidence}); awaiting a visible result, not retrying creation`;
    case "partial":
      // The stop names the owner verb and fields that exit it, never an internal
      // parameter: `retry_effect effect=workspace_creation discard=true` removes
      // the proven orphan and replays the same create once (nucleus#1106).
      return `Paseo left an orphan ${state.orphan.directory ? `worktree at ${state.orphan.directory} (locked: ${state.orphan.lockReason})` : "branch with no worktree"} on branch ${state.orphan.branch} at ${state.orphan.head}, base-identical and unpublished. Retry with retry_effect effect=workspace_creation discard=true; it removes the orphan and replays the same create once`;
    case "conflicting":
      return `Task worktree or branch left by an earlier create is not a provable orphan (${state.evidence}); resolve it manually before replaying creation`;
    case "found_done":
      return `Complete unpublished checkout exists at ${state.directory}; bind it, do not replay`;
    case "proof_head_mismatch":
      return `Proof-only checkout at ${state.directory} is clean but at ${state.head}, not the required commit; re-detach it before execution`;
    case "absent":
      return "Workspace creation is absent from inventory; retry_effect effect=workspace_creation replays the same create once";
  }
}

export async function classifyWorkspaceCreation(input: {
  task: Pick<Task, "id" | "repoPath" | "branch" | "baseBranch" | "planningBase" | "planningCommit" | "proofOnly">;
  ownedPath: string;
  /** Previous Queue allocation paths remain part of the same creation intent. */
  legacyPaths?: string[];
  /** Prove a matched external checkout before inspecting its contents. */
  admitObserved?: (path: string) => void;
  /** Skip the process-table scan only when this dispatch just completed git worktree add. */
  skipProcessScan?: boolean;
  /** The just-populated branch cannot yet have been published by this task. */
  skipRemoteCheck?: boolean;
  /** Optional durable timing wrapper for Git inspection substeps. */
  step?: InspectionStep;
  scan?: (targetPath: string) => ProcessSearch;
}): Promise<WorkspaceCreationState> {
  const { task, ownedPath } = input;
  const paths = [...new Set([ownedPath, ...(input.legacyPaths ?? [])])];
  if (!input.skipProcessScan) {
    for (const path of paths) {
      const live = (input.scan ?? findGitWorktreeAdd)(path);
      if (live.state === "found")
        return { kind: "still_running", evidence: `git worktree add is live at pid ${live.pid} targeting ${path}` };
      if (live.state === "unknown")
        return { kind: "unknown", evidence: `host process listing could not prove whether git worktree add is still targeting ${path}` };
    }
  }

  const slug = `ns-${task.id}`;
  const ref = task.proofOnly ? null : `refs/heads/${task.branch}`;
  const listing = await inspectionStep(input.step, "git_worktree_list", () => git(task.repoPath, "worktree", "list", "--porcelain")).catch(() => null);
  if (listing === null) return { kind: "unknown", evidence: "Git worktree inventory could not be read" };
  const matched = parseWorktreeList(listing).filter(tree =>
    paths.includes(tree.path) || tree.path.split("/").at(-1) === slug || Boolean(ref && tree.branch === ref));
  if (matched.length > 1)
    return { kind: "conflicting", evidence: `multiple worktrees match this task: ${matched.map(tree => tree.path).join(", ")}` };

  const tree = matched[0];
  if (tree) input.admitObserved?.(tree.path);
  const branchHead = ref ? await inspectionStep(input.step, "git_rev_parse", () => git(task.repoPath, "rev-parse", "--verify", ref)).catch(() => "") : "";
  const existingPaths = paths.filter(path => existsSync(path));
  if (existingPaths.length > 1)
    return { kind: "conflicting", evidence: `multiple owned paths exist for this task: ${existingPaths.join(", ")}` };
  const pathExists = existingPaths.length > 0 || Boolean(tree && existsSync(tree.path));
  if (!tree && !pathExists && !branchHead) return { kind: "absent" };

  if (tree && (ref ? Boolean(tree.branch && tree.branch !== ref) : Boolean(tree.branch)))
    return { kind: "conflicting", evidence: `${tree.path} is on ${tree.branch}` };
  if (tree?.locked && tree.lockReason !== PASEO_INIT_LOCK_REASON)
    return { kind: "conflicting", evidence: `${tree.path} is not locked with the exact reason "${PASEO_INIT_LOCK_REASON}"` };
  if (tree && branchHead && tree.head && tree.head !== branchHead)
    return { kind: "conflicting", evidence: `${tree.path} is at ${tree.head || "an unknown commit"}, not the task branch tip` };

  const head = (tree?.head || branchHead) || "";
  if (head && !task.proofOnly) {
    const published = await unpublishedBaseIdentical(task, head, { skipRemoteCheck: input.skipRemoteCheck, step: input.step });
    if (published) return { kind: "conflicting", evidence: published };
  }

  const directory = tree?.path ?? existingPaths[0] ?? null;
  if (tree && existingPaths.length && !sameWorkspacePath(tree.path, existingPaths[0]))
    return { kind: "conflicting", evidence: `worktree ${tree.path} and owned path ${existingPaths[0]} differ` };
  if (directory && !await sameCommonDir(task.repoPath, directory))
    return { kind: "conflicting", evidence: `${directory} does not share the task repository` };

  const dirty = directory && existsSync(directory)
    ? await queueCheckoutStatus(directory, "status", "--porcelain").catch(() => "unreadable")
    : "";
  const initializing = Boolean(tree?.locked && tree.lockReason === PASEO_INIT_LOCK_REASON);
  const atOwned = Boolean(directory && paths.some(path => sameWorkspacePath(directory, path)));
  const checkoutTarget = taskCheckoutTarget(task);
  if (task.proofOnly && tree && !tree.branch && tree.head !== checkoutTarget && atOwned && !initializing) {
    if (dirty) return { kind: "conflicting", evidence: `${directory} is dirty; refusing to change the proof-only checkout from ${tree.head} to ${checkoutTarget}` };
    return { kind: "proof_head_mismatch", directory: directory!, head: tree.head };
  }
  if (tree && (task.proofOnly ? !tree.branch && tree.head === checkoutTarget : tree.branch === ref && tree.head === branchHead)
    && !initializing && !dirty && directory && existsSync(directory))
    return { kind: "found_done", directory };

  if (!head && directory) return { kind: "conflicting", evidence: `${directory} has no task branch` };

  // Removable leftover: Queue-owned populate, Paseo's locked-initializing
  // worktree, or a base-identical unpublished branch with no worktree. An
  // unlocked dirty slug/branch match at any other path is authored work.
  if (directory && !atOwned && !initializing)
    return {
      kind: "conflicting",
      evidence: dirty
        ? `${directory} is unlocked and dirty; it is not a Queue-owned populate leftover or a Paseo initializing lock`
        : `${directory} is not locked with the exact reason "${PASEO_INIT_LOCK_REASON}"`,
    };

  const orphan: OrphanWorkspace = {
    directory,
    branch: task.branch,
    head,
    lockReason: initializing ? PASEO_INIT_LOCK_REASON : "partial",
  };
  const where = directory ? `worktree at ${directory} (locked: ${orphan.lockReason})` : "branch with no worktree";
  return {
    kind: "partial",
    orphan,
    evidence: `${where} on branch ${task.branch} at ${head || "an unknown commit"} is an unpublished populate leftover`,
  };
}

export async function populateOwnedWorktree(input: {
  task: Pick<Task, "id" | "repoPath" | "branch" | "baseBranch" | "planningBase" | "planningCommit" | "proofOnly">;
  ownedPath: string;
  legacyPaths?: string[];
  admitObserved?: (path: string) => void;
  admit?: () => void;
  scan?: (targetPath: string) => ProcessSearch;
}): Promise<{ directory: string; populated: boolean; budgetMs: number; elapsedMs: number }> {
  const started = Date.now();
  const state = await classifyWorkspaceCreation(input);
  if (state.kind === "found_done")
    return { directory: state.directory, populated: false, budgetMs: WORKSPACE_POPULATE_BUDGET_MS, elapsedMs: Date.now() - started };
  if (state.kind === "proof_head_mismatch") {
    input.admit?.();
    const target = taskCheckoutTarget(input.task);
    await git(state.directory, "checkout", "--detach", target);
    const head = await git(state.directory, "rev-parse", "HEAD");
    if (head !== target)
      throw new Error(`Proof-only checkout remained at ${head} after detaching ${target}`);
    const verified = await classifyWorkspaceCreation(input);
    if (verified.kind !== "found_done") throw new Error(workspaceCreationRefusal(verified));
    return { directory: verified.directory, populated: false, budgetMs: WORKSPACE_POPULATE_BUDGET_MS, elapsedMs: Date.now() - started };
  }
  if (state.kind !== "absent") throw new Error(workspaceCreationRefusal(state));
  input.admit?.();
  mkdirSync(dirname(input.ownedPath), { recursive: true, mode: 0o700 });
  input.admit?.();
  const startPoint = taskCheckoutTarget(input.task);
  await gitBulk(input.task.repoPath, "worktree", "add", ...(input.task.proofOnly ? ["--detach"] : ["-b", input.task.branch]), input.ownedPath, startPoint);
  return { directory: input.ownedPath, populated: true, budgetMs: WORKSPACE_POPULATE_BUDGET_MS, elapsedMs: Date.now() - started };
}

export async function removeOrphanCheckout(
  task: Pick<Task, "repoPath" | "branch" | "proofOnly">,
  orphan: OrphanWorkspace,
  ownedPath: string | null,
): Promise<void> {
  if (orphan.directory) {
    const owned = Boolean(ownedPath && sameWorkspacePath(orphan.directory, ownedPath));
    if (!owned && orphan.lockReason !== PASEO_INIT_LOCK_REASON)
      throw new Error(`${orphan.directory} is not a Queue-owned leftover or a Paseo initializing lock`);
    if (orphan.lockReason === PASEO_INIT_LOCK_REASON)
      await git(task.repoPath, "worktree", "unlock", orphan.directory);
    if (existsSync(orphan.directory)) {
      try { await gitSlow(task.repoPath, "worktree", "remove", "--force", orphan.directory); }
      catch (error) {
        if (!owned) throw error;
        rmSync(orphan.directory, { recursive: true, force: true });
      }
    } else await git(task.repoPath, "worktree", "prune");
  }
  if (orphan.head && task.branch)
    await git(task.repoPath, "update-ref", "-d", `refs/heads/${orphan.branch}`, orphan.head);
}

/** `force` only under an owner discard: it removes uncommitted contents the owner accepted losing. */
export async function removeOwnedWorktree(repoPath: string, directory: string, force = false): Promise<void> {
  await gitBulk(repoPath, "worktree", "remove", ...(force ? ["--force"] : []), directory);
}
