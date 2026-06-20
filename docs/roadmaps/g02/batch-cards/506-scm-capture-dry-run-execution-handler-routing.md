# 506 SCM Capture Dry Run Execution Handler Routing

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../108-scm-capture-dry-run-execution-control.md`

## Purpose

Route SCM capture dry-run execution diagnostics from persisted receipt state.

## Scope

- Read persisted execution receipts from state.
- Rebuild diagnostics from persisted records.
- Return sanitized control DTOs.
- Preserve read-only empty-state behavior.

## Acceptance Criteria

- [x] Handler routing reads persisted execution receipts.
- [x] Empty state returns sanitized zero counts.
- [x] Routing grants no SCM capture, forge, provider, or task mutation
  authority.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_execution_handler_routing -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
