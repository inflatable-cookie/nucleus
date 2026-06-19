# 253 Codex Turn Start Envelope Mapping

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../057-codex-turn-start-admission-gate.md`

## Purpose

Map accepted turn-start admissions to sanitized provider envelope records.

## Scope

- Define provider-envelope identity before send.
- Include runtime, session, task, work-item, and request refs.
- Exclude raw prompts and raw provider payloads by default.
- Do not open callback handling.

## Acceptance Criteria

- Envelope records are replay-safe and idempotency-friendly.
- Provider send payload construction has explicit payload-retention policy.
- No callback or cancellation path is implied.

## Result

Implemented `codex_turn_start_envelope`, which maps accepted turn-start
admissions to sanitized `turn/start` envelope records without provider send,
raw payload retention, callback handling, or task mutation.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if envelope mapping requires current Codex schema evidence refresh.
