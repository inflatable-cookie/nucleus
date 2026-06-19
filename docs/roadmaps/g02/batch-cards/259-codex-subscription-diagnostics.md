# 259 Codex Subscription Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../058-codex-turn-start-send-and-subscription-gate.md`

## Purpose

Expose provider-send and subscription state through read-only diagnostics.

## Scope

- Show send/subscription status and next actions.
- Include receipt and evidence refs.
- Do not add desktop panels.
- Do not expose raw streams or provider payloads.

## Acceptance Criteria

- Clients can inspect send/subscription state without authority.
- Diagnostics do not leak raw prompt/provider data.
- Callback/cancellation/recovery gaps remain explicit.

## Result

Implemented read-only send/subscription diagnostics for stdio write and
subscription state records, including receipt refs, next actions, and explicit
no-authority flags for provider writes, callbacks, cancellation, and task
mutation.

## Validation

- targeted serialization tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics need UI design decisions.
