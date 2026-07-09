# 109 Selected Task Aggregate Shell State Hardening

Status: superseded
Owner: Tom
Updated: 2026-07-09
Milestone: `../022-selected-task-aggregate-product-shell-placement.md`

## Purpose

Harden loading, empty, unsupported, and error states for the product-shell
aggregate panel.

## Work

- [x] Add clear empty state for no selected task.
- [x] Add loading and refresh behavior scoped to project/task selection changes.
- [x] Add unsupported/error fallback text that does not expose raw DTO payloads.
- [x] Keep state local to the shell proof until final UI architecture settles.

## Acceptance Criteria

- [x] Switching projects/tasks cannot leave stale aggregate state visible.
- [x] Failures are readable without dumping transport payloads.
- [x] No durable state or mutation behavior is added.

## Result

Added local loading, refresh, empty, unsupported, error, and request-race
guards for the selected-task aggregate panel.

Superseded after operator correction. The normal workspace no longer loads the
selected-task aggregate panel.
