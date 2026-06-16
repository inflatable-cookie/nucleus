# 093 Add Local Control Transport Trait Boundary

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add local control transport traits without implementing a transport listener.

## Scope

- Define request/response transport trait vocabulary.
- Keep transport local and synchronous until runtime needs change.
- Keep auth readiness and request handling separate from transport.
- Add tests that the trait can be implemented by a fixture.

## Out Of Scope

- Tauri IPC implementation.
- HTTP server.
- WebSocket server.
- Local socket listener.
- Remote pairing.
- Live subscriptions.

## Promotion Targets

- `crates/nucleus-server`
- `docs/roadmaps/g01/009-local-transport-and-desktop-bootstrap-prep.md`

## Validation

```sh
cargo test --workspace
effigy qa:docs
effigy qa:northstar
```

## Decisions

- Local transport trait vocabulary lives in
  `crates/nucleus-server/src/local_transport.rs`.
- The first transport trait is synchronous and local-only.
- Transport readiness remains separate from request handling.
- Request/response exchanges are explicit values.

## Closeout

Added `LocalControlTransport`, `LocalControlTransportExchange`,
`LocalControlTransportError`, and `LocalControlTransportBoundary`.

Tests prove the trait can report readiness and carry a request/response
exchange through a shape-only fixture. No Tauri IPC, HTTP server, WebSocket
server, local socket listener, remote pairing, live subscription, or listener
lifecycle was added.
