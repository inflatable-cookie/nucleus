/**
 * A request key's recorded outcome (service-boundary contract, "Rolls: calls
 * wait out the replacement").
 *
 * This type lives in `shared/` so the bridge's roll recovery
 * (`shared/service/roll-recovery.ts`) can name it without importing the
 * request ledger (`core/runtime/request-ledger.ts`), which sits inside the store
 * graph the plugin bridge must never load (Contract 007). The ledger remains
 * the only writer and reader of these outcomes; this module carries the shape
 * both sides share.
 */

/** What the ledger can answer about one request key. */
export type RequestOutcome =
  | { status: "applied"; result?: unknown; truncated?: true }
  | { status: "refused"; code: string; message: string }
  | { status: "pending" }
  | { status: "not_received" };
