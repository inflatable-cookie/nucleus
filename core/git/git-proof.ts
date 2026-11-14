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
import { command, git, gitAncestry } from "./git-command";
import { queueCheckoutStatus, currentWorkerBranch } from "./git-checkout";
import { githubRepositoryFromRemote } from "./git-remote";
import { dirtyWorktreeError } from "./git-stash";

export async function verifyPr(task: Task, number: number) {
  if (!task.directory) throw new Error("Task has no worktree");
  const remote = await git(task.repoPath, "remote", "get-url", "origin");
  const repository = githubRepositoryFromRemote(remote);
  if (!repository) throw new Error("Ready for review requires a GitHub origin remote");
  const pr = JSON.parse(await command("gh", ["pr", "view", String(number), "--repo", repository, "--json", "number,url,state,isDraft,headRefName,baseRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository"], task.repoPath));
  if (pr.state !== "OPEN" || pr.isDraft || pr.headRefName !== task.branch || pr.baseRefName !== task.baseBranch) throw new Error("PR must be open, ready, and match the task's branch and base");
  if (await currentWorkerBranch(task, task.directory!) !== task.branch) throw new Error(`Worker must remain on queue-owned branch ${task.branch}`);
  const status = await queueCheckoutStatus(task.directory, "status", "--porcelain", "--untracked-files=all");
  if (status) {
    const causes = status.split("\n").map(line => {
      const path = line.slice(3);
      return line.startsWith("?? ") ? `untracked ${path}` : `changed ${path}`;
    });
    throw await dirtyWorktreeError(task, `Worker must leave a clean worktree before review: ${causes.join(", ")}`);
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
  await verifyReportOnlyIdentity(task);
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
/** The retained canonical task worktree: registered root, Git root, origin, branch and a clean tree. */
/** The report-only task's own registered worktree: root, Git common dir, origin, branch and clean state. */
export async function verifyReportOnlyIdentity(task: Task, options: { allowDirty?: boolean } = {}): Promise<void> {
  if (!task.directory || !task.workspaceId || !task.branch || !task.baseBranch)
    throw new Error("Report-only completion requires the retained task workspace and branch identity");
  if (task.branch !== `ns-${task.id}`) throw new Error("Report-only completion requires the immutable task branch identity");
  const taskRoot = await realpath(task.directory);
  const worktreeRoot = await realpath(await git(task.directory, "rev-parse", "--show-toplevel"));
  if (taskRoot !== worktreeRoot || worktreeRoot === await realpath(task.repoPath))
    throw new Error("Report-only completion requires the registered task worktree root");
  const common = await git(task.directory, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const planningCommon = await git(task.repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common !== planningCommon) throw new Error("Task worktree and planning checkout belong to different Git roots");
  await verifyRecordedOrigin(task, task.directory);
  if (await currentWorkerBranch(task, task.directory!) !== task.branch)
    throw new Error("Task worktree is on the wrong branch");
  if (!options.allowDirty && await queueCheckoutStatus(task.directory, "status", "--porcelain"))
    throw new Error("Task worktree is dirty; report-only completion cannot preserve uncommitted work");
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
  // Fetch objects without touching shared remote-tracking refs or FETCH_HEAD:
  // other worktrees may be merging or fetching at the same time.
  await git(directory, "fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", "origin", ...[...before.keys()].map(name => `refs/heads/${name}`));
  const live = await advertised();
  const containing = new Set<string>();
  for (const [name, sha] of before) {
    if (live.get(name) === sha && await gitAncestry(directory, head, sha) === 'ancestor') containing.add(name);
  }
  return preferred.find(name => containing.has(name)) ?? [...containing].sort()[0] ?? null;
}
