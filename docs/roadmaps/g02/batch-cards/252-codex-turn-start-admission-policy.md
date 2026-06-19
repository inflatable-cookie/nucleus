# 252 Codex Turn Start Admission Policy

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../057-codex-turn-start-admission-gate.md`

## Purpose

Gate Codex turn-start requests before provider send.

## Scope

- Require live-spawn evidence or an equivalent accepted runtime readiness ref.
- Require task-work readiness and assignment state.
- Block when callback, cancellation, or raw payload policy is not explicit.
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

- Stop if admission needs UI or operator approval semantics not yet contracted.
