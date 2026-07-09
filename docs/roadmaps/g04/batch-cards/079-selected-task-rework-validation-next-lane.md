# 079 Selected Task Rework Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../016-selected-task-rework-from-review-outcome.md`

## Purpose

Validate the selected-task rework lane and choose the next bounded product
workflow step.

## Work

- [x] Run focused server, CLI, Effigy, desktop, docs, and Northstar validation.
- [x] Confirm rework preparation remains explicit, route-backed, and
  provenance-preserving.
- [x] Decide whether to move next to delegation scheduling, SCM handoff review,
  UI/workspace reset, or a planning checkpoint.

## Acceptance Criteria

- [x] Rework preparation is validated across exposed surfaces.
- [x] Any failures are recorded with remediation.
- [x] The root Next Task points to a ready card or planning checkpoint.

## Result

Selected-task rework preparation is validated across the pure server model,
control DTOs, `nucleusd`, Effigy, and the disposable desktop proof.

The next bounded lane is selected-task delegation scheduling admission. This is
the smallest useful follow-up because route admission can now describe rework
and delegation, while the task-backed workflow contract already allows a first
delegation command that creates a scheduled work-item record without starting
provider execution.

SCM handoff review, provider execution, final UI, and broader workspace/panel
reset remain out of scope for the next lane.

## Validation

- `cargo test -p nucleus-server selected_task_rework -- --nocapture`
- `cargo test -p nucleusd selected_task_rework -- --nocapture`
- `effigy server:query:selected-task-rework-preparation`
- `effigy desktop:check`
