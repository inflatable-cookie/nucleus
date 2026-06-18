# 136 Task Work Unit State Projection

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../031-task-agent-work-unit-source-model.md`

## Purpose

Project task work-unit source records into rebuildable state.

## Scope

- Add deterministic projection logic.
- Track last source cursor/ref.
- Keep projection read-only and rebuildable.

## Acceptance Criteria

- Work-unit state rebuilds from source records/events.
- Projection is deterministic.
- Projection does not run side effects.

## Validation

- `cargo test -p nucleus-engine task_agent`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if projection needs side-effect replay.
