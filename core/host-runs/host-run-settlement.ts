import {
  boundCpuCoverage,
  hostRunCapacitySampleSchema, hostRunInternalRecordSchema, hostRunSettlementSchema,
  type HostRunAuthority,
  type HostRunCpuCoverage, type HostRunEscapedDescendant, type HostRunInternalRecord, type HostRunSettlement
} from "../../shared/contracts";
import {
  hostRunAccountingRetirementOf
} from "./host-run-accounting";
import { hostRunCpuCoverageMetaKey } from "./host-run-cpu-coverage";
import type { HostRunHandler } from "./host-run-scheduler-types";
import { startIdentityMatches } from "../machine/start-identity";
import type { Store } from "../store/store";
import { now } from "../store/store";
import { readHostRunJournalFactRow } from "./host-run-facts";
import { refuseHostRun } from "./host-run-refusal";

type HostRunCapacitySample = ReturnType<typeof hostRunCapacitySampleSchema.parse>;

/**
 * What one pass proved about a reservation's recorded hook, and the exact
 * observation behind it. `gone` is the only answer that may settle a row;
 * `unknown` never is, and its `reason` is what the row records so the stuck
 * state has a visible cause. `cause: "budget"` is Queue's own read limit, not an
 * observation of the host, so it is never recorded on the row.
 */
export interface HostRunHookLiveness {
  state: "gone" | "alive" | "unknown";
  reason: string;
  cause: "unbound" | "dead" | "reused" | "unreadable" | "budget" | "alive";
}

export const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
};

/**
 * Why an abandoned admission reservation's capacity was released (Spec 035, "A
 * reservation settles when its recorded process is gone"). It names what Queue
 * observed — the reservation's recorded hook is gone and Queue holds no terminal
 * result of its own — and claims nothing about the workload.
 */
export const HOST_RUN_ABANDONED_RELEASE_REASON = "the admission hook is gone with no terminal result of its own";
/**
 * Why an overdue admission reservation's capacity was released (Spec 035, "An
 * overdue reservation with a dead holder expires"). It names what Queue
 * observed — its own run timeout passed and the recorded hook is gone — and
 * claims nothing about the workload. The deadline no longer decides whether a
 * gone hook settles; it only names which of the two exits applies.
 */
export const HOST_RUN_EXPIRED_RELEASE_REASON = "run timeout expired with the admission hook gone";
/**
 * Why an admitted reservation that never launched was settled, in its `hook_gone`
 * fact and as its release reason (Spec 035, "The sweep proves every
 * reservation's holder"). The hook is the reservation's whole foreground: once
 * it is gone nothing can confirm the admission, so the row is cancelled before
 * it holds a slot or a workspace any longer.
 */
export const HOST_RUN_HOOK_DIED_BEFORE_ADMIT_REASON = "admission hook died before admit";
/**
 * The one journal event that says a reservation's recorded hook could not be
 * proven alive or gone this pass, with the exact observation as its reason. It is
 * written once per distinct reason, so a stuck row always names why it still
 * holds instead of waiting silently for its run timeout.
 */
export const HOST_RUN_LIVENESS_UNKNOWN_EVENT = "hook_liveness_unknown";
/**
 * The one journal event that says the sweep has proven a reservation's hook gone
 * and is holding one bounded window for the endpoint watch to read the producer's
 * answer first (Spec 035, "The sweep proves every reservation's holder"). It
 * records the observation and the instant, so a row that settles after that
 * window names what it waited for.
 */
export const HOST_RUN_HOOK_GONE_PENDING_EVENT = "hook_gone_pending";
/**
 * How long a proven-gone reservation waits for a live endpoint watch to read its
 * producer answer before the sweep settles it on its own proof.
 *
 * The watch is the only reader of the producer: its `run status` answer (a
 * closure, a retained hold or a refusal) is evidence about the run that the sweep
 * cannot get for itself, and a settled row stops being watched. One sweep
 * interval already gives the watch about twenty one-second ticks, each bounded by
 * an eight-second status call, so this window is enough for at least one read and
 * short enough that no reservation waits for a second sweep to be settled.
 */
export const HOST_RUN_WATCH_EVIDENCE_WINDOW_MS = 15_000;
/**
 * Journal events that mean an endpoint watch has read this reservation's producer
 * answer. Any one of them is the evidence the sweep's own window is waiting for.
 */
const HOST_RUN_PRODUCER_OBSERVATION_EVENTS: readonly string[] = [
  "effigy_observation", "effigy_observation_retained", "effigy_observation_refused",
];
/**
 * Start-identity reads one settlement sweep may spend. A dead pid needs none, so
 * the leaked public records cost nothing here; a live pid that may be a reused
 * number needs one `ps`, and that work is bounded per pass instead of stalling
 * the service's event loop behind a page of them.
 */
