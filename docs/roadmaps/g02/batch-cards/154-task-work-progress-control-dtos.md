# 154 Task Work Progress Control DTOs

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../035-desktop-task-agent-progress-proof.md`

## Purpose

Add control DTOs for task work-unit progress.

## Scope

- Add response DTOs for work-unit state, progress, waits, receipts, and review.
- Add query shape if needed.
- Keep DTOs read-only.

## Acceptance Criteria

- Clients can request task work progress.
- DTOs do not expose raw provider payloads.
- DTOs cannot mutate runtime state.

## Validation

- `cargo test -p nucleus-server control_envelope`
- `cargo test -p nucleus-server task_agent`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if DTOs need final UI layout choices.

## Result

- Added `list_task_work_progress` as a read-only runtime metadata query.
- Added task work progress response DTOs with mutation and provider execution
  authority fixed to `false`.
- Extended task-agent diagnostics records with session, receipt, checkpoint,
  diff, validation, artifact, and timeline refs.
