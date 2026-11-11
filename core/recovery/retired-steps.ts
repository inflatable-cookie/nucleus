/**
 * Declared steps are retired (Spec 043). Intake refuses a brief that declares
 * `queue.stages`; historical declarations stay readable history. No unfinished
 * staged task remains (2026-10-16), so nothing parks on one at runtime.
 */
export const STEPS_RETIRED_REASON = 'Declared steps are retired; submit a plain completion brief without queue.stages.';
