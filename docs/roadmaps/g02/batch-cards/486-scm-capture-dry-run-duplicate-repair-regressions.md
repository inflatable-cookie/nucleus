# 486 SCM Capture Dry Run Duplicate Repair Regressions

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../104-scm-capture-dry-run-planning-persistence.md`

## Purpose

Keep duplicate, unsupported, repair-required, and blocked dry-run persistence
states explicit.

## Scope

- Treat duplicate persistence ids as no-ops.
- Preserve unsupported and repair-required plan records as evidence.
- Block raw material and external-effect requests.

## Acceptance Criteria

- [x] Duplicate writes do not overwrite records.
- [x] Unsupported and repair-required records persist as evidence.
- [x] Blocked inputs do not persist as successful dry-run records.
- [x] No SCM or forge authority is granted.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_duplicate_repair -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
