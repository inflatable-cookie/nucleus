# 491 SCM Capture Dry Run Request Handler Routing

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../105-scm-capture-dry-run-control-integration.md`

## Purpose

Route SCM capture dry-run diagnostics queries from persisted dry-run planning
state.

## Scope

- Read persisted dry-run planning records from state.
- Rebuild diagnostics from persisted records.
- Return sanitized control DTOs.
- Preserve read-only missing-state behavior.

## Acceptance Criteria

- [x] Handler routing reads persisted dry-run planning records.
- [x] Empty state returns sanitized zero counts.
- [x] Routing grants no SCM, forge, provider, or task mutation authority.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_handler_routing -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
