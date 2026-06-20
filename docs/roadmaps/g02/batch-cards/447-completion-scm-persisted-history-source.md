# 447 Completion SCM Persisted History Source

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../096-live-evidence-task-state-history-persistence.md`

## Purpose

Feed persisted task-state history into completion SCM readiness diagnostics.

## Scope

- Request handler reads persisted task-state control records.
- Completion SCM read model receives rebuilt history.
- Missing state remains repair-required when no records exist.

## Acceptance Criteria

- [x] Handler returns real candidates when persisted task-state history exists.
- [x] Handler returns missing-state repair diagnostics when no source exists.
- [x] Control DTO remains sanitized.
- [x] No SCM or forge effects execute.

## Validation

- `cargo test -p nucleus-server completion_scm_persisted_history_source -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
