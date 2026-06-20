# 440 Completion SCM Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../095-completion-scm-readiness-control-integration.md`

## Purpose

Add a sanitized control DTO for completion SCM readiness.

## Scope

- Expose candidate and readiness refs.
- Expose adapter and workflow labels.
- Expose diagnostic counts.
- Hide raw provider material and executable SCM instructions.

## Acceptance Criteria

- [x] DTO serializes readiness without raw material.
- [x] DTO includes candidate/readiness counts and statuses.
- [x] DTO keeps adapter metadata descriptive, not executable.
- [x] No SCM or forge authority is granted.

## Validation

- `cargo test -p nucleus-server completion_scm_control_dto -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
