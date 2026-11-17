/** Contract 010 request/supervisor schemas and the allowlisted launch environment. */
import { realpathSync } from "node:fs";
import { z } from "zod";
import { qualificationBindingSchema, qualificationFirstEffectClockSchema, type QualificationFirstEffectClock } from "../../shared/schema/review/proof";
import { readCheckedHostRunFile, readCheckedHostRunFileRead, removeVerifiedOwnedFile, writeVerifiedOwnedFile } from "./host-run-files";
export const HOST_RUN_SUPERVISOR_PLAN_FORMAT = "host.run.supervisor.plan";
// Spec 064 P1–P3: the qualification refusal has one owner beside the binding
// identities; re-exported here because the plan owner and the detached supervisor
// both refuse through this module.
export { QUALIFICATION_FOUNDATION_INCOMPLETE } from "./qualification-binding";
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
export const storedBodySchema = hostRunSubmitBodySchema.omit({ env: true }).extend({
  envKeys: z.array(z.string()).default([]),
  /** Spec 064 P1: the qualification binding a qualification submit resolved (tranche 3 writes it). */
  qualification: qualificationBindingSchema.optional(),
}).strict();

/**
 * Spec 064 P1 (private): the one qualification submit. It carries the executor
 * run's own credential — never a host-run token and never a caller the client
 * chose — beside the host-run body the bound executor asks for. It is resolved
 * and refused before any submit write, so this shape is not a wire record of an
 * accepted run.
 */
export const hostRunQualificationBodySchema = z.object({
  credential: z.object({
    taskId: z.string().min(1).max(160), runId: z.string().min(1).max(160), token: z.string().min(1).max(4000),
  }).strict(),
  submission: hostRunSubmitBodySchema,
}).strict();
export type HostRunQualificationBody = z.infer<typeof hostRunQualificationBodySchema>;

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
  /**
   * Spec 064 P3 (private): how this run's stop behaves. Absent means Contract
   * 010's group stop, unchanged. `qualification_direct` sends TERM to the one
   * still-held direct command and never signals a group, an escapee or KILL.
   */
  stopMode: z.enum(["group", "qualification_direct"]).optional(),
  /**
   * Spec 064 P5 (private): the one cumulative first-effect clock. Its origin was
   * established before the dispatch funnel, reservation persistence included, and
   * every later owner consumes it; nobody starts a launch clock. A qualification
   * plan must carry it.
   */
  firstEffectClock: qualificationFirstEffectClockSchema.optional(),
  /** Spec 064 P1 (private): the qualification binding a qualification run carries. */
  qualification: qualificationBindingSchema.optional(),
}).strip().superRefine((plan, context) => {
  // A qualification plan's clock is the binding's own clock: two readings of the
  // same origin may not disagree, and a qualification plan may not omit it.
  const bindingClock: QualificationFirstEffectClock | undefined = plan.qualification?.firstEffectClock;
  if (!plan.qualification) return;
  if (!plan.firstEffectClock)
    context.addIssue({ code: "custom", message: "A qualification plan carries the attempt's first-effect clock", path: ["firstEffectClock"] });
  if (bindingClock && plan.firstEffectClock
      && (bindingClock.clockId !== plan.firstEffectClock.clockId || bindingClock.originTick !== plan.firstEffectClock.originTick))
    context.addIssue({ code: "custom", message: "The plan's first-effect clock is not the binding's clock", path: ["firstEffectClock"] });
});
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
  /** Spec 064 P3: present only for a qualification stop; absent is Contract 010's group stop. */
  stopMode: z.enum(["group", "qualification_direct"]).optional(),
}).strict();

/**
 * What a run's durable cancel request says: absent, one named reason, or a
 * record that cannot be read. The third is never the first: a request whose
 * bytes are unreadable is unknown, so the supervisor stops the run and records
 * the fault instead of running on as if nothing had been asked.
 */
export type HostRunCancelRequestRead =
  | { state: "absent" }
  | { state: "requested"; reason: string; stopMode?: "group" | "qualification_direct" }
  | { state: "unreadable"; reason: string };

const cancelRequestParts = (runId: string) => ["runs", runId, "cancel.json"];

/** Read one run's cancel request, keeping absent, requested and unreadable apart. */
export function readHostRunCancelRequest(stateDir: string, runId: string): HostRunCancelRequestRead {
  const read = readCheckedHostRunFileRead(stateDir, cancelRequestParts(runId));
  if (read.state === "absent") return { state: "absent" };
  if (read.state === "unreadable") return { state: "unreadable", reason: read.reason };
  try {
    const parsed = hostRunCancelRequestSchema.parse(JSON.parse(read.bytes.toString("utf8")));
    if (parsed.runId !== runId) return { state: "unreadable", reason: `The cancel request names run ${parsed.runId}, not ${runId}` };
    return { state: "requested", reason: parsed.reason, ...(parsed.stopMode ? { stopMode: parsed.stopMode } : {}) };
  } catch (error) {
    return { state: "unreadable", reason: `The cancel request is not a readable host.run.cancel record: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Record one run's durable cancel request; the supervisor reads it, so a roll cannot lose the stop. */
export function writeHostRunCancelRequest(
  stateDir: string, runId: string, reason: string, requestedAt: string,
  stopMode?: "group" | "qualification_direct",
): void {
  writeVerifiedOwnedFile(stateDir, cancelRequestParts(runId), JSON.stringify(hostRunCancelRequestSchema.parse({
    format: "host.run.cancel", version: 1, runId, reason, requestedAt,
    // Contract 010's ordinary record keeps its exact bytes: the mode is written only when it is the qualification stop.
    ...(stopMode === "qualification_direct" ? { stopMode } : {}),
  })), 0o600);
}

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
