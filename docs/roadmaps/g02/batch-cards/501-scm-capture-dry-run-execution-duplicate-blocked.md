# 501 SCM Capture Dry Run Execution Duplicate Blocked

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../107-scm-capture-dry-run-execution-persistence.md`

## Purpose

Keep duplicate and blocked SCM capture dry-run execution persistence states
explicit.

## Scope

- Treat duplicate receipt ids as no-ops.
- Preserve blocked, failed, timed-out, and repair-required outcomes.
- Block raw output and non-dry-run effect requests.

## Acceptance Criteria

- [x] Duplicate writes do not overwrite records.
- [x] Terminal non-success outcomes persist as evidence.
- [x] Raw output inputs do not persist as successful records.
- [x] Capture, publish, and forge authority remain blocked.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_execution_duplicate_blocked -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
