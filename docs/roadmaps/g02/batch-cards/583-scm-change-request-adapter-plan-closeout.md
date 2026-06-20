# 583 SCM Change Request Adapter Plan Closeout

Status: ready
Owner: Tom
Updated: 2026-06-21
Milestone: `../123-scm-change-request-adapter-plan-selection.md`

## Purpose

Validate adapter plan selection and choose the first executable adapter lane.

## Scope

- Prove adapter plans remain non-executing.
- Update the implementation gap index.
- Choose Git, convergence, or control integration from evidence.

## Acceptance Criteria

- [ ] Validation passes or blockers are recorded.
- [ ] Gap index reflects adapter plan selection.
- [ ] Next executable lane is selected from evidence.
- [ ] External effects remain gated.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
