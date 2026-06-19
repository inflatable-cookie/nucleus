# 259 Codex Subscription Diagnostics

Status: ready
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

## Validation

- targeted serialization tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics need UI design decisions.
