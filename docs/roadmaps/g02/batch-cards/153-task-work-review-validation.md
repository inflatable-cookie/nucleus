# 153 Task Work Review Validation

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../034-task-work-checkpoint-and-review-loop.md`

## Purpose

Validate checkpoint and review loop behavior.

## Scope

- Run focused task-agent, checkpoint, diff, and docs gates.
- Confirm no SCM mutation.
- Advance to desktop progress proof.

## Acceptance Criteria

- [x] Review loop cards are complete or rehomed.
- [x] Work units can enter review and accepted/rework states.
- [x] Next ready card points to desktop proof.

## Result

Checkpoint/diff review loop behavior is complete. The next ready card is
`154-task-work-progress-control-dtos.md`.

## Validation

- `cargo test -p nucleus-server checkpoint_diff`
- `cargo test -p nucleus-server task_agent`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if review loop requires real SCM mutation.
