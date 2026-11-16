/**
 * The workspace policy for a task that outlives its first run, split by owner:
 *
 * - `host.ts` — the retained and closeout workspace policy over a host: the
 *   process proof, the continuation preflight, and the closeout registration's
 *   identity, lookup and exact-head proof.
 * - `accepted-pr.ts` — the reconciliation of a parked accepted PR's workspace:
 *   confirm the retained workspace, or recover a replacement checkout.
 *
 * Every existing import path is unchanged: this barrel is the folder's public
 * surface.
 */
export * from "./host";
export * from "./accepted-pr";
