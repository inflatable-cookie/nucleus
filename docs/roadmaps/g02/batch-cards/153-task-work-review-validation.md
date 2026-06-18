# 153 Task Work Review Validation

Status: planned
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

- Review loop cards are complete or rehomed.
- Work units can enter review and accepted/rework states.
- Next ready card points to desktop proof.

## Validation

- `cargo test -p nucleus-server checkpoint_diff`
- `cargo test -p nucleus-server task_agent`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if review loop requires real SCM mutation.
