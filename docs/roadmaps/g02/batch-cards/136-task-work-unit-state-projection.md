# 136 Task Work Unit State Projection

Status: completed
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

- [x] Work-unit state rebuilds from source records/events.
- [x] Projection is deterministic.
- [x] Projection does not run side effects.

## Result

Added deterministic task-agent work-unit projection from source records with
repair issues for missing refs and forbidden summary terms.

## Validation

- `cargo test -p nucleus-engine task_agent`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if projection needs side-effect replay.
