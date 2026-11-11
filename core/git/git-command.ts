import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { retryGitSshAuthentication, SshAuthExhaustedError } from "./git-auth-retry";
import { queueGitFetch, withFetchLock } from "./git-fetch";
import { withSpawnSlot } from "../dispatch/spawn-gate";
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" };
async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitRaw(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.toString("utf8").trim();
}
export interface GitResult { code: number; signal?: NodeJS.Signals | null; stdout: Buffer; stderr: string; sshAuthExhausted?: SshAuthExhaustedError }

/** Run Git with byte-exact stdout. Trimmed text helpers hide trailing bytes we must not guess. */
export async function gitRaw(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024, extraEnv: Record<string, string> = {}, timeout = 30000): Promise<GitResult> {
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
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ code: error?.code as number ?? 0, signal: error?.signal, stdout, stderr: stderr.toString("utf8") });
    });
  }));
}

/** One Git failure formatter keeps the process result visible even when stderr is empty. */
export function formatGitError(args: readonly string[], code: number, signal: NodeJS.Signals | null | undefined, stderr: string): string {
  const outcome = signal ? `was terminated by ${signal}` : `exited with code ${code}`;
  return `git ${args.join(" ")} ${outcome}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
}
