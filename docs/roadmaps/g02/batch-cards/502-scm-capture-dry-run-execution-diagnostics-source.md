# 502 SCM Capture Dry Run Execution Diagnostics Source

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../107-scm-capture-dry-run-execution-persistence.md`

## Purpose

Rebuild SCM capture dry-run execution diagnostics from persisted receipt
records.

## Scope

- Count accepted, completed, failed, timed-out, blocked, repair-required, and
  duplicate states.
- Keep diagnostics sanitized.
- Avoid live SCM, forge, or provider calls.

## Acceptance Criteria

- [ ] Diagnostics rebuild from persisted execution records.
- [ ] Terminal and blocked states remain visible.
- [ ] No raw output appears.
- [ ] Capture, publish, and forge authority remain blocked.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_execution_diagnostics_source -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
