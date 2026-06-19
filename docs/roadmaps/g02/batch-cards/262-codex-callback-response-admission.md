# 262 Codex Callback Response Admission

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../059-codex-callback-response-gate.md`

## Purpose

Gate Codex callback responses before provider send.

## Scope

- Require supported callback kind and explicit authority.
- Require response option/value to match the callback request shape.
- Keep provider send out of this card.

## Acceptance Criteria

- Admission reports accepted, blocked, and unsupported states.
- Blockers are actionable and replay-safe.
- Task state is not mutated by admission.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if callback response policy needs unresolved operator intent.
