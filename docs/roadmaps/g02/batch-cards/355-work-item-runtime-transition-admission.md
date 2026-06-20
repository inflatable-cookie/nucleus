# 355 Work Item Runtime Transition Admission

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../078-task-transition-admission-from-live-observations.md`

## Purpose

Gate task work-item runtime transitions derived from live observations.

## Scope

- Enforce `023` transition rules.
- Require expected current state/revision where available.
- Block task completion, review acceptance, and SCM mutation.

## Acceptance Criteria

- [x] Valid runtime transitions are admitted.
- [x] Invalid transitions fail closed.
- [x] Provider completion does not imply task completion.
- [x] Review acceptance remains separate.

## Validation

- `cargo test -p nucleus-server work_item_runtime_transition_admission -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
