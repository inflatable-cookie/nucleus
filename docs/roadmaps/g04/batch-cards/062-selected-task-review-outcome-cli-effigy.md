# 062 Selected Task Review Outcome CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../013-selected-task-review-outcome-routing.md`

## Purpose

Expose selected-task review outcome routing through control DTOs, `nucleusd`,
and Effigy.

## Work

- [x] Add request/response DTO coverage for the route read model.
- [x] Add a `nucleusd --bootstrap query` surface for local smoke inspection.
- [x] Add an Effigy selector for the query.
- [x] Add CLI rendering tests that prove sanitized output and no-effect flags.

## Acceptance Criteria

- [x] CLI and Effigy expose the same server route model.
- [x] Output is sanitized and explicit about read-only behavior.
- [x] Focused server and `nucleusd` tests pass.

## Result

Added the selected-task review outcome route to the control API, transport DTOs,
`nucleusd --bootstrap query`, typed CLI rendering, and Effigy.

Focused validation passed:

- `cargo test -p nucleus-server selected_task_review_outcome -- --nocapture`
- `cargo test -p nucleusd selected_task_review_outcome -- --nocapture`
- `effigy server:query:selected-task-review-outcome-route`
