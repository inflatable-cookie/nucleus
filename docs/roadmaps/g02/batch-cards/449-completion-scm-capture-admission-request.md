# 449 Completion SCM Capture Admission Request

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../097-completion-scm-capture-admission.md`

## Purpose

Define the request and output records for completion SCM capture admission.

## Scope

- Request by readiness id, candidate id, task id, and operator ref.
- Preserve evidence refs.
- Do not execute capture or write SCM state.

## Acceptance Criteria

- [x] Request record names readiness and candidate refs.
- [x] Admission output can be accepted or blocked.
- [x] Core record avoids Git-only terms.
- [x] No SCM or forge authority is granted.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_admission_request -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
