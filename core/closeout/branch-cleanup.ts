import { existsSync } from "node:fs";
import { doublingDelay } from "../../shared/backoff";
import type { Run, Task } from "../../shared/contracts";
import { externalWorkspace } from "../../shared/workspace-ownership";
import type { Adapter } from "../host/adapter";
import { git, gitAncestry, gitRun } from "../git/index";
import type { Store } from "../store/store";
import { now } from "../store/store";

/**
 * nucleus#1548: closeout deletes the Nucleus-created branch a verified merge
 * leaves behind, locally and on the forge.
 *
 * A merge makes the branch disposable, but the deletion is still a recorded side
 * effect: the intent is durable before the delivery, an attempt always observes
 * the branch first, and a failed or uncertain delete is retried on its own
 * deadline instead of being re-sent blindly. Nothing here blocks closeout or the
 * task reaching `done`; a resolved-but-held branch is recorded and visible in the
 * task's closeout facts.
 *
 * The safety rules are the brief's: delete only a branch Nucleus created for this
 * task, at a head the merged commit contains, never the default or integration
 * branch, never a branch with another open PR, and never a branch another task or
 * worktree still uses. A branch that fails any of them is kept with its cause.
 */

export const BRANCH_CLEANUP_RETRY_BASE_MS = 60_000;
export const BRANCH_CLEANUP_RETRY_MAX_MS = 60 * 60_000;

export type BranchCleanupRecord = Task["resolution"]["branchCleanups"][number];

/** One branch a finished task owes, with the checkout whose removal makes it deletable. */
export type TerminalBranchCandidate = {
  branch: string;
  /** Whether the forge carries the same branch and owes its deletion too. */
  forge: boolean;
  /** The worktree that served the branch; the branch waits until it is gone. */
  directory: string;
};

/** The store and the one host read a branch cleanup needs. */
export type TerminalBranchContext = {
  store: Store;
  adapter: Pick<Adapter, "findAnyOpenBranchPr">;
};

export function branchCleanupRetryDelay(attempts: number) {
  return doublingDelay(
    BRANCH_CLEANUP_RETRY_BASE_MS,
    BRANCH_CLEANUP_RETRY_MAX_MS,
    Math.max(attempts, 1),
  );
}

/**
 * The branches a verified merge lets closeout delete: the ordinary task branch
 * Nucleus names from the task id, and the local view branch a retained reviewer
 * read its exact head from. Cancelled tasks keep their branches, and a workspace
 * Nucleus does not own keeps the branch its own source published.
 */
export function terminalBranchCandidates(task: Task, runs: Run[]): TerminalBranchCandidate[] {
  if (task.phase !== "done" || !task.resolution.mergedCommit) return [];
  const candidates: TerminalBranchCandidate[] = [];
  // The ordinary branch is Nucleus's own only when it is the deterministic name
  // closeout can re-derive: an adopted checkout, a review-entry PR branch or a
  // preserved external workspace was published by someone else.
  if (
    task.branch === `ns-${task.id}` &&
    task.workspaceId &&
    task.directory &&
    !externalWorkspace(task) &&
    task.reviewEntry?.preserveWorkspace !== true
  )
    candidates.push({ branch: task.branch, forge: true, directory: task.directory });
  for (const run of runs) {
    const view = run.reviewSourceView;
    if (!view?.directory || view.branch !== `ns-review-${run.id}`) continue;
    candidates.push({ branch: view.branch, forge: false, directory: view.directory });
  }
  return candidates;
}

/** Whether a recorded cleanup still owes work; a settled record is history. */
export const branchCleanupOwed = (record: BranchCleanupRecord): boolean =>
  record.state === "intent" || record.state === "wait";

type BranchFacts = {
  repoPath: string;
  mergeCommit: string;
  defaultBranch: string;
  /** Branches checked out by a Git worktree of the repository, with that path. */
  worktrees: Map<string, string>;
  /** A registered worktree whose directory is gone; the registration is pruned before the branch goes. */
  staleWorktrees: boolean;
};

