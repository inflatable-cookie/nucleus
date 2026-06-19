# 315 Callback Response Executor Admission Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../070-codex-callback-response-execution-gate.md`

## Purpose

Record admitted callback-response-to-executor identity before provider
execution.

## Scope

- Preserve callback request id, callback response id, task id, work item id,
  provider instance id, runtime session ref, write attempt id, and idempotency
  key.
- Keep the record inspect-only until execution is invoked by a separate
  confirmed command.
- Add validation for missing or mismatched identity.

## Acceptance Criteria

- [x] Admission records preserve callback, task, and provider identity.
- [x] Invalid identity is blocked before executor handoff.
- [x] Records remain metadata-only and sanitized.

## Validation

- targeted server tests
- `cargo check --workspace`
