# 150 Add nucleusd Command Runner Smoke

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Expose the minimal command runner path through `nucleusd` for local smoke use.

## Scope

- Add a narrow `nucleusd` command for the approved read-only subset.
- Route through server command authority and runner surfaces.
- Print sanitized evidence only.

## Out Of Scope

- Shell passthrough.
- Arbitrary command execution.
- Network commands.
- Secret access.
- Destructive commands.
- Desktop UI.

## Promotion Targets

- `apps/nucleusd`
- `crates/nucleus-server`

## Acceptance Criteria

- Smoke command cannot run arbitrary shell input.
- Output is sanitized evidence, not raw process transcript.
- Unsupported commands fail visibly.

## Closeout

- Added `nucleusd command-runner smoke`.
- Added root Effigy selector `server:command-runner:smoke`.
- The smoke path uses a fixed structured invocation and prints sanitized
  evidence fields only.
