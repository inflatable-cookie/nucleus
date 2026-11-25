/** The recorded outcome of one retired TypeScript service request. */

/** What the ledger can answer about one request key. */
export type RequestOutcome =
  | { status: "applied"; result?: unknown; truncated?: true }
  | { status: "refused"; code: string; message: string }
  | { status: "pending" }
  | { status: "not_received" };
