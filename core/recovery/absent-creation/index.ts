/**
 * Proven-absent creation: one module group for everything Nucleus does when a
 * creation it started cannot be proved to exist.
 *
 * - `decisions.ts` — the pure step decisions (workspace replay, absent-worker step);
 * - `budget.ts` — the durable one-replacement-per-role budget and its record shape;
 * - `creation.ts` — the engine-side recovery of a workspace or worker creation intent;
 * - `restarts.ts` — the resolution-side run and worker restarts under the same identity.
 *
 * The two halves stay apart on purpose: each is wired by the owner that holds
 * its dependency direction (the engine for a creation intent, the resolution for
 * a run that belongs to one). The rules they share live in `decisions.ts` and
 * `budget.ts`, so neither restates one.
 */
export { CreationRecovery } from './creation';
export { AbsentRestarts } from './restarts';
export { absentReplacementRecord, absentReplacementRole, absentReplacementSpent } from './budget';
export { absentWorkerStep, workspaceReplayAllowed } from './decisions';
