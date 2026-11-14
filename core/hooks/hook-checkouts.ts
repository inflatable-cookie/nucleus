import { existsSync, realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Task } from "../../shared/contracts";
import type { Store } from "../store/store";
import { gitText, statusEntries } from "../git/git-snapshot";
import { gitRaw, formatGitError } from "../git/git-command";
import { withIntegrationCheckout } from "../git/index";
import { requestServiceRollAfterRepositorySync } from "../forge/roll-request";
import { removeTree } from "../workspaces/tree-removal";
import { WARM_CANDIDATE_NAME, isolationDataDirFor, isolationPathFor, isOwnedIsolationPath } from "./hook-isolation";

/**
 * The Queue-owned checkout and the integration base it observes.
 *
 * One owner for the isolation data directory, the deterministic isolated
 * checkout path of one occurrence, the proof that the canonical integration
 * base is clean and synchronized, the removal of only a Queue-owned checkout,
 * and the ff-only renewal of the base. Publication, retention and retry all
 * reach these through this one module.
 */
export interface HookCheckoutOptions {
  store: Pick<Store, "path">;
  /** Queue data directory. Defaults to the directory that holds the store. */
  dataDir?: string;
}

export class HookCheckouts {
  constructor(private readonly options: HookCheckoutOptions) {}

  /** Queue data directory that owns new isolated checkouts. Never the live `~/.paseo` in tests. */
  dataDir(): string {
    const dir = this.options.dataDir ?? isolationDataDirFor(this.options.store);
    try { return realpathSync(dir); } catch { return resolve(dir); }
  }

