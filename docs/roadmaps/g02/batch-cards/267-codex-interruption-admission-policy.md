# 267 Codex Interruption Admission Policy

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../060-codex-provider-interruption-gate.md`

## Purpose

Gate Codex interruption requests before provider send.

## Scope

- Require explicit operator/client authority.
- Require runtime readiness and an interruptible target state.
- Block duplicate or stale interruption targets.
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

- Stop if provider interruption policy needs unresolved operator intent.
