# 063 Selected Task Review Outcome Desktop Proof

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../013-selected-task-review-outcome-routing.md`

## Purpose

Show selected-task review outcome routing in the disposable desktop proof.

## Work

- [x] Add light TS/Svelte client mapping for the route response.
- [x] Show route status, blockers, source refs, no-effect flags, and downstream
  command hints in the selected-task drilldown proof panel.
- [x] Keep the proof read-only.
- [x] Extend guard tests to prevent forbidden mutation controls.

## Acceptance Criteria

- [x] The desktop proof explains what the user can do next after a review
  decision.
- [x] No final UI commitment or client-side authority is introduced.
- [x] `effigy desktop:check` and panel guard tests pass.

## Result

The disposable desktop proof now queries and renders selected-task review
outcome routing. It shows the route status, primary route, candidates,
decision/outcome refs, downstream hints, blockers, source counts, and read-only
no-effect flags.

The route display adds no command controls and remains server-owned diagnostic
state.

## Validation

- `effigy desktop:check`
- `cargo test -p nucleus-desktop panel_guards -- --nocapture`
