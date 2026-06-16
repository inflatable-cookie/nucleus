# 057 Draft Runtime Effect Subscription Boundary

Status: done
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

## Decisions

- Runtime effect subscriptions are live delivery surfaces, not state
  authority.
- Subscriptions start after replay catch-up or checkpoint negotiation.
- Delivery acknowledgements are client-rendering hints only.
- Backpressure may slow delivery, require replay, compact transient events, or
  require reconnect, but it must not drop durable retained events.
- Disconnect and reconnect flows must use server ordering tokens and storage
  generation posture.
- Subscription transport remains open.
- No Rust implementation, transport, event bus, replay service, persistence,
  acknowledgement store, command execution, or adapter execution was added.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
