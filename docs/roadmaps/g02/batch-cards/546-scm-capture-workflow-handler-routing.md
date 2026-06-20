# 546 SCM Capture Workflow Handler Routing

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../116-scm-capture-workflow-control-integration.md`

## Purpose

Route SCM capture workflow diagnostics through the request handler.

## Scope

- Build replay-only workflow diagnostics from current state.
- Return sanitized control DTOs.
- Keep handler read-only.

## Acceptance Criteria

- [x] Handler routes SCM capture workflow diagnostics.
- [x] Missing state returns empty diagnostics.
- [x] Persisted Git dry-run execution records contribute to workflow state.
- [x] Handler grants no mutation or raw-output authority.

## Validation

- `cargo test -p nucleus-server scm_capture_workflow_handler_routing -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
