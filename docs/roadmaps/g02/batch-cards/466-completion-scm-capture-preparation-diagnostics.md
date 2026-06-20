# 466 Completion SCM Capture Preparation Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../100-completion-scm-capture-preparation-records.md`

## Purpose

Expose read-only diagnostics for capture-preparation records.

## Scope

- Count candidates, skipped admissions, supported/unsupported plans, and
  blockers.
- Keep diagnostics sanitized.

## Acceptance Criteria

- [x] Diagnostics summarize preparation state.
- [x] Skipped and unsupported states are visible.
- [x] No raw material appears.
- [x] No SCM or forge authority is granted.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_preparation_diagnostics -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
