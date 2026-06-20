# 489 SCM Capture Dry Run Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../105-scm-capture-dry-run-control-integration.md`

## Purpose

Create sanitized control DTOs for SCM capture dry-run diagnostics.

## Scope

- Serialize counts and authority flags only.
- Keep raw material and executable SCM instructions out of the DTO.
- Mirror existing diagnostics DTO patterns.

## Acceptance Criteria

- [x] DTO serializes dry-run planning diagnostics.
- [x] DTO exposes no raw material.
- [x] DTO grants no SCM or forge authority.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_control_dto -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
