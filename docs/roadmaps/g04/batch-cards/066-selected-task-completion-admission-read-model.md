# 066 Selected Task Completion Admission Read Model

Status: planned
Owner: Tom
Updated: 2026-07-07
Milestone: `../014-selected-task-route-admission.md`

## Purpose

Add a server-owned dry-run admission model for completing a selected task after
an accepted review route.

## Work

- [ ] Build the pure admission read model around `ready_for_completion_admission`.
- [ ] Reuse existing selected-task command admission primitives where possible.
- [ ] Preserve expected revision, evidence refs, refusal reasons, and no-effect
  flags.
- [ ] Add focused tests for admitted, missing decision, missing evidence, stale
  route, and unsupported route cases.

## Acceptance Criteria

- [ ] Accepted review can produce a completion admission preview.
- [ ] No task lifecycle mutation occurs.
- [ ] Refusals explain the missing or stale source evidence.
