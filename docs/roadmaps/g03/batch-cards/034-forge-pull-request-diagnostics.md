# 034 Forge Pull-Request Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../007-forge-pull-request-descriptor-dry-run.md`

## Purpose

Summarize pull-request descriptor and dry-run evidence state without granting
forge authority.

## Acceptance Criteria

- [x] Diagnostics count descriptor and evidence states.
- [x] Diagnostics count blockers.
- [x] Diagnostics expose no raw output.
- [x] Diagnostics grant no pull-request, forge, provider, callback,
  interruption, recovery, task mutation, or raw-output authority.

## Validation

- [x] `cargo test -p nucleus-server forge_pull_request_diagnostics -- --nocapture`
- [x] `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- [x] `git diff --check`
