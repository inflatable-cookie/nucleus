# 257 Codex Stdio Write Subscription State

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../058-codex-turn-start-send-and-subscription-gate.md`

## Purpose

Add stdio write and subscription state records for Codex provider send.

## Scope

- Record write intent, accepted write state, and subscription state.
- Keep raw stream and raw payload retention off by default.
- Do not answer callbacks or cancel provider work.

## Acceptance Criteria

- Write/subscription records are replay-safe.
- Subscription state can show open, closed, blocked, failed, and recovery
  required.
- Raw stream retention remains absent.

## Result

Implemented sanitized stdio write and subscription state records derived from
provider-send commands, with raw stream retention, callbacks, cancellation, and
task mutation disabled.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if subscription state needs a process supervisor feature not yet
  contracted.
