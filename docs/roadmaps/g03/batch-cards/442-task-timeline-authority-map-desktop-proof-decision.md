# 442 Task Timeline Authority Map Desktop Proof Decision

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../109-task-timeline-authority-map-control-parity.md`

## Purpose

Decide whether to add a disposable desktop proof panel after CLI/control parity.

## Acceptance Criteria

- [x] Decision is based on implementation evidence, not UI design guessing.
- [x] If deferred, the next lane remains server/client or task/project depth.
- [x] If accepted, proof UI scope stays narrow and read-only.

## Decision

Defer the disposable desktop proof panel.

Reason:

- CLI, Effigy, and serialized control-envelope paths now prove the read-only
  task timeline and project authority-map surfaces.
- The current desktop UI is a disposable proof shell and final UI direction is
  intentionally not settled.
- Adding another read-only panel now would create UI churn without improving
  authority, persistence, task workflow, or project workflow depth.

Next lane:

- return to task/project workflow depth, starting with an implementation audit
  against the task, project identity, planning, orchestration, and conversation
  timeline contracts.
