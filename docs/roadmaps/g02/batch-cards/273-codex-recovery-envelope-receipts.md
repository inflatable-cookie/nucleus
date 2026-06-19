# 273 Codex Recovery Envelope Receipts

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../061-codex-session-recovery-gate.md`

## Purpose

Map accepted Codex recovery/resume attempts to sanitized provider envelopes and
receipts.

## Scope

- Define provider resume envelope identity and method.
- Include runtime, session, provider thread/turn, task, and work item refs.
- Map accepted, blocked, failed, replacement-thread, and unsupported outcomes
  to receipts.
- Exclude raw provider payloads.

## Acceptance Criteria

- Envelope records are replay-safe and idempotency-friendly.
- Receipts distinguish resume, repair, replacement-thread, and failed states.
- Task mutation is not implied.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if envelope mapping needs refreshed Codex schema evidence.
