import { writeOwnedJson } from "../machine/owned-file.mjs";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { hostRunResultSchema } from "../../shared/contracts";
import { HOST_RUN_CPU_COVERAGE_FILE, hostRunCpuCoverageSidecarSchema, type HostRunCpuCoverageSidecar } from "../host-runs/host-run-cpu-coverage";

export const PROJECT_VALIDATION_PLAN_FORMAT = "queue.project-validation.plan";
export const PROJECT_VALIDATION_STATE_FORMAT = "queue.project-validation.supervisor";
export const PROJECT_VALIDATION_RESULT_FORMAT = "queue.project-validation.result";
export const PROJECT_VALIDATION_CANCEL_FORMAT = "queue.project-validation.cancel";

export const projectValidationSupervisorPlanSchema = z.object({
  format: z.literal(PROJECT_VALIDATION_PLAN_FORMAT),
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  epoch: z.number().int().positive(),
  runClass: z.enum(["heavy", "light"]).default("heavy"),
  hostRunStateDir: z.string().min(1).optional(),
  /** Private launch credential; stored only in this owner-only plan. */
  hostRunToken: z.string().min(1).optional(),
  identityToken: z.string().min(16).max(128),
  root: z.string().min(1),
  argv: z.array(z.string().max(4096)).min(1).max(32),
  timeoutMs: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
  terminationGraceMs: z.number().int().nonnegative(),
  launchedAt: z.string().datetime().nullable(),
  statePath: z.string().min(1),
  resultPath: z.string().min(1),
}).strict();
export type ProjectValidationSupervisorPlan = z.infer<typeof projectValidationSupervisorPlanSchema>;

export const projectValidationCancellationSchema = z.object({
  format: z.literal(PROJECT_VALIDATION_CANCEL_FORMAT),
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  epoch: z.number().int().positive(),
  identityToken: z.string().min(16).max(128),
  requestedAt: z.string().datetime(),
  reason: z.string().min(1).max(2000),
}).strict();
export type ProjectValidationCancellation = z.infer<typeof projectValidationCancellationSchema>;

export const projectValidationActiveProcessSchema = z.object({
  pid: z.number().int().positive(),
  processGroupId: z.number().int().positive(),
  leaderStartIdentity: z.string().min(1),
  startIdentity: z.string().min(1),
}).strict();

export const projectValidationSupervisorStateSchema = z.object({
  format: z.literal(PROJECT_VALIDATION_STATE_FORMAT),
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  epoch: z.number().int().positive(),
  identityToken: z.string().min(16).max(128),
  supervisorPid: z.number().int().positive(),
  supervisorStartIdentity: z.string().min(1).optional(),
  startedAt: z.string().datetime(),
  heartbeatAt: z.string().datetime(),
  activeProcess: projectValidationActiveProcessSchema.nullable(),
}).strict();
export type ProjectValidationSupervisorState = z.infer<typeof projectValidationSupervisorStateSchema>;

export const projectValidationSupervisorResultSchema = z.object({
  format: z.literal(PROJECT_VALIDATION_RESULT_FORMAT),
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  epoch: z.number().int().positive(),
  identityToken: z.string().min(16).max(128),
  state: z.enum(["passed", "refused", "hold"]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  outputTail: z.string().max(2000),
  timedOut: z.boolean(),
  signal: z.string().min(1).nullable(),
  pid: z.number().int().positive().nullable(),
  processGroupId: z.number().int().positive().nullable(),
  leaderStartIdentity: z.string().min(1).nullable(),
  processGroupEmpty: z.boolean().nullable(),
  terminationError: z.string().nullable(),
  hostResult: hostRunResultSchema.nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
}).strict();
export type ProjectValidationSupervisorResult = z.infer<typeof projectValidationSupervisorResultSchema>;

/**
 * The live log one validation run's terminal tab follows while it runs (task
 * 530). Nothing durable reads it: the plan, supervisor state and result stay
 * the run's record.
 */
export const projectValidationLiveOutputPath = (supervisionRoot: string) => join(supervisionRoot, "live.log");

export function projectValidationSupervisorPaths(dataDir: string, runId: string) {
  const key = createHash("sha256").update(runId).digest("hex").slice(0, 48);
  const root = join(dataDir, "project-validation", key);
  return { root, planPath: join(root, "plan.json"), statePath: join(root, "supervisor.json"), resultPath: join(root, "result.json"),
    cancellationPath: join(root, "cancel.json"), cpuCoveragePath: join(root, HOST_RUN_CPU_COVERAGE_FILE),
    liveOutputPath: projectValidationLiveOutputPath(root) };
}

function readOwnerOnly<T>(path: string, parse: (value: unknown) => T): T | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return null;
    return parse(JSON.parse(readFileSync(fd, "utf8")));
  } catch { return null; }
  finally { closeSync(fd); }
}

