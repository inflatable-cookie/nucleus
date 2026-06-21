# 104 Convergence Local Snap Spawn Request Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../030-convergence-local-snap-spawn-request-boundary.md`

## Purpose

Expose read-only diagnostics for stopped local snap spawn-request records.

## Acceptance Criteria

- [x] Diagnostics count ready, blocked, duplicate, and unsupported states.
- [x] Diagnostics expose no raw command output.
- [x] Diagnostics carry no process, backend, provider, or task mutation
  authority.
- [x] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_spawn_request_diagnostics -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
