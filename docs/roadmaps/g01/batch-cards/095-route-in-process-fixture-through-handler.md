# 095 Route In Process Fixture Through Handler

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Route in-process fixture requests through `LocalControlRequestHandler`.

## Scope

- Connect fixture transport to the handler.
- Prove read-only state query behavior through the transport boundary.
- Prove command receipt behavior through the transport boundary.

## Out Of Scope

- State mutation execution.
- Runtime execution.
- Tauri IPC.
- Network transport.

## Promotion Targets

- `crates/nucleus-server`
- `docs/roadmaps/g01/009-local-transport-and-desktop-bootstrap-prep.md`

## Validation

```sh
cargo test --workspace
```

## Decisions

- Handler-backed in-process transport lives in `local_transport.rs`.
- The fixture owns `LocalControlRequestHandler`.
- The fixture records request/response exchanges.
- It proves transport-level state query and command receipt behavior without
  adding network or IPC.

## Closeout

Added `InProcessControlHandlerFixture`.

Tests prove project list queries and task command receipts route through the
transport boundary into `LocalControlRequestHandler`. No state mutation
execution, runtime execution, Tauri IPC, network transport, socket listener, or
background worker behavior was added.
