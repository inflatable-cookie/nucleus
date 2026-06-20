# 434 Completion SCM Promotion Candidates

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../094-completion-to-scm-change-request-readiness.md`

## Purpose

Create provider-neutral SCM promotion candidates from completed task-state
history entries.

## Scope

- Consume completed task-state history entries.
- Preserve task, work item, completion, operator, and evidence refs.
- Keep candidate records diagnostic and non-mutating.

## Acceptance Criteria

- [x] Completed history entries create promotion candidates.
- [x] Blocked/skipped history entries do not create candidates.
- [x] Candidate records retain refs only.
- [x] No SCM or forge authority is granted.

## Validation

- `cargo test -p nucleus-server completion_scm_promotion_candidates -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
