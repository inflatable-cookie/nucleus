import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { withSpawnSlot } from "../dispatch/spawn-gate";
import { CheckoutRefusalError, CheckoutUnavailableError } from "./checkout-volume";

const execFileAsync = promisify(execFile);

export const BARGE_CLI_DEFAULT_TIMEOUT_MS = 60_000;

export const bargeErrorKindSchema = z.enum([
  "usage",
  "refused",
  "not_found",
  "unknown_state",
  "io",
  "unsupported",
  "uncertain",
]);
export type BargeErrorKind = z.infer<typeof bargeErrorKindSchema>;

const bargeErrorEnvelopeSchema = z.object({
  schema: z.literal("barge.error/1"),
  error: z.object({
    kind: z.string(),
    message: z.string(),
  }),
});

export const bargeWorktreeLeaseSchema = z
  .object({
    schema: z.string(),
    lease_id: z.string().min(1),
    request: z.string().min(1),
    repo: z.string().min(1),
    base: z.string().min(1),
    base_name: z.string().nullable().optional(),
    branch: z.string().min(1),
    label: z.string().nullable().optional(),
    pool: z.string().min(1),
    root_id: z.string().min(1),
    path: z.string().min(1),
    head: z.string().min(1),
    state: z.enum(["leased", "returning", "returned", "interrupted"]),
    disposable: z.boolean(),
    created_unix_ms: z.number(),
    updated_unix_ms: z.number(),
  })
  .passthrough();
export type BargeWorktreeLease = z.infer<typeof bargeWorktreeLeaseSchema>;

export const bargeWorktreeReturnSchema = z
  .object({
    lease_id: z.string().min(1),
    state: z.string().min(1),
    already_returned: z.boolean().optional(),
    disposable: z.boolean().optional(),
    root_id: z.string().optional(),
    path: z.string().optional(),
  })
  .passthrough();
export type BargeWorktreeReturn = z.infer<typeof bargeWorktreeReturnSchema>;

export const bargeWorktreeRootSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    held: z.boolean(),
    state: z.string().min(1),
    lease_id: z.string().nullable().optional(),
    request: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
  })
  .passthrough();
export type BargeWorktreeRoot = z.infer<typeof bargeWorktreeRootSchema>;

export const bargeWorktreePoolStatusSchema = z
  .object({
    repo: z.string().min(1),
    pool: z.string().min(1),
    warm: z.number(),
    max: z.number(),
    location: z.string().nullable().optional(),
    unavailable: z.string().nullable().optional(),
    roots: z.array(bargeWorktreeRootSchema).default([]),
  })
  .passthrough();
export type BargeWorktreePoolStatus = z.infer<
  typeof bargeWorktreePoolStatusSchema
>;

export interface BargeCommandExecutionInput {
  bin: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface BargeCommandExecutionOutput {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnErrorCode?: string;
  timedOut?: boolean;
}

export type BargeCommandRunner = (
  input: BargeCommandExecutionInput,
) => Promise<BargeCommandExecutionOutput>;

let runnerOverride: BargeCommandRunner | null = null;

/** Test hook to intercept `barge` CLI invocations without live global binaries. */
export function overrideBargeCommandRunnerForTest(
  runner: BargeCommandRunner | null,
): void {
  runnerOverride = runner;
}

export function resolveBargeBinary(binOverride?: string): string {
  return (
    binOverride?.trim() ||
    process.env.NUCLEUS_BARGE_BIN?.trim() ||
    process.env.BARGE_BIN?.trim() ||
    "barge"
  );
}

export function buildBargeEnv(
  extraEnv?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
  }
  return merged;
}

/**
 * Format a Barge `--request` id obeying Barge's constraint:
 * 1..=64 ASCII chars in `[A-Za-z0-9-_.]`, not starting with `.` or `-`.
 */
export function formatBargeRequestId(
  prefix: string,
  taskId: string,
  sequence: number,
  suffix?: string,
): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9-_.]/g, "_");
  const cleanPrefix = safe(prefix).replace(/^[.-]+/, "") || "nuc";
  const cleanSuffix = suffix ? `-${safe(suffix)}` : "";
  const body = `${cleanPrefix}-${safe(taskId)}-a${sequence}${cleanSuffix}`;
  if (body.length <= 64) return body;
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 12);
  const headMax = Math.max(8, 64 - digest.length - cleanSuffix.length - 1);
  return `${body.slice(0, headMax)}-${digest}${cleanSuffix}`.slice(0, 64);
}

