/**
 * Dispatch verification: the checkout a run starts from, and the proofs that it
 * carries the submitted planning work.
 *
 * A proof here reads; a repair (a fast-forward, a re-detach, a re-recorded
 * base) happens only under the exact recorded identity it repairs, and never
 * over divergent or dirty work.
 */
import { realpath, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Task } from "../../shared/contracts";
import { taskCheckoutTarget } from "../workspaces/checkout-target";
import { git, gitAncestry, gitBulk, gitRaw, messageOf } from "./git-command";
import { gitStatus, queueCheckoutStatus, currentWorkerBranch } from "./git-checkout";
import { assertPinnedBrief, validateSubmission, verifyBriefWorkerIdentity } from "./git-submission";
import { dirtyWorktreeError } from "./git-stash";
import { verifyRecordedOrigin } from "./git-proof";

export class IntegrationCheckoutCleanupError extends Error {
  readonly operationError: unknown;
  constructor(cleanupError: unknown, operationError: unknown) {
    super(`${messageOf(cleanupError)}; the integration operation failed first: ${messageOf(operationError)}`, { cause: cleanupError });
    this.name = "IntegrationCheckoutCleanupError";
    this.operationError = operationError;
  }
}
const integrationCheckoutLocks = new Map<string, Promise<void>>();
export async function withIntegrationCheckout<T>(task: Pick<Task, "repoPath" | "baseBranch"> & Partial<Pick<Task, "brief">>, operation: (checkout: string, unchanged: () => Promise<void>) => Promise<T>): Promise<T> {
  const originalBranch = await git(task.repoPath, "branch", "--show-current");
  if (originalBranch === task.baseBranch) return operation(task.repoPath, async () => {});
  if (!task.brief || task.baseBranch === "main" || originalBranch !== "main")
    throw new Error("Integration checkout is on a different branch");
  if (!isAbsolute(task.repoPath) || await realpath(task.repoPath) !== task.repoPath ||
      await git(task.repoPath, "rev-parse", "--show-toplevel") !== task.repoPath)
    throw new Error("Use the repository's absolute real Git root");
  await git(task.repoPath, "check-ref-format", "--branch", task.baseBranch);
  const common = await realpath(await git(task.repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const key = `${common}:${task.baseBranch}`, previous = integrationCheckoutLocks.get(key);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  integrationCheckoutLocks.set(key, pending);
  await previous?.catch(() => undefined);
  let root: string | undefined, checkout: string | undefined, added = false, operationFailure: { error: unknown } | undefined;
  try {
    const head = await git(task.repoPath, "rev-parse", "HEAD");
    const unchanged = async () => {
      if (await git(task.repoPath, "branch", "--show-current") !== originalBranch ||
          await git(task.repoPath, "rev-parse", "HEAD") !== head || await gitStatus(task.repoPath, "status", "--porcelain"))
        throw new Error("Preserving dirty or changed registered main checkout during release-base routing");
    };
    await unchanged();
    root = await realpath(await mkdtemp(join(tmpdir(), "nucleus-integration-")));
    checkout = join(root, "checkout");
    // Git refuses a base checked out elsewhere; never override that ownership.
    await gitBulk(task.repoPath, "worktree", "add", checkout, task.baseBranch);
    added = true;
    await unchanged();
    const result = await operation(checkout, unchanged);
    await unchanged();
    return result;
  } catch (error) {
    operationFailure = { error };
    throw error;
  } finally {
    try {
      if (root && checkout) await cleanupIntegrationCheckout(task.repoPath, root, checkout, added);
    } catch (cleanupError) {
      // Both failures stay attached as objects, so a timeout's or exit's structured evidence survives a refused cleanup.
      if (!operationFailure) throw cleanupError;
      throw new IntegrationCheckoutCleanupError(cleanupError, operationFailure.error);
    } finally {
      release();
      if (integrationCheckoutLocks.get(key) === pending) integrationCheckoutLocks.delete(key);
    }
  }
}
/** A failed add is not proof that Git never registered the private checkout. */
export async function cleanupIntegrationCheckout(repoPath: string, root: string, checkout: string, added: boolean): Promise<void> {
  if (added) await gitBulk(repoPath, "worktree", "remove", checkout); // No force: dirty/locked work survives.
  const entries = (await gitRaw(repoPath, "worktree", "list", "--porcelain", "-z")).split("\0");
  if (entries.includes(`worktree ${checkout}`))
    throw new Error(`Preserving uncertain private integration worktree: ${checkout}`);
  await rm(root, { recursive: true, force: true });
}
export async function validateDispatch(task: Task) {
  return withIntegrationCheckout(task, (checkout, unchanged) => validateDispatchCheckout({...task, repoPath: checkout}, unchanged));
}
async function validateDispatchCheckout(task: Task, unchanged: () => Promise<void> = async () => {}) {
  const { handoffText } = await validateSubmission(task);
  if (handoffText !== task.handoffText) throw new Error("Planning handoff content changed");
  if (await git(task.repoPath, "branch", "--show-current") !== task.baseBranch) throw new Error("Integration checkout is on a different branch");
  if (await gitStatus(task.repoPath, "status", "--porcelain")) throw new Error("Integration checkout is dirty; preserve it and resolve before dispatch");
  const remotes = await git(task.repoPath, "remote");
  if (remotes.split("\n").includes("origin")) {
    await git(task.repoPath, "fetch", "origin", task.baseBranch);
    let local = await git(task.repoPath, "rev-parse", `refs/heads/${task.baseBranch}`);
    const remote = await git(task.repoPath, "rev-parse", `refs/remotes/origin/${task.baseBranch}`);
    if (local !== remote) {
      // A local branch that is merely behind is a fast-forward, which is exactly what
      // the closeout sync would do. Repair it here: refusing forever meant a divergence
      // that only the sync could fix, while the sync was what the refusal blocked. A
      // branch that has diverged is a real conflict and still refuses.
      const relation = await gitAncestry(task.repoPath, local, remote);
      if (relation === 'unknown') throw new Error("Local integration branch's relation to origin cannot be read; resolve the checkout before dispatch");
      if (relation !== 'ancestor') throw new Error("Local integration branch diverged from origin; resolve it before dispatch");
      await unchanged();
      await git(task.repoPath, "merge", "--ff-only", remote);
      local = await git(task.repoPath, "rev-parse", `refs/heads/${task.baseBranch}`);
      if (local !== remote) throw new Error("Local integration branch could not be fast-forwarded to origin");
    }
  }
  const base = await git(task.repoPath, "rev-parse", `refs/heads/${task.baseBranch}`);
  await git(task.repoPath, "merge-base", "--is-ancestor", task.planningCommit, base);
  // Brief mode: planning identity is ancestry, checked above; the pinned brief lives in Queue.
  if (task.brief) { assertPinnedBrief(task); return base; }
  const currentHandoff = await git(task.repoPath, "show", `${base}:${task.handoffPath}`);
  if (currentHandoff !== task.handoffText) throw new Error("Handoff was superseded on the integration branch; submit updated planning");
  return base;
}
/**
 * Prove that a workspace which never gained a worker may be dispatched from a newer base.
 *
 * A dispatch records `planningBase` when the handoff is submitted and requires the worker worktree
 * to sit exactly on it. If main advances between that record and the workspace creation - a
 * coordinator's own handoff push will do it - the worktree lands on the newer head and dispatch
 * refuses forever, with no worker, branch or run to preserve. Re-recording the base is the repair,
 * but only when nothing is pinned to the old one and the new one is provably the same work: the
 * worktree must be clean on the queue-owned branch, its head must be a DESCENDANT of the recorded
 * base (a fast-forward, never a rewrite), and the handoff at that head must still be the submitted
 * bytes.
 */
export async function proveRebindableDispatchBase(task: Task, directory: string, newBase: string) {
  if (newBase === task.planningBase) throw new Error("Worktree is already at the recorded dispatch base");
  if (await queueCheckoutStatus(directory, "status", "--porcelain")) throw new Error("Worker worktree is not clean; preserve it and resolve before re-recording the dispatch base");
  if (await git(directory, "rev-parse", "HEAD") !== newBase) throw new Error("Worker worktree HEAD is not the proposed dispatch base");
  const branch = await currentWorkerBranch(task, directory);
  if (branch !== task.branch || branch === task.baseBranch) throw new Error(`Worker must remain on queue-owned branch ${task.branch}`);
  const relation = await gitAncestry(directory, task.planningBase, newBase);
  if (relation === 'unknown') throw new Error("Proposed dispatch base ancestry cannot be read; re-record nothing until the checkout reads");
  if (relation !== 'ancestor') throw new Error("Proposed dispatch base does not descend from the recorded base; a rewrite is never re-recorded");
  if (task.brief) { assertPinnedBrief(task); return newBase; }
  if (await git(directory, "show", `${newBase}:${task.handoffPath}`) !== task.handoffText) throw new Error("Worker handoff at the proposed base does not match the submitted handoff");
  return newBase;
}
export async function verifyWorkspace(task: Task, directory: string) {
  if (await queueCheckoutStatus(directory, "status", "--porcelain")) throw new Error("New worker worktree is not clean");
  const branch = await currentWorkerBranch(task, directory);
  if (branch !== task.branch || branch === task.baseBranch) throw new Error(`Worker must remain on queue-owned branch ${task.branch}`);
  // A proof-only checkout is detached at the immutable proof commit, never the
  // moving planning base: the same target every provisioning path resolves, so
  // an owner restart or absent-executor reconciliation re-detaches the clean
  // checkout at the proof commit instead of fast-forwarding it to the base tip
  // ahead of the executor. Equality with that recorded commit is the source
  // proof; the branch-ancestry and handoff checks below assume the planning
  // worktree and do not apply.
  if (task.proofOnly) {
    const target = taskCheckoutTarget(task);
    const head = await git(directory, "rev-parse", "HEAD");
    if (head !== target) {
      await git(directory, "checkout", "--detach", target);
      if (await git(directory, "rev-parse", "HEAD") !== target)
        throw new Error(`Proof-only checkout remained at ${head} after detaching ${target}`);
    }
    if (task.brief) assertPinnedBrief(task);
    return task.branch;
  }
  // Review-entry branches retain the external PR's lineage. Their recorded
  // base proves planning ancestry separately; the PR head need not contain it.
  if (task.brief && task.reviewEntry) {
    const head = await git(directory, "rev-parse", "HEAD");
    await verifyBriefWorkerIdentity(task, directory, head);
    return task.branch;
  }
  // The worktree must carry the recorded dispatch base, but main moves under an active wave and a
  // workspace created moments after that base was recorded lands on a different head. Requiring exact
  // equality refused forever: the only thing that could reconcile the two was the dispatch the refusal
  // blocked. Both non-equal cases have an exact repair, the same one validateDispatch already applies
  // to the integration branch - a worktree AHEAD of the base already contains it, and a worktree that
  // is merely BEHIND is a fast-forward. Only a worktree that has diverged is a real conflict.
  let head = await git(directory, "rev-parse", "HEAD");
  if (head !== task.planningBase) {
    const ahead = await gitAncestry(directory, task.planningBase, head);
    if (ahead === 'unknown') throw new Error("Worker worktree ancestry cannot be read; inspect the checkout before dispatch");
    if (ahead !== 'ancestor') {
      const behind = await gitAncestry(directory, head, task.planningBase);
      if (behind === 'unknown') throw new Error("Worker worktree ancestry cannot be read; inspect the checkout before dispatch");
      if (behind !== 'ancestor') throw new Error("Worker worktree does not match the recorded dispatch base");
      await git(directory, "merge", "--ff-only", task.planningBase);
      head = await git(directory, "rev-parse", "HEAD");
      if (head !== task.planningBase) throw new Error("Worker worktree could not be fast-forwarded to the recorded dispatch base");
    }
  }
  if (task.brief) {
    await verifyBriefWorkerIdentity(task, directory, head);
    return task.branch;
  }
  if (await git(directory, "show", `HEAD:${task.handoffPath}`) !== task.handoffText) throw new Error("Worker handoff does not match the submitted handoff");
  return task.branch;
}
/**
 * The shared stash list, newest first. `refs/stash` lives in the common Git
 * directory, so every worktree reads the same list. Queue only reads it: it
 * never runs `git stash` in any worktree.
 */
export async function verifyCleanQueueWorktree(task: Task) {
  if (!task.directory) throw new Error("Task has no worktree");
  if (await currentWorkerBranch(task, task.directory!) !== task.branch || task.branch === task.baseBranch) throw new Error(`Worker must remain on queue-owned branch ${task.branch}`);
  if (await queueCheckoutStatus(task.directory, "status", "--porcelain")) throw await dirtyWorktreeError(task, "Worker worktree is dirty; inspect it before replacing the absent run");
}
/**
 * The terminal source head of a report-only task's own workspace. It must
 * contain every authenticated head the task recorded. An unchanged checkout
 * stays the planning base, which the archive proves published like any head.
 * Commits beyond it are preserved donor source: the
 * clean canonical task branch must also descend from the planning base. The archive then proves the head
 * is published on the task branch and unchanged across every await. This head
 * is archive evidence only; it never becomes a PR, review or merge head.
 */
export async function verifyResume(task: Task) {
  if (!task.directory) throw new Error("Missing continuation worktree");
  if (await git(task.directory, "rev-parse", "--git-common-dir") !== await git(task.repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir")) throw new Error("Continuation worktree belongs to another repository");
  const branch = await currentWorkerBranch(task, task.directory);
  if (branch !== task.branch || task.branch === task.baseBranch) throw new Error("Continuation branch changed; inspect before replacing the worker");
  if (task.brief) {
    await verifyBriefWorkerIdentity(task, task.directory, "HEAD", "Continuation planning identity changed");
  } else if (await git(task.directory, "show", `${task.planningCommit}:${task.handoffPath}`) !== task.handoffText) throw new Error("Continuation planning identity changed");
  // Dirty files and unpublished commits are the work being resumed. Never reset them.
  return await git(task.directory, "rev-parse", "HEAD");
}
/**
 * A bounded progress checkpoint is accepted only on the retained queue branch,
 * with a clean worktree, and — once any commit exists beyond the dispatch base
 * — with the claimed head already published as the exact queue-branch head.
 * Dirty work and unpublished commits fail closed into ordinary recovery.
 */
export async function verifyCheckpoint(task: Task, head: string) {
  if (!task.directory) throw new Error("Bounded checkpoint requires the retained worktree");
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Bounded checkpoint requires the exact local head");
  if (await currentWorkerBranch(task, task.directory!) !== task.branch || task.branch === task.baseBranch) throw new Error(`Worker must remain on queue-owned branch ${task.branch}`);
  if (await queueCheckoutStatus(task.directory, "status", "--porcelain")) throw await dirtyWorktreeError(task, "Bounded checkpoint requires a clean worktree; commit or report blocked instead");
  if (await git(task.directory, "rev-parse", "HEAD") !== head) throw new Error("Bounded checkpoint head differs from the worker worktree");
  if (task.brief) await verifyBriefWorkerIdentity(task, task.directory, head);
  if (head === task.planningBase) return; // Nothing beyond the dispatch base is published yet.
  let remote: string;
  try { remote = await git(task.directory, "ls-remote", "origin", `refs/heads/${task.branch}`); }
  catch (error) {
    // Keep the cause: a host stall timing out `git ls-remote` reads the same as a missing push without it.
    const message = error instanceof Error ? error.message : String(error);
    const cause = message.match(/^(?:fatal|ERROR):.*$/m)?.[0] ?? message.split("\n")[0];
    throw new Error(`Bounded checkpoint cannot prove the pushed queue-branch head (${cause}); publish the partial commits or report blocked`);
  }
  const pushed = remote.split(/\s+/)[0] ?? "";
  if (pushed !== head) throw new Error(`Bounded checkpoint head ${head} is not the exact pushed queue-branch head`);
}

/** Verify the published replacement source belongs to the retained repository and planning base. */
export async function verifyReplacementSource(task: Task, head: string) {
  if (!task.directory) throw new Error('Replacement requires the retained worktree');
  await verifyRecordedOrigin(task, task.directory);
  await verifyResume(task);
  if (await gitAncestry(task.directory, task.planningBase, head) !== 'ancestor') throw new Error('Replacement source does not descend from the task planning base');
  await verifyCheckpoint(task, head);
  const advertised = await git(task.directory, 'ls-remote', 'origin', `refs/heads/${task.branch}`);
  if ((advertised.split(/\s+/)[0] ?? '') !== head) throw new Error('Replacement source is not the published task branch head');
}
/**
 * Publication proof for a terminal source head beyond its task branch: the exact
 * HEAD is contained in a branch the canonical origin still advertises after the
 * fetch. Fetching first and reading `ls-remote` last makes the advertisement the
 * latest observation: a branch deleted before or during the fetch leaves only a
 * stale tracking ref, which the later advertisement no longer names (review
 * #538). A tracking ref counts only while it equals that live head, so another
 * remote, a prefix-matched ref or a failed observation (which throws) never
 * proves publication. Preferred names win so repeated proofs select the same ref.
 */
