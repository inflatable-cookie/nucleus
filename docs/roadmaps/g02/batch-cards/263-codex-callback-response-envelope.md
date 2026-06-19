# 263 Codex Callback Response Envelope

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../059-codex-callback-response-gate.md`

## Purpose

Map accepted callback responses to sanitized provider envelope records.

## Scope

- Define provider envelope identity and method.
- Include callback, runtime, session, task, and work refs.
- Exclude raw provider payloads by default.

## Acceptance Criteria

- Envelope records are replay-safe and idempotency-friendly.
- Payload retention policy is explicit.
- Cancellation and task mutation are not implied.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if callback envelope mapping needs refreshed Codex schema evidence.

## Result

- Added sanitized callback response envelope records for accepted admissions.
- Used `serverRequest/resolved` as the provider method label based on local
  Codex runtime evidence.
- Preserved callback, runtime, session, task, work, and provider item refs.
- Kept raw payload retention, provider send, cancellation, and task mutation
  disabled.
