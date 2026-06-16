# 060 Add Runtime Effect Transport Types

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add runtime effect transport types.

## Scope

- Add compile-only Rust vocabulary for transport family, deployment fit,
  transport capability, transport selection criteria, and transport boundary
  guarantees.
- Keep types value-shaped and transport-neutral.
- Keep transport types separate from networking, event bus, auth, pairing,
  replay implementation, subscription delivery, and runtime execution.

## Out Of Scope

- Transport selection.
- WebSocket, HTTP, local socket, polling, or gateway implementation.
- Event bus implementation.
- Auth and pairing implementation.
- Replay service implementation.
- Runtime execution.

## Evidence Questions

- Which transport families need first-class enum variants now?
- Should deployment fit reuse server deployment profile values?
- Which boundary guarantees must be represented as data?
- Which auth and pairing blockers should be named without solving them?

## Stop Conditions

- Types imply a concrete networking stack.
- Types implement delivery, event bus, replay, or subscriptions.
- Types make transport authoritative for event identity, ordering, or state.
- Types combine auth and pairing before their contracts are drafted.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Transport types live in a separate `nucleus-server` module.
- Transport families include local socket, loopback HTTP, LAN HTTP, remote
  HTTP, stream, polling, and custom.
- Transport profiles describe deployment fit, capabilities, boundary
  guarantees, and auth blockers without binding to a networking stack.
- Selection criteria include deployment profile, client kind, live
  subscription need, replay-only support, and auth blockers.
- Auth and pairing blockers are named but not solved.
- No networking, event bus, auth, pairing, replay service, subscription
  delivery, storage, scheduler, command execution, or adapter execution was
  added.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
