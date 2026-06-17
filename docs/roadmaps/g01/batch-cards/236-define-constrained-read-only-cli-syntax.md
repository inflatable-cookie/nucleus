# 236 Define Constrained Read-Only CLI Syntax

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the `nucleusd` CLI syntax for structured read-only command input.

## Scope

- Separate executable from argv.
- Define working directory, timeout, stdout limit, and stderr limit flags.
- Define safe defaults.
- Define rejection text for shell passthrough.

## Out Of Scope

- Implementing parser changes.
- Desktop UI.
- Write-enabled command input.

## Promotion Targets

- `apps/nucleusd`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Syntax is explicit.
- It cannot be mistaken for a shell string.
- Implementation cards remain bounded.

## Closeout

Defined syntax:

```text
nucleusd command-runner read-only [--cwd <dir>] [--timeout-ms <ms>] [--stdout-limit <bytes>] [--stderr-limit <bytes>] -- <executable> [args...]
```

Flags must appear before `--`. Executable and argv must appear after `--`.
There is no shell-string form.
