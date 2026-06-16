# 058 Add Runtime Effect Subscription Types

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add runtime effect subscription types.

## Scope

- Add compile-only Rust vocabulary for subscription lifecycle.
- Represent subscription id, handshake, replay catch-up requirement,
  lifecycle state, delivery acknowledgement posture, backpressure posture,
  disconnect reason, and reconnect requirement.
- Keep types value-shaped and transport-neutral.
- Keep subscription types separate from event bus, transport implementation,
  replay implementation, persistence implementation, and runtime execution.

## Out Of Scope

- WebSocket, HTTP, local socket, polling, or transport selection.
- Event bus implementation.
- Replay service implementation.
- Persistence implementation.
- Client cache implementation.
- Runtime execution.

## Evidence Questions

- Should subscription types reuse replay query ordering token values directly?
- Which acknowledgement states need named variants now?
- Which backpressure and disconnect states need named variants now?
- Should subscription policy include deployment profile variance now?

## Stop Conditions

- Types imply a concrete transport or event bus.
- Types implement replay, subscriptions, or delivery.
- Types make client acknowledgements authoritative for server state.
- Types include raw command output or provider payloads by default.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Subscription types live in a separate `nucleus-server` module.
- Subscription handshakes reuse replay ordering tokens directly.
- Lifecycle state names replay catch-up, accepted, live, backpressure,
  interrupted, reconnect required, closed, rejected, and unsupported states.
- Delivery acknowledgements are explicit client-rendering hints.
- Backpressure and disconnect reasons are named without implementing delivery.
- Reconnect requirements can require replay query before live delivery resumes.
- No transport, event bus, replay service, persistence implementation,
  acknowledgement processing, client cache, scheduler, command execution, or
  adapter execution was added.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
