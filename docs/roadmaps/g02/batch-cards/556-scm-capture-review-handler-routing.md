# 556 SCM Capture Review Handler Routing

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../118-scm-capture-review-control-integration.md`

## Purpose

Route SCM capture review readiness diagnostics through request-handler queries
from persisted replay evidence.

## Scope

- Derive workflow projections from persisted Git dry-run execution records.
- Project review readiness records from workflow projections.
- Return sanitized review readiness diagnostics through the handler.

## Acceptance Criteria

- [x] Handler routing reads persisted Git dry-run execution evidence.
- [x] Handler routing derives workflow projections before review readiness.
- [x] Handler routing returns review readiness diagnostics.
- [x] Handler routing does not execute SCM, forge, provider, callback,
  interruption, or recovery effects.

## Validation

- `cargo test -p nucleus-server scm_capture_review_handler_routing -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
