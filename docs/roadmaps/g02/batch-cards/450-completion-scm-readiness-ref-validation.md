# 450 Completion SCM Readiness Ref Validation

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../097-completion-scm-capture-admission.md`

## Purpose

Validate capture admission requests against persisted completion SCM readiness.

## Scope

- Match readiness id, candidate id, task id, and operator ref.
- Block unsupported and repair-required readiness.
- Surface missing refs as blockers.

## Acceptance Criteria

- [x] Ready refs admit capture preparation.
- [x] Missing refs block admission.
- [x] Unsupported/repair states block admission.
- [x] Validation is read-only.

## Validation

- `cargo test -p nucleus-server completion_scm_readiness_ref_validation -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
