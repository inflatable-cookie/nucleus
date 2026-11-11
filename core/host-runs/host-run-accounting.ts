/**
 * Accounting retirement for host runs (Spec 035, "Operator accounting
 * disposition" and "Automatic accounting on producer cleanup").
 *
 * `releaseCapacity` releases a *settled* run's container or escaped-descendant
 * custody. This module owns the different, narrower question an unknown
 * reservation leaves open: its ACCOUNTING. A reservation admitted before a
 * trusted runtime binding existed can still be running with unknown outcome
 * (Project-e 182: two runs charged 9 CPU and 64 GiB in recorded snapshots with no
 * terminal result). That shape had no supported exit — the accounting could not
 * be retired without inventing a settlement.
 *
 * Two bases retire it, and nothing else does. The operator's exact-run
 * disposition carries the operator's own authority and separate risk
 * acceptance; the automatic path retires it when the producer reported that
 * exact run's `checkout-journal` cleanup complete, under the operator's recorded
 * 2026-10-25 policy ruling and with no per-run acceptance at all.
 *
 * Both are Queue-internal and durable beside the pinned contract 010 row, in the
 * same private sidecar (`hostRunAccountingDisposition:<runId>`), exactly as the
 * admission identity is (task 409). They never write the row: the run keeps its
 * state, settlement, containers, process identity and `capacityReleasedAt`, so
 * no terminal result, exit, pass, cancellation, physical free or consumer
 * permission is invented. The scheduler subtracts the retirement from capacity
 * totals and nothing else.
 */
import {
  hostRunAccountingAbsenceRetirementSchema, hostRunAccountingAuthoritySchema, hostRunAccountingAutomaticRetirementSchema,
  hostRunAccountingDisposeInputSchema,
  hostRunAccountingDispositionSchema,
  hostRunAccountingEvidenceSchema, hostRunAccountingRetirementSchema, hostRunAccountingViewSchema, isOperatorOrigin,
  type HostRunAccountingAbsenceEvidence, type HostRunAccountingAbsencePolicy, type HostRunAccountingAbsenceRetirement,
  type HostRunAccountingAuthority, type HostRunAccountingAutomaticRetirement, type HostRunAccountingDisposeInput,
  type HostRunAccountingList,
  type HostRunAccountingPolicy, type HostRunAccountingProducerRecord,
  type HostRunAccountingRetirement, type HostRunAccountingView,
  type HostRunAuthority,
  type HostRunInternalRecord
} from "../../shared/contracts";
import { publicHostRunRecord } from "./host-run-identity";
import { HOST_RUN_ACCOUNTING_DISPOSITION_META_PREFIX, hostRunAccountingDispositionMetaKey } from "./host-run-meta-keys";
import type { HostRunEvent } from "./host-run-scheduler-types";
import { digest, operationInputHash, type Store } from "../store/store";

export { HOST_RUN_ACCOUNTING_DISPOSITION_META_PREFIX, hostRunAccountingDispositionMetaKey };

/** Canonical JSON so a digest names the same bytes in Queue and in a test. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

/**
 * The exact public record digest a caller reads and passes back: the pinned
 * contract 010 projection, canonically serialized. It is the "version" this
 * surface checks, so a row that changed between the operator's read and their
 * decision refuses instead of being disposed of on stale evidence.
 */
export function hostRunPublicDigest(record: HostRunInternalRecord): string {
  return digest(stableJson(publicHostRunRecord(record)));
}

/** The disposition's own idempotency key: the exact request body, not a re-read of a mutable row. */
export function hostRunAccountingInputHash(input: HostRunAccountingDisposeInput): string {
  return operationInputHash(input);
}

/**
 * The authority one write needs, proved before anything is written. The
 * operator's board identity authorizes directly; a relayed write names the
 * relaying caller and carries the operator's authorization note. A relayed
 * write that names the operator is a forgery of the relay boundary, and a
 * caller with neither is refused. This is authority only: the separate
 * exact-run acceptance is validated with the row itself.
 */
