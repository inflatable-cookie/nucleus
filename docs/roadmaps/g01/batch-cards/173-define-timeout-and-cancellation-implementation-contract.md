# 173 Define Timeout And Cancellation Implementation Contract

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define timeout and cancellation behavior needed before local host spawn.

## Scope

- Define finite timeout requirement for spawned commands.
- Define cancellation behavior and cleanup expectations.
- Define terminal and cleanup-failed event requirements.
- Keep retry classification policy-aware.

## Out Of Scope

- Implementing async process control.
- Implementing kill-tree behavior.
- Desktop UI.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `crates/nucleus-command-policy`
- `crates/nucleus-server`

## Acceptance Criteria

- Timeout behavior is explicit.
- Cancellation behavior is explicit.
- Cleanup failure remains visible as sanitized evidence.

## Closeout

- Added command-policy interruption contract vocabulary for timeout start,
  cancellation, cleanup failure, terminal event, and retry classification.
- Added server host interruption contract envelope.
- Promoted timeout, cancellation, and cleanup-failed evidence rules into the
  server boundary contract.
