# 445 Live Evidence Task State Control State API

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../096-live-evidence-task-state-history-persistence.md`

## Purpose

Add state persistence and read helpers for task-state control records.

## Scope

- Persist records into an existing safe state domain.
- Read records back deterministically.
- Rebuild task-state history projection from persisted records.

## Acceptance Criteria

- [x] Persist helper stores sanitized task-state control records.
- [x] Read helper returns records in stable order.
- [x] History projection rebuilds from persisted records.
- [x] Storage helpers do not execute external effects.

## Validation

- `cargo test -p nucleus-server live_evidence_task_state_control_state_api -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