export const HOST_RUN_SETTLEMENT_IDENTITY_READS_PER_SWEEP = 8;

interface HostRunSettlementOwnerContext {
  store: Store;
  persistMany(run: HostRunInternalRecord, entries: Array<{ event: string; data: Record<string, unknown> }>, at?: string, expectedEpoch?: number, atomicWrite?: () => void): HostRunInternalRecord;
  handlers: Map<string, HostRunHandler>;
  clearDeadline(id: string): void;
  pump(): void;
  assertCurrentEpoch(epoch: number): void;
  sampleCapacity(runs: HostRunInternalRecord[]): HostRunCapacitySample;
  settleIfDue(run: HostRunInternalRecord, budget: { identityReads: number }, scope: "watch" | "sweep"): HostRunInternalRecord | null;
  nowMs: () => number;
  admissionHookState(run: HostRunInternalRecord, budget: { identityReads: number }): HostRunHookLiveness;
  writeSettlement(run: HostRunInternalRecord, event: "hook_gone" | "expiry", reason: string): HostRunInternalRecord | null;
  hookAlive: (pid: number) => boolean;
  hookStartIdentity: (pid: number) => string;
  hasUnresolvedEscapedDescendants(run: HostRunInternalRecord): boolean;
  recordedProducerResult(run: HostRunInternalRecord): { runId: string; state: string; exitCode: number | null; signal: number | null; cleanup: string; startedAt: string | null; endedAt: string | null; verdict: string } | null;
  currentEpoch(epoch: number): boolean;
  authority(): HostRunAuthority;
  persist(run: HostRunInternalRecord, event: string, data: unknown, at?: string, expectedEpoch?: number): HostRunInternalRecord;
  trackLive(run: HostRunInternalRecord): void;
}

export class HostRunSettlementOwner {
  constructor(private readonly context: HostRunSettlementOwnerContext) {}

  settle(id: string, settlement: HostRunSettlement, metrics: { wallMs?: number | null; cpuMs?: number | null; cpuCoverage?: HostRunCpuCoverage } = {},
    atomicWrite?: () => void): HostRunInternalRecord {
    const current = this.context.store.hostRun(id);
    if (!current) throw new Error(`Host run ${id} does not exist`);
    if (current.state === "settled") {
      if (atomicWrite) this.context.store.transaction(atomicWrite);
      return current;
    }
    if (settlement.runId !== id || settlement.result && settlement.result.epoch !== current.epoch)
      throw new Error("Host-run settlement identity does not match its journal row");
    const containersByKey = new Map(current.containers.map(container => [`${container.runtime}\u0000${container.containerId}`, container]));
    for (const container of settlement.containers) {
      const key = `${container.runtime}\u0000${container.id}`;
      const before = containersByKey.get(key);
      containersByKey.set(key, before?.removed === true ? before : {
        runtime: container.runtime, containerId: container.id, removed: container.removed,
        startedAt: before?.startedAt ?? null,
        removedAt: container.removed === true ? before?.removedAt ?? settlement.settledAt : null,
      });
    }
    const containers = [...containersByKey.values()];
    const escapedDescendants = [...new Map((settlement.result?.escapedDescendants ?? [])
      .map(descendant => [`${descendant.pid}:${descendant.startIdentity}`, descendant])).values()];
    const normalizedSettlement = hostRunSettlementSchema.parse({ ...settlement,
      ...(settlement.result ? { result: { ...settlement.result, escapedDescendants } } : {}),
      containers: containers.map(container => ({ runtime: container.runtime, id: container.containerId, removed: container.removed })) });
    const noOpenContainers = containers.every(container => container.removed === true);
    const unresolvedEscapedDescendants = escapedDescendants.length > 0 && !current.escapedDescendantsProvenDeadAt;
    const capacityMustRemain = !noOpenContainers || unresolvedEscapedDescendants;
    const releaseCleared = capacityMustRemain && current.capacityReleaseKind === "automatic";
    const capacityReleased = !capacityMustRemain && !current.capacityReleasedAt;
    const updated = hostRunInternalRecordSchema.parse({ ...current, state: "settled", position: null, settledAt: settlement.settledAt,
      settlement: normalizedSettlement, containers, wallMs: metrics.wallMs === undefined ? settlement.result?.wallMs ?? null : metrics.wallMs,
      cpuMs: metrics.cpuMs === undefined ? settlement.result?.cpuMs ?? null : metrics.cpuMs,
      ...(capacityReleased ? { capacityReleasedAt: settlement.settledAt,
        capacityReleaseReason: "settlement reported no live containers", capacityReleaseKind: "automatic" } : {}),
      ...(releaseCleared ? { capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null } : {}) });
    const facts: Array<{ event: string; data: Record<string, unknown> }> = escapedDescendants.map(descendant => ({
      event: "escaped_descendant", data: { pid: descendant.pid, startIdentity: descendant.startIdentity },
    }));
    facts.push({ event: "settlement", data: { settlement: normalizedSettlement, wallMs: updated.wallMs, cpuMs: updated.cpuMs } });
    if (capacityReleased)
      facts.push({ event: "capacity_release", data: { reason: "settlement reported no live containers", releasedAt: settlement.settledAt } });
    const persisted = this.context.persistMany(updated, facts, now(), current.epoch, atomicWrite);
    // Queue-internal CPU reason, outside the row and the journal: best effort and
    // after the settlement commits, so a failed write leaves it absent, nothing more.
    const cpuCoverage = boundCpuCoverage(persisted.cpuMs, metrics.cpuCoverage);
    if (cpuCoverage) {
      try { this.context.store.setMeta(hostRunCpuCoverageMetaKey(id), { epoch: persisted.epoch, cpuMs: persisted.cpuMs, cpuCoverage }); }
      catch { /* the reason stays unknown */ }
    }
    this.context.handlers.get(id)?.terminal?.(persisted);
    this.context.handlers.delete(id);
    this.context.clearDeadline(id);
    this.context.pump();
    return persisted;
  }

