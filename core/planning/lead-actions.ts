import { hasBriefFrontmatter, leadApprovalView, leadCheckView, type LeadStatusFacts } from "../../shared/lead-status";

function leadCheckReason(lead: LeadStatusFacts): string | undefined {
  if (lead.state !== "open") return `Only open leads can be checked; this lead is ${lead.state.toLowerCase()}`;
  if (!hasBriefFrontmatter(lead.body)) return "Lead has no brief to check";
  if (lead.checkOperationId) return "A check is already running";
}
function leadApproveReason(lead: LeadStatusFacts): string | undefined {
  const check = leadCheckView(lead), approval = leadApprovalView(lead);
  if (lead.state !== "open") return `Only open leads can be approved; this lead is ${lead.state.toLowerCase()}`;
  if (!hasBriefFrontmatter(lead.body)) return "Lead has no brief to approve";
  if (check.kind === "pending") return "A check is running; approve once it passes";
  if (check.kind === "none") return "Check the brief first";
  if (check.kind === "stale") return `The check is for version ${check.version}; check version ${lead.version} first`;
  if (!check.check.ok) return check.check.message || "The current version failed its check";
  if (approval.kind === "current") return "Approved";
}
function leadPromoteReason(lead: LeadStatusFacts, origin: string): string | undefined {
  const approval = leadApprovalView(lead);
  if (lead.state === "dropped") return "A dropped lead cannot be promoted";
  if (lead.targets.some(target => target.kind === "task" && target.repository === origin)) return `Already promoted to a task in ${origin}`;
  if (approval.kind === "stale") return `The approval is for version ${approval.approval.version}; approve version ${lead.version} first`;
  if (approval.kind === "none") return "Approve the checked version first";
}
function leadDropReason(lead: LeadStatusFacts): string | undefined {
  if (lead.papercut) return "Close a papercut from its own record";
  if (lead.state !== "open") return `Only open leads can be dropped; this lead is ${lead.state.toLowerCase()}`;
}
function leadParkReason(lead: LeadStatusFacts): string | undefined {
  if (lead.state !== "open") return `Only open leads can be parked; this lead is ${lead.state.toLowerCase()}`;
}
function leadUnparkReason(lead: LeadStatusFacts): string | undefined {
  if (!lead.parked) return "This lead is not parked";
}
function leadReopenReason(lead: LeadStatusFacts): string | undefined {
  if (lead.state !== "dropped") return "Only a dropped lead can be reopened";
  if (lead.papercut) return "A papercut is never reopened by this action";
}
function leadPromoteToReason(lead: LeadStatusFacts): string | undefined {
  if (lead.papercut) return "Papercuts promote to tasks";
  if (lead.state === "dropped") return "A dropped lead cannot be promoted";
}

/** Action hints for the version returned by lead.get; the mutation still rechecks current state. */
export function leadActions(lead: LeadStatusFacts) {
  return {
    check: leadCheckReason(lead) ?? null,
    approve: leadApproveReason(lead) ?? null,
    drop: leadDropReason(lead) ?? null,
    reopen: leadReopenReason(lead) ?? null,
    park: leadParkReason(lead) ?? null,
    unpark: leadUnparkReason(lead) ?? null,
    promoteTo: leadPromoteToReason(lead) ?? null,
    promote: lead.repositories.map(repo => ({ origin: repo.origin, reason: leadPromoteReason(lead, repo.origin) ?? null })),
  };
}
