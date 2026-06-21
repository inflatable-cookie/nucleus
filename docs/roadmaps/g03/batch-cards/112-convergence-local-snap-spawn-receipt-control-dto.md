# 112 Convergence Local Snap Spawn Receipt Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../033-convergence-local-snap-spawn-receipt-control.md`

## Purpose

Build read-only control DTOs over sanitized local snap spawn receipt records.

## Acceptance Criteria

- [x] DTOs count accepted, blocked, duplicate, unsupported, failed, and
  cleanup-required receipts.
- [x] DTOs preserve receipt and upstream refs needed for inspection.
- [x] DTOs expose no raw stdout/stderr or process material.
- [x] No process runner, provider, or task mutation authority is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_spawn_receipt_control -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
