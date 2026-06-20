# 451 Completion SCM Capture Admission Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../097-completion-scm-capture-admission.md`

## Purpose

Expose read-only diagnostics for completion SCM capture admissions.

## Scope

- Count accepted and blocked admissions.
- Count blocker categories.
- Keep raw material and SCM instructions hidden.

## Acceptance Criteria

- [x] Diagnostics summarize capture admission state.
- [x] Blockers are visible.
- [x] No raw provider material appears.
- [x] No SCM or forge authority is granted.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_admission_diagnostics -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
