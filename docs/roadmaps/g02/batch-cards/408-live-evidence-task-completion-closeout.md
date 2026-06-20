# 408 Live Evidence Task Completion Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../088-explicit-live-evidence-task-completion.md`

## Purpose

Validate explicit live evidence task completion and select the next runtime
lane.

## Scope

- Run focused and workspace validation.
- Update implementation gap index.
- Decide whether to route completion into task timelines, surface it through
  diagnostics/control API, or return to callback/interruption/recovery
  execution.
- Keep broad automation gated.

## Acceptance Criteria

- [x] Validation passes or blockers are recorded.
- [x] Gap index reflects explicit task-completion state.
- [x] Next lane is selected from evidence.
- [x] Broad provider automation remains gated.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
