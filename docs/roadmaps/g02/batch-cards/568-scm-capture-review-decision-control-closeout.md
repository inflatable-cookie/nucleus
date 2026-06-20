# 568 SCM Capture Review Decision Control Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../120-scm-capture-review-decision-control-integration.md`

## Purpose

Validate SCM capture review-decision control integration and choose the next
lane from evidence.

## Scope

- Run focused and workspace validation.
- Update the implementation gap index.
- Choose change-request preparation, review-decision command routing, or
  stocktake from the current state.

## Acceptance Criteria

- [x] Validation passes or blockers are recorded.
- [x] Gap index reflects review-decision control integration.
- [x] Next lane is selected from evidence.
- [x] External effects remain gated.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
