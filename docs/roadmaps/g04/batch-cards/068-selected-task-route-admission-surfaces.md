# 068 Selected Task Route Admission Surfaces

Status: planned
Owner: Tom
Updated: 2026-07-07
Milestone: `../014-selected-task-route-admission.md`

## Purpose

Expose route-admission inspection through the existing control surfaces.

## Work

- [ ] Add control DTOs for route-admission preview records.
- [ ] Add `nucleusd` query output and focused CLI tests.
- [ ] Add an Effigy selector for route-admission inspection.
- [ ] Show the preview in the disposable desktop proof without final UI
  commitment.

## Acceptance Criteria

- [ ] Server, CLI, Effigy, and desktop proof show the same admission state.
- [ ] No apply controls are added.
- [ ] Guard tests prevent provider, SCM, planning, memory, and final UI effects.
