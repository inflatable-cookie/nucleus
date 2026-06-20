# 576 SCM Change Request Prep Query Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../122-scm-capture-change-request-preparation-control.md`

## Purpose

Add control API diagnostics query vocabulary for change-request preparation.

## Scope

- Add a `ScmChangeRequestPreparation` diagnostics query variant.
- Add a matching diagnostics query result variant.
- Include preparation diagnostics in aggregate diagnostics snapshots.

## Acceptance Criteria

- [x] Request query serialization round-trips the new query variant.
- [x] Response envelope serialization round-trips the new result variant.
- [x] Aggregate diagnostics can include preparation diagnostics.
- [x] Existing diagnostics variants remain unchanged.

## Validation

- `cargo test -p nucleus-server scm_change_request_prep_query_vocabulary -- --nocapture`
- `cargo test -p nucleus-server response_envelope_dto_serializes_scm_change_request_prep -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
