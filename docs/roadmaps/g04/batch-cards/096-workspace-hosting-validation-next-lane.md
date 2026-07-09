# 096 Workspace Hosting Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../019-workspace-hosting-model-extraction.md`

## Purpose

Validate the workspace hosting extraction and choose the next implementation
lane.

## Work

- [x] Run focused `nucleus-workspaces` tests.
- [x] Run workspace-level Rust check.
- [x] Run docs/Northstar validation.
- [x] Decide the next lane: selected-task aggregate query, product shell
  layout, local layout persistence, or Aura config UI exploration.

## Acceptance Criteria

- [x] The root Next Task points to a ready implementation card.
- [x] The proof modal remains diagnostic-only.
- [x] Product shell implementation has a real hosting model to build on.

## Result

Workspace hosting extraction is complete at the Rust type and pure-helper
level:

- display/window identity and placement
- deterministic display fallback planning
- hosted surfaces and active-surface fallback
- Nucleus region ids
- per-project panel placement rules
- selected-task shell seed rules
- local-only global shell and project panel layout record families

The next lane is selected-task product aggregate query. Reason: the product UI
should not depend on a pile of proof-first query calls. Product shell layout
can follow once the aggregate query gives it one coherent read model.

## Validation

- `cargo test -p nucleus-workspaces`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
