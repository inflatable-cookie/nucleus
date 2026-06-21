# 079 Convergence Local Snap Admission Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../022-convergence-local-snap-admission.md`

## Purpose

Define stopped local snap admission records from Convergence runner replay
records and authority inputs.

## Acceptance Criteria

- [x] Ready replay records can produce local snap admission records.
- [x] Missing authority, duplicate ids, blocked replay, and unsupported replay
  remain blocked or no-op.
- [x] Remote effect authority stays false.
- [x] No backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_admission -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
