# 074 Selected Task Completion Route Validation

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../015-selected-task-completion-from-route-admission.md`

## Purpose

Validate completion-from-route and choose the next product workflow lane.

## Work

- [x] Run focused server, CLI, Effigy, desktop, docs, and Northstar validation.
- [x] Confirm task completion remains explicit and route-backed.
- [x] Decide whether to move next to rework creation, delegation scheduling, SCM
  handoff review, or a UI/workspace reset.

## Acceptance Criteria

- [x] Completion-from-route is validated across exposed surfaces.
- [x] Any failures are recorded with remediation.
- [x] The root Next Task points to a ready card or planning checkpoint.

## Result

Completion-from-route is validated as a read-only preview lane. The server
model, control DTOs, `nucleusd`, Effigy selector, and disposable desktop proof
all preserve the same boundary:

- accepted-review route admission is required before a complete command can be
  previewed
- expected revision and operator ref stay visible
- the current query does not mutate task lifecycle state
- provider execution, SCM/forge mutation, planning apply, memory apply, agent
  scheduling, and UI authority remain explicitly false

The next lane is selected-task rework from review outcome. It is narrower than
delegation scheduling, SCM handoff execution, or UI reset, and it follows the
already-proven review outcome route and rework admission preview.

## Validation

Validation passed:

- `cargo test -p nucleus-server selected_task_completion_route_apply -- --nocapture`
- `cargo test -p nucleusd selected_task_completion_route_apply -- --nocapture`
- `effigy server:query:selected-task-completion-route-apply`
- `effigy desktop:check`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
- `effigy doctor`

`effigy doctor` remains warning-only with god-file findings.
