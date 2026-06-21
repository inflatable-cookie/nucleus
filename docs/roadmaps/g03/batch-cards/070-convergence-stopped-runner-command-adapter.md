# 070 Convergence Stopped Runner Command Adapter

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../019-convergence-stopped-runner-command-adapter.md`

## Purpose

Define stopped command-adapter records from persisted Convergence runner
evidence.

## Acceptance Criteria

- [x] Reviewable persisted evidence can produce stopped adapter records.
- [x] Blocked and duplicate evidence persistence is skipped.
- [x] Idempotency and provider-stage refs are preserved.
- [x] No execution effect is added.

## Validation

- `cargo test -p nucleus-server convergence_stopped_runner_command_adapter -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
