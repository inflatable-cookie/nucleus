/**
 * Store meta keys for Queue-internal, per-run host-run facts (Spec 035).
 *
 * They live beside the pinned contract 010 row, never in it. A tiny module of
 * its own keeps the store and the modules that write these facts from importing
 * each other, and keeps one spelling of each key. No older Queue scan matches
 * either prefix.
 */
export const HOST_RUN_IDENTITY_META_PREFIX = "hostRunIdentity:";
export const hostRunIdentityMetaKey = (runId: string) => `${HOST_RUN_IDENTITY_META_PREFIX}${runId}`;

/**
 * One reservation's accounting retirement: the operator's exact-run disposition
 * or the automatic producer-cleanup retirement (Spec 035).
 */
export const HOST_RUN_ACCOUNTING_DISPOSITION_META_PREFIX = "hostRunAccountingDisposition:";
export const hostRunAccountingDispositionMetaKey = (runId: string) => `${HOST_RUN_ACCOUNTING_DISPOSITION_META_PREFIX}${runId}`;
