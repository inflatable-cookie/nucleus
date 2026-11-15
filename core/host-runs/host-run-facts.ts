/**
 * The durable `report` facts behind contract 010's journal.
 *
 * A fact is journaled once and acked by `factId`: the journal row is the
 * identity of record, so a retry after a crash gap between the journal write
 * and the endpoint's fact log repairs the log and acks the stored copy, and a
 * reused `factId` with a different body is a `conflict`. This module owns that
 * rule once — the row a `factId` names, the body the wire compares, and the
 * bounded cache and log the endpoint acks from — so the endpoint and the
 * scheduler's own container reports never each carry a copy.
 */
import {
  closeSync,
  constants,
  fstatSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  HOST_RUN_FACT_CACHE_BYTES,
  HOST_RUN_FACT_CACHE_ENTRIES,
  stableJson,
  type HostRunClientErrorCode,
} from "./host-run-endpoint-types";
import {
  appendVerifiedOwnedFile,
  openVerifiedOwnedFile,
  writeVerifiedOwnedFile,
} from "./host-run-files";
import {
  hostRunFactSchema,
  type HostRunFact,
} from "./host-run-wire";
import { refuseHostRun } from "./host-run-refusal";
import type { Store } from "../store/store";

const FACTS_LOG = "facts.jsonl";
const JOURNAL_EVENTS = "('nested','override','container_report')";

/** One journaled fact row: the event it was recorded under and the body it carries. */
export interface HostRunJournalFactRow {
  event: string;
  body: Record<string, unknown>;
}

/** The journal handle facts are read from and written to. */
export interface HostRunFactJournalPort {
  store: Store;
  /** Journal one non-container fact under its holder run id. */
  note(runId: string, event: string, data: Record<string, unknown>): void;
  /** Record one container fact; the scheduler owns container capacity. */
  reportContainerFact(fact: HostRunContainerReport): unknown;
}

/** One container report as the wire carries it (the shape `reportContainerFact` accepts). */
export interface HostRunContainerReport {
  factId: string;
  observedAt: string;
  runId: string;
  epoch: number;
  runtime: string;
  containerId: string;
  event: "started" | "removed";
  removed?: boolean | "unknown";
}

/** The how one `report` batch was settled: the facts to ack, or the refusal it earns. */
export type HostRunReportOutcome =
  | { state: "accepted"; facts: unknown[] }
  | { state: "refused"; code: HostRunClientErrorCode; detail: string };

/**
 * The journal row one `factId` names, or null when it was never journaled. A
 * lookup that fails, and a row whose recorded body cannot be read, are unknown
 * journal state — never "the id is unused" — so they refuse: accepting a body
 * for an id that may already hold another one, or applying a container update
 * twice, is exactly what the identity rule exists to prevent.
 */
export function readHostRunJournalFactRow(store: Store, factId: string): HostRunJournalFactRow | null {
  const row = store.db.prepare(
    `SELECT event,data FROM host_run_journal WHERE event IN ${JOURNAL_EVENTS} AND json_extract(data,'$.factId')=? ORDER BY id LIMIT 1`,
  ).get(factId) as { event: string; data: string } | undefined;
  if (!row) return null;
  let body: unknown;
  try { body = JSON.parse(row.data); }
  catch (error) {
    refuseHostRun("conflict", `host-run fact ${factId} cannot be read from the journal (${error instanceof Error ? error.message : String(error)}); nothing was written`);
  }
  if (!body || typeof body !== "object") refuseHostRun("conflict", `host-run fact ${factId} is journaled without a readable body; nothing was written`);
  return { event: row.event, body: body as Record<string, unknown> };
}

/**
 * The fact body one journaled `factId` names, across every report kind, so a
 * reused `factId` is a global `conflict` even after a crash gap between the
 * journal write and the fact log. A container row omits the `kind`
 * discriminator the wire carries; a non-container row carries a synthetic
 * holder `runId` that is not part of the fact.
 */
export function journaledHostRunFact(store: Store, factId: string): HostRunFact | null {
  const row = readHostRunJournalFactRow(store, factId);
  if (!row) return null;
  const candidate = row.event === "container_report"
    ? { kind: "container" as const, ...row.body }
    : (() => { const { runId: _holder, ...stored } = row.body; return stored; })();
  const parsed = hostRunFactSchema.safeParse(candidate);
  if (!parsed.success)
    refuseHostRun("conflict", `host-run fact ${factId} is journaled in a shape this version cannot read (${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}); nothing was written`);
  return parsed.data;
}

export class HostRunFacts {
  private readonly facts = new Map<string, { body: string; fact: HostRunFact }>();
  private factCacheBytes = 0;

  constructor(private readonly stateDir: string, private readonly journal: HostRunFactJournalPort) {}

  /**
   * Reload the retained tail, re-journal every non-container fact whose crash
   * gap left the journal short, and compact the log.
   */
  start(): void {
    this.load();
    this.reconcile();
    this.compact();
  }

  /** Whether one fact is still in the bounded cache; the journal stays the identity of record. */
  cached(factId: string): boolean {
    return this.facts.has(factId);
  }

