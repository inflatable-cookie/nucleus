# 487 SCM Capture Dry Run Diagnostics Source

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../104-scm-capture-dry-run-planning-persistence.md`

## Purpose

Rebuild SCM capture dry-run planning diagnostics from persisted records.

## Scope

- Count persisted, unsupported, repair-required, duplicate, and blocked states.
- Keep diagnostics sanitized.
- Avoid live adapter, SCM, forge, or provider calls.

## Acceptance Criteria

- [x] Diagnostics rebuild from persisted dry-run planning records.
- [x] Skipped and blocked states remain visible.
- [x] No raw material appears.
- [x] No SCM or forge authority is granted.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_diagnostics_source -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
