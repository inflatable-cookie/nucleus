import { realpathSync } from 'node:fs';
import type { Run, Task } from '../../shared/contracts';
import { git, queueCheckoutStatus } from '../git/index';
import { gitPrefix } from '../git/git-command';
import { GitIdentityError, readGitCheckout, readGitRef } from '../git/git-identity';

/**
 * The largest single inlined report (review text, worker return) a prompt may
 * carry; longer text keeps its head and names where the rest lives. Diff and
 * range-diff text are never inlined at any size (Tom, 2026-11-01): the
 * reviewer reads the delta with git in its own checkout. Characters stand in
 * for provider input limits; a 200 KB prompt is already far past what any
 * review turn should inline.
 */
export const REVIEW_PROMPT_INLINE_BUDGET = 200 * 1024;
/** Each variable reference section (stat, changed files) is capped on its
 * own so the whole prompt stays far under the report budget. */
export const REVIEW_PROMPT_SECTION_BUDGET = 50 * 1024;

/**
 * Cap one long inlined report at the shared prompt budget. Short text passes
 * through unchanged; over-budget text keeps its head and names what was cut
 * and where the full text lives, so no prompt silently drops review evidence.
 */
export function boundInlineReport(text: string, label: string, budget = REVIEW_PROMPT_INLINE_BUDGET): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n\u2026[truncated ${label}: ${budget} of ${text.length} characters shown; read the full text at its source before judging]`;
}

/** One bounded reference section: the head of the text plus a line count,
 * so the reviewer knows how much stayed out of the prompt. */
function boundDeltaSection(text: string, label: string, budget = REVIEW_PROMPT_SECTION_BUDGET): string {
  const lines = text.split('\n');
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n\u2026[truncated ${label}: showing the first ${budget} of ${text.length} characters across ${lines.length} lines]`;
}

/**
 * Exact-head and repository identity from the filesystem. Safe inside a
 * transaction or a stillAllowed send guard: no git spawn, no tree walk.
 */
export function assertOrdinaryReviewIdentity(task: Task, head: string, detached: boolean) {
  if (!task.workspaceIntent || !task.directory || !task.branch || task.branch === task.baseBranch) {
    const missing = [!task.workspaceIntent ? 'workspace intent' : '', !task.directory ? 'checkout directory' : '', !task.branch ? 'branch' : '', task.branch === task.baseBranch ? 'distinct task branch' : ''].filter(Boolean);
    throw Error(`Ordinary reviewer source identity is incomplete: expected workspace intent, checkout directory and a task branch distinct from ${task.baseBranch}; missing or invalid ${missing.join(', ') || 'identity fields'}`);
  }
  let checkout, repo;
  try {
    checkout = readGitCheckout(task.directory);
    repo = readGitCheckout(task.repoPath);
  } catch (error) {
    if (error instanceof GitIdentityError) {
      if (/^(No \.git|Unreadable \.git|Malformed \.git)/.test(error.message))
        throw Error('Ordinary reviewer requires its recorded Queue-owned checkout root');
      throw Error(`Ordinary reviewer checkout identity could not be read: ${String(error)}; expected a clean checkout at ${head} on ${task.branch}`);
    }
    throw error;
  }
  if (realpathSync(task.directory) === realpathSync(task.repoPath) || checkout.toplevel !== realpathSync(task.directory))
    throw Error('Ordinary reviewer requires its recorded Queue-owned checkout root');
  // Origin is compared because a worktree gitDir config can override commonDir.
  if (checkout.commonDir !== repo.commonDir || checkout.origin !== repo.origin)
    throw Error(`Ordinary reviewer repository identity changed: expected common directory ${repo.commonDir} and origin ${repo.origin}, observed ${checkout.commonDir} and ${checkout.origin}`);
  let branchTip: string;
  try { branchTip = readGitRef(checkout, `refs/heads/${task.branch}`); }
  catch (error) { throw Error(`Ordinary reviewer branch ref refs/heads/${task.branch} could not be read: ${String(error)}; expected ${head}`); }
  if (checkout.head !== head || branchTip !== head || checkout.branch !== (detached ? '' : task.branch))
    throw Error(`Ordinary reviewer checkout identity mismatch: expected HEAD ${head}, branch tip ${head}, and branch ${detached ? '(detached)' : task.branch}; observed HEAD ${checkout.head}, branch tip ${branchTip}, and branch ${checkout.branch || '(detached)'}`);
}