export class BargeCliError extends Error {
  readonly kind: BargeErrorKind;
  readonly exitCode: number | null;
  readonly uncertain: boolean;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    kind: BargeErrorKind,
    message: string,
    options: {
      exitCode?: number | null;
      uncertain?: boolean;
      stdout?: string;
      stderr?: string;
    } = {},
  ) {
    super(message);
    this.name = "BargeCliError";
    this.kind = kind;
    this.exitCode = options.exitCode ?? null;
    this.uncertain = options.uncertain ?? kind === "uncertain";
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
  }

  isPoolFull(): boolean {
    return (
      this.kind === "refused" &&
      (/at its maximum/i.test(this.message) ||
        /no root is free/i.test(this.message))
    );
  }

  isPoolUnavailable(): boolean {
    if (this.isPoolFull()) return true;
    if (this.kind === "io") return true;
    return /unavailable|not mounted|does not exist|no such file/i.test(
      this.message,
    );
  }

  isUnsupportedRunCommand(): boolean {
    return (
      this.kind === "unsupported" ||
      (this.kind === "usage" &&
        /unknown worktree command\s+"?run"?/i.test(this.message))
    );
  }
}

export function classifyBargeDispatchError(error: unknown): Error {
  if (
    error instanceof CheckoutUnavailableError ||
    error instanceof CheckoutRefusalError
  )
    return error;
  if (error instanceof BargeCliError) {
    if (error.isPoolFull() || error.isPoolUnavailable())
      return new CheckoutUnavailableError(error.message);
    if (error.kind === "refused" || error.kind === "usage")
      return new CheckoutRefusalError(error.message);
    if (error.uncertain) return new CheckoutUnavailableError(error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function defaultBargeRunner(
  input: BargeCommandExecutionInput,
): Promise<BargeCommandExecutionOutput> {
  return await withSpawnSlot(async () => {
    try {
      const { stdout, stderr } = await execFileAsync(input.bin, input.argv, {
        env: input.env,
        timeout: input.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        code?: string | number;
        killed?: boolean;
        signal?: NodeJS.Signals | null;
        stdout?: string;
        stderr?: string;
      };
      if (typeof err.code === "string" && err.code === "ENOENT") {
        return {
          exitCode: null,
          stdout: "",
          stderr: err.message,
          spawnErrorCode: err.code,
        };
      }
      return {
        exitCode: typeof err.code === "number" ? err.code : null,
        signal: err.signal ?? null,
        stdout: typeof err.stdout === "string" ? err.stdout : "",
        stderr: typeof err.stderr === "string" ? err.stderr : "",
        timedOut: Boolean(err.killed && err.signal === "SIGTERM"),
      };
    }
  });
}

function parseErrorEnvelope(stderr: string): { kind: string; message: string } | null {
  const trimmed = stderr.trim();
  if (!trimmed) return null;
  for (const candidate of [trimmed, trimmed.split(/\r?\n/).pop() ?? ""]) {
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = bargeErrorEnvelopeSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data.error;
    } catch {
      /* ignore non-json line */
    }
  }
  return null;
}

function normalizeErrorKind(raw: string): BargeErrorKind {
  const parsed = bargeErrorKindSchema.safeParse(raw);
  return parsed.success ? parsed.data : "io";
}

function parseJsonDataEnvelope(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new BargeCliError(
      "uncertain",
      "Barge CLI exited successfully with empty JSON output; outcome is uncertain",
      { exitCode: 0, uncertain: true, stdout },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new BargeCliError(
      "uncertain",
      `Barge CLI returned malformed JSON output: ${error instanceof Error ? error.message : String(error)}`,
      { exitCode: 0, uncertain: true, stdout },
    );
  }
  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
    throw new BargeCliError(
      "uncertain",
      "Barge CLI JSON envelope missed `data` payload; outcome is uncertain",
      { exitCode: 0, uncertain: true, stdout },
    );
  }
  return (parsed as { data: unknown }).data;
}

export interface BargeClientOptions {
  bin?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  runner?: BargeCommandRunner;
}

async function runBargeJson(
  subcommandArgv: string[],
  options: BargeClientOptions = {},
): Promise<unknown> {
  // Barge CLI strictly parses `--json` ONLY when it is the very first argument.
  const argv = ["--json", ...subcommandArgv];
  const bin = resolveBargeBinary(options.bin);
  const runner = options.runner ?? runnerOverride ?? defaultBargeRunner;
  const output = await runner({
    bin,
    argv,
    env: buildBargeEnv(options.env),
    timeoutMs: options.timeoutMs ?? BARGE_CLI_DEFAULT_TIMEOUT_MS,
  });

  if (output.spawnErrorCode === "ENOENT") {
    throw new BargeCliError(
      "io",
      `Barge CLI binary \`${bin}\` is unavailable (${output.spawnErrorCode})`,
      { exitCode: null, uncertain: false, stdout: output.stdout, stderr: output.stderr },
    );
  }

  if (output.timedOut || output.signal) {
    throw new BargeCliError(
      "uncertain",
      `Barge CLI interrupted before completing (${output.signal ?? "timeout"})`,
      { exitCode: output.exitCode, uncertain: true, stdout: output.stdout, stderr: output.stderr },
    );
  }

  if (output.exitCode === 0) {
    return parseJsonDataEnvelope(output.stdout);
  }

  const structured = parseErrorEnvelope(output.stderr);
  if (structured) {
    throw new BargeCliError(
      normalizeErrorKind(structured.kind),
      structured.message,
      {
        exitCode: output.exitCode,
        uncertain: false,
        stdout: output.stdout,
        stderr: output.stderr,
      },
    );
  }

  throw new BargeCliError(
    "uncertain",
    `Barge CLI exited with code ${output.exitCode ?? "null"} without a structured error: ${output.stderr.trim() || output.stdout.trim() || "no output"}`,
    {
      exitCode: output.exitCode,
      uncertain: true,
      stdout: output.stdout,
      stderr: output.stderr,
    },
  );
}

export interface BargeLeaseParams {
  repo: string;
  base: string;
  branch: string;
  request: string;
  baseName?: string | null;
  label?: string | null;
  waitSeconds?: number;
}

export async function bargeWorktreeLease(
  params: BargeLeaseParams,
  options: BargeClientOptions = {},
): Promise<BargeWorktreeLease> {
  const argv = [
    "worktree",
    "lease",
    "--repo",
    params.repo,
    "--base",
    params.base,
    "--branch",
    params.branch,
    "--request",
    params.request,
  ];
  if (params.baseName) argv.push("--base-name", params.baseName);
  if (params.label) argv.push("--label", params.label);
  if (params.waitSeconds !== undefined)
    argv.push("--wait", String(params.waitSeconds));

  const data = await runBargeJson(argv, options);
  const rawLease =
    data && typeof data === "object" && "lease" in data
      ? (data as { lease: unknown }).lease
      : data;
  return bargeWorktreeLeaseSchema.parse(rawLease);
}

export async function bargeWorktreeLeaseGet(
  selector: { request: string } | { leaseId: string },
  options: BargeClientOptions = {},
): Promise<BargeWorktreeLease> {
  const argv = ["worktree", "lease", "get"];
  if ("request" in selector) argv.push("--request", selector.request);
  else argv.push("--lease", selector.leaseId);
  const data = await runBargeJson(argv, options);
  const rawLease =
    data && typeof data === "object" && "lease" in data
      ? (data as { lease: unknown }).lease
      : data;
  return bargeWorktreeLeaseSchema.parse(rawLease);
}

export async function bargeWorktreeReturn(
  params: { leaseId: string; request?: string; disposable?: boolean },
  options: BargeClientOptions = {},
): Promise<BargeWorktreeReturn> {
  const argv = ["worktree", "return", "--lease", params.leaseId];
  if (params.request) argv.push("--request", params.request);
  if (params.disposable) argv.push("--disposable");
  const data = await runBargeJson(argv, options);
  const raw =
    data && typeof data === "object" && "lease" in data
      ? {
          ...(data as { lease: Record<string, unknown>; action?: string }).lease,
          already_returned:
            (data as { action?: string }).action === "already_returned",
        }
      : data;
  return bargeWorktreeReturnSchema.parse(raw);
}

export async function bargeWorktreeStatus(
  params: { repo?: string } = {},
  options: BargeClientOptions = {},
): Promise<BargeWorktreePoolStatus[]> {
  const argv = ["worktree", "status"];
  if (params.repo) argv.push("--repo", params.repo);
  const data = await runBargeJson(argv, options);
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && "pools" in data
      ? (data as { pools: unknown }).pools
      : data && typeof data === "object" && "pool" in data
        ? [data]
        : [];
  return z.array(bargeWorktreePoolStatusSchema).parse(list);
}
