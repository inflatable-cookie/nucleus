# 063 Selected Task Review Outcome Desktop Proof

Status: planned
Owner: Tom
Updated: 2026-07-07
Milestone: `../013-selected-task-review-outcome-routing.md`

## Purpose

Show selected-task review outcome routing in the disposable desktop proof.

## Work

- [ ] Add light TS/Svelte client mapping for the route response.
- [ ] Show route status, blockers, source refs, no-effect flags, and downstream
  command hints in the selected-task drilldown proof panel.
- [ ] Keep the proof read-only.
- [ ] Extend guard tests to prevent forbidden mutation controls.

## Acceptance Criteria

- [ ] The desktop proof explains what the user can do next after a review
  decision.
- [ ] No final UI commitment or client-side authority is introduced.
- [ ] `effigy desktop:check` and panel guard tests pass.
