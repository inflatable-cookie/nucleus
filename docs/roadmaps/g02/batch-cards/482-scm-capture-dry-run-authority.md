# 482 SCM Capture Dry Run Authority

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../103-scm-capture-driver-dry-run-planning.md`

## Purpose

Prove dry-run planning records cannot execute SCM, forge, provider, callback,
interruption, recovery, or raw-material effects.

## Scope

- Exercise candidates, capability mappings, and diagnostics.
- Assert effect flags remain false.

## Acceptance Criteria

- [x] No SCM capture/dry-run/publish executes.
- [x] No forge review-request/merge executes.
- [x] No provider/callback/recovery effect executes.
- [x] Raw material remains blocked.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_authority -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
