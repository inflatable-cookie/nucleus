# 153 Persist nucleusd Command Runner Smoke Evidence

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Route the fixed `nucleusd command-runner smoke` evidence through local server
state.

## Scope

- Use the server command evidence write helper.
- Respect `--state <path>`.
- Print sanitized evidence after persistence.

## Out Of Scope

- Arbitrary command input.
- Process execution.
- Raw output retention.

## Promotion Targets

- `apps/nucleusd`

## Acceptance Criteria

- Smoke evidence is persisted.
- Re-running with the same state path can recover the evidence record.
- Output remains sanitized metadata only.

## Closeout

- `nucleusd command-runner smoke` now persists sanitized command evidence to
  the selected state path.
- The CLI smoke output remains sanitized metadata only.
