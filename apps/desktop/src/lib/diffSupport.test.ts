import { describe, expect, test } from "bun:test";
import { filterChangedFiles, latestReviewableDiff, unifiedDiffLineKind } from "./diffSupport";
import type { ControlTaskWorkflowWorkItemDto } from "./control/taskWorkflow";

function work(workItemRef: string, diffs: string[]): ControlTaskWorkflowWorkItemDto {
  return {
    work_item_ref: workItemRef,
    runtime_status: "completed",
    review_status: "ready",
    source_ref: "source:1",
    source_count: 1,
    session_ref: null,
    turn_refs: [],
    receipt_refs: [],
    checkpoint_refs: [],
    diff_summary_refs: diffs,
    timeline_entry_refs: [],
    validation_refs: [],
    artifact_refs: [],
    issue_refs: [],
  };
}

describe("diff support", () => {
  test("selects the latest diff admitted by the review evidence", () => {
    const result = latestReviewableDiff(
      [work("work:1", ["diff:old"]), work("work:2", ["diff:first", "diff:latest"])],
      ["work:1", "work:2"],
      ["diff:old", "diff:latest"],
    );
    expect(result).toEqual({ workItemId: "work:2", diffId: "diff:latest" });
  });

  test("does not infer a diff outside exact review evidence", () => {
    expect(latestReviewableDiff([work("work:1", ["diff:1"])], ["work:1"], [])).toBeNull();
  });

  test("classifies unified patch lines without altering their content", () => {
    expect(unifiedDiffLineKind("@@ -1 +1 @@")).toBe("hunk");
    expect(unifiedDiffLineKind("+++ b/file.ts")).toBe("header");
    expect(unifiedDiffLineKind("+added")).toBe("added");
    expect(unifiedDiffLineKind("-deleted")).toBe("deleted");
    expect(unifiedDiffLineKind(" context")).toBe("context");
  });

  test("filters changed files case-insensitively", () => {
    const files = [{ display_path: "src/App.svelte" }, { display_path: "README.md" }];
    expect(filterChangedFiles(files, " app ")).toEqual([{ display_path: "src/App.svelte" }]);
  });
});
