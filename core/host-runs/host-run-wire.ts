/** Contract 010 request/supervisor schemas and the allowlisted launch environment. */
import { realpathSync } from "node:fs";
import { z } from "zod";
import { readCheckedHostRunFile, removeVerifiedOwnedFile, writeVerifiedOwnedFile } from "./host-run-files";
export const HOST_RUN_SUPERVISOR_PLAN_FORMAT = "host.run.supervisor.plan";
export const HOST_RUN_SUPERVISOR_STATE_FORMAT = "host.run.supervisor.state";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export const hostRunSubmitBodySchema = z.object({
  clientRequestId: z.string().min(1).max(200),
  caller: z.string().min(1).max(300),
  repository: z.string().min(1).max(500),
  cwd: z.string().min(1),
  selector: z.string().min(1).max(500),
  argv: z.array(z.string().min(1)).min(1),
  class: z.enum(["heavy", "light"]),
  classSource: z.enum(["manifest", "default"]),
  priority: z.enum(["milestone", "validation", "interactive"]),
  budgetFallback: z.object({ cpu: z.number().positive(), memoryBytes: z.number().int().positive() }).strict(),
  capacityDeadlineMs: z.number().int().positive(),
  runTimeoutMs: z.number().int().positive(),
  env: z.record(z.string(), z.string()).default({}),
  cancelOnDisconnect: z.boolean().optional(),
}).strict();
export type HostRunSubmitBody = z.infer<typeof hostRunSubmitBodySchema>;
export const storedBodySchema = hostRunSubmitBodySchema.omit({ env: true }).extend({ envKeys: z.array(z.string()).default([]) }).strict();

export const hostRunAttachBodySchema = z.object({
  runId: z.string().min(1).max(160),
  fromOffset: z.object({ stdout: z.number().int().nonnegative().optional(), stderr: z.number().int().nonnegative().optional() }).strict().optional(),
}).strict();
export const hostRunCancelBodySchema = z.object({ runId: z.string().min(1).max(160), reason: z.string().min(1).max(4000) }).strict();
export const hostRunStatusBodySchema = z.object({
  runId: z.string().min(1).max(160).optional(),
  caller: z.string().min(1).max(300).optional(),
  clientRequestId: z.string().min(1).max(200).optional(),
}).strict();

const factId = z.string().min(1).max(200);
const observedAt = z.string().datetime();
export const hostRunNestedFactSchema = z.object({
  kind: z.literal("nested"), factId, observedAt,
  parentRunId: z.string().min(1).max(160), selector: z.string().min(1).max(500),
}).strict();
export const hostRunOverrideFactSchema = z.object({
  kind: z.literal("override"), factId, observedAt,
  reason: z.string().min(1).max(4000), selector: z.string().min(1).max(500),
}).strict();
export const hostRunContainerFactSchema = z.object({
  kind: z.literal("container"), factId, observedAt,
  runId: z.string().min(1).max(160), epoch: z.number().int().positive(),
  runtime: z.string().min(1).max(200), containerId: z.string().min(1).max(400),
  event: z.enum(["started", "removed"]),
  removed: z.union([z.boolean(), z.literal("unknown")]).optional(),
}).strict();
export const hostRunFactSchema = z.discriminatedUnion("kind", [hostRunNestedFactSchema, hostRunOverrideFactSchema, hostRunContainerFactSchema]);
export type HostRunFact = z.infer<typeof hostRunFactSchema>;
export const hostRunReportBodySchema = z.object({ facts: z.array(hostRunFactSchema).min(1).max(512) }).strict();

// ---------------------------------------------------------------------------
// The supervisor contract
// ---------------------------------------------------------------------------

export const hostRunSupervisorPlanSchema = z.object({
  format: z.literal(HOST_RUN_SUPERVISOR_PLAN_FORMAT),
  version: z.literal(1),
  stateDir: z.string().min(1),
  runId: z.string().min(1).max(160),
  epoch: z.number().int().positive(),
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1),
  envKeys: z.array(z.string()),
  runTimeoutMs: z.number().int().positive(),
  graceMs: z.number().int().min(0),
  startedAt: z.string().datetime(),
}).strip();
export type HostRunSupervisorPlan = z.infer<typeof hostRunSupervisorPlanSchema>;