export function hostRunAccountingAuthority(input: HostRunAccountingDisposeInput["authority"]): HostRunAccountingAuthority {
  const caller = input.caller.trim();
  if (input.relayed) {
    if (isOperatorOrigin(caller))
      throw new Error("A relayed accounting disposition names the relaying caller, not the operator");
    const note = input.note?.trim();
    if (!note) throw new Error("A relayed accounting disposition requires the operator's authorization note");
    return hostRunAccountingAuthoritySchema.parse({ role: "authorized_relay", caller, note: note.slice(0, 4000) });
  }
  if (!isOperatorOrigin(caller))
    throw new Error(`An accounting disposition needs the operator at the board or a relayed operator authorization note; ${caller} has none`);
  return hostRunAccountingAuthoritySchema.parse({ role: "operator", caller, note: null });
}

/** The observed evidence snapshot, built only from the row's own fields. */
export function hostRunAccountingEvidence(record: HostRunInternalRecord) {
  return hostRunAccountingEvidenceSchema.parse({
    state: record.state,
    launchedAt: record.launchedAt,
    settledAt: record.settledAt,
    pid: record.pid,
    processGroupId: record.processGroupId,
    startIdentity: record.startIdentity,
    settlement: record.settlement,
    containers: record.containers,
    escapedDescendantsProvenDeadAt: record.escapedDescendantsProvenDeadAt,
    effigyRunId: record.effigyRunId ?? null,
    effigyRuntime: record.effigyRuntime ?? null,
    effigyRuntimeRefusal: record.effigyRuntimeRefusal ?? null,
    budget: record.budget,
    capacityReleasedAt: record.capacityReleasedAt,
    capacityReleaseKind: record.capacityReleaseKind,
  });
}

/**
 * The disposition that applies to this row, or undefined. It applies only when
 * it is readable, names this row and carries the row's own epoch; anything
 * stale, unreadable or half-written is absent, so accounting stays charged
 * rather than a damaged key silently freeing a slot.
 */
export function hostRunAccountingRetirementOf(store: Store, record: HostRunInternalRecord): HostRunAccountingRetirement | undefined {
  return store.hostRunAccountingRetirement(record);
}

/** True when a stored retirement exists but this build cannot bind it to the row. */
export function hostRunAccountingRetirementUnreadable(store: Store, record: HostRunInternalRecord): boolean {
  const raw = store.hostRunAccountingDispositionRaw(record.id);
  if (raw === undefined) return false;
  const parsed = hostRunAccountingRetirementSchema.safeParse(raw);
  return !(parsed.success && parsed.data.runId === record.id && parsed.data.epoch === record.epoch);
}

/** The owner read: the pinned record beside Queue's accounting state, never a rewritten row. */
export function hostRunAccountingView(store: Store, record: HostRunInternalRecord, readAt = new Date().toISOString()): HostRunAccountingView {
  const retirement = hostRunAccountingRetirementOf(store, record);
  return hostRunAccountingViewSchema.parse({
    runId: record.id,
    readAt,
    accounting: retirement ? "retired" : "charged",
    dispositionReadable: !hostRunAccountingRetirementUnreadable(store, record),
    disposition: retirement ?? null,
    runDigest: hostRunPublicDigest(record),
    record: publicHostRunRecord(record),
  });
}

/**
 * The durable write: the row is left exactly as it is; the disposition and its
 * journal fact commit in one transaction. The caller (the scheduler) owns the
 * transaction, the authority epoch check and the journal append, so a failed
 * meta write rolls the fact back with it.
 */
export function hostRunAccountingDispositionRecord(
  record: HostRunInternalRecord,
  input: HostRunAccountingDisposeInput,
  authority: HostRunAccountingAuthority,
  at: string,
) {
  return hostRunAccountingDispositionSchema.parse({
    format: "queue.host-run.accounting-disposition",
    version: 1,
    runId: record.id,
    epoch: record.epoch,
    operationId: input.operationId,
    inputHash: hostRunAccountingInputHash(input),
    disposition: "accounting_retired",
    disposedAt: at,
    authority,
    acceptance: { ...input.acceptance, acceptedAt: at },
    reason: input.reason.trim(),
    expectedRunDigest: input.expectedRunDigest,
    observed: hostRunAccountingEvidence(record),
  });
}

