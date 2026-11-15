/** Shared settled-run custody rule for the scheduler and QA runs surface. */
export function settledHostRunHoldsCapacity(run: {
  capacityReleasedAt: string | null;
  containers: Array<{ removed: boolean | "unknown" }>;
  settlement?: { result?: { escapedDescendants: unknown[] } | null } | null;
  escapedDescendantsProvenDeadAt: string | null;
}): boolean {
  const holdsContainer = run.containers.some(container => container.removed !== true);
  const holdsEscapedDescendants = Boolean(run.settlement?.result?.escapedDescendants.length && !run.escapedDescendantsProvenDeadAt);
  return !run.capacityReleasedAt && (holdsContainer || holdsEscapedDescendants);
}
