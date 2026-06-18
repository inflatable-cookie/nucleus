# 150 Task Work Diff Summary Linkage

Status: planned
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

- Review state can show diff summary refs.
- Missing diff summaries are explicit.
- No working copy mutation occurs.

## Validation

- `cargo test -p nucleus-engine diff`
- `cargo test -p nucleus-server checkpoint_diff`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if real SCM diff execution is required.
