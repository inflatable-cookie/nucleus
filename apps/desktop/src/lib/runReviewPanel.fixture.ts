import type { ControlOrchestrationRunReviewDto } from "./control/generated/ControlOrchestrationRunReviewDto";
import type { ControlOrchestrationRunReviewPatchDto } from "./control/generated/ControlOrchestrationRunReviewPatchDto";

export const deliveredRunReview: ControlOrchestrationRunReviewDto = {
  project_id: "project:one",
  run_id: "run:delivered-worker",
  state: "delivered",
  objective_scope: "Implement the run delivery review surface.",
  acceptance: ["review renders closeout + validation + diff"],
  stop_conditions: [],
  provider_instance: "codex:local-default",
  provider_model: "gpt-5.4-mini",
  orchestrator_designation: null,
  worktree_ref: "/tmp/repo-wt/delivered-worker",
  base_ref: "abc123def456",
  conversation_id: "conversation:run:run:delivered-worker",
  closeout: {
    summary: "Worker finished the review surface with passing validation.",
    evidence_refs: [
      "turn:turn:1",
      "validation:effigy-test-plan:passed",
      "changed-files:2",
      "delivery:commit-created:true",
      "delivery:push-executed:true",
    ],
    diff_ref: "worktree:delivered-worker",
  },
  transitions: [
    { command_id: "command:run:propose:1", from: null, to: "proposed", at: 1700000000n },
    { command_id: "command:run:dispatch:1", from: "proposed", to: "dispatched", at: 1700000010n },
    { command_id: "command:run:running:1", from: "dispatched", to: "running", at: 1700000020n },
    { command_id: "command:run:deliver:1", from: "running", to: "delivered", at: 1700000100n },
  ],
  created_at: 1700000000n,
  updated_at: 1700000100n,
  validation: {
    status: "passed",
    changed_files: 2n,
    commit_created: true,
    push_executed: true,
  },
  diff: {
    base_ref: "abc123def456",
    available: true,
    unreachable_reason: null,
    files: [
      { path: "src/lib/RunReviewPanel.svelte", change_kind: "added", additions: 180n, deletions: 0n },
      { path: "src/lib/control/runFleet.ts", change_kind: "modified", additions: 60n, deletions: 10n },
    ],
    truncated: false,
  },
};

export const rejectedRunReview: ControlOrchestrationRunReviewDto = {
  ...deliveredRunReview,
  run_id: "run:rejected-worker",
  state: "rejected",
  closeout: {
    ...deliveredRunReview.closeout!,
    summary: "Worker finished, but acceptance was not met.",
  },
  transitions: [
    ...deliveredRunReview.transitions,
    {
      command_id: "command:run:reject:1",
      from: "delivered",
      to: "rejected",
      at: 1700000200n,
    },
  ],
  updated_at: 1700000200n,
};

export const reviewPatchFixture: ControlOrchestrationRunReviewPatchDto = {
  run_id: "run:delivered-worker",
  file_ref: "src/lib/RunReviewPanel.svelte",
  available: true,
  unreachable_reason: null,
  patch: [
    "diff --git a/src/lib/RunReviewPanel.svelte b/src/lib/RunReviewPanel.svelte",
    "index 111..222 100644",
    "--- a/src/lib/RunReviewPanel.svelte",
    "+++ b/src/lib/RunReviewPanel.svelte",
    "@@ -1,3 +1,4 @@",
    " <script lang=\"ts\">",
    "+import { Button } from \"@inflatable-cookie/poodle-svelte\";",
    " </script>",
  ].join("\n"),
  additions: 1n,
  deletions: 0n,
  truncated: false,
};
