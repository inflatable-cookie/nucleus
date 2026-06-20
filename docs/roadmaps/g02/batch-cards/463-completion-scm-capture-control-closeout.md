# 463 Completion SCM Capture Control Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../099-completion-scm-capture-diagnostics-control-integration.md`

## Purpose

Validate capture-admission control integration and select the next lane.

## Scope

- Run focused and workspace validation.
- Update implementation gap index.
- Decide whether the next lane is capture preparation records, SCM driver dry
  run, or desktop proof.

## Acceptance Criteria

- [x] Validation passes or blockers are recorded.
- [x] Gap index reflects control integration state.
- [x] Next lane is selected from evidence.
- [x] External effects remain gated.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
