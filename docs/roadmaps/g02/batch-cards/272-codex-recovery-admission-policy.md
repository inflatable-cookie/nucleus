# 272 Codex Recovery Admission Policy

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../061-codex-session-recovery-gate.md`

## Purpose

Gate Codex recovery/resume attempts before provider send.

## Scope

- Require explicit recovery authority.
- Require provider identity evidence and supported resume capability.
- Block unsafe replacement-thread or missing-thread cases.
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

- Stop if recovery policy needs unresolved operator intent.
