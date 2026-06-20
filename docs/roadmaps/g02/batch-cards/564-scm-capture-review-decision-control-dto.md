# 564 SCM Capture Review Decision Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../120-scm-capture-review-decision-control-integration.md`

## Purpose

Serialize persisted SCM capture review-decision diagnostics into the read-only
control API surface.

## Scope

- Add a DTO around `ScmCaptureReviewDecisionDiagnosticsRecord`.
- Preserve decision outcome counts.
- Keep DTOs free of raw output and mutation authority.

## Acceptance Criteria

- [x] DTO serialization preserves decision counts.
- [x] DTO serialization preserves blocked and duplicate counts.
- [x] DTO flags keep change-request and SCM authority false.
- [x] Raw output remains absent.

## Validation

- `cargo test -p nucleus-server scm_capture_review_decision_control_dto -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
