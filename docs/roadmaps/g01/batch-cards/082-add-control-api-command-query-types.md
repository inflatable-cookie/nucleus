# 082 Add Control API Command Query Types

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Define first local command/query value types for the server control boundary.

## Scope

- Add command, query, response, and error vocabulary.
- Cover project, task, workspace, adapter/session, route, and runtime metadata
  access.
- Keep transport independent.
- Add compile tests or unit tests for boundary shape.

## Out Of Scope

- HTTP, WebSocket, local socket, or Tauri IPC transport.
- Remote auth.
- Runtime execution.
- Provider adapters.

## Promotion Targets

- `crates/nucleus-server`
- `docs/roadmaps/g01/007-server-control-api-and-runtime-sequencing.md`

## Validation

```sh
cargo test --workspace
```

## Decisions

- Control API vocabulary lives in `nucleus-server/src/control_api.rs`.
- `ServerCommand` remains the existing command envelope; the new control API
  wraps it instead of replacing it.
- Query vocabulary is transport-neutral and covers project, task, workspace,
  adapter/session, model route, and runtime metadata surfaces.
- Responses distinguish command receipts, query results, and errors.
- Command receipts are explicit acceptance records, not proof of execution.

## Closeout

Added `ServerControlRequest`, `ServerQuery`, query categories, response
envelopes, command receipts, state record sets, and control error vocabulary.

Tests cover command wrapping without transport, project query results through
server state record sets, and distinct auth/storage/runtime/deferred errors.
No request handler, network transport, Tauri IPC, auth middleware, scheduling,
command execution, storage replay, or provider runtime behavior was added.
