/**
 * Reason text, refusal errors and small helpers the daemon's owners share.
 *
 * The module is a leaf: nothing here imports a daemon module by value except
 * `capacity`, which itself imports only `shared/`, so anything can import this
 * barrel without closing a cycle. Callers keep importing this path; the owners
 * behind it are split by mechanism:
 *
 * - `reasons.ts` — the text a task row records, and the named readers of it;
 * - `verdicts.ts` — review, merge and recovery verdicts at an exact head;
 * - `parks.ts` — whether a task is parked, and which owner may resume it;
 * - `participants.ts` — run roles, thread waits and participant identity;
 * - `phase-sets.ts` — the phase order and the phase sets the lifecycle branches on;
 * - `refusals.ts` — the refusal classes and the guidance a refused caller gets;
 * - `policy.ts` — the bounded windows, per-run keys and the repository QA argv.
 */
export * from './reasons';
export * from './verdicts';
export * from './parks';
export * from './participants';
export * from './phase-sets';
export * from './refusals';
export * from './policy';
