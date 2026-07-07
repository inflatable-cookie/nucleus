# 062 Selected Task Review Outcome CLI Effigy

Status: planned
Owner: Tom
Updated: 2026-07-07
Milestone: `../013-selected-task-review-outcome-routing.md`

## Purpose

Expose selected-task review outcome routing through control DTOs, `nucleusd`,
and Effigy.

## Work

- [ ] Add request/response DTO coverage for the route read model.
- [ ] Add a `nucleusd --bootstrap query` surface for local smoke inspection.
- [ ] Add an Effigy selector for the query.
- [ ] Add CLI rendering tests that prove sanitized output and no-effect flags.

## Acceptance Criteria

- [ ] CLI and Effigy expose the same server route model.
- [ ] Output is sanitized and explicit about read-only behavior.
- [ ] Focused server and `nucleusd` tests pass.