type RecordDraft = {
  state: BranchCleanupRecord["state"];
  detail: string;
  head?: string;
  intentAt?: string | null;
  attempts?: number;
  nextAttemptAt?: string | null;
};

const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 1200);

function recordFor(
  candidate: TerminalBranchCandidate,
  previous: BranchCleanupRecord | null,
  draft: RecordDraft,
): BranchCleanupRecord {
  return {
    branch: candidate.branch,
    forge: candidate.forge,
    head: draft.head ?? previous?.head ?? "",
    state: draft.state,
    detail: draft.detail.slice(0, 2000),
    intentAt: draft.intentAt ?? previous?.intentAt ?? null,
    at: now(),
    attempts: draft.attempts ?? previous?.attempts ?? 0,
    nextAttemptAt: draft.nextAttemptAt ?? null,
  };
}

function waited(
  candidate: TerminalBranchCandidate,
  previous: BranchCleanupRecord | null,
  detail: string,
  head?: string,
): BranchCleanupRecord {
  const attempts = (previous?.attempts ?? 0) + 1;
  return recordFor(candidate, previous, {
    state: "wait",
    detail,
    ...(head ? { head } : {}),
    attempts,
    nextAttemptAt: new Date(Date.now() + branchCleanupRetryDelay(attempts)).toISOString(),
  });
}

const EVENT_BY_STATE: Record<BranchCleanupRecord["state"], string> = {
  intent: "task_branch_cleanup_intent",
  wait: "task_branch_cleanup_wait",
  deleted: "task_branch_deleted",
  kept: "task_branch_kept",
};

/** Write one branch record, keeping every other branch's record and history. */
export function saveBranchCleanup(
  store: Store,
  taskId: string,
  record: BranchCleanupRecord,
): Task {
  const current = store.task(taskId);
  const branchCleanups = [
    ...current.resolution.branchCleanups.filter((item) => item.branch !== record.branch),
    record,
  ].sort((left, right) => left.branch.localeCompare(right.branch));
  return store.update(
    taskId,
    { resolution: { ...current.resolution, branchCleanups } },
    EVENT_BY_STATE[record.state],
    `${record.branch}: ${record.detail}`,
  );
}

async function localBranchHead(repoPath: string, branch: string): Promise<string | null> {
  const result = await gitRun(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], 64 * 1024);
  if (result.code === 1 && !result.signal) return null;
  if (result.code !== 0) throw new Error(result.stderr || `refs/heads/${branch} could not be read`);
  return result.stdout.toString("utf8").trim();
}

async function remoteBranchHead(repoPath: string, branch: string): Promise<string | null> {
  const listed = await git(repoPath, "ls-remote", "origin", `refs/heads/${branch}`);
  if (!listed) return null;
  const head = listed.split(/\s+/)[0] ?? "";
  return /^[a-f0-9]{40}$/.test(head) ? head : null;
}

/** The repository's default branch, as the forge advertises it. */
async function defaultBranchOf(repoPath: string): Promise<string> {
  const local = await gitRun(repoPath, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], 64 * 1024);
  if (local.code === 0) {
    const branch = local.stdout.toString("utf8").trim().replace(/^refs\/remotes\/origin\//, "");
    if (branch) return branch;
  }
  const advertised = await gitRun(repoPath, ["ls-remote", "--symref", "origin", "HEAD"], 64 * 1024);
  const match = advertised.stdout.toString("utf8").match(/^ref: refs\/heads\/(\S+)\tHEAD$/m);
  if (advertised.code !== 0 || !match)
    throw new Error("the repository default branch could not be observed");
  return match[1]!;
}

async function worktreeBranches(
  repoPath: string,
): Promise<{ holders: Map<string, string>; stale: boolean }> {
  const listed = await git(repoPath, "worktree", "list", "--porcelain");
  const holders = new Map<string, string>();
  let stale = false;
  let path = "";
  for (const line of listed.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/")) {
      // A registration whose directory is gone holds nothing; it is stale admin
      // state the local delete prunes, never a checkout still on the branch.
      if (existsSync(path)) holders.set(line.slice("branch refs/heads/".length), path);
      else stale = true;
    }
  }
  return { holders, stale };
}

