# 256 Codex Provider Send Command Boundary

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../058-codex-turn-start-send-and-subscription-gate.md`

## Purpose

Add provider-send command records for accepted Codex turn-start envelopes.

## Scope

- Require accepted turn-start envelope refs.
- Require explicit write target and payload-retention policy.
- Keep stdio writes out of this card.
- Keep callbacks, cancellation, recovery, and task mutation out of scope.

## Acceptance Criteria

- Provider-send command records cannot exist without an accepted envelope ref.
- Records are replay-safe and idempotency-friendly.
- Raw prompt/provider payload retention remains disabled by default.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if send command identity needs provider response ids that do not exist
  before write.
