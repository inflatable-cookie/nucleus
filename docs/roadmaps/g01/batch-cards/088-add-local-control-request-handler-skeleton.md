# 088 Add Local Control Request Handler Skeleton

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add a transport-neutral local control request handler skeleton.

## Scope

- Add a modular request handler boundary in `nucleus-server`.
- Accept `ServerControlRequest` values.
- Return `ServerControlResponse` values.
- Wire in state, replay, auth readiness, and scheduler admission dependencies
  as inert service inputs.
- Keep command handling receipt-only.

## Out Of Scope

- State query execution beyond skeleton routing.
- State mutation execution.
- Command execution.
- Network transport.
- Tauri IPC.
- Live subscriptions.
- Provider adapters.

## Stop Conditions

- The handler starts a server listener.
- The handler runs commands or starts providers.
- The handler mutates worktrees or SCM state.
- The handler becomes a large catch-all module.

## Promotion Targets

- `crates/nucleus-server`
- `docs/roadmaps/g01/008-local-request-handling-and-transport-readiness.md`

## Validation

```sh
cargo test --workspace
effigy qa:docs
effigy qa:northstar
```

## Decisions

- The local request handler skeleton lives in
  `crates/nucleus-server/src/request_handler.rs`.
- The handler is transport-neutral and accepts `ServerControlRequest` values.
- The handler wires state, replay, scheduler, and optional auth readiness
  dependencies without executing them yet.
- Query requests return explicit deferred errors.
- Command requests return rejected deferred receipts, not execution outcomes.

## Closeout

Added `LocalControlRequestHandler` and `LocalControlRequestHandlerBoundary`.

Tests cover deferred query responses, command receipts without execution, and
auth-readiness denial. No state query execution, state mutation, command
execution, network transport, Tauri IPC, live subscription, or provider adapter
behavior was added.
