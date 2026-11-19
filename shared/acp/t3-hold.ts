/** T3 displays re-entry prompts, so reserve a readable sentence for its held turns. */
export const T3_HOLD_TEXT = "Nucleus keeps this task thread open for its next role.";
const LEGACY_T3_HOLD_PATTERN = "nucleus-hold-the-task-thread";

/** Older T3 bindings reserve the legacy marker; also reserve the new exact sentence. */
export const isLegacyT3Hold = (pattern: string | undefined, text: string): boolean =>
  pattern === LEGACY_T3_HOLD_PATTERN && text === T3_HOLD_TEXT;
