# 439 Project Authority Map Control Envelope DTO

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../109-task-timeline-authority-map-control-parity.md`

## Purpose

Add serialized read-only project authority-map publication query/result DTO
support.

## Acceptance Criteria

- [x] Query action includes a bounded project id input or documented list
  posture.
- [x] Response DTO states publication rows are explanatory and do not grant
  authority.
- [x] Unsupported/mutating actions fail closed.
- [x] Focused codec and handler tests pass.
