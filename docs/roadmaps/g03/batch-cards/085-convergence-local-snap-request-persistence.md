# 085 Convergence Local Snap Request Persistence

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../024-convergence-local-snap-request-persistence.md`

## Purpose

Persist stopped Convergence local snap request records with duplicate-safe
idempotency handling.

## Acceptance Criteria

- [x] Stopped requests can persist.
- [x] Duplicate idempotency keys become no-op records.
- [x] Blocked requests remain inspectable.
- [x] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_request_persistence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
