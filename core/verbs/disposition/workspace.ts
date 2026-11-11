import { existsSync } from "node:fs";
import type { Task } from "../../../shared/contracts";
import type { Store } from "../../store/store";
import { git, originBranchContaining, verifyRecordedOrigin, queueCheckoutStatus } from "../../git/index";

export async function proveWorkspaceEmpty(store: Store, task: Task, baseOnly = false, allowDirty = false): Promise<{ empty: boolean; detail: string; uncertain?: string }> {
  if (!task.workspaceId || !task.directory) return { empty: false, detail: "No task workspace was created" };
  if (task.reviewEntry) return { empty: false, detail: "Review-entry workspace preserved; Nucleus never archives externally owned work" };
  if (store.tasks().some((other) => other.id !== task.id && other.phase !== "done" && other.phase !== "cancelled" &&
    (other.workspaceId === task.workspaceId || other.resolution.coordinatorWorkspaceId === task.workspaceId ||
      other.resolution.closeoutWorkspaceId === task.workspaceId || store.runs(other.id).some((run) => run.workspaceId === task.workspaceId))))
    return { empty: false, detail: "Workspace is referenced by another task; preserved without archive" };
  if (!existsSync(task.directory)) return { empty: false, detail: "Task workspace directory is missing; preserved without archive" };
  try {
    const branch = await git(task.directory, "branch", "--show-current");
    if (branch !== task.branch) return { empty: false, detail: `Workspace is on ${branch || "a detached head"}, not the queue branch ${task.branch}; preserved without archive` };
    const common = await git(task.directory, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const canonical = await git(task.repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (common !== canonical) return { empty: false, detail: "Workspace belongs to another repository; preserved without archive" };
    const head = await git(task.directory, "rev-parse", "HEAD");
    // Under a recorded owner content discard only the content proofs are waived:
    // the clean head, the porcelain state and publication. Identity, repository,
    // branch and ownership above are proved first and always stay, so this
    // returns "nothing worth preserving" for exactly the discarded contents.
    if (allowDirty) return { empty: true, detail: `Workspace identity and ownership proved at ${head}; the recorded owner content discard waives the clean-head and publication proofs` };
    if (await queueCheckoutStatus(task.directory, "status", "--porcelain")) return { empty: false, detail: "Workspace worktree is dirty; preserved without archive" };
    if (baseOnly) {
      const remotes = (await git(task.directory, "remote")).split("\n");
      const listed = remotes.includes("origin") ? (await git(task.directory, "ls-remote", "origin", `refs/heads/${task.branch}`)).split(/\s+/)[0] ?? "" : "";
      if (head !== task.planningBase || listed && listed !== head) return { empty: false, detail: "Unused workspace is not at its clean planning base; preserved without archive" };
      return { empty: true, detail: `Unused workspace clean at planning base ${head}; remote branch ${listed || "absent"}` };
    }
    // Every publication path, the queue branch included, reads the recorded
    // canonical origin; a foreign origin's branch proves nothing (review #538).
    await verifyRecordedOrigin(task, task.directory);
    const listed = (await git(task.directory, "ls-remote", "origin", `refs/heads/${task.branch}`)).split(/\s+/)[0] ?? "";
    let remoteHead = "";
    if (/^[a-f0-9]{40}$/.test(listed)) {
      await git(task.directory, "fetch", "origin", `+refs/heads/${task.branch}:refs/remotes/origin/${task.branch}`);
      remoteHead = await git(task.directory, "rev-parse", `refs/remotes/origin/${task.branch}`);
      if (/^[a-f0-9]{40}$/.test(remoteHead) && await git(task.directory, "merge-base", "--is-ancestor", head, remoteHead).then(() => true, () => false))
        return { empty: true, detail: `Workspace clean on queue branch at ${head}; origin queue branch ${remoteHead} contains every local commit${task.prUrl ? "; PR remains on GitHub" : ""}` };
    }
    // The queue branch is one proof of publication, not the only one: HEAD on any
    // branch the canonical origin advertises now (the base, a renamed or donor
    // branch) is published too. A missing or behind queue branch alone proves
    // nothing either way (papercut 7d59b444, review #536).
    const containing = await originBranchContaining(task.directory, head, [task.branch, task.baseBranch]);
    if (!containing) return { empty: false, detail: remoteHead
      ? `Workspace HEAD ${head} is not on origin queue branch ${remoteHead} or any other origin branch; preserved without archive`
      : "Remote queue branch is missing and no origin ref contains HEAD; local commits are not proved published" };
    return { empty: true, detail: `Workspace clean on queue branch at ${head}; ${remoteHead ? "queue branch behind HEAD" : "queue branch absent"} on origin, but origin/${containing} contains every local commit${task.prUrl ? "; PR remains on GitHub" : ""}` };
  } catch (error) {
    return { empty: false, detail: "", uncertain: `Work evidence is uncertain: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function proveRetainedByReplacement(task: Task, replacement: Task): Promise<{ retained: boolean; detail: string; uncertain?: string }> {
  if (!task.directory || !existsSync(task.directory)) return { retained: false, detail: "", uncertain: "Task workspace is unavailable; replacement retention cannot be proved" };
  try {
    const unique = (await git(task.directory, "rev-list", `${task.planningBase}..${task.branch}`)).split("\n").filter(Boolean);
    if (!unique.length && !task.prUrl) return { retained: true, detail: "Task holds no unique commits or PR; nothing needs retention" };
    if (!replacement.directory || !existsSync(replacement.directory)) return { retained: false, detail: "", uncertain: "Replacement workspace is unavailable; retention cannot be proved" };
    const replacementHead = await git(replacement.directory, "rev-parse", "HEAD");
    for (const commit of unique) {
      try {
        await git(replacement.directory, "merge-base", "--is-ancestor", commit, replacementHead);
      } catch {
        return { retained: false, detail: `Replacement does not retain task commit ${commit}; original evidence preserved` };
      }
    }
    if (task.prUrl && replacement.prHead !== task.prHead)
      return { retained: false, detail: "Replacement does not retain the task PR head; original evidence preserved" };
    return { retained: true, detail: `Replacement retains every unique task commit${task.prUrl ? " and the PR head" : ""}` };
  } catch (error) {
    return { retained: false, detail: "", uncertain: `Retention evidence is uncertain: ${error instanceof Error ? error.message : String(error)}` };
  }
}