  async gitCommonDir(task: Pick<Task, "repoPath">): Promise<string> {
    return gitText(task.repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
  }

  async isolationPath(task: Task, eventId: string): Promise<string> {
    return isolationPathFor(this.dataDir(), await this.gitCommonDir(task), eventId);
  }

  /** The canonical checkout must be clean for Git publication and exact at the event base. Ignored evidence is allowed. */
  async verifyCleanSynchronizedBase(root: string, baseBranch: string, baseCommit: string) {
    const dirty = await statusEntries(root, false);
    if (dirty.length) throw new Error("Integration checkout has tracked or untracked changes");
    if (await gitText(root, "branch", "--show-current") !== baseBranch) throw new Error("Integration checkout is not on the base branch");
    const head = await gitText(root, "rev-parse", "HEAD");
    if (head !== baseCommit) throw new Error("Integration HEAD moved from the event base");
    await gitText(root, "fetch", "origin", baseBranch);
    const remote = await gitText(root, "rev-parse", `refs/remotes/origin/${baseBranch}`);
    if (remote !== head) throw new Error("Local integration base differs from origin");
  }

  /** Remove only a Queue-owned isolated checkout. A non-forced removal refuses to discard dirty state. */
  async removeIsolatedCheckout(task: Task, path: string, force: boolean) {
    const common = await gitText(task.repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (!isOwnedIsolationPath(path, this.dataDir(), common)) throw new Error("Refusing to remove a checkout outside the Queue-owned isolation root");
    const rootInfo = await lstat(path).catch(() => null);
    if (!rootInfo) { await gitRaw(task.repoPath, ["worktree", "prune"]); return; }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Queue-owned isolated checkout path is not a real directory");
    const gitMarker = await lstat(join(path, ".git")).catch(() => null);
    if (gitMarker?.isFile()) {
      const result = await gitRaw(task.repoPath, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
      if (result.code !== 0) {
        if (!force) throw new Error(`Isolated checkout removal failed: ${formatGitError(["worktree", "remove", path], result.code, result.signal, result.stderr)}`);
        await removeTree(path);
        await gitRaw(task.repoPath, ["worktree", "prune"]);
      }
    } else if (gitMarker?.isDirectory()) {
      // Ignored entries are disposable runtime material in a Queue-owned
      // isolated checkout; every non-ignored entry still blocks a clean removal.
      if (!force) {
        const dirt = await statusEntries(path, false);
        if (dirt.length) throw new Error("Queue-owned isolated repository is dirty");
      }
      await removeTree(path);
    } else {
      if (!force) throw new Error("Queue-owned isolated checkout has no recognized Git identity");
      await removeTree(path);
    }
    if (existsSync(path)) throw new Error("Isolated checkout still exists after removal");
  }

  /** The clean, synchronized integration base commit for one repository, proven against origin. */
  async integrationBase(task: Task, verifyCleanSynchronizedBase: (root: string, baseBranch: string, baseCommit: string) => Promise<void> = (root, baseBranch, baseCommit) => this.verifyCleanSynchronizedBase(root, baseBranch, baseCommit)): Promise<string> {
    return withIntegrationCheckout(task, async (checkout, unchanged) => {
      const head = await gitText(checkout, "rev-parse", "HEAD");
      await verifyCleanSynchronizedBase(checkout, task.baseBranch, head);
      await unchanged();
      return head;
    });
  }

  /**
   * Fast-forward the integration base to origin after a stale-base refusal: the
   * same ff-only move the post-merge sync makes, without its merged-commit
   * precondition. Dirty, wrong-branch and locally-ahead checkouts still refuse,
   * so the cleanliness proof is not relaxed; only origin being ahead is renewed.
   */
  async renewIntegrationBase(task: Task, allowed: () => boolean): Promise<string> {
    return withIntegrationCheckout(task, async (checkout, unchanged) => {
      if (await gitText(checkout, "branch", "--show-current") !== task.baseBranch) throw new Error("Integration checkout is not on the base branch");
      if ((await statusEntries(checkout, false)).length) throw new Error("Integration checkout has tracked or untracked changes");
      const head = await gitText(checkout, "rev-parse", "HEAD");
      await gitText(checkout, "fetch", "origin", task.baseBranch);
      const remote = await gitText(checkout, "rev-parse", `refs/remotes/origin/${task.baseBranch}`);
      if (remote === head) return head;
      // Commits origin does not have are a state their author must push, not a base to renew.
      try { await gitText(checkout, "merge-base", "--is-ancestor", head, remote); }
      catch { throw new Error("Integration base cannot fast-forward: local integration commits are not on origin"); }
      await unchanged();
      if (!allowed()) throw new Error("Paused before local main update");
      await gitText(checkout, "merge", "--ff-only", remote);
      if (await gitText(checkout, "rev-parse", "HEAD") !== remote || (await statusEntries(checkout, false)).length)
        throw new Error("Integration synchronization did not leave a clean expected head");
      // A direct update of the registered checkout is the same main change the post-merge sync announces.
      if (checkout === task.repoPath) requestServiceRollAfterRepositorySync(task.repoPath);
      return remote;
    });
  }

  /** Dispose the former repository-local warm clones once; no event checkout is replayed or removed. */
  async disposeLegacyWarmCheckouts(store: Store, proveWarmOwnership: (task: Pick<Task, "repoPath">, path: string, common: string) => Promise<void>): Promise<void> {
    if (store.getMeta<boolean>("legacyWarmCheckoutsDisposed")) return;
    const tasks = store.tasks();
    const repositories = new Map(tasks.map(task => [task.repoPath, { repoPath: task.repoPath }]));
    for (const repository of store.repositories()) {
      if (repository.repository.path) repositories.set(repository.repository.path, { repoPath: repository.repository.path });
    }
    for (const project of store.projects()) for (const repository of project.repositories) {
      if (repository.path) repositories.set(repository.path, { repoPath: repository.path });
    }
    for (const task of repositories.values()) {
      const common = await this.gitCommonDir(task);
      const path = join(common, "queue-hooks", WARM_CANDIDATE_NAME);
      try { await lstat(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const unresolved = store.db.prepare(`SELECT id FROM hook_events
        WHERE json_extract(data,'$.workspace.path')=?
          AND json_extract(data,'$.state') NOT IN ('result','published','failed','blocked') LIMIT 1`).get(path);
      if (unresolved)
        throw new Error(`Legacy warm checkout still has an unresolved occurrence: ${path}`);
      await proveWarmOwnership(task, path, common);
      await removeTree(path, { force: false });
    }
    store.setMeta("legacyWarmCheckoutsDisposed", true);
  }
}