/**
 * The operator ruling the automatic path runs under (Spec 035, "Automatic
 * accounting on producer cleanup", Tom 2026-10-25). He chose automatic
 * retirement when the producer reports that exact run's cleanup complete,
 * accepting that an environment container may still be running. It is a policy
 * for any such reservation, not an acceptance of any one run: the record this
 * basis writes carries `acceptance: null`.
 */
export const HOST_RUN_ACCOUNTING_POLICY: HostRunAccountingPolicy = {
  rule: "spec-035/automatic-accounting-on-producer-cleanup",
  decidedOn: "2026-10-25",
  decision: "Auto-free on cleanup (Recommended); an environment container may still be running",
};

/**
 * What one automatic retirement is decided on: this reservation and the exact
 * producer record the endpoint's bound observer read for it.
 */
export interface HostRunProducerCleanupRetirementInput {
  runId: string;
  producer: HostRunAccountingProducerRecord;
}

/**
 * The automatic retirement's own idempotency key, derived from its exact
 * evidence: this run, this epoch and the producer record (without the tick's
 * observation instant, which is when Queue looked, not what the producer said).
 * Repeated observation of the same record therefore names the same operation.
 */
export function hostRunAccountingProducerInputHash(
  record: HostRunInternalRecord,
  producer: HostRunAccountingProducerRecord,
): string {
  const { observedAt: _observedAt, ...reported } = producer;
  return digest(stableJson({ runId: record.id, epoch: record.epoch, producer: reported }));
}

/** The durable operation id an automatic retirement writes; 1–160 of A–Z a–z 0–9 . _ : -. */
export function hostRunAccountingProducerOperationId(inputHash: string): string {
  return `producer-cleanup:${inputHash.slice(0, 40)}`;
}

/**
 * Why accounting was retired, in the producer's own terms and the policy's. The
 * producer's verdict stays a verdict: this never reads as a terminal outcome,
 * a custody closure or a physical release.
 */
export function hostRunAccountingRetirementReason(producer: HostRunAccountingProducerRecord): string {
  const verdict = producer.exitCode !== null
    ? `exit code ${producer.exitCode}`
    : producer.signal !== null ? `signal ${producer.signal}` : "no exit code or signal";
  return `Effigy reported run ${producer.runId} for selector ${JSON.stringify(producer.selector)} with checkout-journal cleanup complete and its own verdict (${producer.state}, ${verdict}); the operator's ${HOST_RUN_ACCOUNTING_POLICY.decidedOn} automatic-cleanup ruling retires this reservation's accounting and nothing else. The producer record is kept as evidence, while the workload outcome and runtime custody stay unknown: this record writes no settlement, escaped-descendant or container inventory, process-group claim or capacity release, and it is not physical headroom. A reservation whose recorded hook is gone then settles through its own ordinary path, carrying this answer as evidence.`;
}

/**
 * The durable automatic retirement: the row is left exactly as it is, and the
 * record plus its journal fact commit in one transaction (the caller, the
 * scheduler, owns that transaction, the epoch check and the journal append, so a
 * failed meta write rolls the fact back with it).
 */
export function hostRunAccountingAutomaticRetirementRecord(
  record: HostRunInternalRecord,
  producer: HostRunAccountingProducerRecord,
  expectedRunDigest: string,
  at: string,
): HostRunAccountingAutomaticRetirement {
  const inputHash = hostRunAccountingProducerInputHash(record, producer);
  return hostRunAccountingAutomaticRetirementSchema.parse({
    format: "queue.host-run.accounting-retirement",
    version: 1,
    runId: record.id,
    epoch: record.epoch,
    operationId: hostRunAccountingProducerOperationId(inputHash),
    inputHash,
    disposition: "accounting_retired",
    disposedAt: at,
    basis: "producer_cleanup",
    policy: HOST_RUN_ACCOUNTING_POLICY,
    producer,
    acceptance: null,
    reason: hostRunAccountingRetirementReason(producer),
    expectedRunDigest,
    observed: hostRunAccountingEvidence(record),
  });
}

