# 558 SCM Capture Review Control Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../118-scm-capture-review-control-integration.md`

## Purpose

Validate SCM capture review control integration and choose the next product
lane from evidence.

## Scope

- Run focused and workspace validation.
- Update the implementation gap index.
- Choose operator decision persistence, change-request preparation, or stocktake
  from the current state.

## Acceptance Criteria

- [x] Validation passes or blockers are recorded.
- [x] Gap index reflects review control integration.
- [x] Next lane is selected from evidence.
- [x] External effects remain gated.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
