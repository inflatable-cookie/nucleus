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

type HostRunCapacitySample = ReturnType<typeof hostRunCapacitySampleSchema.parse>;

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
 * claims nothing about the workload. This stays the exit for a reservation the
 * producer still reports live, held or retained.
 */
export const HOST_RUN_EXPIRED_RELEASE_REASON = "run timeout expired with the admission hook gone";
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
  reservationAccountingRetired(run: HostRunInternalRecord): boolean;
  admissionHookState(run: HostRunInternalRecord, budget: { identityReads: number }): "gone" | "alive" | "unknown";
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
      if (run.epoch !== epoch) throw new Error(`stale_epoch: run epoch ${run.epoch} does not match ${epoch}`);
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
   * covers (Spec 035, "A reservation settles when its recorded process is
   * gone"): every launched admission reservation whose hook is gone settles
   * once, and the freed capacity is offered to the queue.
   *
   * The sweep settles the two shapes whose evidence is already final without
   * asking a producer again: the row's own producer retired its accounting, or
   * its recorded run timeout has passed. A row the producer still reports live,
   * held or retained keeps that hold until its deadline; a row with no producer
   * answer yet is left to the watch that owns it, so the sweep never settles a
   * reservation one instant before its own observer reads the result. A bounded
   * page of start-identity reads keeps a busy pass from stalling the service;
   * anything it leaves unproven waits for the next tick.
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
  settleIfDue(run: HostRunInternalRecord, budget: { identityReads: number }, scope: "watch" | "sweep"): HostRunInternalRecord | null {
    if (run.state !== "running" || run.submissionSource !== "admission" || run.launchedAt === null) return null;
    const overdue = Date.parse(run.launchedAt) + run.runTimeoutMs < this.context.nowMs();
    if (scope === "sweep" && !overdue && !this.context.reservationAccountingRetired(run)) return null;
    if (this.context.admissionHookState(run, budget) !== "gone") return null;
    return overdue
      ? this.context.writeSettlement(run, "expiry", HOST_RUN_EXPIRED_RELEASE_REASON)
      : this.context.writeSettlement(run, "hook_gone", HOST_RUN_ABANDONED_RELEASE_REASON);
  }

  /** True when this row already carries its producer's own accounting retirement. */
  reservationAccountingRetired(run: HostRunInternalRecord): boolean {
    return hostRunAccountingRetirementOf(this.context.store, run) !== undefined;
  }

  /**
   * The recorded admission hook's liveness: `gone` only on positive absence,
   * `unknown` whenever this host cannot prove either way.
   *
   * A pid the kernel no longer reports is positive absence, whatever the
   * recorded identity says, because no identity read can make a dead pid alive.
   * A live pid is only `alive` when its identity still matches — a reused number
   * is `gone` — and an unreadable identity, or a pass that has spent its bounded
   * reads, is `unknown` and never absence.
   */
  admissionHookState(run: HostRunInternalRecord, budget: { identityReads: number }): "gone" | "alive" | "unknown" {
    if (!run.pid || !run.startIdentity) return "unknown";
    if (!this.context.hookAlive(run.pid)) return "gone";
    if (run.startIdentity.endsWith("@unknown")) return "unknown";
    if (budget.identityReads >= HOST_RUN_SETTLEMENT_IDENTITY_READS_PER_SWEEP) return "unknown";
    budget.identityReads++;
    const liveIdentity = this.context.hookStartIdentity(run.pid);
    if (liveIdentity.endsWith("@unknown")) return "unknown";
    return startIdentityMatches(run.startIdentity, liveIdentity) ? "alive" : "gone";
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
    if (run.epoch !== authority.epoch) throw new Error(`stale_epoch: run epoch ${run.epoch} is not current ${authority.epoch}`);
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
    if (fact.epoch !== authority.epoch) throw new Error(`stale_epoch: expected ${authority.epoch}, received ${fact.epoch}`);
    const run = this.context.store.hostRun(fact.runId);
    if (!run) throw new Error(`unknown_run: ${fact.runId}`);
    if (run.epoch !== fact.epoch) throw new Error(`stale_epoch: run epoch ${run.epoch} does not match ${fact.epoch}`);
    if (!run.launchedAt) throw new Error("Container reports require a launched host run");
    if (!fact.factId || !fact.runtime || !fact.containerId || !Number.isFinite(Date.parse(fact.observedAt))) throw new Error("Container reports require fact ID, observed time, runtime and container ID");
    if (fact.event === "removed" && fact.removed === undefined) throw new Error("Container removed reports require removed");
    let updated: HostRunInternalRecord | null = null;
    let duplicateFact = false;
    this.context.store.transaction(() => {
      this.context.assertCurrentEpoch(fact.epoch);
      const duplicate = this.context.store.db.prepare("SELECT run_id,data FROM host_run_journal WHERE event='container_report' AND json_extract(data,'$.factId')=? ORDER BY id LIMIT 1")
        .get(fact.factId) as { run_id: string; data: string } | undefined;
      if (duplicate) {
        const stored = JSON.parse(duplicate.data) as unknown;
        if (stableJson(stored) !== stableJson(fact)) throw new Error(`conflict: host-run fact ${fact.factId} changed body`);
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
