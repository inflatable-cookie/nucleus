import {
  HostCreateInFlightError,
  HostReadRefusalError,
  PassProofPendingError,
} from "../host/errors";
import {
  noTurnLive,
  type ObservedTurnState,
  type OwnedToolHoldResult,
  type TimelineEntry,
} from "../recovery/stall";
import {
  DeferredPassReadError,
  isQuantumDeadlineExceeded,
  isTerminalParticipant,
  type PassProcessRead,
  type PassTimelinePageRead,
} from "../scheduling/pass-snapshot";

export const PASS_PROOF_WAIT_LIMIT_MINUTES = 5;

/** A host adapter's null response means the requested evidence could not be read. */
export function requireCustodyEvidence<T>(value: T | null, label: string): T {
  if (value === null) throw new HostReadRefusalError(`${label} is unreadable`);
  return value;
}

export type CustodyProofRead =
  | { kind: "error"; error: unknown }
  | {
      kind: "timeline";
      page: Extract<PassTimelinePageRead, { state: "ok" }>;
      participant: ObservedTurnState | null;
      requiresInactivity: boolean;
    }
  | {
      kind: "processes";
      scan: PassProcessRead;
      participant?: ObservedTurnState | null;
      beforeScan?: (ObservedTurnState & { archived?: boolean }) | null;
      entries?: TimelineEntry[];
    };

/**
 * An unread or stale proof has no verdict. Check its freshness before using any
 * cached evidence to clear custody or record a hold (Spec 068 §6).
 */
export function custodyProofDeferral(
  read: CustodyProofRead,
): Extract<OwnedToolHoldResult, { kind: "deferred" }> | null {
  const defer = (reason: string) => ({ kind: "deferred" as const, reason });
  if (read.kind === "error") {
    const { error } = read;
    if (error instanceof PassProofPendingError) return defer(error.reason);
    if (
      (error instanceof HostReadRefusalError &&
        !(error instanceof HostCreateInFlightError)) ||
      error instanceof DeferredPassReadError ||
      isQuantumDeadlineExceeded(error)
    )
      return defer(error.message);
    return null;
  }
  const stamp = read.participant?.updatedAt;
  if (read.kind === "timeline") {
    const { page, participant } = read;
    if (!page.fromPassSnapshot) return null;
    const inactive =
      participant &&
      !participant.active &&
      !participant.permissions &&
      !participant.activeTurnId &&
      ["idle", "error", "closed", "gone"].includes(participant.status ?? "");
    if (
      !stamp ||
      stamp !== page.coveredObservation?.updatedAt ||
      (read.requiresInactivity && !inactive)
    )
      return defer(
        "cached tool timeline predates the participant's latest observation or lacks a positive activity stamp; waiting for the next host pass",
      );
    return null;
  }
  const { scan, beforeScan, entries } = read;
  if (scan.state === "unknown" && scan.deferred) return defer(scan.reason);
  if (!scan.fromPassSnapshot || scan.state !== "listed") return null;
  if (entries?.some((entry) => Date.parse(entry.timestamp) > scan.capturedAt))
    return defer(
      "the pass process snapshot predates observed tool activity; waiting for the next host pass",
    );
  if (stamp && Date.parse(stamp) > scan.capturedAt)
    return defer(
      "the pass process snapshot predates the participant's latest activity; waiting for the next host pass",
    );
  if (!noTurnLive(beforeScan) && !isTerminalParticipant(beforeScan))
    return defer(
      "the pass process snapshot was captured before the participant was proven inactive; waiting for the next host pass",
    );
  const retired = beforeScan?.status === "gone" || beforeScan?.archived === true;
  if (!retired && (!stamp || stamp !== beforeScan?.updatedAt))
    return defer(
      "the participant was active after the pass process snapshot or lacks a positive activity stamp; waiting for the next host pass",
    );
  return null;
}