  cancelQueued(id: string, reason: string, epoch: number): HostRunInternalRecord {
    let run: HostRunInternalRecord | null = null;
    this.context.store.transaction(() => {
      this.context.assertCurrentEpoch(epoch);
      run = this.context.store.hostRun(id);
      if (!run) throw new Error(`Host run ${id} does not exist`);
      if (run.epoch !== epoch) refuseHostRun("stale_epoch", `run epoch ${run.epoch} does not match ${epoch}`);
      this.context.store.appendHostRunJournal(id, "request", { method: "host.run.cancel", input: { runId: id, reason } });
    });
    run = this.context.store.hostRun(id);
    if (!run) throw new Error(`Host run ${id} does not exist`);
    if (run.state !== "queued" && run.state !== "admitted") return run;
    const at = now();
    const settlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: id,
      outcome: "cancelled", launched: false, settledAt: at, result: null, containers: [] });
    const updated = this.context.store.hostRun(id)!;
    const settled = this.context.persistMany({ ...updated, state: "settled", position: null, settledAt: at,
      settlement, capacityReleasedAt: at, capacityReleaseReason: "cancelled before launch", capacityReleaseKind: "automatic" }, [
      { event: "settlement", data: { settlement } },
      { event: "capacity_release", data: { reason: "cancelled before launch", releasedAt: at } },
    ], at, epoch);
    this.context.handlers.get(id)?.terminal?.(settled);
    this.context.handlers.delete(id);
    this.context.clearDeadline(id);
    this.context.pump();
    return settled;
  }

  /**
   * Settle an admitted reservation whose recorded hook died before it was
   * admitted (Spec 035, "The sweep proves every reservation's holder"). Nothing
   * was launched for it, so there is no command to lose and no result to wait
   * for: it is the pinned record's `cancelled` before launch, one `hook_gone`
   * fact names the dead hook and the observation, and the release carries the
   * same reason. A row that moved, was settled by another writer or advanced its
   * epoch is not this pass's to settle.
   */
  cancelAdmittedOnDeadHook(run: HostRunInternalRecord, observation: string): HostRunInternalRecord | null {
    if (run.state !== "queued" && run.state !== "admitted") return null;
    const at = new Date(this.context.nowMs()).toISOString();
    const settlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: run.id,
      outcome: "cancelled", launched: false, settledAt: at, result: null, containers: [] });
    const updated = hostRunInternalRecordSchema.parse({ ...run, state: "settled", position: null, settledAt: at, settlement,
      capacityReleasedAt: at, capacityReleaseReason: HOST_RUN_HOOK_DIED_BEFORE_ADMIT_REASON, capacityReleaseKind: "automatic" });
    let persisted: HostRunInternalRecord;
    try {
      persisted = this.context.persistMany(updated, [
        { event: "hook_gone", data: { reason: HOST_RUN_HOOK_DIED_BEFORE_ADMIT_REASON, observation, outcome: settlement.outcome,
          custody: "unknown", launched: false, settledAt: at,
          hook: { pid: run.pid, startIdentity: run.startIdentity } } },
        { event: "settlement", data: { settlement } },
        { event: "capacity_release", data: { reason: HOST_RUN_HOOK_DIED_BEFORE_ADMIT_REASON, releasedAt: at } },
      ], at, run.epoch);
    } catch (error) {
      // A timer racing an authority handoff is a fenced no-op, not a service error.
      if (!this.context.currentEpoch(run.epoch)) return null;
      throw error;
    }
    return persisted;
  }

  rejectBeforeLaunch(id: string, reason: string): HostRunInternalRecord {
    const run = this.context.store.hostRun(id);
    if (!run) throw new Error(`Host run ${id} does not exist`);
    if (run.state === "running" || run.state === "settled") return run;
    const at = now();
    const settlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: id,
      outcome: "cancelled", launched: false, settledAt: at, result: null, containers: [] });
    const rejected = this.context.persistMany({ ...run, state: "settled", position: null, settledAt: at, settlement,
      capacityReleasedAt: at, capacityReleaseReason: "launch preparation was rejected before a host process started", capacityReleaseKind: "automatic" }, [
      { event: "decision", data: { decision: "reject", reason: reason.slice(0, 2000), capacitySample: this.context.sampleCapacity(this.context.store.hostRunCapacityCandidates()) } },
      { event: "launch_failure", data: { error: reason.slice(0, 2000), launched: false } },
      { event: "settlement", data: { settlement } },
      { event: "capacity_release", data: { reason: "launch preparation was rejected before a host process started", releasedAt: at } },
    ], at, run.epoch);
    this.context.clearDeadline(id);
    this.context.handlers.get(id)?.terminal?.(rejected);
    this.context.handlers.delete(id);
    this.context.pump();
    return rejected;
  }

  /**
   * Settle the launched admission reservation `id` when the admission hook it
   * recorded is gone (Spec 035, "A reservation settles when its recorded
   * process is gone"). This is the watcher's side of the rule: the endpoint has
   * just read the row's producer answer, so the reservation's own recorded
   * process being absent is the whole question. Returns the settled row, or null
   * when nothing is due: a live hook, an unprovable hook identity, a row that is
   * not a launched admission, or a row already settled. Idempotent by that last
   * check, so a repeated tick writes nothing again.
   *
   * The hook is the foreground process Queue recorded for this reservation and it
   * holds until it is terminated, so its absence is the end of that foreground.
   * The settlement claims nothing about the workload: it is the pinned record's
   * `lost` — launched, no result, no process-group identity, no containers, no
   * escaped descendants — and one `hook_gone` journal fact names the dead
   * identity, custody unknown, and the producer's own terminal answer when the
   * row already holds one. Capacity is released under the settlement's own
   * reason unless this row already records a release, which keeps its original
   * one.
   */
  settleAbandonedAdmission(id: string): HostRunInternalRecord | null {
    const run = this.context.store.hostRun(id);
    return run ? this.context.settleIfDue(run, { identityReads: 0 }, "watch") : null;
  }

  /**
   * The ordinary sweep behind `tick()`, and the restart path for rows no watch
   * covers (Spec 035, "The sweep proves every reservation's holder": a
   * reservation whose recorded process is gone settles on the next pass, never
   * at its run timeout). Every admitted or running admission reservation whose
   * recorded hook is proven gone settles once, and the freed capacity is offered
   * to the queue.
   *
   * The sweep asks no producer anything and needs no second opinion: the hook's
   * own liveness, by pid and contract 010 start identity, is the whole question,
   * because the hook is the reservation's entire foreground. What it does not do
   * is settle a row before a live endpoint watch has read that run's producer
   * answer: the pass that proves the hook gone holds one bounded window for it
   * (see `deferToWatchEvidence`), and the next pass settles the row whether or
   * not the answer arrived. A row whose hook is alive, unreadable, unbound or
   * unread this pass holds and records why. A bounded page of start-identity
   * reads keeps a busy pass from stalling the service; anything it leaves
   * unproven waits for the next tick, and a dead pid costs no read at all.
   */
  sweepAbandonedAdmissions(): HostRunInternalRecord[] {
    const budget = { identityReads: 0 };
    const settledRows: HostRunInternalRecord[] = [];
    for (const candidate of this.context.store.hostRunCapacityCandidates()) {
      const settled = this.context.settleIfDue(candidate, budget, "sweep");
      if (!settled) continue;
      settledRows.push(settled);
      this.context.handlers.get(settled.id)?.terminal?.(settled);
      this.context.handlers.delete(settled.id);
      this.context.clearDeadline(settled.id);
    }
    if (settledRows.length) this.context.pump();
    return settledRows;
  }

  /**
   * Settle one admission reservation its recorded hook has left behind. The one
   * question is the hook's liveness; the run timeout only decides which of the
   * two exits names it.
   *
   * An `admitted` reservation never launched a command, so a gone hook means
   * nothing can confirm the admission: it is cancelled before launch and its
   * queued slot, reservation and workspace hold go with it. A `running` one is
   * the pinned record's own `lost` — launched, no result, custody unknown —
   * because Queue supervised no command for an admission and observed no
   * container or escaped descendant.
   */
  settleIfDue(run: HostRunInternalRecord, budget: { identityReads: number }, scope: "watch" | "sweep"): HostRunInternalRecord | null {
    if (run.submissionSource !== "admission") return null;
    if (run.state === "admitted") {
      // The watch owns a reservation it is still observing and cancels it there;
      // the sweep is the path for a row no watch covers. Nothing ran for an
      // admitted reservation, so there is no producer answer to wait for.
      if (scope !== "sweep") return null;
      const admitted = this.admissionHookState(run, budget);
      if (admitted.state === "unknown") { this.recordUnknownProof(run, admitted); return null; }
      if (admitted.state !== "gone") return null;
      return this.cancelAdmittedOnDeadHook(run, admitted.reason);
    }
    if (run.state !== "running" || run.launchedAt === null) return null;
    const overdue = Date.parse(run.launchedAt) + run.runTimeoutMs < this.context.nowMs();
    const proof = this.admissionHookState(run, budget);
    if (proof.state === "unknown") { this.recordUnknownProof(run, proof); return null; }
    if (proof.state !== "gone") return null;
    // Inside its own timeout the sweep gives a live watch the one chance to read
    // this run's producer answer that a settled row would lose. The watch path
    // has just read it, and an overdue row's deadline is its own final answer.
    if (scope === "sweep" && !overdue && this.deferToWatchEvidence(run, proof.reason)) return null;
    return overdue
      ? this.context.writeSettlement(run, "expiry", HOST_RUN_EXPIRED_RELEASE_REASON)
      : this.context.writeSettlement(run, "hook_gone", HOST_RUN_ABANDONED_RELEASE_REASON);
  }

  /**
   * Hold one bounded window for the endpoint watch to read this reservation's
   * producer answer, and say whether this pass deferred to it.
   *
   * The watch is the only reader of the producer, and a settled row stops being
   * watched, so a settlement written before that read discards evidence about the
   * run the producer alone can give. A row that already carries the answer — a
   * closure, a retained hold, a refusal, or an accounting retirement — has
   * nothing left to wait for and settles on this pass. Otherwise the first pass
   * to prove the hook gone records `hook_gone_pending` with that proof, and the
   * next pass settles the row whether the watch answered in the window or not, so
   * a service with no watch attached, a crashed watch and a watch that cannot
   * reach the producer all still clear inside one window.
   */
  deferToWatchEvidence(run: HostRunInternalRecord, observation: string): boolean {
    const journal = this.context.store.hostRunJournal(run.id);
    const answered = hostRunAccountingRetirementOf(this.context.store, run) !== undefined
      || journal.some(entry => HOST_RUN_PRODUCER_OBSERVATION_EVENTS.includes(entry.event));
    if (answered) return false;
    const pending = journal.filter(entry => entry.event === HOST_RUN_HOOK_GONE_PENDING_EVENT).at(-1);
    // The proof instant is the scheduler's own clock, recorded in the fact: the
    // journal's `at` is the store's wall clock, and only this one is comparable
    // with `nowMs()`.
    const provenAt = pending ? Date.parse(String((pending.data as { provenAt?: unknown } | null)?.provenAt)) : Number.NaN;
    if (Number.isFinite(provenAt) && this.context.nowMs() - provenAt >= HOST_RUN_WATCH_EVIDENCE_WINDOW_MS) return false;
    if (!pending) {
      const provenAtIso = new Date(this.context.nowMs()).toISOString();
      try {
        this.context.store.appendHostRunJournal(run.id, HOST_RUN_HOOK_GONE_PENDING_EVENT, {
          runId: run.id, observation, windowMs: HOST_RUN_WATCH_EVIDENCE_WINDOW_MS,
          hook: { pid: run.pid, startIdentity: run.startIdentity }, provenAt: provenAtIso,
        }, provenAtIso);
      } catch { /* the next pass records it again before settling */ }
    }
    return true;
  }

  /**
   * The recorded admission hook's liveness: `gone` only on positive absence,
   * `unknown` whenever this host cannot prove either way, with the observation
   * that decided it.
   *
   * A pid the kernel no longer reports is positive absence, whatever the
   * recorded identity says, because no identity read can make a dead pid alive.
   * A live pid is only `alive` when its identity still matches — a reused number
   * is `gone` — and an unreadable or unrecorded identity, or a pass that has
   * spent its bounded reads, is `unknown` and never absence.
   */
  admissionHookState(run: HostRunInternalRecord, budget: { identityReads: number }): HostRunHookLiveness {
    if (!run.pid || !run.startIdentity)
      return { state: "unknown", cause: "unbound", reason: "the reservation records no hook process, so its liveness cannot be proven" };
    if (!this.context.hookAlive(run.pid))
      return { state: "gone", cause: "dead", reason: `recorded hook pid ${run.pid} is not a live process` };
    if (run.startIdentity.endsWith("@unknown"))
      return { state: "unknown", cause: "unreadable", reason: `recorded hook pid ${run.pid} carries no readable start identity (${run.startIdentity})` };
    if (budget.identityReads >= HOST_RUN_SETTLEMENT_IDENTITY_READS_PER_SWEEP)
      return { state: "unknown", cause: "budget", reason: `hook pid ${run.pid} was not read again: this pass spent its ${HOST_RUN_SETTLEMENT_IDENTITY_READS_PER_SWEEP} start-identity reads` };
    budget.identityReads++;
    const liveIdentity = this.context.hookStartIdentity(run.pid);
    if (liveIdentity.endsWith("@unknown"))
      return { state: "unknown", cause: "unreadable", reason: `hook pid ${run.pid} start identity could not be read (${liveIdentity})` };
    if (!startIdentityMatches(run.startIdentity, liveIdentity))
      return { state: "gone", cause: "reused", reason: `hook pid ${run.pid} now carries ${liveIdentity}, not the recorded ${run.startIdentity}` };
    return { state: "alive", cause: "alive", reason: `hook pid ${run.pid} still carries its recorded start identity` };
  }

  /**
   * Record that this pass could not prove the recorded hook alive or gone, once
   * per distinct observation, so a row that still holds capacity names why
   * instead of waiting silently for its run timeout (Spec 035, "A hold is never
   * silent"). Queue's own read budget is not an observation of the host and is
   * never recorded. Best effort and never fatal: a journal that refuses the note
   * must not stop the sweep settling the rows whose evidence is final.
   */
  recordUnknownProof(run: HostRunInternalRecord, proof: HostRunHookLiveness): void {
    if (proof.cause === "budget") return;
    const reason = proof.reason;
    try {
      if (!this.context.currentEpoch(run.epoch)) return;
      const already = this.context.store.hostRunJournal(run.id).some(entry => entry.event === HOST_RUN_LIVENESS_UNKNOWN_EVENT
        && (entry.data as Record<string, unknown> | null)?.reason === reason);
      if (already) return;
      this.context.store.appendHostRunJournal(run.id, HOST_RUN_LIVENESS_UNKNOWN_EVENT, {
        runId: run.id, kind: "hook-liveness-unknown", cause: proof.cause, reason,
        hook: { pid: run.pid, startIdentity: run.startIdentity },
        observedAt: new Date(this.context.nowMs()).toISOString(),
      });
    } catch { /* the next pass names it again */ }
  }

  /**
   * One writer for both honest exits of an abandoned reservation: the producer
   * closed the accounting (`hook_gone`) and the deadline that outlives a
   * producer still claiming the run (`expiry`).
   */
  writeSettlement(run: HostRunInternalRecord, event: "hook_gone" | "expiry", reason: string): HostRunInternalRecord | null {
    const at = new Date(this.context.nowMs()).toISOString();
    // The settlement carries the container facts this row already holds and no
    // others: an admission records none, so it claims none.
    const containers = run.containers.map(container => ({ runtime: container.runtime, id: container.containerId, removed: container.removed }));
    const settlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: run.id,
      outcome: "lost", launched: true, settledAt: at, result: null, containers });
    const reasons = { reason, releasedAt: at };
    // A row that already records a release keeps it. So does one still holding an
    // open container or an unproven escaped descendant: settling the reservation
    // is not custody closure, and that hold follows its own ordinary path.
    const release = run.capacityReleasedAt === null && containers.every(container => container.removed === true)
      && !this.context.hasUnresolvedEscapedDescendants(run);
    const updated = hostRunInternalRecordSchema.parse({ ...run, state: "settled", position: null, settledAt: at, settlement,
      ...(release ? { capacityReleasedAt: at, capacityReleaseReason: reason, capacityReleaseKind: "automatic" } : {}) });
    try {
      return this.context.persistMany(updated, [
        { event, data: { reason, outcome: settlement.outcome, custody: "unknown",
          launchedAt: run.launchedAt, runTimeoutMs: run.runTimeoutMs, settledAt: at,
          ...(event === "expiry" ? { expiredAt: at } : {}),
          hook: { pid: run.pid, startIdentity: run.startIdentity },
          producer: this.context.recordedProducerResult(run) } },
        { event: "settlement", data: { settlement } },
        ...(release ? [{ event: "capacity_release", data: reasons }] : []),
      ], at, run.epoch);
    } catch (error) {
      // A timer racing an authority handoff is a fenced no-op, not a service error.
      if (!this.context.currentEpoch(run.epoch)) return null;
      throw error;
    }
  }

  /**
   * The producer's own terminal answer this reservation already holds, when it
   * holds one: the automatic retirement its bound runtime's `checkout-journal`
   * record produced (`cleanup: complete` and the producer's verdict). It travels
   * in the settlement's journal fact as evidence beside Queue's own `lost`,
   * because a producer's verdict about a workload Queue never supervised is not
   * a contract 010 result and is never written as one.
   */
  recordedProducerResult(run: HostRunInternalRecord) {
    const retirement = hostRunAccountingRetirementOf(this.context.store, run);
    if (!retirement || retirement.format !== "queue.host-run.accounting-retirement") return null;
    const producer = retirement.producer;
    return { runId: producer.runId, state: producer.state, exitCode: producer.exitCode, signal: producer.signal,
      cleanup: producer.cleanup, startedAt: producer.startedAt, endedAt: producer.endedAt, verdict: producer.verdict };
  }

  releaseCapacity(id: string, reason: string): HostRunInternalRecord {
    const authority = this.context.authority();
    const run = this.context.store.hostRun(id);
    if (!run) throw new Error(`Host run ${id} does not exist`);
    if (run.epoch !== authority.epoch) refuseHostRun("stale_epoch", `run epoch ${run.epoch} is not current ${authority.epoch}`);
    if (!reason.trim()) throw new Error("Capacity release requires an operator reason");
    if (run.state !== "settled") throw new Error("Capacity can be released only after the host run settles");
    if (run.capacityReleasedAt) return run;
    const holdsContainerCapacity = run.containers.some(container => container.removed !== true);
    if (!holdsContainerCapacity && !this.context.hasUnresolvedEscapedDescendants(run))
      throw new Error("Host run has no held container or escaped-descendant capacity");
    const at = now();
    const updated = this.context.persist({ ...run, capacityReleasedAt: at, capacityReleaseReason: reason.trim(), capacityReleaseKind: "operator" }, "capacity_release",
      { reason: reason.trim(), releasedAt: at, operator: true }, at, run.epoch);
    this.context.pump();
    return updated;
  }

  /** Record identity-based proof that every escaped descendant has exited. */
  markEscapedDescendantsDead(id: string, provenDead: HostRunEscapedDescendant[]): HostRunInternalRecord {
    const current = this.context.store.hostRun(id);
    if (!current) throw new Error(`Host run ${id} does not exist`);
    this.context.assertCurrentEpoch(current.epoch);
    if (current.state !== "settled") throw new Error("Escaped descendants can be released only after the host run settles");
    const escaped = current.settlement?.result?.escapedDescendants ?? [];
    if (!escaped.length) throw new Error("Host run has no recorded escaped descendants");
    const identities = new Set(provenDead.map(item => `${item.pid}:${item.startIdentity}`));
    if (identities.size !== escaped.length || escaped.some(item => !identities.has(`${item.pid}:${item.startIdentity}`)))
      throw new Error("Dead-process proof must cover every recorded escaped descendant exactly");
    const at = now();
    const noOpenContainers = current.containers.every(container => container.removed === true);
    const releaseCapacity = noOpenContainers && !current.capacityReleasedAt;
    const reason = "all recorded escaped descendants proven dead";
    const updated = hostRunInternalRecordSchema.parse({ ...current,
      escapedDescendantsProvenDeadAt: current.escapedDescendantsProvenDeadAt ?? at,
      ...(releaseCapacity ? { capacityReleasedAt: at, capacityReleaseReason: reason, capacityReleaseKind: "automatic" } : {}),
    });
    const facts = [{ event: "escaped_descendants_dead", data: { escapedDescendants: escaped, provenAt: at } },
      ...(releaseCapacity ? [{ event: "capacity_release", data: { reason, releasedAt: at, escapedDescendants: escaped } }] : [])];
    const persisted = this.context.persistMany(updated, facts, at, current.epoch);
    this.context.pump();
    return persisted;
  }

  /** Part 3's durable report seam; container capacity is keyed by run/runtime/container. */
  reportContainerFact(fact: { factId: string; observedAt: string; runId: string; epoch: number; runtime: string; containerId: string; event: "started" | "removed"; removed?: boolean | "unknown" }): HostRunInternalRecord {
    const authority = this.context.authority();
    if (fact.epoch !== authority.epoch) refuseHostRun("stale_epoch", `expected ${authority.epoch}, received ${fact.epoch}`);
    const run = this.context.store.hostRun(fact.runId);
    if (!run) refuseHostRun("unknown_run", `${fact.runId}`);
    if (run.epoch !== fact.epoch) refuseHostRun("stale_epoch", `run epoch ${run.epoch} does not match ${fact.epoch}`);
    if (!run.launchedAt) throw new Error("Container reports require a launched host run");
    if (!fact.factId || !fact.runtime || !fact.containerId || !Number.isFinite(Date.parse(fact.observedAt))) throw new Error("Container reports require fact ID, observed time, runtime and container ID");
    if (fact.event === "removed" && fact.removed === undefined) throw new Error("Container removed reports require removed");
    let updated: HostRunInternalRecord | null = null;
    let duplicateFact = false;
    this.context.store.transaction(() => {
      this.context.assertCurrentEpoch(fact.epoch);
      const duplicate = readHostRunJournalFactRow(this.context.store, fact.factId);
      if (duplicate) {
        if (stableJson(duplicate.body) !== stableJson(fact)) refuseHostRun("conflict", `host-run fact ${fact.factId} changed body`);
        duplicateFact = true;
        updated = this.context.store.hostRun(run.id)!;
        return;
      }
      const current = this.context.store.hostRun(run.id)!;
      const at = new Date(Date.parse(fact.observedAt)).toISOString();
      const containers = [...current.containers];
      const index = containers.findIndex(item => item.runtime === fact.runtime && item.containerId === fact.containerId);
      const before = index >= 0 ? containers[index] : null;
      if (fact.event === "started") {
        if (before?.removed !== true) {
          const next = { runtime: fact.runtime, containerId: fact.containerId, removed: false as const,
            startedAt: before?.startedAt ?? at, removedAt: null };
          if (index >= 0) containers[index] = next; else containers.push(next);
        }
      } else if (before?.removed !== true) {
        const next = { runtime: fact.runtime, containerId: fact.containerId, removed: fact.removed!,
          startedAt: before?.startedAt ?? null, removedAt: fact.removed === true ? at : null };
        if (index >= 0) containers[index] = next; else containers.push(next);
      }
      const hostContainers = containers.map(item => ({ runtime: item.runtime, id: item.containerId, removed: item.removed }));
      const settlement = current.settlement ? hostRunSettlementSchema.parse({ ...current.settlement, containers: hostContainers }) : null;
      const allRemoved = containers.every(item => item.removed === true);
      const hasOpenContainer = containers.some(item => item.removed !== true);
      const hasUnresolvedEscapedDescendants = this.context.hasUnresolvedEscapedDescendants(current);
      const mayReacquire = current.launchedAt !== null && current.capacityReleaseKind === "automatic"
        && (current.capacityReleaseReason === "runtime reported all containers removed"
          || current.capacityReleaseReason === "settlement reported no live containers"
          || current.capacityReleaseReason === "all recorded escaped descendants proven dead");
      const releaseCleared = hasOpenContainer && mayReacquire;
      const releaseCapacity = allRemoved && !hasUnresolvedEscapedDescendants && !current.capacityReleasedAt;
      updated = hostRunInternalRecordSchema.parse({ ...current, containers, settlement,
        ...(releaseCleared ? { capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null } : {}),
        ...(releaseCapacity ? { capacityReleasedAt: at, capacityReleaseReason: "runtime reported all containers removed", capacityReleaseKind: "automatic" } : {}) });
      const reportData = { ...fact };
      this.context.store.putHostRun(updated);
      this.context.trackLive(updated);
      this.context.store.appendHostRunJournal(updated.id, "container_report", reportData, at);
      if (releaseCapacity) {
        const releaseData = { runId: updated.id, epoch: updated.epoch, reason: "runtime reported all containers removed", releasedAt: at };
        this.context.store.appendHostRunJournal(updated.id, "capacity_release", releaseData, at);
      }
    });
    if (duplicateFact) return updated!;
    this.context.pump();
    return updated!;
  }
  capacityTimeout(run: HostRunInternalRecord): void {
    const at = new Date(this.context.nowMs()).toISOString();
    const settlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: run.id,
      outcome: "capacity_timeout", launched: false, settledAt: at, result: null, containers: [] });
    let updated: HostRunInternalRecord | null;
    try {
      updated = this.context.persistMany({ ...run, state: "settled", position: null, settledAt: at, settlement,
        capacityReleasedAt: at, capacityReleaseReason: "capacity deadline expired before launch", capacityReleaseKind: "automatic" }, [
        { event: "decision", data: { decision: "reject", reason: "capacity_timeout", capacitySample: this.context.sampleCapacity(this.context.store.hostRunCapacityCandidates()) } },
        { event: "settlement", data: { settlement } },
        { event: "capacity_release", data: { reason: "capacity deadline expired before launch", releasedAt: at } },
      ], at, run.epoch);
    } catch (error) {
      if (!this.context.currentEpoch(run.epoch)) return;
      throw error;
    }
    if (!updated) return;
    this.context.handlers.get(run.id)?.terminal?.(updated);
    this.context.handlers.delete(run.id);
    this.context.clearDeadline(run.id);
  }
}
