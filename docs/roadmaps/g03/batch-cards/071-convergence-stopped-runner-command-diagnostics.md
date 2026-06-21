# 071 Convergence Stopped Runner Command Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../019-convergence-stopped-runner-command-adapter.md`

## Purpose

Add read-only diagnostics for stopped Convergence runner command-adapter
records.

## Acceptance Criteria

- [x] Diagnostics count runnable, blocked, duplicate, and unsupported records.
- [x] Diagnostics expose no raw provider payloads.
- [x] Diagnostics carry no mutation authority.
- [x] No execution effect is added.

## Validation

- `cargo test -p nucleus-server convergence_stopped_runner_command_diagnostics -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
