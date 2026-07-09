# 088 Product Workflow Implementation Runway Reset

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../018-product-workflow-ui-architecture-refocus.md`

## Purpose

Reset the implementation runway around the real product workflow surface.

## Work

- [x] Reorder queued cards so implementation follows product workflow needs.
- [x] Decide whether delegation scheduling resumes before or after the first
  selected-task shell implementation.
- [x] Add or revise cards for aggregate query, product client adapters, and UI
  shell work.
- [x] Keep proof UI changes limited to diagnostics.

## Acceptance Criteria

- [x] The next ready implementation card is product-shaped.
- [x] Deferred work is explicit rather than hidden in stale cards.
- [x] The runway avoids more speculative proof UI.

## Result

Delegation scheduling remains paused. The next implementation runway is not
more proof UI.

The selected next lane is workspace hosting model extraction:

- inspect Loophole's current Echo windowing/layout crates
- port or recreate display/window/surface/region/panel domain types in
  `nucleus-workspaces`
- add deterministic window planning and hosted-surface fallback tests
- keep persistence local-client-profile scoped
- defer Aura config UI until the Rust model is stable
