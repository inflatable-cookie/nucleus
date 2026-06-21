# 146 SCM Capture Dry Run Persistence Helper Test Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../044-scm-capture-dry-run-persistence-split.md`

## Purpose

Move SCM capture dry-run persistence codec/helper/test code into focused
modules if needed after the type/support split.

## Acceptance Criteria

- [x] Helper/test code is split only where it reduces real pressure.
- [x] Persistence behavior remains unchanged.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI, or task behavior is added.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_persistence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
