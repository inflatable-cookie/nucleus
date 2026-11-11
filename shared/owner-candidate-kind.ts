import { wireLabel } from "./wire-labels";

/** Live-thread kinds the planner picker uses to leave task threads out. */
export const PROJECT_OWNER_CANDIDATE_KINDS = [
  "planner",
  "worker",
  "reviewer",
  "recovery",
  "closeout",
  "coordinator",
  "executor",
  "other",
] as const;
export type ProjectOwnerCandidateKind = (typeof PROJECT_OWNER_CANDIDATE_KINDS)[number];

/**
 * Classify a live host thread from its Nucleus/Northstar labels. A standing
 * thread with no task or role label is a planner candidate. Conflicting
 * dual-generation labels are `other`, never guessed.
 */
export function ownerCandidateKind(
  labels?: Record<string, string> | null,
): ProjectOwnerCandidateKind {
  try {
    const role = wireLabel(labels, "role");
    const task = wireLabel(labels, "task");
    const reviewer = wireLabel(labels, "reviewer");
    const decider = wireLabel(labels, "decider");
    if (role === "reviewer" || reviewer) return "reviewer";
    if (role === "recovery") return "recovery";
    if (role === "closeout") return "closeout";
    if (role === "coordinator") return "coordinator";
    if (role === "executor") return "executor";
    if (role === "worker" || task) return "worker";
    if (decider) return "other";
    return "planner";
  } catch {
    return "other";
  }
}
