# 541 SCM Capture Workflow Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../115-scm-capture-workflow-composition.md`

## Purpose

Summarize SCM capture workflow projections as read-only diagnostics.

## Scope

- Count workflows by stage state.
- Surface evidence refs and repair counts.
- Exclude raw Git output and raw provider material.

## Acceptance Criteria

- [x] Diagnostics summarize stage states.
- [x] Evidence refs remain inspectable.
- [x] Raw output is absent.
- [x] Diagnostics are read-only.

## Validation

- `cargo test -p nucleus-server scm_capture_workflow_diagnostics -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
