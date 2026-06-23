# 464 Planning Task Seed Persistence Validation

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../112-planning-task-seed-persistence-and-projection.md`

## Purpose

Validate the persisted planning task seed inspection slice.

## Work

- [x] Run focused engine, server, and `nucleusd` tests.
- [x] Run focused crate checks.
- [x] Run Effigy smoke.
- [x] Run docs QA, Northstar QA, diff check, and doctor.

## Acceptance Criteria

- [x] Tests pass.
- [x] Effigy smoke passes with non-empty candidates.
- [x] Doctor has zero errors.

## Result

- Focused engine, local-store, server, and `nucleusd` tests passed.
- Effigy planning task seed query reports one reviewable candidate.
- Doctor reports zero errors.

## Validation

- `cargo test -p nucleus-engine planning_task_seed`
- `cargo test -p nucleus-local-store sqlite_first_slice_domain_records_survive_reopen`
- `cargo test -p nucleus-local-store sqlite_single_database_recovers_all_first_domains`
- `cargo test -p nucleus-server planning_seed`
- `cargo test -p nucleus-server planning_task_seed`
- `cargo test -p nucleusd cli_config_parses_bootstrap_status_and_state`
- `cargo check -p nucleus-engine`
- `cargo check -p nucleus-local-store`
- `cargo check -p nucleus-server`
- `cargo check -p nucleusd`
- `effigy server:query:planning-task-seeds`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
- `effigy doctor`
