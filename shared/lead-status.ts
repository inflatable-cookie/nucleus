import type { Lead, LeadDetail } from "./contracts";

export type LeadStatusFacts = Omit<LeadDetail, "actions">;

/**
 * What the check says about the version the operator is looking at. A new version
 * clears the check, so the history's last checked version is named as stale rather
 * than silently shown as this version's result.
 */
export type LeadCheckView =
  | { kind: "pending" }
  | { kind: "none" }
  | { kind: "current"; check: NonNullable<Lead["check"]> }
  | { kind: "stale"; version: number; check: NonNullable<Lead["check"]> };

export function leadCheckView(lead: LeadStatusFacts): LeadCheckView {
  if (lead.checkOperationId) return { kind: "pending" };
  if (lead.check) return { kind: "current", check: lead.check };
  const earlier = [...lead.versions]
    .filter(version => version.check && version.version < lead.version)
    .sort((a, b) => b.version - a.version)[0];
  return earlier ? { kind: "stale", version: earlier.version, check: earlier.check! } : { kind: "none" };
}

/** Approval binds to one version and its digest. An approval for another version is named stale, never implied. */
export type LeadApprovalView =
  | { kind: "none" }
  | { kind: "current"; approval: NonNullable<Lead["approval"]> }
  | { kind: "stale"; approval: NonNullable<Lead["approval"]> };

export function leadApprovalView(lead: LeadStatusFacts): LeadApprovalView {
  const approval = lead.approval;
  if (approval) {
    if (approval.version !== lead.version || (lead.digest !== undefined && approval.digest !== lead.digest)) return { kind: "stale", approval };
    return { kind: "current", approval };
  }
  // Writing a new version clears the approval on the record, so an ordinary edit would otherwise hide
  // that the earlier version was approved. The version history keeps it, and it names its version.
  const earlier = [...lead.versions]
    .filter(version => version.approval && version.version < lead.version)
    .sort((a, b) => b.version - a.version)[0];
  return earlier ? { kind: "stale", approval: earlier.approval! } : { kind: "none" };
}