  /** Settle one `report` batch: dedup and conflict checks first, then the durable writes. */
  report(facts: HostRunFact[]): HostRunReportOutcome {
    const batch = new Map<string, string>();
    for (const fact of facts) {
      const encoded = stableJson(fact);
      const inBatch = batch.get(fact.factId);
      if (inBatch !== undefined && inBatch !== encoded)
        return { state: "refused", code: "conflict", detail: `factId ${fact.factId} appears twice with different bodies` };
      batch.set(fact.factId, encoded);
      const known = this.facts.get(fact.factId);
      if (known && known.body !== encoded)
        return { state: "refused", code: "conflict", detail: `factId ${fact.factId} already names a different body` };
      const durable = journaledHostRunFact(this.journal.store, fact.factId);
      if (durable && stableJson(durable) !== encoded)
        return { state: "refused", code: "conflict", detail: `factId ${fact.factId} already names a different journaled body` };
    }
    const acked: unknown[] = [];
    for (const fact of facts) {
      const known = this.facts.get(fact.factId);
      if (known) { acked.push(known.fact); continue; }
      const durable = journaledHostRunFact(this.journal.store, fact.factId);
      if (durable) {
        // The durable write already happened; only the fact log is short. Repair
        // it, never re-journal or re-report capacity, and ack the stored copy.
        this.store(fact);
        acked.push(durable);
        continue;
      }
      if (fact.kind === "container") {
        if (fact.removed === undefined && fact.event === "removed")
          return { state: "refused", code: "invalid", detail: `factId ${fact.factId}: removed events require removed` };
        this.journal.reportContainerFact({
          factId: fact.factId, observedAt: fact.observedAt, runId: fact.runId, epoch: fact.epoch,
          runtime: fact.runtime, containerId: fact.containerId, event: fact.event,
          ...(fact.removed !== undefined ? { removed: fact.removed } : {}),
        });
        this.store(fact);
      } else {
        this.journalFact(fact);
        this.store(fact);
      }
      acked.push(fact);
    }
    return { state: "accepted", facts: acked };
  }

  private load(): void {
    let fd: number | null = null;
    try {
      fd = openVerifiedOwnedFile(this.stateDir, [FACTS_LOG], constants.O_RDONLY, 0o600);
      const size = fstatSync(fd).size;
      const offset = Math.max(0, size - HOST_RUN_FACT_CACHE_BYTES);
      const buffer = Buffer.alloc(Math.min(size, HOST_RUN_FACT_CACHE_BYTES));
      const bytes = readSync(fd, buffer, 0, buffer.length, offset);
      const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
      // The first line may be partial; its durable copy is in the journal.
      if (offset) lines.shift();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { this.cache(hostRunFactSchema.parse(JSON.parse(line))); }
        catch { /* one corrupt line cannot hide the rest */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally { if (fd !== null) closeSync(fd); }
  }

  private cache(fact: HostRunFact): void {
    const body = stableJson(fact);
    const previous = this.facts.get(fact.factId);
    if (previous) this.factCacheBytes -= Buffer.byteLength(previous.body) + 1;
    this.facts.delete(fact.factId);
    this.facts.set(fact.factId, { body, fact });
    this.factCacheBytes += Buffer.byteLength(body) + 1;
    while (this.factCacheBytes > HOST_RUN_FACT_CACHE_BYTES || this.facts.size > HOST_RUN_FACT_CACHE_ENTRIES) {
      const oldest = this.facts.keys().next().value!;
      this.factCacheBytes -= Buffer.byteLength(this.facts.get(oldest)!.body) + 1;
      this.facts.delete(oldest);
    }
  }

  private compact(): void {
    writeVerifiedOwnedFile(this.stateDir, [FACTS_LOG],
      [...this.facts.values()].map(entry => entry.body + "\n").join(""), 0o600);
  }

  /**
   * A durable non-container fact is written before its event. If the process
   * exited in that gap, the fact is reloaded here and its journal event is
   * recreated, so a retry that is acked does not leave the journal short.
   */
  private reconcile(): void {
    for (const { fact } of this.facts.values()) {
      if (fact.kind !== "nested" && fact.kind !== "override") continue;
      try { this.journalFact(hostRunFactSchema.parse(fact)); } catch { /* a corrupt fact is skipped */ }
    }
  }

  /** Journal a non-container fact once, refusing a different body for the same id. */
  private journalFact(fact: HostRunFact): void {
    const durable = journaledHostRunFact(this.journal.store, fact.factId);
    if (durable) {
      if (stableJson(durable) !== stableJson(fact)) throw new Error(`conflict: host-run fact ${fact.factId} changed body`);
      return;
    }
    const holder = fact.kind === "nested" ? fact.parentRunId : "host-run-override";
    this.journal.note(holder, fact.kind, { ...fact });
  }

  private store(fact: HostRunFact): void {
    appendVerifiedOwnedFile(this.stateDir, [FACTS_LOG], `${JSON.stringify(fact)}\n`);
    this.cache(fact);
    // Appends may temporarily exceed the cap by one request, then compact.
    if (statSync(join(this.stateDir, FACTS_LOG)).size > HOST_RUN_FACT_CACHE_BYTES) this.compact();
  }
}
