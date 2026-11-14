/**
 * The local checkout's own state: its status, the paths a status must never
 * count, and the branch its queue-owned checkout is on.
 *
 * One filter decides what a clean checkout means, so a review gate, a dispatch
 * check and a completion proof cannot disagree about whether the same tree is
 * dirty.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Task } from "../../shared/contracts";
import { GIT_SLOW_TIMEOUT_MS, git, gitSlow } from "./git-command";

export function isQueueRetainedNodeModulesLink(directory: string): boolean {
  try {
    const link = resolve(directory, "node_modules");
    if (!lstatSync(link).isSymbolicLink() || !statSync(link).isDirectory()) return false;
    const root = realpathSync(directory);
    const target = realpathSync(link);
    const fromRoot = relative(root, target);
    return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
  } catch {
    return false;
  }
}

/**
 * Git reports Queue's retained root dependency symlink as untracked when a
 * repository ignores only `node_modules/`. Hide that one owned shape from
 * checkout cleanliness proofs while preserving every other status entry.
 */
function withoutRetainedNodeModulesStatus(directory: string, status: string): string {
  if (!isQueueRetainedNodeModulesLink(directory)) return status;
  return status.split("\n").filter(line => line !== "?? node_modules" && line !== "?? node_modules/").join("\n");
}

/** OS/editor metadata is not task source and must never make a checkout dirty. */
export function isOsMetadataPath(path: string): boolean {
  return path.split("/").some(part => part === ".DS_Store" || part === ".localized" || part.startsWith("._"));
}

function withoutOsMetadataStatus(status: string): string {
  return status.split("\n").filter(line => {
    const path = line.slice(3).replace(/^"|"$/g, "");
    return !((line.startsWith("?? ") || line.startsWith("!! ")) && isOsMetadataPath(path));
  }).join("\n");
}

export async function queueCheckoutStatus(directory: string, ...args: string[]): Promise<string> {
  return withoutOsMetadataStatus(withoutRetainedNodeModulesStatus(directory, await gitStatus(directory, ...args)));
}

/** A local Git status read whose child process was terminated by its own timeout. */
export class GitReadTimeoutError extends Error {
  readonly args: string[];
  readonly timeoutMs: number;
  constructor(args: string[], timeoutMs: number, cause: unknown) {
    super(`git ${args.join(' ')} timed out after ${timeoutMs}ms`, { cause });
    this.name = 'GitReadTimeoutError';
    this.args = [...args];
    this.timeoutMs = timeoutMs;
  }
}

/** The timeout is trusted only when Node reports it terminated the child itself. */
export function gitReadTimeoutFailure(args: string[], timeoutMs: number, error: unknown): GitReadTimeoutError | null {
  const failure = error as { killed?: unknown; code?: unknown } | null;
  return failure?.killed === true && failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    ? new GitReadTimeoutError(args, timeoutMs, error)
    : null;
}

/** Local checkout status can be slow under disk load; other Git and network reads keep their own bounds. */
export async function gitStatus(directory: string, ...args: string[]): Promise<string> {
  const timeoutMs = GIT_SLOW_TIMEOUT_MS;
  try {
    return await gitSlow(directory, ...args);
  } catch (error) {
    const timeout = gitReadTimeoutFailure(args, timeoutMs, error);
    if (timeout) throw timeout;
    throw error;
  }
}

export async function queueUntrackedFiles(directory: string, ...args: string[]): Promise<string> {
  const files = await git(directory, ...args);
  return files.split("\n").filter(path => !isOsMetadataPath(path)
    && !(path === "node_modules" && isQueueRetainedNodeModulesLink(directory))).join("\n");
}
/**
 * The worker checkout's current branch, reattaching it first when ordinary review
 * left it detached at the reviewed head. Reattach only when that clean head is
 * still exactly the locally recorded and remotely published queue branch tip;
 * otherwise return the checkout's branch unchanged (empty when detached) for the
 * caller to refuse.
 */
export async function currentWorkerBranch(task: Pick<Task, "branch" | "baseBranch">, directory: string): Promise<string> {
  let branch = await git(directory, "branch", "--show-current");
  if (!branch && task.branch && task.branch !== task.baseBranch && !(await queueCheckoutStatus(directory, "status", "--porcelain"))) {
    const head = await git(directory, "rev-parse", "HEAD");
    const local = await git(directory, "rev-parse", "--verify", `refs/heads/${task.branch}`).catch(() => "");
    const remote = await git(directory, "ls-remote", "origin", `refs/heads/${task.branch}`).catch(() => "");
    const published = remote.split(/\s+/)[0] ?? "";
    if (head === local && head === published) {
      await git(directory, "switch", "--quiet", task.branch);
      branch = await git(directory, "branch", "--show-current");
      if (branch !== task.branch || await git(directory, "rev-parse", "HEAD") !== head
        || await queueCheckoutStatus(directory, "status", "--porcelain"))
        throw new Error("Detached worker checkout changed while reattaching its queue-owned branch");
    }
  }
  return branch;
}
