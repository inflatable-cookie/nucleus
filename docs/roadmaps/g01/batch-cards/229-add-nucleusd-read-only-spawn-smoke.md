# 229 Add Nucleusd Read-Only Spawn Smoke

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add a narrow `nucleusd` smoke command for real read-only spawn.

## Scope

- Add a command runner smoke variant.
- Run a fixed safe structured command.
- Print sanitized evidence only.

## Out Of Scope

- User-supplied arbitrary commands.
- Desktop UI.
- Interactive terminal support.

## Promotion Targets

- `apps/nucleusd`

## Acceptance Criteria

- Smoke command runs locally.
- Output is sanitized.
- Existing smoke command remains available.

## Closeout

Added `nucleusd command-runner read-only-spawn-smoke` and Effigy selector
`server:command-runner:read-only-spawn-smoke`.

The existing non-spawning `command-runner smoke` remains available.
