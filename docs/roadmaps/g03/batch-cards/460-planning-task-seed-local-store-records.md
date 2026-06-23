# 460 Planning Task Seed Local Store Records

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../112-planning-task-seed-persistence-and-projection.md`

## Purpose

Persist and decode planning task seed candidate records.

## Work

- [x] Add focused storage record conversion helpers.
- [x] Store only sanitized planning/task seed fields.
- [x] Add deterministic encode/decode tests.

## Acceptance Criteria

- [x] Stored records round-trip without raw conversation payloads.
- [x] Project ids and source artifact refs survive round-trip.
- [x] Promotion state is data only, not an action.

## Result

- Added `crates/nucleus-engine/src/planning_task_seed/storage_codec.rs`.
- Added deterministic codec tests in
  `crates/nucleus-engine/src/planning_task_seed/storage_codec/tests.rs`.
- Added SQLite Planning table support.
- Added SQLite kind mapping for planning session, planning artifact, and task
  seed records.

## Validation

- `cargo test -p nucleus-engine planning_task_seed`
- `cargo test -p nucleus-local-store sqlite_first_slice_domain_records_survive_reopen`
- `cargo test -p nucleus-local-store sqlite_single_database_recovers_all_first_domains`
- `cargo check -p nucleus-engine`
- `cargo check -p nucleus-local-store`
