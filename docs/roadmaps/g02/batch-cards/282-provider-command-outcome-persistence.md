# 282 Provider Command Outcome Persistence

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../063-provider-command-reactor-gate.md`

## Purpose

Persist provider command outcomes through existing runtime receipt/event
surfaces before live provider send.

## Scope

- Connect provider reactor outcomes to runtime receipt persistence.
- Connect provider reactor outcomes to runtime observation event persistence.
- Keep persistence sanitized and metadata/evidence-ref only.
- Do not project outcomes into task state.

## Acceptance Criteria

- Provider command outcomes can be written and read as runtime receipts/events.
- Raw provider payloads are not persisted.
- Task state is not mutated by outcome persistence.

## Validation

- [x] targeted server/orchestration tests
- [x] `cargo check --workspace`
- [x] `git diff --check`

## Stop Conditions

- Stop if persistence requires a broader event-store migration.

## Result

Added provider command outcome persistence that writes reactor outcomes as
sanitized runtime receipts and runtime observation event-store records through
the server state facade.

Tests prove the persisted receipt and event can be read back, do not contain
raw provider payload or credential fields, and do not permit task mutation.
