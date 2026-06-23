# 461 Planning Task Seed Query From Persistence

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../112-planning-task-seed-persistence-and-projection.md`

## Purpose

Compose the read-only planning task seed query from persisted records.

## Work

- [x] Load planning task seed records from local store.
- [x] Decode records into engine task seed candidates.
- [x] Preserve the explicit no-effect flags.

## Acceptance Criteria

- [x] Query filters by project id.
- [x] Query remains read-only.
- [x] Decode failures return controlled server errors.

## Result

- Added Planning domain access to the server state facade.
- Updated the planning task seed query to load Planning/TaskSeed records.
- Decode failures return controlled storage errors.
- Other planning record kinds are ignored by the task seed query.

## Validation

- `cargo test -p nucleus-server planning_task_seed`
- `cargo check -p nucleus-server`
