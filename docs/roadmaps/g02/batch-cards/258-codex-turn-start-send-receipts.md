# 258 Codex Turn Start Send Receipts

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../058-codex-turn-start-send-and-subscription-gate.md`

## Purpose

Map provider send and subscription outcomes to sanitized runtime receipts.

## Scope

- Map accepted, blocked, failed, timed-out, closed, and recovery-required
  states.
- Use refs and summaries only.
- Do not retain raw prompts or provider payloads.

## Acceptance Criteria

- Receipt status vocabulary covers send/subscription outcomes.
- Receipts are replay-safe and artifact-free by default.
- Callback/cancellation behavior is not implied.

## Result

Implemented sanitized runtime receipt mappings for Codex stdio write and
subscription state records, including queued, completed, blocked, failed, and
recovery-required outcomes without raw stream or provider payload retention.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if receipts need provider callback payload retention.
