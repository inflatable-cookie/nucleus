/**
 * The owner's `move` verb, one module per mechanism: the controls class the
 * engine composes (`controls.ts`), the review move with its displacement, reader
 * and settlement (`review*.ts`), the work, merge and closeout routes, and the
 * external-merge reconciliation (`external-merge.ts`). This barrel is the public
 * surface; every import from outside the folder goes through it.
 */
export { MoveControls } from "./controls";
export { ExternalMergeRefusal } from "./external-merge";
export { retainedReaderDecision } from "./review-reader";
