# 235 Reassess Constrained CLI Input Readiness

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Decide whether `nucleusd` should accept constrained read-only command input.

## Scope

- Review control API test evidence.
- Decide if CLI input should be fixed-command, allowlisted, or structured.
- Decide whether desktop should wait for the same boundary.

## Out Of Scope

- Implementing CLI input.
- Desktop UI.
- Write-enabled commands.

## Promotion Targets

- `docs/roadmaps/g01`

## Acceptance Criteria

- Next implementation lane is explicit.
- CLI input does not proceed without admission rules.

## Closeout

Constrained CLI input is now ready because the server control API has
structured request fields, rejection behavior, sanitized result fields, and
persistence tests.

The next lane should expose this through `nucleusd` as a constrained structured
command, not as a shell string. Desktop controls should wait until the CLI path
proves the operator-facing shape.
