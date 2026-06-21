# 110 Convergence Local Snap Spawn Receipt Diagnostics

Status: planned
Owner: Tom
Updated: 2026-06-21
Milestone: `../032-convergence-local-snap-spawn-receipt-boundary.md`

## Purpose

Expose read-only diagnostics for stopped local snap spawn receipt records.

## Acceptance Criteria

- [ ] Diagnostics count accepted, blocked, duplicate, unsupported, failed, and
  cleanup-required states.
- [ ] Diagnostics expose no raw command output.
- [ ] Diagnostics carry no process, backend, provider, or task mutation
  authority.
- [ ] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_spawn_receipt_diagnostics -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
