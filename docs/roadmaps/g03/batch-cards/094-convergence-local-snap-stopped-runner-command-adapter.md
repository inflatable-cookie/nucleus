# 094 Convergence Local Snap Stopped Runner Command Adapter

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../027-convergence-local-snap-stopped-runner-command-adapter.md`

## Purpose

Define stopped local snap command-adapter records from persisted local snap
runner evidence.

## Acceptance Criteria

- [x] Reviewable persisted evidence can produce stopped adapter records.
- [x] Blocked and duplicate evidence persistence is skipped.
- [x] Idempotency and authority refs are preserved.
- [x] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_stopped_runner_command_adapter -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
