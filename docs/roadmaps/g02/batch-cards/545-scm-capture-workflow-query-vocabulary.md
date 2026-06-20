# 545 SCM Capture Workflow Query Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../116-scm-capture-workflow-control-integration.md`

## Purpose

Add SCM capture workflow diagnostics to the control query vocabulary.

## Scope

- Extend diagnostics query enum.
- Extend diagnostics response enum and all-snapshot shape.
- Add DTO round-trip tests.

## Acceptance Criteria

- [x] Query vocabulary includes SCM capture workflow.
- [x] Response vocabulary includes the diagnostics DTO.
- [x] All-snapshot includes the diagnostics DTO.
- [x] Existing diagnostics domains keep working.

## Validation

- `cargo test -p nucleus-server scm_capture_workflow_query_vocabulary -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
