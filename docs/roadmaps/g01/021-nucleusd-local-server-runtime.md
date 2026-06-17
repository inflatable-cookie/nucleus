# 021 nucleusd Local Server Runtime

Status: complete
Owner: Tom
Updated: 2026-06-17

## Goal

Make the server runnable and inspectable without depending on the desktop
proof UI.

## Scope

- Add `apps/nucleusd` as a Rust workspace binary.
- Open local SQLite-backed server state from the binary.
- Seed local bootstrap project/task records through server-owned services.
- Print local state status through the control handler.
- Expose root Effigy tasks for server build/status/smoke.
- Keep desktop UI disposable and out of server authority.

## Out Of Scope

- Network listener.
- Long-running daemon loop.
- Remote auth or pairing.
- Live subscriptions.
- Provider process lifecycle.
- Command execution.
- Desktop product UI.

## Decisions

- The current desktop shell is a proof interface and can be thrown away later.
- Server progress should not wait for final UI direction.
- The first `nucleusd` binary is a local smoke/runtime shell over the existing
  server state and request-handler boundaries.
- `nucleusd` must not imply HTTP, WebSocket, sockets, background workers, or
  provider execution yet.

## Execution Plan

- [x] Add local `nucleusd` binary crate and workspace membership.
- [x] Add bootstrap/status smoke path over SQLite state.
- [x] Add root Effigy selectors for server build/status/smoke.
- [x] Compile next server runtime control surface.
- [x] Add first local server command/query CLI surface if contract-approved.
- [x] Compile next server runtime expansion point.

## Acceptance Criteria

- [x] `cargo run -p nucleusd -- --bootstrap` can initialize local state.
- [x] `effigy server:smoke` proves project/task state through server-owned
  control handling.
- [x] `nucleusd` does not open network transport or execute runtime work.
- [x] Next server runtime work is represented by ready cards.

## Cards

- `docs/roadmaps/g01/batch-cards/143-add-nucleusd-local-smoke-binary.md`
- `docs/roadmaps/g01/batch-cards/144-compile-server-runtime-control-surface.md`
- `docs/roadmaps/g01/batch-cards/145-add-nucleusd-control-query-command.md`
- `docs/roadmaps/g01/batch-cards/146-compile-next-server-runtime-expansion-point.md`
