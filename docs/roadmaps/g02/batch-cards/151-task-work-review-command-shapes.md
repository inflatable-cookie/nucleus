# 151 Task Work Review Command Shapes

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../034-task-work-checkpoint-and-review-loop.md`

## Purpose

Add command shapes for accepting, rejecting, or requesting rework on task
work units.

## Scope

- Add review command vocabulary.
- Require expected work-unit state or revision.
- Keep task completion separate from work acceptance.

## Acceptance Criteria

- Review commands are typed.
- Invalid state transitions fail closed.
- Accepting work does not silently complete unrelated task state.

## Validation

- `cargo test -p nucleus-server task_agent`
- `cargo test -p nucleus-engine task_agent`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if review commands need final UI decisions.
