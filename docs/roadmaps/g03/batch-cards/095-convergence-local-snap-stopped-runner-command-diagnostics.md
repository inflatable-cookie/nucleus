# 095 Convergence Local Snap Stopped Runner Command Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../027-convergence-local-snap-stopped-runner-command-adapter.md`

## Purpose

Expose read-only diagnostics for stopped local snap command-adapter records.

## Acceptance Criteria

- [x] Diagnostics count runnable, blocked, duplicate, and unsupported records.
- [x] Diagnostics expose no raw command output.
- [x] Diagnostics carry no mutation or backend authority.
- [x] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_stopped_runner_command_diagnostics -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
