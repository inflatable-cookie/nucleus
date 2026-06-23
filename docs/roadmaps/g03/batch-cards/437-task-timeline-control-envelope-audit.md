# 437 Task Timeline Control Envelope Audit

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../109-task-timeline-authority-map-control-parity.md`

## Purpose

Inspect existing task timeline and project authority-map query/result types
before adding DTO support.

## Acceptance Criteria

- [x] Existing server query and result types are identified.
- [x] Required task id or project id inputs are explicit.
- [x] Any missing contract gap is recorded before implementation.

## Result

Task timeline is bounded by `task_id`.

Project authority-map publication is bounded by `project_id` and expected
authority domains. Current handler returns a deferred publication because
authority-map persistence is not implemented.
