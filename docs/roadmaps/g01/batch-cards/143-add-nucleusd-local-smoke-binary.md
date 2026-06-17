# 143 Add nucleusd Local Smoke Binary

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Make `nucleusd` runnable as a local server smoke binary.

## Scope

- Add `apps/nucleusd` workspace package.
- Open local SQLite state.
- Seed bootstrap project/task records.
- Print state summary through the local control handler.
- Add root Effigy selectors for server build/status/smoke.

## Out Of Scope

- Network listener.
- Daemon lifecycle.
- Provider processes.
- Command execution.
- Desktop UI.

## Promotion Targets

- `apps/nucleusd`
- `Cargo.toml`
- `effigy.toml`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/021-nucleusd-local-server-runtime.md`

## Acceptance Criteria

- [x] `nucleusd` is a workspace binary.
- [x] Local bootstrap creates project/task records through server services.
- [x] Status output reports state counts through the request handler.
- [x] Root Effigy exposes server build/status/smoke tasks.

## Result

`apps/nucleusd` now provides `nucleusd --bootstrap`, `--status`, and
`--state <path>` for local server smoke runs. It uses SQLite and server-owned
control handling only. It does not open transport or execute runtime work.
