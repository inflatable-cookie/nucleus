# 251 Codex Turn Start Request Records

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../057-codex-turn-start-admission-gate.md`

## Purpose

Add Codex turn-start request records linked to runtime, session, task, and work
refs.

## Scope

- Require runtime instance, session, task, and work-item refs.
- Require prompt/source summary refs without raw prompt retention by default.
- Keep callback response, cancellation, resume, and task mutation out of scope.
- Do not send a provider turn in this card.

## Acceptance Criteria

- Turn-start request records cannot omit runtime/session/work identity.
- Raw provider payload retention remains explicit and off by default.
- Request records do not mutate task state.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if request identity depends on provider response ids that do not exist
  before send.
