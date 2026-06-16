# 057 Draft Runtime Effect Subscription Boundary

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Draft runtime effect subscription boundary.

## Scope

- Draft live event subscription semantics after replay query vocabulary exists.
- Separate subscription lifecycle from replay queries, storage, transport
  selection, command execution, adapter execution, and client rendering.
- Define subscription handshake expectations with replay catch-up.
- Define delivery acknowledgement posture without making clients
  authoritative.

## Out Of Scope

- Rust implementation.
- WebSocket, HTTP, local socket, or transport selection.
- Event bus implementation.
- Replay implementation.
- Persistence implementation.
- Runtime execution.

## Evidence Questions

- How should a live subscription start from a replay query checkpoint?
- Which delivery acknowledgements are client-rendering hints versus durable
  server state?
- What backpressure and disconnect states need names before implementation?
- How much subscription policy should vary by deployment profile?

## Stop Conditions

- The draft chooses a concrete transport.
- The draft implements an event bus or replay service.
- The draft makes client acknowledgements authoritative for server state.
- The draft includes raw command output or provider payloads in live events by
  default.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