/** The one read of a pass: the merged commit, the default branch and the branch's holders. */
async function readBranchFacts(task: Task, mergeCommit: string): Promise<BranchFacts> {
  const repoPath = task.repoPath;
  const present = await gitRun(repoPath, ["cat-file", "-e", `${mergeCommit}^{commit}`], 64 * 1024);
  if (present.code !== 0)
    throw new Error(`the merged commit ${mergeCommit} is not in the registered checkout`);
  const worktrees = await worktreeBranches(repoPath);
  return {
    repoPath,
    mergeCommit,
    defaultBranch: await defaultBranchOf(repoPath),
    worktrees: worktrees.holders,
    staleWorktrees: worktrees.stale,
  };
}

/**
 * One branch's attempt: observe, prove every safety rule, record the intent, delete,
 * then observe the result. It never throws a delivery fault: an unknown outcome is a
 * recorded wait, and the next pass observes before it acts again. A branch whose
 * worktree is still present is not due, so nothing is recorded for it.
 */
async function attemptBranchCleanup(
  ctx: TerminalBranchContext,
  task: Task,
  candidate: TerminalBranchCandidate,
  facts: BranchFacts,
  previous: BranchCleanupRecord | null,
): Promise<BranchCleanupRecord | null> {
  const branch = candidate.branch;
  // The branch belongs to a checkout: closeout deletes it only once that checkout is
  // gone. Until then the task owes the workspace archive, which records its own
  // effect, and this pass writes nothing for the branch.
  if (existsSync(candidate.directory)) return null;

  const localHead = await localBranchHead(facts.repoPath, branch);
  const remoteHead = candidate.forge ? await remoteBranchHead(facts.repoPath, branch) : null;
  const observed = localHead ?? remoteHead;
  if (!localHead && !remoteHead)
    return recordFor(candidate, previous, { state: "deleted", detail: "The branch was already absent" });

  if (branch === task.baseBranch)
    return recordFor(candidate, previous, { state: "kept", detail: "The branch is the task's integration branch" });
  if (branch === facts.defaultBranch)
    return recordFor(candidate, previous, { state: "kept", detail: "The branch is the repository default branch" });

  const other = ctx.store
    .tasks()
    .find((item) => item.id !== task.id && item.removedAt == null && item.branch === branch);
  if (other)
    return recordFor(candidate, previous, {
      state: "kept",
      detail: `Task ${other.id} still records the branch`,
    });

  const holder = facts.worktrees.get(branch);
  if (holder) return waited(candidate, previous, `A Git worktree at ${holder} still has the branch checked out`);

  if (candidate.forge) {
    if (typeof ctx.adapter.findAnyOpenBranchPr !== "function")
      return recordFor(candidate, previous, {
        state: "kept",
        detail: "Open branch PR observation is unavailable, so the branch is preserved",
      });
    const open = await ctx.adapter.findAnyOpenBranchPr(task);
    if (open.length)
      return recordFor(candidate, previous, {
        state: "kept",
        detail: `Another open PR (${open.map((pr) => `#${pr.number}`).join(", ")}) still uses the branch`,
      });
  }

  // The merged commit must contain every head the branch carries. A head it does
  // not contain is work only this branch holds, and a branch is never deleted for it.
  for (const head of new Set([localHead, remoteHead].filter((value): value is string => Boolean(value)))) {
    const relation = await gitAncestry(facts.repoPath, head, facts.mergeCommit);
    if (relation === "unknown")
      return waited(candidate, previous, `The ancestry of ${head} in ${facts.mergeCommit} is unreadable`, observed ?? undefined);
    if (relation === "diverged")
      return recordFor(candidate, previous, {
        state: "kept",
        head,
        detail: `Branch head ${head} is not in the merged commit ${facts.mergeCommit}`,
      });
  }

  const head = observed ?? "";
  const intent = recordFor(candidate, previous, {
    state: "intent",
    head,
    intentAt: now(),
    detail:
      remoteHead && localHead
        ? "Deleting the branch on the forge and in the registered checkout"
        : remoteHead
          ? "Deleting the branch on the forge"
          : "Deleting the branch in the registered checkout",
  });
  saveBranchCleanup(ctx.store, task.id, intent);
  let delivery = "";
  try {
    if (remoteHead) await git(facts.repoPath, "push", "origin", "--delete", branch);
    if (localHead) {
      if (facts.staleWorktrees)
        await gitRun(facts.repoPath, ["worktree", "prune"], 64 * 1024);
      await git(facts.repoPath, "branch", "-D", branch);
    }
  } catch (error) {
    // A failed or unconfirmed delete is observed below; its message is the cause
    // a retry reports, never a reason to re-send blindly.
    delivery = messageOf(error);
  }
  let remainingLocal: string | null;
  let remainingRemote: string | null;
  try {
    remainingLocal = await localBranchHead(facts.repoPath, branch);
    remainingRemote = candidate.forge ? await remoteBranchHead(facts.repoPath, branch) : null;
  } catch (error) {
    return waited(
      candidate,
      intent,
      `The delete result could not be observed: ${messageOf(error)}`,
      head,
    );
  }
  if (!remainingLocal && !remainingRemote)
    return recordFor(candidate, intent, {
      state: "deleted",
      head,
      detail: candidate.forge ? "Deleted on the forge and locally" : "Deleted locally",
    });
  return waited(
    candidate,
    intent,
    `${delivery || "The branch still exists after the delete"}${
      remainingRemote ? ` (the forge branch ${remainingRemote} remains)` : ""
    }${remainingLocal ? ` (the local branch ${remainingLocal} remains)` : ""}`,
    head,
  );
}

