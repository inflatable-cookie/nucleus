# 258 Codex Turn Start Send Receipts

Status: ready
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

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if receipts need provider callback payload retention.
