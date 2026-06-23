# 456 Planning Task Seed Validation

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../111-planning-artifact-task-seed-promotion.md`

## Purpose

Validate the planning/task seed inspection slice.

## Work

- [x] Run focused Rust tests.
- [x] Run focused crate checks.
- [x] Run new Effigy smoke.
- [x] Run docs QA, Northstar QA, diff check, and doctor.

## Acceptance Criteria

- [x] Tests pass.
- [x] Effigy smoke passes.
- [x] Doctor has zero errors.

## Result

- Focused engine, server, and `nucleusd` tests passed.
- Focused crate checks passed.
- `effigy server:query:planning-task-seeds` passed and reported explicit
  no-effect flags.
- Doctor returned zero errors after splitting threshold-crossing files.

## Validation

- `cargo test -p nucleus-engine planning_task_seed`
- `cargo test -p nucleus-server planning_task_seeds`
- `cargo test -p nucleus-server task_timeline_authority_map`
- `cargo test -p nucleusd planning_task_seeds`
- `cargo test -p nucleusd query_domain`
- `cargo check -p nucleus-engine`
- `cargo check -p nucleus-server`
- `cargo check -p nucleusd`
- `effigy server:query:planning-task-seeds`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
- `effigy doctor`