/**
 * The operator ruling the foreground-absence path runs under (Spec 035, "Retired
 * runs age out, and dead foreground runs retire"; Tom, 2026-10-25). A policy for
 * any such reservation, never an acceptance of one run: `acceptance` stays null.
 */
export const HOST_RUN_ACCOUNTING_ABSENCE_POLICY: HostRunAccountingAbsencePolicy = {
  rule: "spec-035/automatic-accounting-on-foreground-absence",
  decidedOn: "2026-10-25",
  decision: "Auto-free them (Recommended); a stray process could survive",
};

/** What one foreground-absence retirement is decided on: this reservation and the exact evidence the endpoint read. */
export interface HostRunForegroundAbsenceRetirementInput {
  runId: string;
  absence: HostRunAccountingAbsenceEvidence;
}

/** Its idempotency key: this run, this epoch and the evidence, without the observation instant. */
export function hostRunAccountingAbsenceInputHash(record: HostRunInternalRecord, absence: HostRunAccountingAbsenceEvidence): string {
  const { observedAt: _observedAt, ...reported } = absence;
  return digest(stableJson({ runId: record.id, epoch: record.epoch, absence: reported }));
}

/** Why accounting was retired: the evidence and the policy, never an outcome, custody closure or release. */
export function hostRunAccountingAbsenceReason(absence: HostRunAccountingAbsenceEvidence): string {
  return `The admission hook (pid ${absence.hook.pid}) is gone by its recorded identity, and Effigy run ${absence.runId} for selector ${JSON.stringify(absence.selector)} has no foreground holder and no journal record in this reservation's checkout (structured not-found, not-recorded); the operator's ${HOST_RUN_ACCOUNTING_ABSENCE_POLICY.decidedOn} foreground-absence ruling retires this reservation's accounting and nothing else. The workload outcome and runtime custody stay unknown, and a stray process may survive: this record writes no settlement, cleanup, container or descendant claim, capacity release or physical headroom. A reservation whose recorded hook is gone then settles through its own ordinary path, carrying this answer as evidence.`;
}

/** The durable foreground-absence retirement; the scheduler owns the transaction, as for the other two. */
export function hostRunAccountingAbsenceRetirementRecord(
  record: HostRunInternalRecord,
  absence: HostRunAccountingAbsenceEvidence,
  expectedRunDigest: string,
  at: string,
): HostRunAccountingAbsenceRetirement {
  const inputHash = hostRunAccountingAbsenceInputHash(record, absence);
  return hostRunAccountingAbsenceRetirementSchema.parse({
    format: "queue.host-run.accounting-absence-retirement",
    version: 1,
    runId: record.id,
    epoch: record.epoch,
    operationId: `foreground-absent:${inputHash.slice(0, 40)}`,
    inputHash,
    disposition: "accounting_retired",
    disposedAt: at,
    basis: "foreground_absent",
    policy: HOST_RUN_ACCOUNTING_ABSENCE_POLICY,
    absence,
    acceptance: null,
    reason: hostRunAccountingAbsenceReason(absence),
    expectedRunDigest,
    observed: hostRunAccountingEvidence(record),
  });
}

interface HostRunAccountingContext {
  store: Store;
  nowMs: () => number;
  authority(): HostRunAuthority;
  pump(): void;
}

export class HostRunAccounting {
  constructor(private readonly context: HostRunAccountingContext) {}

  /**
   * Queue-internal read of a run's accounting state (Spec 035, "Operator
   * accounting disposition"): the pinned record beside the durable disposition,
   * or null for an unknown run. Never a wire shape of contract 010.
   */
  accountingStatus(id: string): HostRunAccountingView | null {
    const run = this.context.store.hostRun(id);
    return run ? hostRunAccountingView(this.context.store, run, new Date(this.context.nowMs()).toISOString()) : null;
  }

