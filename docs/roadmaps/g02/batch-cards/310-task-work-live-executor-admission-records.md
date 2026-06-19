# 310 Task Work Live Executor Admission Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../069-codex-task-backed-live-execution-gate.md`

## Purpose

Record admitted task-work-to-live-executor identity before provider execution.

## Scope

- Preserve work item id, task id, project id, provider instance id, runtime
  session ref, live executor write attempt id, and idempotency key.
- Keep the record inspect-only until the executor path is invoked by a separate
  confirmed command.
- Add validation for missing or mismatched identity.

## Acceptance Criteria

- [x] Admission records preserve task and provider identity.
- [x] Invalid identity is blocked before executor handoff.
- [x] Records remain metadata-only and sanitized.

## Validation

- targeted server tests
- `cargo check --workspace`