export const hostRunSupervisorStateSchema = z.object({
  format: z.literal(HOST_RUN_SUPERVISOR_STATE_FORMAT),
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  epoch: z.number().int().positive(),
  supervisorPid: z.number().int().positive(),
  supervisorStartIdentity: z.string().min(1),
  commandPid: z.number().int().positive().nullable().default(null),
  commandPgid: z.number().int().positive().nullable().default(null),
  commandStartIdentity: z.string().min(1).nullable().default(null),
  termination: z.enum(["timeout", "cancel"]).nullable().default(null),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().default(null),
}).strict();
export type HostRunSupervisorState = z.infer<typeof hostRunSupervisorStateSchema>;

export const hostRunCancelRequestSchema = z.object({
  format: z.literal("host.run.cancel"),
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  reason: z.string().min(1).max(4000),
  requestedAt: z.string().datetime(),
}).strict();

/** A durable disconnect deadline (`cancelOnDisconnect` or unlaunched), so a service roll cannot lose the window. */
export const hostRunDisconnectSchema = z.object({
  format: z.literal("host.run.disconnect"),
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  deadlineAt: z.string().datetime(),
  requestedAt: z.string().datetime(),
  /** `unlaunched`: cancel only while the run has not launched. Absent: `cancelOnDisconnect`. */
  mode: z.literal("unlaunched").optional(),
}).strict();

/**
 * Contract 010's expired-output marker: the retained byte counts, written
 * before the output files are removed at the one-hour deadline so `attach` can
 * still report `output_expired` with the right `availableFrom`.
 */
export const hostRunOutputRetentionSchema = z.object({
  format: z.literal("host.run.output.retention"),
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  expiredAt: z.string().datetime(),
  sizes: z.object({ stdout: z.number().int().nonnegative(), stderr: z.number().int().nonnegative() }).strict(),
}).strict();
export type HostRunOutputRetention = z.infer<typeof hostRunOutputRetentionSchema>;


export const HOST_RUN_LAUNCH_ENV_FORMAT = "host.run.launch.env";
const launchEnvParts = (runId: string) => ["launch-env", `${runId}.json`];
const launchEnvSchema = z.object({
  format: z.literal(HOST_RUN_LAUNCH_ENV_FORMAT), version: z.literal(1), runId: z.string().min(1),
  env: z.record(z.string(), z.string()),
}).strict();

/**
 * The one place env values live: a mode-0600 file per unlaunched run, outside
 * `runs/<id>`, deleted once the supervisor has started the command or the run
 * settles. Never written to the database, journal, facts, exports or backups.
 */
export function writeHostRunLaunchEnv(stateDir: string, runId: string, env: Record<string, string>): void {
  writeVerifiedOwnedFile(stateDir, launchEnvParts(runId), JSON.stringify({ format: HOST_RUN_LAUNCH_ENV_FORMAT, version: 1, runId, env }), 0o600);
}
export function readHostRunLaunchEnv(stateDir: string, runId: string): Record<string, string> | null {
  const raw = readCheckedHostRunFile(stateDir, launchEnvParts(runId));
  if (!raw) return null;
  try {
    const parsed = launchEnvSchema.parse(JSON.parse(raw.toString("utf8")));
    return parsed.runId === runId ? parsed.env : null;
  } catch { return null; }
}
export function removeHostRunLaunchEnv(stateDir: string, runId: string): void {
  try { removeVerifiedOwnedFile(realpathSync(stateDir), launchEnvParts(runId)); }
  catch { /* already gone, or the chain check refused */ }
}
/** Contract 010's launch environment: only the listed `env` plus the four named variables. */
export function hostRunLaunchEnvironment(listed: Record<string, string>, extra: { runId: string; token: string; env?: NodeJS.ProcessEnv }): Record<string, string> {
  const source = extra.env ?? process.env;
  return {
    ...listed,
    PATH: source.PATH ?? "",
    HOME: source.HOME ?? "",
    HOST_RUN_ID: extra.runId,
    HOST_RUN_TOKEN: extra.token,
  };
}
