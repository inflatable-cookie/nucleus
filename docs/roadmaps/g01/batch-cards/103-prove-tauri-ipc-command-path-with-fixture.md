# 103 Prove Tauri IPC Command Path With Fixture

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Prove one Tauri IPC-shaped request/response path through a fixture before
desktop scaffolding.

## Scope

- Add a fixture that exercises the Tauri IPC command boundary.
- Route a control request through `LocalControlRequestHandler`.
- Prove one read-only state query response.
- Prove errors remain server-shaped, not UI-owned.

## Out Of Scope

- Tauri app scaffolding.
- Real IPC transport.
- State mutation execution.
- Live subscriptions.

## Promotion Targets

- `crates/nucleus-server`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/010-server-module-decomposition-and-ipc-readiness.md`

## Acceptance Criteria

- The fixture proves request/response routing through the future IPC boundary.
- The server remains the authority for state and errors.
- No desktop shell or Tauri runtime is required.

## Validation

```sh
cargo test --workspace
cargo fmt --all --check
```

## Decisions

- The fixture-backed command boundary is `TauriIpcCommandHandlerFixture`.
- The fixture owns a `LocalControlRequestHandler` and records
  `TauriIpcCommandExchange` values.
- The fixture uses `FixtureBacked` posture, not Tauri runtime posture.
- The proof path is a read-only project list query through the local handler.

## Closeout

Added a Tauri IPC-shaped fixture that routes one request/response path through
the server handler.

No Tauri app, macro command, IPC serialization, state mutation execution, live
subscription, or runtime execution was introduced.
