# 504 SCM Capture Dry Run Execution Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../108-scm-capture-dry-run-execution-control.md`

## Purpose

Create sanitized control DTOs for SCM capture dry-run execution diagnostics.

## Scope

- Serialize counts and authority flags only.
- Keep raw SCM output and executable driver instructions out of the DTO.
- Mirror existing diagnostics DTO patterns.

## Acceptance Criteria

- [x] DTO serializes dry-run execution diagnostics.
- [x] DTO exposes no raw output.
- [x] DTO grants no capture, publish, or forge authority.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_execution_control_dto -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
