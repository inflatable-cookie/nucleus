# 459 Completion SCM Capture Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../099-completion-scm-capture-diagnostics-control-integration.md`

## Purpose

Add a sanitized control DTO for completion SCM capture-admission diagnostics.

## Scope

- Expose counts and authority flags only.
- Hide raw material and executable SCM instructions.

## Acceptance Criteria

- [x] DTO serializes diagnostics counts.
- [x] DTO exposes no raw material.
- [x] DTO grants no SCM/forge/provider authority.
- [x] Missing state remains empty.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_control_dto -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
