# 455 Planning Task Seed Query Control CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../111-planning-artifact-task-seed-promotion.md`

## Purpose

Expose task seed inspection without task mutation.

## Work

- [x] Add server query composition.
- [x] Add serialized control DTOs.
- [x] Add `nucleusd query` output.
- [x] Add root Effigy selector.
- [x] Add unsupported-action rejection tests.

## Acceptance Criteria

- [x] Output is sanitized and stable.
- [x] Mutation flags are explicit false.
- [x] Promotion commands are not added in this card.

## Result

- Added `PlanningTaskSeedsQuery` and `ServerQueryResult::PlanningTaskSeeds`.
- Added a read-only local request-handler query that returns the projection
  shape without persistence coupling.
- Added serialized request/response DTOs with explicit no-effect flags.
- Added `nucleusd query planning-task-seeds --project <project-id>`.
- Added `effigy server:query:planning-task-seeds`.

## Validation

- `cargo test -p nucleus-server planning_task_seeds`
- `cargo test -p nucleus-server task_timeline_authority_map`
- `cargo test -p nucleusd planning_task_seeds`
- `cargo check -p nucleus-server`
- `cargo check -p nucleusd`
- `effigy server:query:planning-task-seeds`
