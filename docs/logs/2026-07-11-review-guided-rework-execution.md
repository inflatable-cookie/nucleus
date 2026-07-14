# Review Guided Rework Execution

Date: 2026-07-11
Lane: G04 review-guided rework execution
Cards: 159-161

## Outcome

- The existing `task_workflow` portal now exposes current durable review
  context during task inspection.
- A fresh task-scoped mandate after rejected or Needs changes review creates a
  distinct work item carrying the decision, prior work, and reviewed evidence
  refs.
- Provider instructions include the durable review note and opaque refs, but
  never transient patch content.
- Accepted or mismatched review context refuses the rework path. Review state
  alone never grants execution authority.
- Operator smoke confirmed note discovery, execution, receipt refresh, and a
  fresh independently reviewable Diff result.

## Evidence

- 2,143 full-suite tests pass; 10 skipped
- desktop production build passes
- Svelte check passes with zero errors or warnings
- docs QA, Rust formatting, and diff hygiene pass
- no new agent tool, permanent UI, task completion, or SCM mutation

## Next

Stop for operator selection between explicit accepted-review task completion,
Goal-wide rework policy, or another product workflow gap.
