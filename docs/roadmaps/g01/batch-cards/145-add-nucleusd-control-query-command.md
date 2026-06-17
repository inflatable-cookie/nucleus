# 145 Add nucleusd Control Query Command

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Add the first general-purpose `nucleusd` query command over server-owned state.

## Scope

- Add a narrow CLI command for local control queries.
- Route through `LocalControlRequestHandler`.
- Keep output deterministic enough for smoke tests.

## Out Of Scope

- Network transport.
- Live subscriptions.
- Runtime command execution.
- Provider adapters.
- Desktop UI.

## Promotion Targets

- `apps/nucleusd`
- `crates/nucleus-server` only if reusable helper extraction is needed

## Acceptance Criteria

- [x] Query command reads through server control handling.
- [x] Unsupported query shapes return explicit errors.
- [x] Tests prove the command shape without opening transport.

## Result

`nucleusd query projects`, `nucleusd query tasks`, and `nucleusd query
workspaces` now route through `LocalControlRequestHandler` and print record
ids, kinds, and revisions. Root Effigy selectors expose project/task/workspace
query commands.
