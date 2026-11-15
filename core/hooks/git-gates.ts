import { lstat } from "node:fs/promises";
import type { MergeCandidate } from "../../shared/hooks";
import { gitText, statusEntries } from "../git/git-snapshot";

/** Prove the retained task workspace still holds the exact reviewed queue head. */
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

/** Verify that a synthetic prospective merge commit and tree have not moved. */
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
