# 566 SCM Capture Review Decision Handler Routing

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../120-scm-capture-review-decision-control-integration.md`

## Purpose

Route persisted SCM capture review-decision diagnostics through request-handler
queries.

## Scope

- Read persisted review decision records from local state.
- Return sanitized review-decision diagnostics.
- Avoid deriving decisions from readiness unless a decision was explicitly
  persisted.

## Acceptance Criteria

- [x] Handler routing reads persisted review decisions.
- [x] Handler routing reports empty diagnostics when no decisions exist.
- [x] Handler routing does not create decisions.
- [x] Handler routing does not execute SCM, forge, provider, callback,
  interruption, or recovery effects.

## Validation

- `cargo test -p nucleus-server scm_capture_review_decision_handler_routing -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
