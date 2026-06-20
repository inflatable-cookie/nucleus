# 425 Live Evidence Task State History Projection

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../092-live-evidence-completion-task-state-transition.md`

## Purpose

Project accepted live evidence task-state transitions into task history.

## Scope

- Produce deterministic history/timeline refs.
- Preserve completion, review, operator, and evidence refs.
- Keep projection read-only and replay-safe.

## Acceptance Criteria

- [x] Accepted transition produces deterministic task-history entry.
- [x] Blocked transitions are skipped.
- [x] History entries retain refs, not raw provider material.
- [x] Projection grants no provider or SCM authority.

## Validation

- `cargo test -p nucleus-server live_evidence_task_state_history_projection -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
