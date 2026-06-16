# 094 Add In Process Control Client Fixture

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add an in-process control client fixture for local request/response behavior.

## Scope

- Implement the local transport trait for an in-process fixture.
- Keep the fixture test-only or clearly non-production.
- Prove it can carry control requests and responses.

## Out Of Scope

- Tauri IPC.
- Network transport.
- Background workers.

## Promotion Targets

- `crates/nucleus-server`
- `docs/roadmaps/g01/009-local-transport-and-desktop-bootstrap-prep.md`

## Validation

```sh
cargo test --workspace
```

## Decisions

- The in-process fixture lives beside the local transport trait in
  `local_transport.rs`.
- It is explicitly non-production.
- It carries scripted responses and records exchanges.
- Handler-backed routing is deferred to card `095`.

## Closeout

Added `InProcessControlClientFixture`.

Tests prove scripted request/response exchange recording and blocked readiness
when no handler behavior is available. No Tauri IPC, network transport, socket
listener, request handler routing, or background worker behavior was added.
