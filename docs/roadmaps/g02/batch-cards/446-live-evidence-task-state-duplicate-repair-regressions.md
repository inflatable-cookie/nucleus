# 446 Live Evidence Task State Duplicate Repair Regressions

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../096-live-evidence-task-state-history-persistence.md`

## Purpose

Prove duplicate and repair task-state records remain deterministic.

## Scope

- Duplicate control ids.
- Blocked admissions.
- Empty history entries.
- Missing evidence refs.

## Acceptance Criteria

- [x] Duplicate persistence is deterministic.
- [x] Blocked admissions remain visible as repair evidence.
- [x] Invalid records do not create SCM readiness candidates.
- [x] No task mutation authority is granted.

## Validation

- `cargo test -p nucleus-server live_evidence_task_state_duplicate_repair -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
