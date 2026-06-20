# 423 Live Evidence Completion Request Handler Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../091-live-evidence-completion-request-handler-diagnostics.md`

## Purpose

Validate request-handler diagnostics for live evidence completion and select
the next lane.

## Scope

- Run focused and workspace validation.
- Update implementation gap index.
- Decide whether to expose desktop diagnostics, add explicit task-state
  mutation, or return to callback/interruption/recovery execution.
- Keep broad automation gated.

## Acceptance Criteria

- [x] Validation passes or blockers are recorded.
- [x] Gap index reflects request-handler diagnostics state.
- [x] Next lane is selected from evidence.
- [x] Broad provider automation remains gated.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
