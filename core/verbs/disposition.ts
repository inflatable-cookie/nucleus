// Compatibility surface; implementation modules depend only on lower-level owners.
export type { DispositionRequest, DispositionDeps } from "./disposition/types";
export type { DispositionWorkspaceReopen } from "./disposition/requests";
export { dispositionInFlight } from "./disposition/state";
export { recordIntent, recordResult, progressDisposition, resumeDispositions } from "./disposition/effects";
export { parseLsRemote, listOriginRefs, postDispositionRefDiff } from "./disposition/refs";
export { reopenDispositionWorkspace, withdrawCancellation, fenceDisposition, requestDisposition, recordLateCallbackEvidence } from "./disposition/requests";
export { productionDeps } from "./disposition/production";
export { proveWorkspaceEmpty } from "./disposition/workspace";
export { Dispositions } from "./disposition/controls";
