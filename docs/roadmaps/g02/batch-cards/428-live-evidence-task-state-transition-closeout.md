# 428 Live Evidence Task State Transition Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../092-live-evidence-completion-task-state-transition.md`

## Purpose

Validate live evidence task-state transition and select the next lane.

## Scope

- Run focused and workspace validation.
- Update implementation gap index.
- Decide whether to expose desktop diagnostics, continue task mutation
  integration, or return to callback/interruption/recovery execution.
- Keep broad automation gated.

## Acceptance Criteria

- [x] Validation passes or blockers are recorded.
- [x] Gap index reflects task-state transition.
- [x] Next lane is selected from evidence.
- [x] Broad provider automation remains gated.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