function writeJson(path: string, value: unknown, exclusive: boolean): void {
  writeOwnedJson(path, value, { exclusive, syncDirectory: "required" });
}

export function writeProjectValidationPlan(path: string, value: ProjectValidationSupervisorPlan): void {
  writeJson(path, projectValidationSupervisorPlanSchema.parse(value), false);
}
export function readProjectValidationPlan(path: string): ProjectValidationSupervisorPlan | null {
  return readOwnerOnly(path, value => projectValidationSupervisorPlanSchema.parse(value));
}
export function writeProjectValidationCancellation(path: string, value: ProjectValidationCancellation): ProjectValidationCancellation {
  const parsed = projectValidationCancellationSchema.parse(value);
  try { writeJson(path, parsed, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readProjectValidationCancellation(path, parsed.runId);
    if (existing && existing.epoch === parsed.epoch && existing.identityToken === parsed.identityToken) return existing;
    throw new Error("Project-validation cancellation record belongs to a different run identity");
  }
  return readProjectValidationCancellation(path, parsed.runId) ?? parsed;
}
export function readProjectValidationCancellation(path: string, runId?: string): ProjectValidationCancellation | null {
  return readOwnerOnly(path, value => {
    const cancellation = projectValidationCancellationSchema.parse(value);
    if (runId && cancellation.runId !== runId) throw new Error("Project-validation cancellation runId mismatch");
    return cancellation;
  });
}
export function writeProjectValidationSupervisorState(path: string, value: ProjectValidationSupervisorState): void {
  writeJson(path, projectValidationSupervisorStateSchema.parse(value), false);
}
export function readProjectValidationSupervisorState(path: string): ProjectValidationSupervisorState | null {
  return readOwnerOnly(path, value => projectValidationSupervisorStateSchema.parse(value));
}
export function writeProjectValidationResult(path: string, value: ProjectValidationSupervisorResult): ProjectValidationSupervisorResult {
  const parsed = projectValidationSupervisorResultSchema.parse(value);
  const existing = readProjectValidationResult(path, parsed.runId);
  if (existing) return existing;
  try { writeJson(path, parsed, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = readProjectValidationResult(path, parsed.runId);
    if (winner) return winner;
    throw error;
  }
  return readProjectValidationResult(path, parsed.runId) ?? parsed;
}
export function readProjectValidationResult(path: string, runId?: string): ProjectValidationSupervisorResult | null {
  return readOwnerOnly(path, value => {
    const result = projectValidationSupervisorResultSchema.parse(value);
    if (runId && result.runId !== runId) throw new Error("Project-validation result runId mismatch");
    return result;
  });
}
/** The sidecar path beside a plan's result envelope (the same as `projectValidationSupervisorPaths().cpuCoveragePath`). */
export const projectValidationCpuCoveragePath = (resultPath: string) => join(dirname(resultPath), HOST_RUN_CPU_COVERAGE_FILE);
/** The private CPU-reason sidecar beside the result; removed with the run directory. */
export function writeProjectValidationCpuCoverage(path: string, value: HostRunCpuCoverageSidecar): void {
  writeJson(path, hostRunCpuCoverageSidecarSchema.parse(value), false);
}
export function readProjectValidationCpuCoverage(path: string): unknown {
  return readOwnerOnly(path, value => value);
}
