# 068 Selected Task Route Admission Surfaces

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../014-selected-task-route-admission.md`

## Purpose

Expose route-admission inspection through the existing control surfaces.

## Work

- [x] Add control DTOs for route-admission preview records.
- [x] Add `nucleusd` query output and focused CLI tests.
- [x] Add an Effigy selector for route-admission inspection.
- [x] Show the preview in the disposable desktop proof without final UI
  commitment.

## Acceptance Criteria

- [x] Server, CLI, Effigy, and desktop proof show the same admission state.
- [x] No apply controls are added.
- [x] Guard tests prevent provider, SCM, planning, memory, and final UI effects.

## Result

Route admission now has:

- server control query and response DTOs
- `nucleusd query selected-task-route-admission`
- Effigy selector `server:query:selected-task-route-admission`
- disposable desktop proof display for completion, rework, delegation, evidence,
  and no-effect flags

Bootstrap inspection correctly reports refused completion and rework/delegation
admissions because no reviewed decision exists in the seeded task state.
