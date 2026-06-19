# 271 Codex Recovery Need Records

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../061-codex-session-recovery-gate.md`

## Purpose

Add Codex recovery need records for sessions that may require resume or repair.

## Scope

- Record runtime, session, provider thread/turn refs, task, and work item refs.
- Classify recovery triggers: process exit, reconnect, server restart, or
  provider identity mismatch.
- Require summary/evidence refs without raw provider payload retention.
- Do not issue resume commands in this card.

## Acceptance Criteria

- Recovery records preserve Nucleus and provider identity.
- Raw provider payload retention is disabled by default.
- Records do not mutate task state.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if recovery identity cannot be stable before resume admission.