  /** The accounting entries for rows already read; the single join both board reads use. */
  accountingOf(runs: HostRunInternalRecord[], limit: number): HostRunAccountingList {
    const rows = runs.filter(run => run.state !== "settled" && this.context.store.hostRunAccountingDispositionRaw(run.id) !== undefined);
    const entries = rows.slice(0, limit).map(run => {
      const retirement = hostRunAccountingRetirementOf(this.context.store, run);
      if (!retirement) return { runId: run.id, epoch: run.epoch, accounting: "unreadable" as const, format: null, disposedAt: null, producer: null };
      const producer = retirement.format === "queue.host-run.accounting-retirement"
        ? { verdict: retirement.producer.verdict, state: retirement.producer.state, exitCode: retirement.producer.exitCode, signal: retirement.producer.signal }
        : null;
      return { runId: run.id, epoch: run.epoch, accounting: "retired" as const, format: retirement.format, disposedAt: retirement.disposedAt, producer };
    });
    return { readAt: new Date(this.context.nowMs()).toISOString(), entries, complete: rows.length <= limit };
  }

  /**
   * Retire one launched reservation's ACCOUNTING while its workload outcome and
   * runtime custody stay UNKNOWN (Spec 035, "Operator accounting disposition").
   *
   * This is the general operator surface the settled-only `releaseCapacity`
   * never covered: an admission reservation admitted before a trusted runtime
   * binding existed can be running with no honest terminal result, and used to
   * charge capacity forever. The row is never rewritten and no settlement, exit,
   * custody, container, descendant, workspace or consumer permission changes: the
   * scheduler stops charging this reservation's budget and records who decided
   * it, the separate exact-run/current-epoch acceptance and the evidence it saw.
   *
   * Only an operator (or an authenticated relay with the operator's note) is
   * authority; generic approval is not acceptance. The exact pinned record
   * digest the caller read must still hold, so a changed row refuses instead of
   * being disposed of on stale evidence, and the durable operation id makes a
   * lost reply observable by repeating the same call rather than a blind replay
   * or a fresh key.
   */
  disposeAccounting(input: HostRunAccountingDisposeInput): HostRunAccountingView {
    const parsed = hostRunAccountingDisposeInputSchema.parse(input);
    const authority = hostRunAccountingAuthority(parsed.authority);
    const inputHash = hostRunAccountingInputHash(parsed);
    const at = new Date(this.context.nowMs()).toISOString();
    const outcome: { view?: HostRunAccountingView; journal?: HostRunEvent } = {};
    this.context.store.transaction(() => {
      const run = this.context.store.hostRun(parsed.runId);
      if (!run) throw new Error(`unknown_run: ${parsed.runId}`);
      if (parsed.acceptance.runId !== run.id)
        throw new Error("The exact-run acceptance names a different host run; nothing was written");
      // A stored retirement is the durable observation of the same effect: a
      // retry with the same id and input returns it, a mutated retry and a second
      // operation both refuse. Nothing is released twice.
      const stored = this.context.store.hostRunAccountingDispositionRaw(run.id);
      if (stored !== undefined) {
        const existing = hostRunAccountingRetirementSchema.safeParse(stored);
        if (!existing.success || existing.data.runId !== run.id || existing.data.epoch !== run.epoch)
          throw new Error("This run's stored accounting disposition cannot be read against its epoch; a new disposition does not replace it");
        if (existing.data.format !== "queue.host-run.accounting-disposition")
          throw new Error(`Accounting was already retired for this run automatically (${existing.data.basis === "foreground_absent" ? "its hook died and the producer holds no record of it" : "on the producer's cleanup"}) at ${existing.data.disposedAt}; an operator disposition does not retire it twice`);
        if (existing.data.operationId !== parsed.operationId)
          throw new Error(`Accounting was already retired for this run by operation ${existing.data.operationId} at ${existing.data.disposedAt}; a new operation does not dispose of it again`);
        if (existing.data.inputHash !== inputHash)
          throw new Error(`Accounting disposition operation ${parsed.operationId} already belongs to a different input; nothing was written`);
        outcome.view = hostRunAccountingView(this.context.store, run, at);
        return;
      }
      const current = this.context.authority();
      if (parsed.expectedEpoch !== current.epoch)
        throw new Error(`stale_epoch: expected ${current.epoch}, received ${parsed.expectedEpoch}`);
      if (run.epoch !== current.epoch) throw new Error(`stale_epoch: run epoch ${run.epoch} is not current ${current.epoch}`);
      if (parsed.acceptance.epoch !== run.epoch)
        throw new Error("The exact-run acceptance names another epoch; nothing was written");
      if (run.settlement !== null)
        throw new Error("This run already has a settlement; its recorded outcome is not unknown and its capacity follows the ordinary settlement path");
      if (run.state !== "running" || run.launchedAt === null)
        throw new Error(`Accounting disposition covers a launched reservation whose outcome is unknown; this run is ${run.state}${run.launchedAt ? "" : " and never launched"}, so its ordinary path is not this one`);
      if (run.capacityReleasedAt !== null)
        throw new Error("This run already records a capacity release; an accounting disposition would release it twice");
      const digest = hostRunPublicDigest(run);
      if (digest !== parsed.expectedRunDigest)
        throw new Error("The host run changed since it was read; read host.run.accounting.status and decide again. Nothing was written");
      // Retained evidence: the reservation's own request fact must still be there.
      // An unsettled run's journal is never pruned, so a missing one is unreadable
      // evidence, not history, and accounting is not retired on it.
      const retained = this.context.store.hostRunJournal(run.id);
      if (!retained.some(entry => entry.event === "request"))
        throw new Error("The reservation's own request evidence is not readable; accounting is not retired without retained evidence");
      const disposition = hostRunAccountingDispositionRecord(run, parsed, authority, at);
      this.context.store.setMeta(hostRunAccountingDispositionMetaKey(run.id), disposition);
      const data = { disposition: disposition.disposition, operationId: disposition.operationId, inputHash,
        authority: disposition.authority, acceptance: disposition.acceptance, reason: disposition.reason,
        disposedAt: at, expectedRunDigest: disposition.expectedRunDigest, observed: disposition.observed };
      const journalData = { runId: run.id, epoch: run.epoch, ...data };
      const journalId = this.context.store.appendHostRunJournal(run.id, "accounting_disposition", journalData, at);
      outcome.journal = { journalId, runId: run.id, event: "accounting_disposition", at, data: journalData };
      outcome.view = hostRunAccountingView(this.context.store, run, at);
    });
    // Retiring accounting can free the slot a queued run is waiting for.
    this.context.pump();
    return outcome.view!;
  }

