# 503 SCM Capture Dry Run Execution Persistence Closeout

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../107-scm-capture-dry-run-execution-persistence.md`

## Purpose

Validate SCM capture dry-run execution persistence and select the next control
or adapter-specific driver lane.

## Scope

- Run focused and workspace validation.
- Update implementation gap index.
- Choose execution control diagnostics, Git dry-run adapter proof, or stocktake
  as the next lane.

## Acceptance Criteria

- [ ] Validation passes or blockers are recorded.
- [ ] Gap index reflects persisted dry-run execution state.
- [ ] Next lane is selected from evidence.
- [ ] External effects remain gated.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
