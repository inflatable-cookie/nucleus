import { z } from "zod";
import { projectRepositorySchema } from "./projects";

/**
 * Milestone QA on the integration head (Spec 022 follow-up, task 104).
 *
 * Full QA no longer runs per task. The operator or a planner asks Queue to run
 * a repository's full QA on current `main` at a milestone. The run happens in a
 * Queue-owned linked worktree of the repository's registered checkout, the same
 * shape a Paseo task worktree has, under project-qa/. Queue runs paseo.json
 * worktree.setup and worktree.teardown there, scopes Effigy resources to that
 * checkout, and never uses a task worktree or writes to the registered working
 * tree. The run goes through Queue's host scheduler as a heavy run with one run
 * per repository at a time, and records its state, duration, per-step output and
 * result tail. It grants no merge authority and gates no task. The command
 * comes from the repository's `qa` setting when set, else the default
 * `effigy qa`; per-task validation stays opt-in and is untouched.
 */
/** A descendant found outside the recorded host process group at settlement. */
export const hostRunEscapedDescendantSchema = z.object({
  pid: z.number().int().positive(),
  startIdentity: z.string().min(1),
}).strict();

export type HostRunEscapedDescendant = z.infer<typeof hostRunEscapedDescendantSchema>;

/**
 * Queue-internal reason for a host run's CPU (Tom, 2026-10-23, "Honest +
 * cheaper"): `sampled` pairs with a positive `cpuMs`; `unobserved` (the tree
 * was seen, never working) and `unavailable` (never seen) pair with a null
 * `cpuMs`. It lives only in private sidecars and the store's internal meta,
 * never in a Contract 010 shape, a private record or a table row. Absent
 * means legacy or unknown provenance. Coverage only: not identity, exit,
 * capacity or containment evidence.
 */
export const hostRunCpuCoverageSchema = z.enum(["sampled", "unobserved", "unavailable"]);

export type HostRunCpuCoverage = z.infer<typeof hostRunCpuCoverageSchema>;

/** The reason only when it is a known value consistent with `cpuMs`; anything else stays absent. */
export function boundCpuCoverage(cpuMs: number | null | undefined, coverage: unknown): HostRunCpuCoverage | undefined {
  const parsed = hostRunCpuCoverageSchema.safeParse(coverage);
  if (!parsed.success) return undefined;
  const consistent = parsed.data === "sampled" ? typeof cpuMs === "number" && cpuMs > 0 : cpuMs === null;
  return consistent ? parsed.data : undefined;
}

/** Nucleus contract 010's durable supervisor result record. */
export const hostRunResultSchema = z.object({
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
  escapedDescendants: z.array(hostRunEscapedDescendantSchema),
}).strict().refine(record => (record.exitCode === null) !== (record.signal === null), {
  message: "Exactly one of exitCode and signal must be non-null",
});

export type HostRunResult = z.infer<typeof hostRunResultSchema>;

