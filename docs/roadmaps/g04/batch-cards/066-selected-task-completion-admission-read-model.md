# 066 Selected Task Completion Admission Read Model

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../014-selected-task-route-admission.md`

## Purpose

Add a server-owned dry-run admission model for completing a selected task after
an accepted review route.

## Work

- [x] Build the pure admission read model around `ready_for_completion_admission`.
- [x] Reuse existing selected-task command admission primitives where possible.
- [x] Preserve expected revision, evidence refs, refusal reasons, and no-effect
  flags.
- [x] Add focused tests for admitted, missing decision, missing evidence, stale
  route, and unsupported route cases.

## Acceptance Criteria

- [x] Accepted review can produce a completion admission preview.
- [x] No task lifecycle mutation occurs.
- [x] Refusals explain the missing or stale source evidence.

## Result

Added the pure server-owned selected-task completion route admission model.
Accepted review routes can now produce a dry-run completion command admission
preview after route validation. Missing decisions, missing evidence, stale
routes, unsupported outcomes, and command-admission refusal all fail closed
with explicit refusal kinds.

The model reuses selected-task command admission only after the route is proven
ready, accepted, evidence-backed, and scoped to the same selected task gate.

## Validation

- `cargo test -p nucleus-server selected_task_route_admission -- --nocapture`
