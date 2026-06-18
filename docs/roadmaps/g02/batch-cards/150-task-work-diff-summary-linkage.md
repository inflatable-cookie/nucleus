# 150 Task Work Diff Summary Linkage

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../034-task-work-checkpoint-and-review-loop.md`

## Purpose

Attach diff summary refs to task work review state.

## Scope

- Link existing diff summary records to work-unit review.
- Preserve confidence and evidence refs.
- Do not compute real repository diffs.

## Acceptance Criteria

- [x] Review state can show diff summary refs.
- [x] Missing diff summaries are explicit.
- [x] No working copy mutation occurs.

## Result

Review decisions now accept diff summary refs as evidence and merge them into
work-item review state.

## Validation

- `cargo test -p nucleus-engine diff`
- `cargo test -p nucleus-server checkpoint_diff`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if real SCM diff execution is required.
