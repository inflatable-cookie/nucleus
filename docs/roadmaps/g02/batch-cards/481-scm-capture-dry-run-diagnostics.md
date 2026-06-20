# 481 SCM Capture Dry Run Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../103-scm-capture-driver-dry-run-planning.md`

## Purpose

Expose read-only diagnostics for SCM capture dry-run planning.

## Scope

- Count candidates, skipped preparation records, supported plans, unsupported
  plans, and blockers.
- Keep diagnostics sanitized.

## Acceptance Criteria

- [x] Diagnostics summarize dry-run planning state.
- [x] Skipped and unsupported states are visible.
- [x] No raw material appears.
- [x] No SCM or forge authority is granted.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_diagnostics -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
