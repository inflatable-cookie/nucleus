# 261 Codex Callback Request Records

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../059-codex-callback-response-gate.md`

## Purpose

Add callback request records for Codex permission and user-input callbacks.

## Scope

- Record provider callback id, runtime, session, turn, item, task, and work
  refs.
- Support permission and user-input callback kinds.
- Exclude raw callback payloads by default.
- Do not answer callbacks in this card.

## Acceptance Criteria

- Callback request records preserve provider and Nucleus identity.
- Raw provider payload retention is disabled by default.
- Records do not mutate task state.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if callback identity cannot be stable before response.