/**
 * Full send-boundary proof: filesystem identity plus an async clean-tree read.
 * The tree walk delays this task, not the executor's other work. Call this
 * before a transaction or as the last await before send; re-check identity
 * cheaply inside the guard or transaction.
 */
export async function ordinaryReviewSource(task: Task, head: string, detached: boolean) {
  assertOrdinaryReviewIdentity(task, head, detached);
  const status = await queueCheckoutStatus(task.directory!, 'status', '--porcelain');
  if (status) throw Error(`Ordinary reviewer checkout is dirty: expected an empty porcelain status; observed ${status.slice(0, 1000)}`);
}

export async function ordinaryReviewDelta(task: Task, prior: Run, head: string, base: string): Promise<string> {
  const read = (...args: string[]) => git(task.directory!, ...args);
  const oldBase = await read('merge-base', prior.base, prior.head);
  const newBase = await read('merge-base', base, head);
  // The range-diff is read to classify the round and never inlined: range-diff
  // emits '=' rows for an unchanged patch series; an empty series is also unchanged.
  const range = await read('range-diff', '--no-color', '--no-patch', `${oldBase}..${prior.head}`, `${newBase}..${head}`);
  const confirmation = range.split('\n').filter(Boolean).every(line => /^\s*\d+:\s+\S+\s+=\s+\d+:/.test(line));
  const header = `Prior run: ${prior.id}; priorHead: ${prior.head}\nBase movement: ${prior.base} -> ${base}\n${confirmation ? 'Pure rebase confirmation: unchanged patch series. Judge actual covering evidence at this new head; issue a genuine new verdict.' : 'Review the revision delta and resolve the earlier findings.'}\n`;
  const findings = `Earlier findings:\n${prior.completion?.reviewText ?? prior.completion?.summary}\nEarlier verdicts:\n${JSON.stringify(prior.completion?.verdicts ?? [])}\nBrief: earlier v${prior.briefVersion ?? 'legacy'}, current v${task.briefVersions.at(-1)?.version ?? 'legacy'}; amendments are marked in the supplied brief.\n`;
  // No delta or range-diff text enters the prompt at any size (Tom, 2026-11-01:
  // diffs are what git is for). The reviewer gets the stat, the changed files,
  // the exact SHAs and the commands to read the delta in its own checkout,
  // plus the earlier findings.
  const stat = boundDeltaSection(await gitPrefix(task.directory!, ['diff', '--stat', '--no-color', '--stat-count=100', `${prior.head}..${head}`], REVIEW_PROMPT_SECTION_BUDGET), 'diff stat');
  const files = boundDeltaSection(await gitPrefix(task.directory!, ['diff', '--name-only', '--no-color', `${prior.head}..${head}`], REVIEW_PROMPT_SECTION_BUDGET), 'changed files');
  return `${header}The delta and range-diff are never inlined; read them in this checkout with the commands below before judging, and do not report a verdict from the stat alone.\nDiff stat:\n${stat}\nChanged files:\n${files}\nExact SHAs: priorHead ${prior.head}, head ${head}, oldBase ${oldBase} (of ${prior.base}..${prior.head}), newBase ${newBase} (of ${base}..${head})\nCommands to read the delta:\n  git diff --no-ext-diff --no-color ${prior.head}..${head}\n  git range-diff --no-color ${oldBase}..${prior.head} ${newBase}..${head}\n${findings}`;
}


/** Exact-head identity from the filesystem. Safe inside a transaction or stillAllowed. */
function assertReviewRunSource(task: Task, head: string, detached: boolean) {
  assertOrdinaryReviewIdentity(task, head, detached);
}

/** Full send-boundary proof: identity plus an async clean-tree walk. Last await before send or a transaction. */
async function proveReviewRunSource(task: Task, head: string, detached: boolean) {
  await ordinaryReviewSource(task, head, detached);
}

export { assertReviewRunSource, proveReviewRunSource };
