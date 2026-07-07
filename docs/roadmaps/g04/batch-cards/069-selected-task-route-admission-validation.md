# 069 Selected Task Route Admission Validation

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../014-selected-task-route-admission.md`

## Purpose

Validate route admission and select the next product-workflow lane.

## Work

- [x] Run focused server, CLI, Effigy, desktop, docs, and Northstar validation.
- [x] Confirm admission previews remain read-only.
- [x] Compare next-phase choices: completion apply, rework work-item creation,
  delegation scheduling, SCM handoff review, or planning checkpoint.
- [x] Advance the root Next Task to the selected ready card.

## Acceptance Criteria

- [x] Route admission is validated across all exposed surfaces.
- [x] Any failures are recorded with remediation.
- [x] The next task points to a ready card or explicit planning checkpoint.

## Decision

Next lane: explicit completion from route admission.

Reason:

- it closes the smallest visible gap after accepted-review route admission
- it can reuse existing task-command admission and apply boundaries
- it does not require rework work-item creation, delegation scheduling, SCM
  mutation, forge mutation, planning apply, or memory apply

Deferred:

- rework work-item creation
- agent delegation scheduling
- SCM handoff review/apply
- broader planning checkpoint lanes

## Validation

Validation passed:

- `cargo fmt`
- `cargo test -p nucleus-server selected_task_route_admission -- --nocapture`
- `cargo test -p nucleusd selected_task_route_admission -- --nocapture`
- `effigy server:query:selected-task-route-admission`
- `effigy desktop:check`
- `cargo test -p nucleus-desktop panel_guards -- --nocapture`
