# Task Run Checkpoint Diff Integration

Date: 2026-07-10
Lane: G04 task-attributed diff review
Card: 155

## Outcome

- Desktop Agent Chat configures the snapshot backend from host-local Nucleus
  state rather than project or server-state paths.
- Goal execution persists a baseline snapshot checkpoint and work-item source
  linkage after scheduling/dispatch composition and before provider start.
- Completed turns persist target checkpoints and exact source diff summaries
  before their work items become awaiting review.
- Diff summaries now carry typed added, modified, deleted, and metadata-only
  path records, exact counts, coverage, truncation, and the concurrent-write
  attribution notice without patch bytes.
- Baseline refusal fails before runner invocation. Target/diff failure moves the
  work item to recovery required and stops the remaining Goal runway.

## Evidence

- the fake runner reads a persisted baseline checkpoint and execution ref before
  invoking its start callback
- a missing snapshot backend produces zero provider calls and one recovery path
- two serial tasks produce non-overlapping source windows
- pre-existing unchanged files stay out of diffs; added, modified, deleted, and
  binary metadata-only fixtures produce exact records
- completed source records hold two checkpoint refs plus one diff ref before
  awaiting review
- Rust workspace check and the full Effigy suite pass: 2,136 tests with 10
  skipped

## Next

Expose lineage-validated diff overview and bounded transient file patches
through dedicated Rust, Tauri, and TypeScript read boundaries.
