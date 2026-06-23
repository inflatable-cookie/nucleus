# 454 Planning Task Seed Record Implementation

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../111-planning-artifact-task-seed-promotion.md`

## Purpose

Implement the selected planning artifact/task seed record slice.

## Work

- [x] Add focused Rust modules for record types and projection helpers.
- [x] Keep module front doors small.
- [x] Add deterministic tests for draft, reviewable, blocked, and promoted
  readiness states.

## Acceptance Criteria

- [x] Task seed records do not create active tasks.
- [x] Tests cover no-effect behavior.
- [x] No broad `lib.rs` or god-file growth is introduced.

## Result

- Added `crates/nucleus-engine/src/planning_task_seed.rs`.
- Added focused tests in `crates/nucleus-engine/src/planning_task_seed/tests.rs`.
- Kept task seeds as read-only planning candidates with explicit no-effect
  flags.
- Blockers are authoritative in readiness classification.

## Validation

- `cargo test -p nucleus-engine planning_task_seed`
- `cargo check -p nucleus-engine`
