# 038 Forge Pull-Request Execution Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../008-forge-pull-request-execution-admission.md`

## Purpose

Summarize PR execution admission and preflight state without granting forge
authority.

## Acceptance Criteria

- [x] Diagnostics count admission and preflight states.
- [x] Diagnostics count blockers.
- [x] Diagnostics expose no raw output.
- [x] Diagnostics grant no pull-request, forge, provider, callback,
  interruption, recovery, task mutation, or raw-output authority.

## Validation

- [x] `cargo test -p nucleus-server forge_pull_request_execution_diagnostics -- --nocapture`
- [x] `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- [x] `git diff --check`
