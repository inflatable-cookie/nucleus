# 554 SCM Capture Review Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../118-scm-capture-review-control-integration.md`

## Purpose

Serialize SCM capture operator review readiness diagnostics into the read-only
control API surface.

## Scope

- Add a DTO around `ScmCaptureReviewDiagnosticsRecord`.
- Preserve ready, blocked, repair-required, blocker, and evidence counts.
- Keep DTOs free of raw Git output and mutation authority.

## Acceptance Criteria

- [x] DTO serialization preserves review readiness counts.
- [x] DTO serialization preserves blocker and evidence counts.
- [x] DTO flags keep change-request and SCM authority false.
- [x] Raw output remains absent.

## Validation

- `cargo test -p nucleus-server scm_capture_review_control_dto -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
