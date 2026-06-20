# 458 Completion SCM Capture Persistence Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../098-completion-scm-capture-admission-persistence.md`

## Purpose

Validate capture-admission persistence and select the next lane.

## Scope

- Run focused and workspace validation.
- Update implementation gap index.
- Decide whether the next lane is SCM capture preparation records, control DTO
  integration, or driver-specific dry-run planning.

## Acceptance Criteria

- [x] Validation passes or blockers are recorded.
- [x] Gap index reflects persisted capture admissions.
- [x] Next lane is selected from evidence.
- [x] External effects remain gated.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
