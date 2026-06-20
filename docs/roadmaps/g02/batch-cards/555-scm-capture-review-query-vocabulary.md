# 555 SCM Capture Review Query Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../118-scm-capture-review-control-integration.md`

## Purpose

Add explicit control API diagnostics query vocabulary for SCM capture review
readiness.

## Scope

- Add a `ScmCaptureReview` diagnostics query variant.
- Add a matching diagnostics query result variant.
- Include review readiness in aggregate diagnostics snapshots.

## Acceptance Criteria

- [x] Request query serialization round-trips the new query variant.
- [x] Response envelope serialization round-trips the new result variant.
- [x] Aggregate diagnostics can include review readiness.
- [x] Existing diagnostics variants remain unchanged.

## Validation

- `cargo test -p nucleus-server scm_capture_review_query_vocabulary -- --nocapture`
- `cargo test -p nucleus-server response_envelope_dto_serializes_scm_capture_review -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
