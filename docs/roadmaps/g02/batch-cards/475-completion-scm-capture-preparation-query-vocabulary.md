# 475 Completion SCM Capture Preparation Query Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../102-completion-scm-capture-preparation-control-integration.md`

## Purpose

Add request/response envelope vocabulary for preparation diagnostics.

## Scope

- Add diagnostics query kind.
- Add request domain mapping.
- Add response DTO variant.

## Acceptance Criteria

- [x] Query vocabulary round-trips.
- [x] Response DTO serializes sanitized diagnostics.
- [x] Domain name avoids Git-only language.
- [x] No effect authority is introduced.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_preparation_query_vocabulary -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
