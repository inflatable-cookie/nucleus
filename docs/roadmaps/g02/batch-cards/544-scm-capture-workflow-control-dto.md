# 544 SCM Capture Workflow Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../116-scm-capture-workflow-control-integration.md`

## Purpose

Add a sanitized control DTO for SCM capture workflow diagnostics.

## Scope

- Serialize workflow counts and stage-state counts.
- Include evidence counts and authority flags.
- Exclude raw Git output and raw provider material.

## Acceptance Criteria

- [x] DTO serializes workflow diagnostics.
- [x] DTO carries authority flags as false.
- [x] DTO exposes no raw output field.
- [x] DTO has focused serialization coverage.

## Validation

- `cargo test -p nucleus-server scm_capture_workflow_control_dto -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