/** The durable outcome envelope for a host run, including container evidence. */
export const hostRunSettlementSchema = z.object({
  format: z.literal("host.run.settlement"),
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  outcome: z.enum(["passed", "failed", "timed_out", "cancelled", "lost", "capacity_timeout"]),
  launched: z.boolean(),
  settledAt: z.string().datetime(),
  result: hostRunResultSchema.nullable(),
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

export type HostRunSettlement = z.infer<typeof hostRunSettlementSchema>;

export const hostRunPrioritySchema = z.enum(["milestone", "validation", "interactive"]);

export type HostRunPriority = z.infer<typeof hostRunPrioritySchema>;

export const hostRunClassSchema = z.enum(["heavy", "light"]);

export const hostRunBudgetSchema = z.object({
  cpu: z.number().positive(),
  memoryBytes: z.number().int().positive(),
  wallMs: z.number().int().positive().nullable(),
  source: z.enum(["fallback", "history"]),
}).strict();

export const hostRunCapacitySampleSchema = z.object({
  sampledAt: z.string().datetime(),
  cpuCapacity: z.number().positive(),
  memoryCapacityBytes: z.number().int().positive(),
  reservedCpu: z.number().nonnegative(),
  reservedMemoryBytes: z.number().int().nonnegative(),
  freeMemoryBytes: z.number().int().nonnegative(),
  loadAverage: z.array(z.number().nonnegative()),
}).strict();

export const hostRunContainerSchema = z.object({
  runtime: z.string().min(1),
  containerId: z.string().min(1),
  removed: z.union([z.boolean(), z.literal("unknown")]),
  startedAt: z.string().datetime().nullable(),
  removedAt: z.string().datetime().nullable(),
}).strict();

/**
 * The exact Effigy executable combination behind an admission reservation
 * (Spec 035, "Runtime identity"): the verified artifact Queue may observe with,
 * the executable image the admitted workload was running, and when the two were
 * bound. Queue-internal: it travels in the admission identity beside the record
 * (see `hostRunIdentitySchema`), never in the pinned contract 010 record. An
 * absent binding is never observed and never authorizes a capacity release.
 */
export const hostRunEffigyRuntimeSchema = z.object({
  /**
   * Real path of the Effigy executable the observer runs: the workload's own
   * Effigy (Spec 035, Tom 2026-10-26), or the declared artifact for a row bound
   * before that change.
   */
  path: z.string().min(1).max(4096),
  /** Its bytes at binding: provenance, not a gate. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Its `--version` at binding; absent on rows bound under the retired pin. */
  version: z.string().min(1).max(200).optional(),
  /** Real path of the executable image the admitted workload process ran. */
  workloadPath: z.string().min(1).max(4096),
  boundAt: z.string().datetime(),
}).strict();

export type HostRunEffigyRuntime = z.infer<typeof hostRunEffigyRuntimeSchema>;

/** An Effigy kernel run id, as the producer's `effigy.admission-request.v1` names it. */
export const hostRunEffigyRunIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

/**
 * Queue's durable scheduler row and the pinned contract 010 record (Spec 035).
 *
 * This is Nucleus's strict record, byte for byte: `host.run.list` and
 * `host.run.capacity.release` carry it, `host_run_records.data` holds it, and an
 * older Queue reads it. The journal is the ordered source of transition
 * evidence. Nothing Queue keeps only for itself — the admission submission
 * source, the Effigy run id, the verified runtime and its refusal — belongs
 * here; those travel in `hostRunIdentitySchema` beside the row.
 */
export const hostRunRecordSchema = z.object({
  id: z.string().min(1).max(160),
  epoch: z.number().int().positive(),
  /** Queue-created host runs default to queue; the client endpoint marks its submissions. */
  submissionSource: z.enum(["queue", "client"]).optional(),
  caller: z.string().min(1).max(300),
  clientRequestId: z.string().min(1).max(300).optional(),
  repository: projectRepositorySchema,
  selector: z.string().min(1).max(500),
  runClass: hostRunClassSchema,
  classSource: z.enum(["manifest", "default"]),
  priority: hostRunPrioritySchema,
  state: z.enum(["queued", "admitted", "running", "settled"]),
  submittedAt: z.string().datetime(),
  capacityDeadlineAt: z.string().datetime(),
  runTimeoutMs: z.number().int().positive(),
  budgetFallback: z.object({ cpu: z.number().positive(), memoryBytes: z.number().int().positive() }).strict(),
  budget: hostRunBudgetSchema,
  position: z.number().int().positive().nullable(),
  admittedAt: z.string().datetime().nullable(),
  launchedAt: z.string().datetime().nullable(),
  settledAt: z.string().datetime().nullable(),
  capacitySample: hostRunCapacitySampleSchema.nullable(),
  pid: z.number().int().positive().nullable(),
  processGroupId: z.number().int().positive().nullable(),
  startIdentity: z.string().min(1).nullable(),
  settlement: hostRunSettlementSchema.nullable(),
  wallMs: z.number().int().nonnegative().nullable(),
  cpuMs: z.number().int().nonnegative().nullable(),
  containers: z.array(hostRunContainerSchema),
  /** Durable proof that every escaped descendant in the result has exited. */
  escapedDescendantsProvenDeadAt: z.string().datetime().nullable().default(null),
  capacityReleasedAt: z.string().datetime().nullable(),
  capacityReleaseReason: z.string().trim().min(1).max(4000).nullable(),
  capacityReleaseKind: z.enum(["automatic", "operator"]).nullable().default(null),
}).strict();

export type HostRunRecord = z.infer<typeof hostRunRecordSchema>;

/**
 * Queue-internal admission identity for one host run (Spec 035, "Runtime
 * identity"): the submission source Nucleus's pinned record cannot name, the
 * Effigy run id that reservation correlates to, and the verified runtime
 * binding or the reason none could be made. It is durable beside the row in the
 * store's internal meta under `hostRunIdentity:<runId>` and is never a wire
 * shape, a private record or a table row. `epoch` binds it to the row it was
 * written for: an identity whose epoch is not the row's current epoch is stale
 * and is ignored, never migrated forward.
 */
export const hostRunIdentitySchema = z.object({
  epoch: z.number().int().positive(),
  submissionSource: z.literal("admission"),
  effigyRunId: hostRunEffigyRunIdSchema.optional(),
  effigyRuntime: hostRunEffigyRuntimeSchema.optional(),
  effigyRuntimeRefusal: z.string().trim().min(1).max(2000).optional(),
}).strict().refine(identity => !(identity.effigyRuntime && identity.effigyRuntimeRefusal), {
  message: "A bound Effigy runtime and a binding refusal are mutually exclusive",
  path: ["effigyRuntime"],
});

export type HostRunIdentity = z.infer<typeof hostRunIdentitySchema>;

/**
 * The record Queue's own scheduler works with: the pinned public record plus the
 * internal identity fields Queue reads beside it. Never validated as a wire
 * shape. It also reads a row written by the builds that carried those fields in
 * the record itself, so an upgrade keeps a live reservation's binding.
 */
export const hostRunInternalRecordSchema = hostRunRecordSchema.extend({
  submissionSource: z.enum(["queue", "client", "admission"]).optional(),
  effigyRunId: hostRunEffigyRunIdSchema.optional(),
  effigyRuntime: hostRunEffigyRuntimeSchema.optional(),
  effigyRuntimeRefusal: z.string().trim().min(1).max(2000).optional(),
}).strict().refine(record => !(record.effigyRuntime && record.effigyRuntimeRefusal), {
  message: "A bound Effigy runtime and a binding refusal are mutually exclusive",
  path: ["effigyRuntime"],
}).refine(record => record.submissionSource === "admission"
  || (!record.effigyRunId && !record.effigyRuntime && !record.effigyRuntimeRefusal), {
  message: "An Effigy run id or runtime binding belongs only to an admission reservation",
  path: ["submissionSource"],
});

export type HostRunInternalRecord = z.infer<typeof hostRunInternalRecordSchema>;

export const hostRunAuthoritySchema = z.object({ holder: z.literal("queue"), epoch: z.number().int().positive(), endpoint: z.string().nullable() }).strict();

export type HostRunAuthority = z.infer<typeof hostRunAuthoritySchema>;

export const hostRunCapacityReleaseInputSchema = z.object({
  runId: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(1).max(4000),
}).strict();

export type HostRunCapacityReleaseInput = z.infer<typeof hostRunCapacityReleaseInputSchema>;

/**
 * Who authorized one accounting disposition (Spec 035, "Operator accounting
 * disposition"): the operator's own board identity, or an authenticated caller
 * relaying the operator's recorded authorization note. A relayed write names the
 * relaying caller, never the operator, and always carries the note.
 */
export const hostRunAccountingAuthoritySchema = z.object({
  role: z.enum(["operator", "authorized_relay"]),
  caller: z.string().trim().min(1).max(160),
  note: z.string().trim().min(1).max(4000).nullable(),
}).strict()
  .refine(authority => (authority.role === "operator") === (authority.note === null), {
    message: "An operator authority carries no relay note; a relayed one requires it",
    path: ["note"],
  });

export type HostRunAccountingAuthority = z.infer<typeof hostRunAccountingAuthoritySchema>;

/**
 * The separate exact-run, current-epoch risk acceptance an accounting
 * disposition needs. Generic approval is not acceptance: it names this run and
 * this epoch, and states that the workload outcome and runtime custody stay
 * UNKNOWN. Nothing about a terminal result, physical quiescence or consumer
 * permission follows from it.
 */
export const hostRunAccountingAcceptanceSchema = z.object({
  scope: z.literal("exact_run"),
  runId: z.string().trim().min(1).max(160),
  epoch: z.number().int().positive(),
  /** Explicit acknowledgement that outcome and custody remain unknown. */
  unknownOutcomeRetained: z.literal(true),
  reason: z.string().trim().min(1).max(4000),
  acceptedAt: z.string().datetime(),
}).strict();

export type HostRunAccountingAcceptance = z.infer<typeof hostRunAccountingAcceptanceSchema>;

/**
 * The evidence Queue kept when it retired a reservation's accounting. It is the
 * row as observed at that instant — state, launch, process identity, verified
 * runtime or refusal, containers, settlement and budget — so later authentic
 * evidence is attributable instead of laundering the earlier UNKNOWN. It is
 * never a terminal result, a proof of physical quiescence or a custody release.
 */
export const hostRunAccountingEvidenceSchema = z.object({
  state: hostRunRecordSchema.shape.state,
  launchedAt: z.string().datetime().nullable(),
  settledAt: z.string().datetime().nullable(),
  pid: z.number().int().positive().nullable(),
  processGroupId: z.number().int().positive().nullable(),
  startIdentity: z.string().min(1).nullable(),
  settlement: hostRunSettlementSchema.nullable(),
  containers: z.array(hostRunContainerSchema),
  escapedDescendantsProvenDeadAt: z.string().datetime().nullable(),
  effigyRunId: hostRunEffigyRunIdSchema.nullable(),
  effigyRuntime: hostRunEffigyRuntimeSchema.nullable(),
  effigyRuntimeRefusal: z.string().trim().min(1).max(2000).nullable(),
  budget: hostRunBudgetSchema,
  capacityReleasedAt: z.string().datetime().nullable(),
  capacityReleaseKind: z.enum(["automatic", "operator"]).nullable(),
}).strict();

export type HostRunAccountingEvidence = z.infer<typeof hostRunAccountingEvidenceSchema>;

/**
 * Queue's durable record that one reservation's ACCOUNTING was retired by the
 * operator while its workload outcome and runtime custody stay UNKNOWN
 * (Spec 035, "Operator accounting disposition"). It lives beside the pinned
 * contract 010 row in the store's internal meta under
 * `hostRunAccountingDisposition:<runId>`, bound to the row's own epoch, written
 * in the same transaction as its journal fact. It is not a settlement, not a
 * capacity release, not container or descendant custody and not a wire record.
 */
export const hostRunAccountingDispositionSchema = z.object({
  format: z.literal("queue.host-run.accounting-disposition"),
  version: z.literal(1),
  runId: z.string().trim().min(1).max(160),
  /** The row's epoch, re-checked against the current authority epoch before any write. */
  epoch: z.number().int().positive(),
  /** The durable idempotency key and the exact input it belongs to. */
  operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  disposition: z.literal("accounting_retired"),
  disposedAt: z.string().datetime(),
  authority: hostRunAccountingAuthoritySchema,
  acceptance: hostRunAccountingAcceptanceSchema,
  /** The operator's accounting-disposition reason. */
  reason: z.string().trim().min(1).max(4000),
  /** The pinned record digest this disposition was decided against. */
  expectedRunDigest: z.string().regex(/^[0-9a-f]{64}$/),
  observed: hostRunAccountingEvidenceSchema,
}).strict()
  .refine(record => record.acceptance.runId === record.runId && record.acceptance.epoch === record.epoch, {
    message: "The exact-run acceptance must name this run and this epoch",
    path: ["acceptance"],
  });

export type HostRunAccountingDisposition = z.infer<typeof hostRunAccountingDispositionSchema>;

/**
 * The policy provenance of an automatic accounting retirement (Spec 035,
 * "Automatic accounting on producer cleanup"). It names the operator ruling
 * that authorized the rule and the day it was decided: it is the policy, not a
 * per-run acceptance. Nobody accepted this reservation's outcome, which is why
 * the automatic record below carries no acceptance at all.
 */
export const hostRunAccountingPolicySchema = z.object({
  rule: z.literal("spec-035/automatic-accounting-on-producer-cleanup"),
  decidedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The option the operator chose, in the words the ruling records. */
  decision: z.string().trim().min(1).max(400),
}).strict();

export type HostRunAccountingPolicy = z.infer<typeof hostRunAccountingPolicySchema>;

/**
 * The exact producer record an automatic retirement was decided on, as this
 * reservation's own bound runtime bytes answered it (Spec 035, "Producer
 * closure"): the run id and selector it named, its `checkout-journal` source,
 * `cleanup: complete`, the workload verdict state with Queue's reading of it,
 * and the producer's own numeric exit code and numeric signal.
 *
 * It is producer evidence and nothing else. It carries no process group, start
 * identity, escaped descendant or container claim, because Queue supervised no
 * admitted command and observed no custody.
 */
export const hostRunAccountingProducerRecordSchema = z.object({
  runId: hostRunEffigyRunIdSchema,
  selector: z.string().trim().min(1).max(500),
  evidenceSource: z.literal("checkout-journal"),
  cleanup: z.literal("complete"),
  state: z.string().trim().min(1).max(80),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().positive().nullable(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** The exact bound runtime bytes that answered for this record. */
  runtimePath: z.string().min(1).max(4096),
  runtimeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  verdict: z.enum(["passed", "failed"]),
  observedAt: z.string().datetime(),
}).strict();

export type HostRunAccountingProducerRecord = z.infer<typeof hostRunAccountingProducerRecordSchema>;

/**
 * Queue's durable record that one reservation's ACCOUNTING was retired because
 * its producer reported that exact run's cleanup complete (Spec 035, "Automatic
 * accounting on producer cleanup"). It lives in the same private accounting
 * sidecar as the operator disposition (`hostRunAccountingDisposition:<runId>`,
 * bound to the row's own epoch) and commits with its own `host_run` journal
 * fact. The pinned contract 010 record is left exactly as it is: this is not a
 * settlement, an outcome, a container or descendant inventory, a capacity
 * release or physical headroom.
 *
 * `acceptance` is literally null: the automatic path has no operator acceptance,
 * and a later reader may not mistake the policy provenance for one.
 */
export const hostRunAccountingAutomaticRetirementSchema = z.object({
  format: z.literal("queue.host-run.accounting-retirement"),
  version: z.literal(1),
  runId: z.string().trim().min(1).max(160),
  epoch: z.number().int().positive(),
  /** The durable idempotency key, derived from this exact producer evidence. */
  operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  disposition: z.literal("accounting_retired"),
  disposedAt: z.string().datetime(),
  basis: z.literal("producer_cleanup"),
  policy: hostRunAccountingPolicySchema,
  producer: hostRunAccountingProducerRecordSchema,
  /** No per-run operator acceptance exists; nobody accepted this run's outcome. */
  acceptance: z.null(),
  reason: z.string().trim().min(1).max(4000),
  /** The pinned record digest this retirement was decided against. */
  expectedRunDigest: z.string().regex(/^[0-9a-f]{64}$/),
  observed: hostRunAccountingEvidenceSchema,
}).strict();

export type HostRunAccountingAutomaticRetirement = z.infer<typeof hostRunAccountingAutomaticRetirementSchema>;

/** The operator ruling the foreground-absence path runs under (Spec 035, "Retired runs age out, and dead foreground runs retire"). */
export const hostRunAccountingAbsencePolicySchema = z.object({
  rule: z.literal("spec-035/automatic-accounting-on-foreground-absence"),
  decidedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  decision: z.string().trim().min(1).max(400),
}).strict();

export type HostRunAccountingAbsencePolicy = z.infer<typeof hostRunAccountingAbsencePolicySchema>;

/**
 * The evidence a foreground-absence retirement is decided on: the reservation's
 * own admission hook observed dead by its recorded identity, and this
 * reservation's bound runtime bytes, run in its own checkout, answering its own
 * Effigy run id with the producer's structured `not-found` + `not-recorded`.
 * At the qualified producer that answer means its held-gate inventory found no
 * foreground holder of that run and its journal has no record. It is not proof
 * the workload ended, that cleanup ran or that nothing escaped.
 */
export const hostRunAccountingAbsenceEvidenceSchema = z.object({
  runId: hostRunEffigyRunIdSchema,
  selector: z.string().trim().min(1).max(500),
  state: z.literal("not-found"),
  recording: z.literal("not-recorded"),
  message: z.string().max(4000),
  /** The checkout the producer was asked in: the reservation's own repository path. */
  checkout: z.string().min(1).max(4096),
  runtimePath: z.string().min(1).max(4096),
  runtimeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  hook: z.object({ pid: z.number().int().positive(), startIdentity: z.string().min(1).max(200) }).strict(),
  observedAt: z.string().datetime(),
}).strict();

export type HostRunAccountingAbsenceEvidence = z.infer<typeof hostRunAccountingAbsenceEvidenceSchema>;

/**
 * Queue's durable record that one reservation's ACCOUNTING was retired because
 * its admission hook died and the producer holds no foreground gate and no
 * journal record for it (Tom, 2026-10-25: "Auto-free them (Recommended)"). Same
 * sidecar and journal discipline as the other two retirements; the pinned row is
 * untouched and `acceptance` is null.
 */
export const hostRunAccountingAbsenceRetirementSchema = z.object({
  format: z.literal("queue.host-run.accounting-absence-retirement"),
  version: z.literal(1),
  runId: z.string().trim().min(1).max(160),
  epoch: z.number().int().positive(),
  operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  disposition: z.literal("accounting_retired"),
  disposedAt: z.string().datetime(),
  basis: z.literal("foreground_absent"),
  policy: hostRunAccountingAbsencePolicySchema,
  absence: hostRunAccountingAbsenceEvidenceSchema,
  acceptance: z.null(),
  reason: z.string().trim().min(1).max(4000),
  expectedRunDigest: z.string().regex(/^[0-9a-f]{64}$/),
  observed: hostRunAccountingEvidenceSchema,
}).strict();

export type HostRunAccountingAbsenceRetirement = z.infer<typeof hostRunAccountingAbsenceRetirementSchema>;

/**
 * One durable accounting retirement: the operator's exact-run disposition or the
 * automatic retirement on the producer's cleanup closure. Both stop the charge
 * and neither writes the row, so an older record (#412) keeps parsing exactly as
 * it did and a new automatic record cannot be read as an operator acceptance.
 */
export const hostRunAccountingRetirementSchema = z.union([
  hostRunAccountingDispositionSchema,
  hostRunAccountingAutomaticRetirementSchema,
  hostRunAccountingAbsenceRetirementSchema,
]);

export type HostRunAccountingRetirement = z.infer<typeof hostRunAccountingRetirementSchema>;

/** The owner surface's read: the pinned record plus Queue's accounting state for it. */
export const hostRunAccountingViewSchema = z.object({
  runId: z.string().min(1),
  readAt: z.string().datetime(),
  accounting: z.enum(["charged", "retired"]),
  /** False when a stored retirement exists but cannot be read; accounting stays charged. */
  dispositionReadable: z.boolean(),
  /** The durable retirement that stops the charge: an operator disposition or an automatic producer-cleanup retirement. */
  disposition: hostRunAccountingRetirementSchema.nullable(),
  /**
   * The exact pinned record digest a disposition must name as `expectedRunDigest`.
   * It is what the operator read: a row that changed afterwards refuses.
   */
  runDigest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Contract 010's pinned record, byte for byte. */
  record: hostRunRecordSchema,
}).strict();

export type HostRunAccountingView = z.infer<typeof hostRunAccountingViewSchema>;

export const hostRunAccountingStatusInputSchema = z.object({ runId: z.string().trim().min(1).max(160) }).strict();

export type HostRunAccountingStatusInput = z.infer<typeof hostRunAccountingStatusInputSchema>;

/**
 * One run the board's bulk accounting read covers: an unsettled row with a
 * stored accounting retirement, read from Queue's private sidecar and never
 * from the pinned record. `retired` only when the retirement is readable and
 * bound to this run id and epoch; `unreadable` keeps the run charged and on the
 * live list. Retirement is accounting only: the pinned outcome, custody and
 * process state stay unknown.
 */
export const hostRunAccountingListEntrySchema = z.object({
  runId: z.string().min(1),
  /** The row epoch the retirement is bound to; a board row with another epoch is not covered. */
  epoch: z.number().int(),
  accounting: z.enum(["retired", "unreadable"]),
  /** The retirement's own format: an operator disposition or an automatic producer-cleanup retirement. */
  format: z.string().nullable(),
  disposedAt: z.string().datetime().nullable(),
  /** The producer's own attributed verdict when its cleanup closure retired the run; never the pinned outcome. */
  producer: z.object({
    verdict: z.enum(["passed", "failed"]),
    state: z.string(),
    exitCode: z.number().int().nullable(),
    signal: z.number().int().positive().nullable(),
  }).strict().nullable(),
}).strict();

export type HostRunAccountingListEntry = z.infer<typeof hostRunAccountingListEntrySchema>;

export const hostRunAccountingListSchema = z.object({
  readAt: z.string().datetime(),
  entries: z.array(hostRunAccountingListEntrySchema),
  /** False when more unsettled rows carry a stored retirement than this read returns; an absent run stays charged. */
  complete: z.boolean(),
}).strict();

export type HostRunAccountingList = z.infer<typeof hostRunAccountingListSchema>;

/**
 * Audit A8: the board's one combined host-run read. `runs` is exactly
 * `host.run.list`'s pinned record and `accounting` exactly
 * `host.run.accounting.list`'s derived answer, from one list call; the joined
 * entries keep the same run-id and epoch binding and the same conservative
 * `unreadable` answer, and `complete` keeps its meaning. Both pinned reads,
 * their schema and their method digests are untouched.
 */
export const hostRunBoardSchema = z.object({
  runs: z.array(hostRunRecordSchema),
  accounting: hostRunAccountingListSchema,
}).strict();

export type HostRunBoard = z.infer<typeof hostRunBoardSchema>;

export const hostRunAccountingDisposeInputSchema = z.object({
  runId: z.string().trim().min(1).max(160),
  /** Durable idempotency key: the same key with the same input observes the same disposition. */
  operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
  /** Both the current host-run authority epoch and the row's own epoch must equal this. */
  expectedEpoch: z.number().int().positive(),
  /** The exact pinned record digest the operator read; a changed row refuses. */
  expectedRunDigest: z.string().regex(/^[0-9a-f]{64}$/),
  authority: z.object({
    caller: z.string().trim().min(1).max(160),
    relayed: z.boolean().optional(),
    note: z.string().trim().min(1).max(4000).optional(),
  }).strict().superRefine((authority, context) => {
    if (authority.relayed && !authority.note)
      context.addIssue({ code: "custom", path: ["note"], message: "A relayed accounting disposition requires the operator's authorization note" });
    if (!authority.relayed && authority.note !== undefined)
      context.addIssue({ code: "custom", path: ["note"], message: "A note records a relayed authorization; set relayed true" });
  }),
  /** Separate from the authority: this exact run and epoch, outcome stays UNKNOWN. */
  acceptance: z.object({
    scope: z.literal("exact_run"),
    runId: z.string().trim().min(1).max(160),
    epoch: z.number().int().positive(),
    unknownOutcomeRetained: z.literal(true),
    reason: z.string().trim().min(1).max(4000),
  }).strict(),
  reason: z.string().trim().min(1).max(4000),
}).strict();

export type HostRunAccountingDisposeInput = z.infer<typeof hostRunAccountingDisposeInputSchema>;
