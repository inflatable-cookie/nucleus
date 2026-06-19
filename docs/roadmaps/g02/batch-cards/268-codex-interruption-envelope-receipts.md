# 268 Codex Interruption Envelope Receipts

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../060-codex-provider-interruption-gate.md`

## Purpose

Map accepted Codex interruptions to sanitized provider envelopes and receipts.

## Scope

- Define provider interruption envelope identity and method.
- Include runtime, session, turn, task, work item, and interruption request refs.
- Map accepted, blocked, failed, and unsupported outcomes to receipts.
- Exclude raw provider payloads.

## Acceptance Criteria

- Envelope records are replay-safe and idempotency-friendly.
- Receipts are sanitized and include explicit next-state summaries.
- Recovery and task mutation are not implied.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if envelope mapping needs refreshed Codex schema evidence.
