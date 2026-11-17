/**
 * Publication and PR proofs: the head a task may call done, and the origin
 * facts that bind it.
 *
 * Every proof here reads the live remote and refuses on an unreadable answer;
 * none of them mutates a branch.
 */
import { realpath } from "node:fs/promises";
import type { Run, Task } from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { externalWorkspace } from "../../shared/workspace-ownership";
import { command, git, gitAncestry } from "./git-command";
import { queueCheckoutStatus, currentWorkerBranch } from "./git-checkout";
import { githubRepositoryFromRemote } from "./git-remote";
import { dirtyWorktreeError } from "./git-stash";
import { WORKER_BRANCH_REFUSAL_PREFIX, WORKER_DIRTY_REFUSAL_PREFIX, WORKER_PR_IDENTITY_REFUSAL, WorkerSourceRefusal } from "./git-refusals";

export async function verifyPr(task: Task, number: number) {
  if (!task.directory) throw new Error("Task has no worktree");
  const remote = await git(task.repoPath, "remote", "get-url", "origin");
  const repository = githubRepositoryFromRemote(remote);
  if (!repository) throw new Error("Ready for review requires a GitHub origin remote");
  const pr = JSON.parse(await command("gh", ["pr", "view", String(number), "--repo", repository, "--json", "number,url,state,isDraft,headRefName,baseRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository"], task.repoPath));
  if (pr.state !== "OPEN" || pr.isDraft || pr.headRefName !== task.branch || pr.baseRefName !== task.baseBranch) throw new WorkerSourceRefusal('pr_identity', WORKER_PR_IDENTITY_REFUSAL);
  if (await currentWorkerBranch(task, task.directory!) !== task.branch) throw new WorkerSourceRefusal('worktree_branch', `${WORKER_BRANCH_REFUSAL_PREFIX}${task.branch}`);
  const status = await queueCheckoutStatus(task.directory, "status", "--porcelain", "--untracked-files=all");
  if (status) {
    const causes = status.split("\n").map(line => {
      const path = line.slice(3);
      return line.startsWith("?? ") ? `untracked ${path}` : `changed ${path}`;
    });
    throw await dirtyWorktreeError(task, `${WORKER_DIRTY_REFUSAL_PREFIX}${causes.join(", ")}`);
  }
  if (pr.headRefOid !== await git(task.directory, "rev-parse", "HEAD")) throw new Error("PR head differs from the worker worktree");
  // The head repository is reported for the PR-binding sites; null when the fork was deleted.
  const headRepository = pr.headRepository?.name && pr.headRepositoryOwner?.login ? `${pr.headRepositoryOwner.login}/${pr.headRepository.name}` : null;
  return { url: String(pr.url), head: String(pr.headRefOid), repository, headRepository, crossRepository: pr.isCrossRepository === true };
}

export async function reportOnlySourceHead(task: Task, runs: readonly Run[]): Promise<string> {
  if (!task.directory) throw new Error("Report-only source requires the retained task workspace");
  const head = await git(task.directory, "rev-parse", "HEAD");
  const contain = async (commit: string, refusal: string): Promise<void> => {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(refusal);
    const relation = await gitAncestry(task.directory!, commit, head);
    if (relation === 'unknown')
      throw new Error(`${refusal.replace('; workspace preserved', '')}; Git ancestry is unreadable, so containment is unknown; workspace preserved`);
    if (relation !== 'ancestor') throw new Error(refusal);
  };
  // Every authenticated reported head binds the source, including a checkout
  // back at the planning base: reported donor work it lacks is never discarded.
  const reported = [task.completion?.head, ...task.checkpoints.records.map(record => record.head),
    ...runs.filter(run => run.workspaceId === task.workspaceId).map(run => run.completion?.head)];
  for (const recorded of new Set(reported.filter((value): value is string => Boolean(value))))
    await contain(recorded, `Report-only source ${head} does not contain authenticated reported head ${recorded}; workspace preserved`);
  if (head === task.planningBase) return head;
  await verifyTaskWorktreeIdentity(task);
  await contain(task.planningBase, `Report-only source ${head} does not descend from planning base ${task.planningBase}; workspace preserved`);
  return head;
}
/**
 * A hosted task repository is recorded at submission; the checkout's origin
 * must still name it. A local-only identity records no origin to bind.
 */
