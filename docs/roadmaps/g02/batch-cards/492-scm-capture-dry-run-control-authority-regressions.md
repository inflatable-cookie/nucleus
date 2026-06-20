# 492 SCM Capture Dry Run Control Authority Regressions

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../105-scm-capture-dry-run-control-integration.md`

## Purpose

Prove SCM capture dry-run control diagnostics remain read-only.

## Scope

- Exercise DTO, envelope, and handler routing.
- Assert no SCM dry-run, capture, publish, forge, provider, callback,
  interruption, recovery, or raw-material effect executes.

## Acceptance Criteria

- [x] Control diagnostics grant no SCM dry-run authority.
- [x] Control diagnostics grant no SCM capture or publish authority.
- [x] Control diagnostics grant no forge or provider authority.
- [x] Raw material remains blocked.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_control_authority -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
