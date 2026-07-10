import type { ControlTaskWorkflowWorkItemDto } from "./control/taskWorkflow";

export type UnifiedDiffLineKind = "header" | "hunk" | "added" | "deleted" | "context";

export function unifiedDiffLineKind(line: string): UnifiedDiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff ")) {
    return "header";
  }
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "deleted";
  return "context";
}

export function latestReviewableDiff(
  workItems: ControlTaskWorkflowWorkItemDto[],
  reviewWorkItemRefs: string[],
  reviewDiffRefs: string[],
): { workItemId: string; diffId: string } | null {
  const admittedWorkItems = new Set(reviewWorkItemRefs);
  const admittedDiffs = new Set(reviewDiffRefs);

  for (const workItem of [...workItems].reverse()) {
    if (!admittedWorkItems.has(workItem.work_item_ref)) continue;
    const diffId = [...workItem.diff_summary_refs].reverse().find((id) => admittedDiffs.has(id));
    if (diffId) return { workItemId: workItem.work_item_ref, diffId };
  }

  return null;
}

export function filterChangedFiles<T extends { display_path: string }>(
  files: T[],
  query: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle
    ? files.filter((file) => file.display_path.toLocaleLowerCase().includes(needle))
    : files;
}
