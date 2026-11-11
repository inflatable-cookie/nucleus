/**
 * The request ledger (service-boundary contract, "Rolls: calls wait out the
 * replacement").
 *
 * A mutating catalogue call may carry a client-minted request key on its frame.
 * Before the handler runs, the ledger records that the request was received;
 * after it settles, the ledger records its definite outcome — the result or the
 * typed error the service answered with. Both records are durable store writes
 * that survive a service roll, so when a response is lost mid-roll the
 * replacement can answer what actually happened:
 *
 * - `applied` — the handler settled; the recorded result is returned exactly as
 *   the lost response would have carried it, and the handler never runs again;
 * - `refused` — the service settled on a typed refusal; it is replayed as-is;
 * - `not received` — no record under that key: the request provably never
 *   reached a service, and resending it is not a blind retry.
 *
 * One bounded journal in store meta (the `capacityChanges` precedent), never
 * exported: a replayable outcome is roll-scoped recovery evidence, not a
 * public record, and the oldest entries fall off the bound.
 */
import { RPC_CATALOGUE } from "../../shared/rpc-catalogue";
import type { RequestOutcome } from "../../shared/request-outcome";
import { operationInputHash } from "../store/store";

export type { RequestOutcome };

/** The journal's meta key; Queue-internal, like `capacityChanges`, never exported. */
export const REQUEST_LEDGER_META_KEY = "requestLedger";
/** Entries kept; a recovery only ever asks about requests younger than the last roll. */
export const REQUEST_LEDGER_LIMIT = 48;
/** A recorded result larger than this is recorded as applied-without-replayable-result. */
export const REQUEST_LEDGER_RESULT_LIMIT_BYTES = 16 * 1024;
/** A recorded refusal message is bounded the way the wire bounds error frames. */
export const REQUEST_LEDGER_REFUSAL_LIMIT_CHARS = 2_000;

const MUTATING_METHODS = new Set(RPC_CATALOGUE.filter(entry => entry.mutating).map(entry => entry.name));

export type RequestLedgerState = "received" | "applied" | "refused";

export interface RequestLedgerEntry {
  key: string;
  method: string;
  /** Digest of the exact request input; a key reuse with other input refuses. */
  inputHash: string;
  at: string;
  state: RequestLedgerState;
  /** The settled result, when applied and small enough to replay. */
  result?: unknown;
  /** Set when the result was real but too large to carry across the roll. */
  truncated?: true;
  /** The typed error the service settled with, when refused. */
  error?: { code: string; message: string };
}

export class RequestKeyConflictError extends Error {
  /** `refused` for a key reused with a different request; `busy` for one still being served. */
  constructor(readonly code: "refused" | "busy", message: string) { super(message); this.name = "RequestKeyConflictError"; }
}

export class RequestLedger {
  private readonly clock: () => string;

  constructor(private readonly store: { getMeta<T>(key: string): T | undefined; setMeta(key: string, value: unknown): void; transaction<T>(fn: () => T): T }, options: { clock?: () => string } = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  /** Whether this method's requests are recorded at all: mutating catalogue calls only. */
  watches(method: string): boolean {
    return MUTATING_METHODS.has(method);
  }

  /**
   * Record one keyed request as received, before its handler runs. A key that
   * already carries a settled outcome replays that outcome instead of running
   * the handler again — the exactly-once property the recovery relies on. The
   * same key with a different method or input refuses, like a durable
   * operation's key.
   */
  open(key: string, method: string, input: unknown): { replay: RequestOutcome } | { fresh: true } {
    const inputHash = operationInputHash(input);
    return this.store.transaction(() => {
      const entries = this.read();
      const prior = entries.find(entry => entry.key === key);
      if (prior) {
        if (prior.method !== method || prior.inputHash !== inputHash) {
          throw new RequestKeyConflictError("refused", `Request key ${key} was already used for ${prior.method} with a different input; a key names one exact request`);
        }
        if (prior.state === "received") {
          throw new RequestKeyConflictError("busy", `Request key ${key} is still being served; its outcome is not recorded yet`);
        }
        return { replay: this.outcomeOf(prior) };
      }
      entries.push({ key, method, inputHash, at: this.clock(), state: "received" });
      this.write(entries);
      return { fresh: true };
    });
  }

  /** Record the applied outcome; the response frame is only written after this. */
  settle(key: string, result: unknown): void {
    this.recordOutcome(key, entry => {
      const bytes = Buffer.byteLength(JSON.stringify(result ?? null));
      if (bytes > REQUEST_LEDGER_RESULT_LIMIT_BYTES) return { ...entry, state: "applied", truncated: true };
      return { ...entry, state: "applied", result };
    });
  }

  /** Record the refused outcome: the definite typed answer the service settled with. */
  settleRefused(key: string, code: string, message: string): void {
    this.recordOutcome(key, entry => ({
      ...entry, state: "refused",
      error: { code, message: message.slice(0, REQUEST_LEDGER_REFUSAL_LIMIT_CHARS) },
    }));
  }

  /** What happened to this request, for the replacement answering a recovery ask. */
  outcome(key: string): RequestOutcome {
    const prior = this.read().find(entry => entry.key === key);
    return prior ? this.outcomeOf(prior) : { status: "not_received" };
  }

  private recordOutcome(key: string, apply: (entry: RequestLedgerEntry) => RequestLedgerEntry): void {
    this.store.transaction(() => {
      const entries = this.read();
      const index = entries.findIndex(entry => entry.key === key);
      if (index < 0) return; // Pruned between open and settle; the outcome rides on the response instead.
      entries[index] = apply(entries[index]);
      this.write(entries);
    });
  }

  private outcomeOf(entry: RequestLedgerEntry): RequestOutcome {
    if (entry.state === "applied") return entry.truncated ? { status: "applied", truncated: true } : { status: "applied", result: entry.result };
    if (entry.state === "refused") {
      const error = entry.error ?? { code: "internal", message: "The recorded outcome carries no error detail" };
      return { status: "refused", code: error.code, message: error.message };
    }
    return { status: "pending" };
  }

  /** The journal, oldest first. A damaged entry is dropped, never fatal. */
  private read(): RequestLedgerEntry[] {
    const raw = this.store.getMeta<unknown>(REQUEST_LEDGER_META_KEY);
    if (!Array.isArray(raw)) return [];
    const entries: RequestLedgerEntry[] = [];
    for (const candidate of raw) {
      if (!candidate || typeof candidate !== "object") continue;
      const entry = candidate as Partial<RequestLedgerEntry>;
      if (typeof entry.key !== "string" || typeof entry.method !== "string" || typeof entry.inputHash !== "string"
        || typeof entry.at !== "string" || (entry.state !== "received" && entry.state !== "applied" && entry.state !== "refused")) continue;
      entries.push(entry as RequestLedgerEntry);
    }
    return entries.slice(-REQUEST_LEDGER_LIMIT);
  }

  private write(entries: RequestLedgerEntry[]): void {
    this.store.setMeta(REQUEST_LEDGER_META_KEY, entries.slice(-REQUEST_LEDGER_LIMIT));
  }
}
