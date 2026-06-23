# 438 Task Timeline Control Envelope DTO

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../109-task-timeline-authority-map-control-parity.md`

## Purpose

Add serialized read-only task timeline query/result DTO support if the audit
confirms the shape is bounded.

## Acceptance Criteria

- [x] Query action includes a bounded task id input.
- [x] Response DTO exposes sanitized timeline projection data only.
- [x] Unsupported actions fail closed.
- [x] Focused codec and handler tests pass.