/**
 * Settle every branch this finished task still owes. Runs inside the terminal
 * cleanup pass after the workspaces are archived; it never throws and never
 * changes the task's phase, so a branch cleanup can never block `done`.
 *
 * `retry` is the owner path (`retry_effect` on a terminal workspace): it bypasses
 * the recorded deadline and re-proves the same safety rules.
 */
export async function cleanupTerminalBranches(
  ctx: TerminalBranchContext,
  taskId: string,
  options: { retry?: boolean } = {},
): Promise<Task> {
  let task = ctx.store.task(taskId);
  if (task.removedAt) return task;
  const candidates = terminalBranchCandidates(task, ctx.store.runs(taskId));
  if (!candidates.length) return task;
  const due = candidates.filter((candidate) => {
    // The branch is deletable only once its worktree is gone, and until then the
    // lane already owes the workspace archive that records that state. Keeping the
    // check here, before any Git read, keeps a backed-off pass as cheap as before.
    if (existsSync(candidate.directory)) return false;
    const record = task.resolution.branchCleanups.find((item) => item.branch === candidate.branch);
    if (record && !branchCleanupOwed(record)) return false;
    if (options.retry || !record?.nextAttemptAt) return true;
    return Date.parse(record.nextAttemptAt) <= Date.now();
  });
  if (!due.length) return task;
  const mergeCommit = task.resolution.syncedCommit ?? task.resolution.mergedCommit;
  let facts: BranchFacts | null = null;
  let unreadable = "";
  try {
    facts = await readBranchFacts(task, mergeCommit ?? "");
  } catch (error) {
    unreadable = `Branch cleanup could not read the repository facts: ${messageOf(error)}`;
  }
  for (const candidate of due) {
    task = ctx.store.task(taskId);
    if (task.removedAt || task.phase !== "done") return task;
    const previous =
      task.resolution.branchCleanups.find((item) => item.branch === candidate.branch) ?? null;
    let record: BranchCleanupRecord | null;
    if (!facts) record = waited(candidate, previous, unreadable);
    else {
      try {
        record = await attemptBranchCleanup(ctx, task, candidate, facts, previous);
      } catch (error) {
        record = waited(candidate, previous, `Branch cleanup failed: ${messageOf(error)}`);
      }
    }
    if (record) {
      try {
        task = saveBranchCleanup(ctx.store, taskId, record);
      } catch {
        // A store that cannot record the effect ends this pass; the archive lane's
        // own guards own the fault and the next pass observes the branch again.
        return task;
      }
    }
  }
  return ctx.store.task(taskId);
}
