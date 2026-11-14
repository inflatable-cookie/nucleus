/**
 * The shared stash list, read only.
 *
 * `refs/stash` lives in the common Git directory, so every worktree reads the
 * same list. Queue never runs `git stash` in any worktree; it reads the list to
 * report work another worktree moved while this run was live.
 */
import type { StashEntry, Task } from "../../shared/contracts";
import { git, gitNulEach } from "./git-command";

export async function readStash(directory: string): Promise<StashEntry[]> {
  if (!await git(directory, "rev-parse", "--verify", "--quiet", "refs/stash").then(() => true, () => false)) return [];
  const entries: StashEntry[] = [];
  await gitNulEach(directory, ["log", "--walk-reflogs", "-z", "--format=%H%x09%gs", "refs/stash"], record => {
    const line = record.replace(/^\n+|\n+$/g, "");
    if (!line) return;
    const tab = line.indexOf("\t");
    entries.push({ sha: line.slice(0, tab), subject: line.slice(tab + 1) });
  });
  return entries;
}
/** The branch a stash entry was taken on, from `WIP on <branch>: ...` or `On <branch>: ...`. */
export const stashBranch = (subject: string) => subject.match(/^(?:WIP on|On) ([^:]+):/)?.[1] ?? null;
const QUEUE_BRANCH = /^ns-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const describeStash = (entry: StashEntry) => `stash entry ${entry.sha.slice(0, 12)} "${entry.subject}"`;
/**
 * Compare the stash list recorded when the run was created with the current
 * one. An entry that vanished during the run and was not taken on this task's
 * branch was popped or dropped from another worktree's work. An entry that
 * appeared during the run naming another Queue branch is that task's work,
 * stashed while this run could apply it. A run that never touches the stash,
 * while no other worktree does, produces no findings.
 */
export function stashFindings(branch: string, baseline: StashEntry[], current: StashEntry[]) {
  const present = new Set(current.map(entry => entry.sha));
  const vanished = baseline.filter(entry => !present.has(entry.sha) && stashBranch(entry.subject) !== branch)
    .map(entry => `${describeStash(entry)} was popped or dropped during this run; it was taken on ${stashBranch(entry.subject) ?? "an unknown branch"}, not ${branch}`);
  const recorded = new Set(baseline.map(entry => entry.sha));
  const foreign = current.filter(entry => { const other = stashBranch(entry.subject); return !recorded.has(entry.sha) && other !== null && other !== branch && QUEUE_BRANCH.test(other); })
    .map(entry => `${describeStash(entry)} names another Queue branch ${stashBranch(entry.subject)}`);
  return [...vanished, ...foreign];
}
/**
 * A dirty-worktree refusal names any stash that crossed worktrees during the
 * run, so the likely cause is visible instead of a bare "leave a clean worktree".
 */
export async function dirtyWorktreeError(task: Task, message: string) {
  if (!task.directory || !task.stashBaseline) return new Error(message);
  let findings: string[];
  try { findings = stashFindings(task.branch, task.stashBaseline.entries, await readStash(task.directory)); }
  catch { return new Error(message); }
  return new Error(findings.length ? `${message}. Stash findings: ${findings.join("; ")}` : message);
}
