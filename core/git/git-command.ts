import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
      if (error && typeof error.code !== "number") return reject(nameOutputLimit(error, ['git', ...args]));
      resolve({ code: error?.code as number ?? 0, signal: error?.signal, stdout, stderr: stderr.toString("utf8") });
    });
  }));
}

/** Node's maxBuffer error omits argv, which makes an attention reason impossible to act on. */
export function nameOutputLimit(error: unknown, command: readonly string[]): unknown {
  if (!(error instanceof Error) || !/maxBuffer length exceeded/i.test(error.message)) return error;
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
    const child = spawn("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] });
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
    const child = spawn("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] });
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
    const child = spawn("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] });
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
