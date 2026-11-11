/**
 * Frozen Contract 010 shapes, copied verbatim from Nucleus's pinned Queue
 * contract (nucleus hosts/paseo/src/queue-contract/contracts.ts, re-pin
 * fe9c912 at Queue a9c6bc3a), which equal Queue main before #618. Strict, with
 * no `cpuCoverage`. Never imported from the Nucleus checkout at runtime; do not
 * edit to follow Queue: a change here is a Contract 010 wire change.
 */
import { z } from "zod";

export const frozenProjectRepositorySchema = z.object({
  origin: z.string().nullable(),
  path: z.string().max(1024).default(""),
}).strict();
/** A descendant found outside the recorded host process group at settlement. */
export const frozenHostRunEscapedDescendantSchema = z.object({
  pid: z.number().int().positive(),
  startIdentity: z.string().min(1),
}).strict();
export type FrozenHostRunEscapedDescendant = z.infer<typeof frozenHostRunEscapedDescendantSchema>;
/** Nucleus contract 010's durable supervisor result record. */
export const frozenHostRunResultSchema = z.object({
  format: z.literal("host.run.result"),
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  epoch: z.number().int().positive(),
  pgid: z.number().int().positive(),
  startIdentity: z.string().min(1),
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  wallMs: z.number().int().nonnegative(),
  cpuMs: z.number().int().nonnegative().nullable(),
  escapedDescendants: z.array(frozenHostRunEscapedDescendantSchema),
}).strict().refine(record => (record.exitCode === null) !== (record.signal === null), {
  message: "Exactly one of exitCode and signal must be non-null",
});
export type FrozenHostRunResult = z.infer<typeof frozenHostRunResultSchema>;
/** The durable outcome envelope for a host run, including container evidence. */
export const frozenHostRunSettlementSchema = z.object({
  format: z.literal("host.run.settlement"),
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  outcome: z.enum(["passed", "failed", "timed_out", "cancelled", "lost", "capacity_timeout"]),
  launched: z.boolean(),
  settledAt: z.string().datetime(),
  result: frozenHostRunResultSchema.nullable(),
  containers: z.array(z.object({
    runtime: z.string().min(1),
    id: z.string().min(1),
    removed: z.union([z.boolean(), z.literal("unknown")]),
  }).strict()),
}).strict().superRefine((settlement, context) => {
  if (settlement.result && settlement.result.runId !== settlement.runId)
    context.addIssue({ code: "custom", message: "Result runId must match settlement runId", path: ["result", "runId"] });
  if (!settlement.launched && (settlement.result !== null || !["cancelled", "capacity_timeout"].includes(settlement.outcome)))
    context.addIssue({ code: "custom", message: "Only an unlaunched cancelled or capacity_timeout settlement may omit result" });
  if (settlement.launched && settlement.outcome === "lost" && settlement.result !== null)
    context.addIssue({ code: "custom", message: "A lost settlement has no result" });
  if (settlement.launched && settlement.outcome !== "lost" && settlement.result === null)
    context.addIssue({ code: "custom", message: "A launched settlement requires a result unless it is lost" });
});
export type FrozenHostRunSettlement = z.infer<typeof frozenHostRunSettlementSchema>;
export const frozenHostRunPrioritySchema = z.enum(["milestone", "validation", "interactive"]);
export type FrozenHostRunPriority = z.infer<typeof frozenHostRunPrioritySchema>;
export const frozenHostRunClassSchema = z.enum(["heavy", "light"]);
export const frozenHostRunBudgetSchema = z.object({
  cpu: z.number().positive(),
  memoryBytes: z.number().int().positive(),
  wallMs: z.number().int().positive().nullable(),
  source: z.enum(["fallback", "history"]),
}).strict();
export const frozenHostRunCapacitySampleSchema = z.object({
  sampledAt: z.string().datetime(),
  cpuCapacity: z.number().positive(),
  memoryCapacityBytes: z.number().int().positive(),
  reservedCpu: z.number().nonnegative(),
  reservedMemoryBytes: z.number().int().nonnegative(),
  freeMemoryBytes: z.number().int().nonnegative(),
  loadAverage: z.array(z.number().nonnegative()),
}).strict();
export const frozenHostRunContainerSchema = z.object({
  runtime: z.string().min(1),
  containerId: z.string().min(1),
  removed: z.union([z.boolean(), z.literal("unknown")]),
  startedAt: z.string().datetime().nullable(),
  removedAt: z.string().datetime().nullable(),
}).strict();
/** Queue's durable scheduler row. The journal is the ordered source of transition evidence. */
export const frozenHostRunRecordSchema = z.object({
  id: z.string().min(1).max(160),
  epoch: z.number().int().positive(),
  /** Queue-created host runs default to queue; the client endpoint marks its submissions. */
  submissionSource: z.enum(["queue", "client"]).optional(),
  caller: z.string().min(1).max(300),
  clientRequestId: z.string().min(1).max(300).optional(),
  repository: frozenProjectRepositorySchema,
  selector: z.string().min(1).max(500),
  runClass: frozenHostRunClassSchema,
  classSource: z.enum(["manifest", "default"]),
  priority: frozenHostRunPrioritySchema,
  state: z.enum(["queued", "admitted", "running", "settled"]),
  submittedAt: z.string().datetime(),
  capacityDeadlineAt: z.string().datetime(),
  runTimeoutMs: z.number().int().positive(),
  budgetFallback: z.object({ cpu: z.number().positive(), memoryBytes: z.number().int().positive() }).strict(),
  budget: frozenHostRunBudgetSchema,
  position: z.number().int().positive().nullable(),
  admittedAt: z.string().datetime().nullable(),
  launchedAt: z.string().datetime().nullable(),
  settledAt: z.string().datetime().nullable(),
  capacitySample: frozenHostRunCapacitySampleSchema.nullable(),
  pid: z.number().int().positive().nullable(),
  processGroupId: z.number().int().positive().nullable(),
  startIdentity: z.string().min(1).nullable(),
  settlement: frozenHostRunSettlementSchema.nullable(),
  wallMs: z.number().int().nonnegative().nullable(),
  cpuMs: z.number().int().nonnegative().nullable(),
  containers: z.array(frozenHostRunContainerSchema),
  /** Durable proof that every escaped descendant in the result has exited. */
  escapedDescendantsProvenDeadAt: z.string().datetime().nullable().default(null),
  capacityReleasedAt: z.string().datetime().nullable(),
  capacityReleaseReason: z.string().trim().min(1).max(4000).nullable(),
  capacityReleaseKind: z.enum(["automatic", "operator"]).nullable().default(null),
}).strict();
export type FrozenHostRunRecord = z.infer<typeof frozenHostRunRecordSchema>;
