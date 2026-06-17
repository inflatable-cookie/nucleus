# 237 Add Read-Only Command CLI Parser

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add parser support for constrained read-only command input.

## Scope

- Parse executable and argv separately.
- Parse working directory, timeout, and output limit flags.
- Preserve existing smoke commands.

## Out Of Scope

- Running commands.
- Desktop UI.
- Shell passthrough.

## Promotion Targets

- `apps/nucleusd`

## Acceptance Criteria

- Parser tests cover executable, argv, defaults, and rejected malformed input.
- Existing CLI tests continue to pass.

## Closeout

Added `CliReadOnlyCommand` parsing with structured executable/argv,
working-directory, timeout, stdout limit, and stderr limit fields.

Parser tests cover structured command parsing, missing separator rejection, and
zero timeout rejection.
