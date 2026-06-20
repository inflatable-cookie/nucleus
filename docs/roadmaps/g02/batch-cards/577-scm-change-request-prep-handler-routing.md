# 577 SCM Change Request Prep Handler Routing

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../122-scm-capture-change-request-preparation-control.md`

## Purpose

Route persisted change-request preparation diagnostics through request-handler
queries.

## Scope

- Read persisted preparation records from local state.
- Return sanitized preparation diagnostics.
- Do not create preparation records while querying diagnostics.

## Acceptance Criteria

- [x] Handler routing reads persisted preparation records.
- [x] Handler routing reports empty diagnostics when no preparation records
  exist.
- [x] Handler routing does not create preparation records.
- [x] Handler routing does not execute SCM or forge effects.

## Validation

- `cargo test -p nucleus-server scm_change_request_prep_handler_routing -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
