# 462 Planning Task Seed Fixture Effigy Smoke

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../112-planning-task-seed-persistence-and-projection.md`

## Purpose

Prove non-empty planning task seed inspection with fixture-backed data.

## Work

- [x] Add a bootstrap or fixture path for one reviewable task seed.
- [x] Extend `nucleusd` output tests or focused smoke coverage.
- [x] Run `effigy server:query:planning-task-seeds` against non-empty data.

## Acceptance Criteria

- [x] Effigy output includes at least one candidate.
- [x] Output remains sanitized.
- [x] `task_creation_performed=false`.

## Result

- Added `seed_local_planning_task_seed`.
- `nucleusd --bootstrap` now seeds one reviewable planning task seed.
- `effigy server:query:planning-task-seeds` reports one candidate with
  no-effect flags.

## Validation

- `cargo test -p nucleus-server planning_seed`
- `cargo test -p nucleus-server planning_task_seed`
- `cargo test -p nucleusd cli_config_parses_bootstrap_status_and_state`
- `cargo check -p nucleus-server`
- `cargo check -p nucleusd`
- `effigy server:query:planning-task-seeds`
