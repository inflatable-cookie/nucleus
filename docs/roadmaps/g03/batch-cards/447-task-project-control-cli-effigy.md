# 447 Task Project Control CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../110-task-project-workflow-depth.md`

## Purpose

Expose the selected read model through control DTOs, `nucleusd`, and Effigy.

## Work

- [x] Add serialized control-envelope request/response support.
- [x] Add `nucleusd query` support with typed output.
- [x] Add an Effigy selector for root-level inspection.
- [x] Add rejection tests for unsupported or mutating actions.

## Acceptance Criteria

- [x] CLI output is sanitized and stable.
- [x] Effigy selector runs from repo root.
- [x] Unsupported actions fail closed.

## Result

Added:

- `ServerQueryKind::TaskReadiness`
- serialized `task_readiness` control query DTO
- serialized `TaskReadiness` response DTO
- server query composition from stored task records
- `nucleusd query task-readiness --project <project-id>`
- `effigy server:query:task-readiness`

Smoke output confirms one bootstrap candidate with:

- `client_can_mutate=false`
- `provider_execution_available=false`
- readiness `human_planning_ready`
