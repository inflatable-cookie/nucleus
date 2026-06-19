# 264 Codex Callback Receipts Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../059-codex-callback-response-gate.md`

## Purpose

Expose callback outcomes through sanitized receipts and read-only diagnostics.

## Scope

- Map accepted, blocked, failed, and unsupported callback outcomes to receipts.
- Add diagnostics DTOs with next action hints.
- Do not add desktop panels.
- Do not expose raw provider payloads.

## Acceptance Criteria

- Clients can inspect callback status without authority.
- Receipts and diagnostics do not leak raw provider data.
- Cancellation/recovery/task-mutation gaps remain explicit.

## Validation

- targeted serialization tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics need UI design decisions.

## Result

- Added callback response outcome records and runtime receipt mapping.
- Added client-safe callback diagnostics with next action hints.
- Covered accepted, blocked, failed, and unsupported outcomes.
- Kept raw payloads, cancellation, recovery, and task mutation out of
  diagnostics authority.
