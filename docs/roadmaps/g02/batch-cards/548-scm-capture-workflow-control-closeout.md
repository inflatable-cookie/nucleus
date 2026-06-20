# 548 SCM Capture Workflow Control Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../116-scm-capture-workflow-control-integration.md`

## Purpose

Validate SCM capture workflow control integration and select the next lane.

## Scope

- Run focused and workspace validation.
- Update the implementation gap index.
- Choose change-request preparation, operator review, or stocktake from
  evidence.

## Acceptance Criteria

- [x] Validation passes or blockers are recorded.
- [x] Gap index reflects workflow control integration.
- [x] Next lane is selected from evidence.
- [x] External effects remain gated.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