  /**
   * Retire one launched reservation's ACCOUNTING because the producer reported
   * that exact run's cleanup complete (Spec 035, "Automatic accounting on
   * producer cleanup").
   *
   * This is the automatic path the #415 closure gates feed: the observer has
   * already read a `checkout-journal` record for this reservation's own Effigy
   * run id and selector, with `cleanup: complete` and a workload verdict, using
   * the reservation's bound runtime bytes in its own checkout. What arrives here
   * is that producer record — evidence, not a Contract 010 result.
   *
   * The row is never rewritten: Queue supervised no admitted command, so it holds
   * no result record, no process-group identity, no container or escaped-
   * descendant inventory and no custody closure. The retired charge is recorded in
   * the same private sidecar the operator disposition uses, as an automatic
   * retirement naming the policy ruling and the exact producer record, and the
   * pinned contract 010 row, `host.run.list` and `host.run.capacity.release` stay
   * byte for byte what they were. Accounting stops; outcome and custody stay
   * UNKNOWN.
   *
   * Idempotent by construction: an already-stored retirement bound to this row
   * and epoch is returned as itself and nothing is written again, so a repeated
   * tick, a restart, a lost reply and a concurrent pass cannot double-retire. A
   * stored retirement this build cannot read leaves the run charged and refuses
   * rather than replacing it. Every refusal writes nothing.
   */
  retireAccountingOnProducerCleanup(input: HostRunProducerCleanupRetirementInput): {
    kind: "retired" | "already_retired";
    view: HostRunAccountingView;
    retirement: HostRunAccountingRetirement;
  } {
    const at = new Date(this.context.nowMs()).toISOString();
    const outcome: { view?: HostRunAccountingView; retirement?: HostRunAccountingRetirement; journal?: HostRunEvent } = {};
    this.context.store.transaction(() => {
      const run = this.context.store.hostRun(input.runId);
      if (!run) throw new Error(`unknown_run: ${input.runId}`);
      const current = this.context.authority();
      if (run.epoch !== current.epoch) throw new Error(`stale_epoch: run epoch ${run.epoch} is not current ${current.epoch}`);
      const stored = this.context.store.hostRunAccountingDispositionRaw(run.id);
      if (stored !== undefined) {
        const existing = hostRunAccountingRetirementSchema.safeParse(stored);
        if (!existing.success || existing.data.runId !== run.id || existing.data.epoch !== run.epoch)
          throw new Error("This run's stored accounting retirement cannot be read against its epoch; accounting stays charged and is not retired again");
        outcome.retirement = existing.data;
        outcome.view = hostRunAccountingView(this.context.store, run, at);
        return;
      }
      if (run.settlement !== null)
        throw new Error("This run already has a settlement; its recorded outcome is not unknown and its accounting follows the ordinary settlement path");
      if (run.state !== "running" || run.launchedAt === null)
        throw new Error(`Accounting retirement on producer cleanup covers a launched reservation; this run is ${run.state}${run.launchedAt ? "" : " and never launched"}, so its ordinary path is not this one`);
      const runtime = run.effigyRuntime;
      if (!runtime)
        throw new Error(`Reservation ${run.id} has no bound Effigy runtime, so a producer record cannot be attributed to it; accounting is not retired`);
      const producer = input.producer;
      if (!run.effigyRunId || producer.runId !== run.effigyRunId)
        throw new Error(`The producer record names run ${producer.runId} where this reservation binds ${run.effigyRunId ?? "no run id"}; accounting is not retired on another run's record`);
      if (producer.selector !== run.selector)
        throw new Error(`The producer record names selector ${JSON.stringify(producer.selector)} where this reservation was admitted for ${JSON.stringify(run.selector)}; accounting is not retired on another task's record`);
      if (producer.runtimePath !== runtime.path || producer.runtimeSha256 !== runtime.sha256)
        throw new Error("The producer record was not read by this reservation's bound runtime bytes; accounting is not retired on another runtime's answer");
      const retirement = hostRunAccountingAutomaticRetirementRecord(run, producer, hostRunPublicDigest(run), at);
      this.context.store.setMeta(hostRunAccountingDispositionMetaKey(run.id), retirement);
      const journalData = {
        runId: run.id, epoch: run.epoch, disposition: retirement.disposition, basis: retirement.basis,
        operationId: retirement.operationId, inputHash: retirement.inputHash, policy: retirement.policy,
        producer: retirement.producer, acceptance: retirement.acceptance, reason: retirement.reason,
        disposedAt: at, expectedRunDigest: retirement.expectedRunDigest, observed: retirement.observed,
      };
      const journalId = this.context.store.appendHostRunJournal(run.id, "accounting_retirement", journalData, at);
      outcome.journal = { journalId, runId: run.id, event: "accounting_retirement", at, data: journalData };
      outcome.retirement = retirement;
      outcome.view = hostRunAccountingView(this.context.store, run, at);
    });
    // Retiring accounting can free the slot a queued run is waiting for.
    this.context.pump();
    return { kind: outcome.journal ? "retired" : "already_retired", view: outcome.view!, retirement: outcome.retirement! };
  }

