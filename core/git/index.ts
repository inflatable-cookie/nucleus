import { ForgeOutageError, githubHealthy, isForgeNetworkFailure, classifyGitCommandFailure, GitTransientError } from '../forge/forge-health';
import { SshAuthExhaustedError } from './git-auth-retry';
import { gitRaw as runGitRaw, nameOutputLimit } from "./git-command";
import { execFile, execFileSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Run, StashEntry, Submission, Task } from "../../shared/contracts";
import type { InstructionArtifact } from "../../shared/hooks";
import { CONTROL_SCHEMA_V5, manifestSupportsCloseoutSelection } from "../../shared/hooks";
import { discoverManifest, instructionForCommit, pinInstruction } from "../hooks/hook-manifest";
import { assertOneInstructionSource, briefDigest, currentBrief, pinnedBriefDigest } from "../planning/brief";
import { isLoginSessionFault, LoginSessionFaultError } from "../../shared/session-fault";
import { taskCheckoutTarget } from "../workspaces/checkout-target";
import { notifyLoginSessionFault } from "../../shared/session-fault";
import { withSpawnSlot } from "../dispatch/spawn-gate";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
const exec = promisify(execFile);

export async function command(file: string, args: string[], cwd: string, extraEnv?: NodeJS.ProcessEnv, options?: { timeout?: number; maxBuffer?: number; trim?: boolean }): Promise<string> {
  const run = () => withSpawnSlot(() => exec(file, args, { cwd, timeout: options?.timeout ?? 30000, maxBuffer: options?.maxBuffer ?? 1024 * 1024,
    env: { ...process.env, ...extraEnv, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" } }));
  try {
    const result = file === "git" ? await (async () => {
      const raw = await runGitRaw(cwd, args, options?.maxBuffer ?? 1024 * 1024, extraEnv as Record<string, string>, options?.timeout);
      if (raw.sshAuthExhausted) throw raw.sshAuthExhausted;
      if (raw.code !== 0) throw Object.assign(new Error(raw.stderr || `git ${args.join(" ")} exited with code ${raw.code}`), raw);
      return { stdout: raw.stdout.toString("utf8") };
    })() : await run();
    return options?.trim === false ? result.stdout : result.stdout.trim();
  } catch (error) {
    const namedError = nameOutputLimit(error, [file, ...args]);
    if (file === "gh" && isLoginSessionFault(namedError)) {
      notifyLoginSessionFault();
      throw new LoginSessionFaultError(namedError);
    }
    const remoteFailure = file === "git" && ["fetch", "push", "ls-remote"].includes(args[0]) &&
      (namedError instanceof SshAuthExhaustedError || isForgeNetworkFailure(namedError));
    const githubRemote = remoteFailure && Boolean(githubRepositoryFromRemote(await command("git", ["remote", "get-url", "origin"], cwd).catch(() => "")));
    const kind = (file === "git" || file === "gh") ? classifyGitCommandFailure(namedError) : null;
    // A failed remote mutation can have reached its recipient. Its caller's
    // durable intent, not this classification, governs any later retry.
    const ghRead = args[0] === 'pr' && ['view', 'list'].includes(args[1]) || args[0] === 'api'
      && !args.some(arg => ['-f', '-F', '--field', '--raw-field', '--input'].includes(arg))
      && !args.some((arg, i) => ['-X', '--method'].includes(arg) && args[i + 1]?.toUpperCase() !== 'GET');
    const mutating = file === 'git' && args[0] === 'push' || file === 'gh' && !ghRead;
    const wrapped = namedError instanceof GitTransientError ? namedError : kind ? new GitTransientError(kind, namedError, kind === 'network' && mutating) : namedError;
    if ((file === "gh" && isForgeNetworkFailure(error) || githubRemote) && !await githubHealthy())
      throw new ForgeOutageError(wrapped);
    throw wrapped;
  }
}
export const git = (cwd: string, ...args: string[]) => command("git", args, cwd);
/** Bounded local Git witness. Network freshness comes from separately dated remote reads.
 * This helper does not reserve external writers or prove remote-at-commit state.
 */
/**
 * Synchronous ancestry answer for the finite dated boundary: 0 yes, 1 no, and
 * anything else (missing object, unusable executable, timeout) is unknown. Only
 * a proven "no" is divergence; an unreadable ancestry is never drift.
 */
export function gitAncestrySync(cwd: string, ancestor: string, descendant: string): 'ancestor' | 'diverged' | 'unknown' {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant],
      { cwd, stdio: ["ignore", "ignore", "pipe"], timeout: 30000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" } });
    return 'ancestor';
  } catch (error) {
    return (error as { status?: unknown }).status === 1 ? 'diverged' : 'unknown';
  }
}

export function gitSync(cwd: string, ...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" } }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: unknown })?.stderr;
    const detail = typeof stderr === "string" && stderr.trim() ? stderr.trim()
      : error instanceof Error && error.message ? error.message : String(error);
    throw Error(detail.slice(0, 2000));
  }
}

/** True only for the dependency link Queue retains from a source checkout. */
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
 * Raw stdout for `git` calls whose output must not be trimmed or normalized,
 * such as NUL-separated path lists. Trimming would fold a whitespace sibling
 * (`manifest.json `) into the declared `manifest.json`.
 */
export const gitRaw = (cwd: string, ...args: string[]) => command("git", args, cwd, undefined, { trim: false });
export function githubRepositoryFromRemote(remote: string): string | null {
  const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}
/** The default gate is tuned to per-command Git reads; store clones, repacks and linked-checkout population over full history need a longer ceiling. */
export const GIT_SLOW_TIMEOUT_MS = 600000;
const GIT_SLOW_MAX_BUFFER = 8 * 1024 * 1024;
export const gitSlow = (cwd: string, ...args: string[]) => command("git", args, cwd, undefined, { timeout: GIT_SLOW_TIMEOUT_MS, maxBuffer: GIT_SLOW_MAX_BUFFER });
const GIT_DIAGNOSTIC_MAX_CHARS = 2000, GIT_DIAGNOSTIC_MAX_LINES = 8;

/** A failed bulk Git command. Its fields keep timeout, exit and signal evidence apart; output is bounded. */
export class GitBulkCommandError extends Error {
  readonly args!: string[];
  readonly budgetMs!: number;
  readonly elapsedMs!: number;
  readonly timedOut!: boolean;
  /** Node's raw witness that it terminated the child, which is true for a timeout and for an output overrun. */
  readonly killed!: boolean;
  readonly exitCode!: number | null;
  readonly signal!: string | null;
  readonly stdout!: string;
  readonly stderr!: string;
  constructor(message: string, fields: Omit<GitBulkCommandError, "name" | "message" | "stack" | "cause">) {
    super(message);
    this.name = "GitBulkCommandError";
    Object.assign(this, fields);
  }
}

/**
 * Bulk filesystem Git (linked worktree add and no-force remove) under the slow
 * ceiling. The generic 30-second read gate would stop a healthy checkout mid-populate.
 */
export async function gitBulk(cwd: string, ...args: string[]): Promise<void> {
  const started = Date.now();
  try { await gitSlow(cwd, ...args); }
  catch (error) { throw bulkGitFailure(args, GIT_SLOW_TIMEOUT_MS, Date.now() - started, error); }
}

/**
 * Classify a failed `execFile` call. Node sets `killed` only when it terminated
 * the child itself (the timeout, or an output overrun), so a timeout is
 * witnessed by that flag, never inferred from progress text.
 */
export function bulkGitFailure(args: string[], budgetMs: number, elapsedMs: number, error: unknown): GitBulkCommandError {
  const failure = error as { code?: unknown; signal?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown } | null;
  const overflow = failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  const killed = failure?.killed === true;
  const timedOut = killed && !overflow;
  const exitCode = typeof failure?.code === "number" ? failure.code : null;
  const signal = typeof failure?.signal === "string" ? failure.signal : null;
  const stdout = boundedGitOutput(failure?.stdout), stderr = boundedGitOutput(failure?.stderr);
  const subject = `git ${args.slice(0, 2).join(" ")}`;
  const killedBy = signal ?? "an unknown signal";
  const verdict = timedOut ? `timed out and was terminated by ${killedBy}`
    : overflow ? `exceeded its ${GIT_SLOW_MAX_BUFFER}-byte output limit${killed ? ` and was terminated by ${killedBy}` : ""}`
    : exitCode !== null ? `exited with code ${exitCode}`
    : signal ? `was terminated by ${signal}`
    : `failed without exit evidence (${typeof failure?.code === "string" ? failure.code : "unknown code"})`;
  // The budget and elapsed time name every outcome, so a refusal never hides the ceiling it ran under.
  const message = `${subject} ${verdict} (budget ${budgetMs}ms, elapsed ${elapsedMs}ms)${stderr ? `: ${stderr}` : ""}${stdout ? ` (stdout: ${stdout})` : ""}`;
  return new GitBulkCommandError(message, { args, budgetMs, elapsedMs, timedOut, killed, exitCode, signal, stdout, stderr });
}

/**
 * A refused private-root cleanup after the integration operation had already
 * failed. `cause` is the cleanup refusal and `operationError` the earlier failure;
 * both keep their own fields, and the message carries both for durable records.
 */
export class IntegrationCheckoutCleanupError extends Error {
  readonly operationError: unknown;
  constructor(cleanupError: unknown, operationError: unknown) {
    super(`${messageOf(cleanupError)}; the integration operation failed first: ${messageOf(operationError)}`, { cause: cleanupError });
    this.name = "IntegrationCheckoutCleanupError";
    this.operationError = operationError;
  }
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The last progress or fatal lines, with URL credentials removed and length capped. */
function boundedGitOutput(output: unknown): string {
  const lines = String(output ?? "").split(/[\r\n]+/).map(line => line.trim()).filter(Boolean).slice(-GIT_DIAGNOSTIC_MAX_LINES);
  const text = lines.join("\n").replace(/(\/\/)[^/\s@]+@/g, "$1***@");
  return text.length > GIT_DIAGNOSTIC_MAX_CHARS ? `…${text.slice(-GIT_DIAGNOSTIC_MAX_CHARS)}` : text;
}
export interface PlanningHeadProof { head: string; planningCommit: string; ancestor?: boolean }

export async function validateSubmission(input: Submission) {
  if (!isAbsolute(input.repoPath) || await realpath(input.repoPath) !== input.repoPath) throw new Error("Use the repository's absolute real path");
  if (await git(input.repoPath, "rev-parse", "--show-toplevel") !== input.repoPath) throw new Error("Repository path must name its Git root");
  await git(input.repoPath, "check-ref-format", "--branch", input.baseBranch);
  assertOneInstructionSource(input);
  if (input.brief) return validateBriefSubmission(input);
  if (input.handoffPath.startsWith("/") || input.handoffPath.split("/").some(p => !p || p === "." || p === "..") || input.handoffPath.includes("\\")) throw new Error("Handoff must be a repository-relative file path");
  const tree = await git(input.repoPath, "ls-tree", input.planningCommit, "--", input.handoffPath);
  if (!/^100(644|755) blob /.test(tree)) throw new Error("Handoff must be a regular tracked file at the planning commit");
  const instruction = await resolveInstruction(input);
  const handoffText = await git(input.repoPath, "show", `${input.planningCommit}:${input.handoffPath}`);
  if (!handoffText || handoffText.length > 128000) throw new Error("Handoff is empty or exceeds 128 KB");
  const planningBase = await git(input.repoPath, "rev-parse", `refs/heads/${input.baseBranch}`);
  try {
    await git(input.repoPath, "merge-base", "--is-ancestor", input.planningCommit, planningBase);
  } catch (error) {
    throw error;
  }
  return { handoffText, planningBase, instruction };
}
/**
 * Spec 020 brief submission: nothing is read from or written to the repository
 * except the manifest eligibility and planning ancestry at the planning commit.
 */
async function validateBriefSubmission(input: Submission) {
  pinnedBriefDigest(input);
  if (input.instruction) throw new Error("A Queue-held brief carries no committed instruction artifact");
  await assertBriefEligible(input.repoPath, input.planningCommit);
  // Spec 022: the planning base is the pushed integration head, fetched fresh.
  // A shared checkout that is merely behind origin still validates against what
  // is pushed, because capture pinned the pushed head as the planning commit.
  try { await git(input.repoPath, "fetch", "origin", input.baseBranch); }
  catch (error) { throw new SubmissionUnavailableError(`Submission awaits Git remote: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  const planningBase = await git(input.repoPath, "rev-parse", `refs/remotes/origin/${input.baseBranch}`);
  const ancestor = await isAncestor(input.repoPath, input.planningCommit, planningBase);
  if (!ancestor) throw new Error("Brief planning commit is not on the integration branch");
  return { handoffText: input.brief!.text, planningBase, instruction: null };
}
const isAncestor = (cwd: string, ancestor: string, head: string) => git(cwd, "merge-base", "--is-ancestor", ancestor, head).then(() => true, () => false);
/**
 * Brief mode runs only where no lifecycle hook reads a committed handoff: a v5,
 * v6 or v7 manifest at the planning commit, or no manifest. v1–v4 are refused.
 */
export async function assertBriefEligible(repoPath: string, planningCommit: string) {
  const discovery = await discoverManifest(repoPath, planningCommit);
  if (discovery && !manifestSupportsCloseoutSelection(discovery.manifest.schema))
    throw new Error(`Brief mode requires a ${CONTROL_SCHEMA_V5} control manifest or none; this repository's manifest at ${planningCommit.slice(0, 12)} is ${discovery.manifest.schema}, whose lifecycle hooks read committed handoffs. Submit a committed handoff instead.`);
}
/** A brief task's pinned text must be exactly its current recorded version. */
function assertPinnedBrief(task: Task) {
  const current = currentBrief(task);
  if (!current || current.text !== task.handoffText || current.digest !== briefDigest(task.handoffText)) throw new Error("Queue-held brief does not match its pinned version");
}
/** Prove a brief worker's source identity, accounting for an external PR intake. */
async function verifyBriefWorkerIdentity(task: Task, directory: string, head: string, ordinaryFailure = "Brief planning commit is not an ancestor of the worker worktree"): Promise<void> {
  assertPinnedBrief(task);
  if (task.reviewEntry) {
    const { planningCommit, verifiedBase, verifiedHead } = task.reviewEntry;
    if (planningCommit !== task.planningCommit || !await isAncestor(directory, planningCommit, verifiedBase))
      throw new Error("Brief review-entry base does not descend from the planning commit");
    if (!await isAncestor(directory, verifiedHead, head))
      throw new Error("Brief review-entry worker head does not descend from the recorded intake head");
    return;
  }
  if (!await isAncestor(directory, task.planningCommit, head))
    throw new Error(ordinaryFailure);
}
/** A read-only submission check can wait safely for its Git remote without losing intent. */
export class SubmissionUnavailableError extends Error {}

/** Verify pushed planning after acceptance; fetch before ancestry checks and never mutate the checkout. */
export async function verifyPublishedPlanning(input: Submission): Promise<void> {
  try { await git(input.repoPath, "fetch", "origin", input.baseBranch); }
  catch (error) { throw new SubmissionUnavailableError(`Submission awaits Git remote: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  const local = await git(input.repoPath, "rev-parse", `refs/heads/${input.baseBranch}`);
  const remote = await git(input.repoPath, "rev-parse", `refs/remotes/origin/${input.baseBranch}`);
  const pushed = await git(input.repoPath, "merge-base", "--is-ancestor", local, remote).then(() => true, () => false);
  if (!pushed) throw new Error("Push the integration commit before queue submission");
  await git(input.repoPath, "merge-base", "--is-ancestor", input.planningCommit, remote);
}

/** Resolve the immutable generic instruction identity, validating any supplied artifact. */
async function resolveInstruction(input: Submission): Promise<InstructionArtifact> {
  if (!input.instruction) return instructionForCommit(input.repoPath, input.planningCommit, input.handoffPath, "text/markdown");
  if (input.instruction.commit !== input.planningCommit || input.instruction.path !== input.handoffPath) throw new Error("Instruction identity must match the committed planning base");
  return pinInstruction(input.repoPath, input.instruction);
}
/** Use a private linked base checkout without switching the registered main checkout. */
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
      const behindOnly = await git(task.repoPath, "merge-base", "--is-ancestor", local, remote).then(() => true, () => false);
      if (!behindOnly) throw new Error("Local integration branch diverged from origin; resolve it before dispatch");
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
  const descends = await git(directory, "merge-base", "--is-ancestor", task.planningBase, newBase).then(() => true, () => false);
  if (!descends) throw new Error("Proposed dispatch base does not descend from the recorded base; a rewrite is never re-recorded");
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
    const ahead = await git(directory, "merge-base", "--is-ancestor", task.planningBase, head).then(() => true, () => false);
    if (!ahead) {
      const behind = await git(directory, "merge-base", "--is-ancestor", head, task.planningBase).then(() => true, () => false);
      if (!behind) throw new Error("Worker worktree does not match the recorded dispatch base");
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
export async function readStash(directory: string): Promise<StashEntry[]> {
  if (!await git(directory, "rev-parse", "--verify", "--quiet", "refs/stash").then(() => true, () => false)) return [];
  const log = await git(directory, "log", "--walk-reflogs", "--format=%H%x09%gs", "refs/stash");
  return log.split("\n").filter(Boolean).map(line => {
    const tab = line.indexOf("\t");
    return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
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
export async function reportOnlySourceHead(task: Task, runs: readonly Run[]): Promise<string> {
  if (!task.directory) throw new Error("Report-only source requires the retained task workspace");
  const head = await git(task.directory, "rev-parse", "HEAD");
  const contains = (commit: string) => /^[a-f0-9]{40}$/.test(commit)
    && git(task.directory!, "merge-base", "--is-ancestor", commit, head).then(() => true, () => false);
  // Every authenticated reported head binds the source, including a checkout
  // back at the planning base: reported donor work it lacks is never discarded.
  const reported = [task.completion?.head, ...task.checkpoints.records.map(record => record.head),
    ...runs.filter(run => run.workspaceId === task.workspaceId).map(run => run.completion?.head)];
  for (const recorded of new Set(reported.filter((value): value is string => Boolean(value))))
    if (!await contains(recorded))
      throw new Error(`Report-only source ${head} does not contain authenticated reported head ${recorded}; workspace preserved`);
  if (head === task.planningBase) return head;
  await verifyReportOnlyIdentity(task);
  if (!await contains(task.planningBase))
    throw new Error(`Report-only source ${head} does not descend from planning base ${task.planningBase}; workspace preserved`);
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
  if (!await isAncestor(task.directory, task.planningBase, head)) throw new Error('Replacement source does not descend from the task planning base');
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
    if (live.get(name) === sha && await git(directory, "merge-base", "--is-ancestor", head, sha).then(() => true, () => false)) containing.add(name);
  }
  return preferred.find(name => containing.has(name)) ?? [...containing].sort()[0] ?? null;
}
