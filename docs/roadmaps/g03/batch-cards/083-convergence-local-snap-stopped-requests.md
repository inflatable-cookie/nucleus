# 083 Convergence Local Snap Stopped Requests

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../023-convergence-local-snap-command-boundary.md`

## Purpose

Create stopped request records with stable idempotency keys from local snap
command descriptors.

## Acceptance Criteria

- [x] Ready descriptors can produce stopped request records.
- [x] Idempotency keys are stable.
- [x] Request records carry no argv execution authority.
- [x] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_stopped_requests -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