  /**
   * Retire one launched reservation's ACCOUNTING because its admission hook is
   * dead and the producer reports no foreground holder and no journal record of
   * its run (Spec 035, "Retired runs age out, and dead foreground runs retire";
   * Tom, 2026-10-25: "Auto-free them (Recommended)").
   *
   * Same discipline as the producer-cleanup retirement: the pinned row is never
   * rewritten, the record and its journal fact commit together, an already
   * stored retirement bound to the row is returned as itself, and every binding
   * (epoch, launch, run id, selector, checkout, runtime bytes, hook identity) is
   * re-checked here so evidence read before an await cannot retire a row that
   * moved. Accounting only: outcome and custody stay UNKNOWN.
   */
  retireAccountingOnForegroundAbsence(input: HostRunForegroundAbsenceRetirementInput): {
    kind: "retired" | "already_retired";
    view: HostRunAccountingView;
    retirement: HostRunAccountingRetirement;
  } {
    const at = new Date(this.context.nowMs()).toISOString();
    const outcome: { view?: HostRunAccountingView; retirement?: HostRunAccountingRetirement; journal?: HostRunEvent } = {};
    this.context.store.transaction(() => {
      const run = this.context.store.hostRun(input.runId);
      if (!run) throw new Error(`unknown_run: ${input.runId}`);
      const current = this.context.authority();
      if (run.epoch !== current.epoch) throw new Error(`stale_epoch: run epoch ${run.epoch} is not current ${current.epoch}`);
      const stored = this.context.store.hostRunAccountingDispositionRaw(run.id);
      if (stored !== undefined) {
        const existing = hostRunAccountingRetirementSchema.safeParse(stored);
        if (!existing.success || existing.data.runId !== run.id || existing.data.epoch !== run.epoch)
          throw new Error("This run's stored accounting retirement cannot be read against its epoch; accounting stays charged and is not retired again");
        outcome.retirement = existing.data;
        outcome.view = hostRunAccountingView(this.context.store, run, at);
        return;
      }
      if (run.settlement !== null)
        throw new Error("This run already has a settlement; its recorded outcome is not unknown and its accounting follows the ordinary settlement path");
      if (run.state !== "running" || run.launchedAt === null)
        throw new Error(`Accounting retirement on foreground absence covers a launched reservation; this run is ${run.state}${run.launchedAt ? "" : " and never launched"}`);
      const runtime = run.effigyRuntime;
      if (!runtime)
        throw new Error(`Reservation ${run.id} has no bound Effigy runtime, so the producer's answer cannot be attributed to it; accounting is not retired`);
      const absence = input.absence;
      if (!run.effigyRunId || absence.runId !== run.effigyRunId)
        throw new Error(`The absence evidence names run ${absence.runId} where this reservation binds ${run.effigyRunId ?? "no run id"}; accounting is not retired`);
      if (absence.selector !== run.selector)
        throw new Error(`The absence evidence names selector ${JSON.stringify(absence.selector)} where this reservation was admitted for ${JSON.stringify(run.selector)}; accounting is not retired`);
      if (absence.checkout !== run.repository.path)
        throw new Error("The absence evidence was not read in this reservation's own checkout; accounting is not retired");
      if (absence.runtimePath !== runtime.path || absence.runtimeSha256 !== runtime.sha256)
        throw new Error("The absence evidence was not read by this reservation's bound runtime bytes; accounting is not retired");
      if (!run.pid || !run.startIdentity || absence.hook.pid !== run.pid || absence.hook.startIdentity !== run.startIdentity)
        throw new Error("The absence evidence names another admission hook identity than this reservation recorded; accounting is not retired");
      const retirement = hostRunAccountingAbsenceRetirementRecord(run, absence, hostRunPublicDigest(run), at);
      this.context.store.setMeta(hostRunAccountingDispositionMetaKey(run.id), retirement);
      const journalData = {
        runId: run.id, epoch: run.epoch, disposition: retirement.disposition, basis: retirement.basis,
        operationId: retirement.operationId, inputHash: retirement.inputHash, policy: retirement.policy,
        absence: retirement.absence, acceptance: retirement.acceptance, reason: retirement.reason,
        disposedAt: at, expectedRunDigest: retirement.expectedRunDigest, observed: retirement.observed,
      };
      const journalId = this.context.store.appendHostRunJournal(run.id, "accounting_retirement", journalData, at);
      outcome.journal = { journalId, runId: run.id, event: "accounting_retirement", at, data: journalData };
      outcome.retirement = retirement;
      outcome.view = hostRunAccountingView(this.context.store, run, at);
    });
    this.context.pump();
    return { kind: outcome.journal ? "retired" : "already_retired", view: outcome.view!, retirement: outcome.retirement! };
  }
}
