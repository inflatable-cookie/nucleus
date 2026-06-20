# 565 SCM Capture Review Decision Query Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../120-scm-capture-review-decision-control-integration.md`

## Purpose

Add explicit control API diagnostics query vocabulary for SCM capture review
decisions.

## Scope

- Add a `ScmCaptureReviewDecision` diagnostics query variant.
- Add a matching diagnostics query result variant.
- Include review decisions in aggregate diagnostics snapshots.

## Acceptance Criteria

- [x] Request query serialization round-trips the new query variant.
- [x] Response envelope serialization round-trips the new result variant.
- [x] Aggregate diagnostics can include review decisions.
- [x] Existing diagnostics variants remain unchanged.

## Validation

- `cargo test -p nucleus-server scm_capture_review_decision_query_vocabulary -- --nocapture`
- `cargo test -p nucleus-server response_envelope_dto_serializes_scm_capture_review_decision -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
