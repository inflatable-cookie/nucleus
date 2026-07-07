# 067 Selected Task Rework Delegation Admission Shape

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../014-selected-task-route-admission.md`

## Purpose

Shape rework and delegation admissions enough to keep review outcomes coherent
without implementing scheduling or work-item creation.

## Work

- [x] Define preview records for rework preparation and delegation readiness.
- [x] Capture why rejected and needs-changes reviews do not complete the task.
- [x] Keep new work-item creation, provider scheduling, and task reassignment
  out of scope.
- [x] Add tests for supported previews and blocked routes.

## Acceptance Criteria

- [x] Rework and delegation have explicit route-admission vocabulary.
- [x] No provider execution or scheduling is introduced.
- [x] Later work-item/delegation lanes have clear handoff points.

## Result

Added pure server preview records for rework preparation and delegation
readiness. Rejected and needs-changes review routes now produce preview-only
records with source refs, evidence refs, and no-effect flags. Accepted review
routes refuse the rework/delegation path.

The preview model does not create work items, schedule providers, reassign the
task, or mutate task lifecycle state.

## Validation

- `cargo test -p nucleus-server selected_task_route_admission -- --nocapture`
