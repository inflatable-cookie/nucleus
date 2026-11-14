import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { retryGitSshAuthentication, SshAuthExhaustedError } from "./git-auth-retry";
import { queueGitFetch, withFetchLock } from "./git-fetch";
import { withSpawnSlot } from "../dispatch/spawn-gate";
import { ForgeOutageError, githubHealthy, isForgeNetworkFailure, classifyGitCommandFailure, GitTransientError } from "../forge/forge-health";
import { isLoginSessionFault, LoginSessionFaultError, notifyLoginSessionFault } from "../../shared/session-fault";
import { promisify } from "node:util";
import { githubRepositoryFromRemote } from "./git-remote";
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" };
const exec = promisify(execFile);
async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitRun(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.toString("utf8").trim();
}
export interface GitResult { code: number; signal?: NodeJS.Signals | null; stdout: Buffer; stderr: string; sshAuthExhausted?: SshAuthExhaustedError }

/**
 * Run Git and keep its whole result: exit code, signal, byte-exact stdout and
 * stderr. This is the binary reader, for callers that inspect the exit code or
 * must not lose trailing bytes.
 */
export async function gitRun(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024, extraEnv: Record<string, string> = {}, timeout = 30000): Promise<GitResult> {
  class FailedGit extends Error {
    constructor(readonly result: GitResult) { super(result.stderr); }
    get code() { return this.result.code; }
    get stderr() { return this.result.stderr; }
    get stdout() { return this.result.stdout; }
  }
  const operation = () => retryGitSshAuthentication(args, async () => {
    const result = await gitRawOnce(cwd, args, maxBuffer, extraEnv, timeout);
    if (result.code !== 0) throw new FailedGit(result);
    return result;
  });
  try {
    return args[0] === "fetch"
      ? await queueGitFetch(await realpath(await gitText(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")), operation)
      : args[0] === "merge" && args.includes("--ff-only")
        ? await withFetchLock(`checkout:${await realpath(cwd)}`, operation)
        : await operation();
  } catch (error) {
    if (error instanceof FailedGit) return error.result;
    // Raw callers keep an exit result; throwing callers also need the typed
    // exhaustion witness for the GitHub outage probe.
    if (error instanceof SshAuthExhaustedError && error.original instanceof FailedGit)
      return { ...error.original.result, stderr: error.message, sshAuthExhausted: error };
    throw error;
  }
}

function gitRawOnce(cwd: string, args: string[], maxBuffer: number, extraEnv: Record<string, string>, timeout: number): Promise<GitResult> {
  return withSpawnSlot(() => new Promise((resolve, reject) => {
    if (!existsSync(cwd)) return reject(new Error(`Git working directory is unavailable: ${cwd}`));
    execFile("git", args, { cwd, timeout, killSignal: "SIGKILL", maxBuffer, encoding: "buffer",
      env: { ...process.env, ...GIT_ENV, ...extraEnv } }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(nameOutputLimit(error, ['git', ...args]));
      resolve({ code: error?.code as number ?? 0, signal: error?.signal, stdout, stderr: stderr.toString("utf8") });
    });
  }));
}

/** Node's maxBuffer error omits argv, which makes an attention reason impossible to act on. */
export function nameOutputLimit(error: unknown, command: readonly string[]): unknown {
  if (!(error instanceof Error) || !/maxBuffer length exceeded/i.test(error.message)
    || /exceeded its stdout output limit/i.test(error.message)) return error;
  const named = Object.assign(new Error(`${command.join(' ')} exceeded its stdout output limit: ${error.message}`), error);
  named.cause = error;
  return named;
}

/** One Git failure formatter keeps the process result visible even when stderr is empty. */
export function formatGitError(args: readonly string[], code: number, signal: NodeJS.Signals | null | undefined, stderr: string): string {
  const outcome = signal ? `was terminated by ${signal}` : `exited with code ${code}`;
  return `git ${args.join(" ")} ${outcome}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
}

/** Read a bounded prefix from a growing Git result without buffering the full output. */
export function gitPrefix(cwd: string, args: string[], maxBytes: number): Promise<string> {
  return withSpawnSlot(() => new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, timeout: 30_000, killSignal: "SIGKILL", env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let truncated = false;
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = maxBytes - size;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        size = maxBytes;
        truncated = true;
        child.kill("SIGTERM");
      } else {
        chunks.push(chunk);
        size += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString("utf8").slice(0, 4000 - stderr.length); });
    child.once("error", error => { if (!settled) { settled = true; reject(error); } });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      if (!truncated && code !== 0) return reject(new Error(formatGitError(args, code ?? -1, child.signalCode, stderr)));
      const output = Buffer.concat(chunks).toString("utf8");
      resolve(truncated ? `${output}\n…[truncated ${args.slice(0, 2).join(" ")} after ${maxBytes} bytes; read the full output in this checkout]` : output);
    });
  }));
}

/** Process a potentially large NUL-delimited Git result one record at a time. */
export async function gitNulEach(cwd: string, args: string[], visit: (record: string) => void | Promise<void>): Promise<void> {
  await withSpawnSlot(async () => {
    const child = spawn("git", args, { cwd, timeout: 30_000, killSignal: "SIGKILL", env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", status => resolve(status));
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString("utf8").slice(0, 4000 - stderr.length); });
    let pending = Buffer.alloc(0);
    try {
      for await (const chunk of child.stdout) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let boundary: number;
        while ((boundary = pending.indexOf(0)) !== -1) {
          await visit(pending.subarray(0, boundary).toString("utf8"));
          pending = pending.subarray(boundary + 1);
        }
      }
      const code = await closed;
      if (pending.length) throw new Error(`git ${args.join(" ")} returned an incomplete NUL-delimited record`);
      if (code !== 0) throw new Error(formatGitError(args, code ?? -1, child.signalCode, stderr));
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      throw error;
    }
  });
}


/** Hash a potentially large Git blob as it streams from the child process. */
export async function gitHash(cwd: string, args: string[]): Promise<string> {
  return withSpawnSlot(async () => {
    const child = spawn("git", args, { cwd, timeout: 30_000, killSignal: "SIGKILL", env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", status => resolve(status));
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString("utf8").slice(0, 4000 - stderr.length); });
    const hash = createHash("sha256");
    try {
      for await (const chunk of child.stdout) hash.update(chunk);
      const code = await closed;
      if (code !== 0) throw new Error(formatGitError(args, code ?? -1, child.signalCode, stderr));
      return hash.digest("hex");
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      throw error;
    }
  });
}

/**
 * The one Git and `gh` process runner: the environment, the spawn slot, the
 * output ceiling, the timeout ceiling and the failure classification every
 * other Git module calls.
 *
 * A failed remote mutation is classified so its caller can keep a durable
 * intent, never so it can retry blindly.
 */
export async function command(file: string, args: string[], cwd: string, extraEnv?: NodeJS.ProcessEnv, options?: { timeout?: number; maxBuffer?: number; trim?: boolean }): Promise<string> {
  const run = () => withSpawnSlot(() => exec(file, args, { cwd, timeout: options?.timeout ?? 30000, maxBuffer: options?.maxBuffer ?? 1024 * 1024,
    env: { ...process.env, ...extraEnv, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" } }));
  try {
    const result = file === "git" ? await (async () => {
      const raw = await gitRun(cwd, args, options?.maxBuffer ?? 1024 * 1024, extraEnv as Record<string, string>, options?.timeout);
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

/** The finite answer to "does this commit contain that one": yes, a proven no, or unreadable. */
export type GitAncestry = 'ancestor' | 'diverged' | 'unknown';

/**
 * Asynchronous ancestry on the shared runner: exit 0 is a proven yes and exit 1
 * a proven no; anything else (missing object, unusable executable, timeout) is
 * unknown. Only a proven "no" is divergence — an unreadable ancestry never is.
 */
export async function gitAncestry(cwd: string, ancestor: string, descendant: string): Promise<GitAncestry> {
  const result = await gitRun(cwd, ["merge-base", "--is-ancestor", ancestor, descendant], 64 * 1024);
  return result.code === 0 ? 'ancestor' : result.code === 1 ? 'diverged' : 'unknown';
}

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
export const gitRaw = (cwd: string, ...args: string[]) => command("git", args, cwd, undefined, { trim: false });

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
export const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The last progress or fatal lines, with URL credentials removed and length capped. */
function boundedGitOutput(output: unknown): string {
  const lines = String(output ?? "").split(/[\r\n]+/).map(line => line.trim()).filter(Boolean).slice(-GIT_DIAGNOSTIC_MAX_LINES);
  const text = lines.join("\n").replace(/(\/\/)[^/\s@]+@/g, "$1***@");
  return text.length > GIT_DIAGNOSTIC_MAX_CHARS ? `…${text.slice(-GIT_DIAGNOSTIC_MAX_CHARS)}` : text;
}