export async function verifyRecordedOrigin(task: Task, directory: string): Promise<void> {
  const expectedOrigin = normalizeRepositoryOrigin(task.repository ?? "");
  if (expectedOrigin && normalizeRepositoryOrigin(await git(directory, "remote", "get-url", "origin")) !== expectedOrigin)
    throw new Error("Task worktree repository origin does not match the recorded task identity");
}
/** Prove the retained task worktree root, Git common dir, origin, branch and clean state. */
export async function verifyTaskWorktreeIdentity(task: Task, options: { allowDirty?: boolean } = {}): Promise<void> {
  if (!task.directory || !task.workspaceId || !task.branch || !task.baseBranch)
    throw new Error("Task worktree proof requires the retained workspace and branch identity");
  if (!externalWorkspace(task) && task.branch !== `ns-${task.id}`) throw new Error("Task worktree proof requires the immutable task branch identity");
  const taskRoot = await realpath(task.directory);
  const worktreeRoot = await realpath(await git(task.directory, "rev-parse", "--show-toplevel"));
  if (taskRoot !== worktreeRoot || worktreeRoot === await realpath(task.repoPath))
    throw new Error("Task worktree proof requires the registered task worktree root");
  const common = await git(task.directory, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const planningCommon = await git(task.repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common !== planningCommon) throw new Error("Task worktree and planning checkout belong to different Git roots");
  await verifyRecordedOrigin(task, task.directory);
  if (await currentWorkerBranch(task, task.directory!) !== task.branch)
    throw new Error("Task worktree is on the wrong branch");
  if (!options.allowDirty && await queueCheckoutStatus(task.directory, "status", "--porcelain"))
    throw new Error("Task worktree is dirty; worktree proof requires committed work");
}
/**
 * The worker checkout's current branch, reattaching it first when ordinary review left it detached.
 * Ordinary review temporarily detaches the shared worker checkout at the reviewed head. Reattach only
 * when that clean head is still exactly the locally recorded and remotely published queue branch tip;
 * otherwise return the checkout's branch unchanged (empty when detached) for the caller to refuse.
 */
export async function originBranchContaining(directory: string, head: string, preferred: readonly string[]): Promise<string | null> {
  if (!/^[a-f0-9]{40}$/.test(head)) return null;
  const advertised = async () => new Map((await git(directory, "ls-remote", "--heads", "origin")).split("\n").filter(Boolean).map(line => line.split(/\s+/))
    .filter(([sha, ref]) => /^[a-f0-9]{40}$/.test(sha ?? "") && ref?.startsWith("refs/heads/"))
    .map(([sha, ref]) => [ref!.slice("refs/heads/".length), sha!] as const));
  const before = await advertised();
  if (!before.size) return null;
  const fetchRef = (name: string) => git(directory, "fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", "origin", `refs/heads/${name}`);
  const live = new Map<string, string>();
  const prove = async (names: readonly string[]) => {
    // Fetch objects without touching shared remote-tracking refs or FETCH_HEAD:
    // other worktrees may be merging or fetching at the same time. Small
    // batches keep argv bounded even when a repository has thousands of refs.
    for (let offset = 0; offset < names.length; offset += 64) {
      const batch = names.slice(offset, offset + 64);
      try {
        await git(directory, "fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", "origin", ...batch.map(name => `refs/heads/${name}`));
      } catch (error) {
        // One ref can disappear after ls-remote. Refresh the set and retry the
        // still-advertised refs individually so that one deletion cannot abort
        // the archive proof. A second disappearance is simply absent evidence.
        const refreshed = await advertised();
        for (const name of batch) {
          if (!refreshed.has(name)) continue;
          try { await fetchRef(name); }
          catch (retryError) {
            if (!/couldn't find remote ref|remote ref .* not found|no such ref/i.test(String(retryError))) throw retryError;
          }
        }
        // Preserve genuine failures (for example authentication or transport
        // errors) from the batch. Missing-ref failures are handled above.
        if (!/couldn't find remote ref|remote ref .* not found|no such ref/i.test(String(error))) throw error;
      }
    }
    const current = await advertised();
    for (const name of names) if (current.has(name)) live.set(name, current.get(name)!);
  };
  const preferredNames = [...new Set(preferred)].filter(name => before.has(name));
  await prove(preferredNames);
  // This reader only ever proves containment: an unreadable ancestry adds no
  // branch to the proof, and the caller's refusal is "no branch proves it",
  // never a claim that the head is absent.
  const containing = new Set<string>();
  const ancestry = new Map<string, Awaited<ReturnType<typeof gitAncestry>>>();
  const check = async (names: readonly string[]) => {
    for (const name of names) {
      const sha = before.get(name);
      if (!sha || live.get(name) !== sha) continue;
      let relation = ancestry.get(sha);
      if (!relation) { relation = await gitAncestry(directory, head, sha); ancestry.set(sha, relation); }
      if (relation === 'ancestor') containing.add(name);
    }
  };
  await check(preferredNames);
  const preferredMatch = preferred.find(name => containing.has(name));
  if (preferredMatch) return preferredMatch;

  const wider = [...before.keys()].filter(name => !preferredNames.includes(name));
  await prove(wider);
  await check(wider);
  return [...containing].sort()[0] ?? null;
}
