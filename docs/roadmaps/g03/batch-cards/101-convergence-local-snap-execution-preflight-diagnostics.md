# 101 Convergence Local Snap Execution Preflight Diagnostics

Status: planned
Owner: Tom
Updated: 2026-06-21
Milestone: `../029-convergence-local-snap-execution-preflight.md`

## Purpose

Expose read-only diagnostics for local snap execution preflight records.

## Acceptance Criteria

- [ ] Diagnostics count ready, blocked, duplicate, and unsupported states.
- [ ] Diagnostics expose no raw command output.
- [ ] Diagnostics carry no process, backend, provider, or task mutation
  authority.
- [ ] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_execution_preflight_diagnostics -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
