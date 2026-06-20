# 454 Completion SCM Capture Admission Persistence Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../098-completion-scm-capture-admission-persistence.md`

## Purpose

Define sanitized persistence records for completion SCM capture admissions.

## Scope

- Persist admission id, readiness/candidate/task refs, operator, evidence refs,
  status, and blockers.
- Exclude raw provider material and executable SCM instructions.

## Acceptance Criteria

- [x] Persistence record carries refs and blockers.
- [x] Raw material is not retained.
- [x] SCM/forge/provider authority remains false.
- [x] Record is serializable.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_admission_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
