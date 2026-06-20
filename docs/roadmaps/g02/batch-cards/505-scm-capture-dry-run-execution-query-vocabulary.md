# 505 SCM Capture Dry Run Execution Query Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../108-scm-capture-dry-run-execution-control.md`

## Purpose

Add request/response envelope vocabulary for SCM capture dry-run execution
diagnostics.

## Scope

- Add diagnostics query enum mapping.
- Add response DTO mapping.
- Preserve stable snake-case domain naming.

## Acceptance Criteria

- [x] Request envelope round-trips the execution diagnostics domain.
- [x] Response envelope serializes the execution diagnostics domain.
- [x] Existing diagnostics domains remain unchanged.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_execution_query_vocabulary -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
