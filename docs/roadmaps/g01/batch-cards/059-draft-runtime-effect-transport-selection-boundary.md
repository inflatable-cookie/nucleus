# 059 Draft Runtime Effect Transport Selection Boundary

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Draft runtime effect transport selection boundary.

## Scope

- Draft criteria for choosing local and remote event transports later.
- Keep transport selection separate from server event identity, replay,
  subscription semantics, storage, command execution, and adapter execution.
- Compare local socket, loopback HTTP, LAN HTTP, remote HTTP, WebSocket,
  polling, and custom transports as deployment options without selecting one.
- Define what transport must preserve from replay and subscription contracts.

## Out Of Scope

- Rust implementation.
- Transport selection.
- Event bus implementation.
- Auth and pairing design.
- Replay service implementation.
- Runtime execution.

## Evidence Questions

- Which deployment profiles need different transport families?
- What must any transport preserve for ordering tokens, replay catch-up, and
  delivery acknowledgements?
- Which transport concerns belong in server boundary versus deployment
  boundary?
- What auth and pairing questions block implementation readiness?

## Stop Conditions

- The draft chooses a transport.
- The draft implements networking or event delivery.
- The draft makes transport the authority for event identity or state.
- The draft combines auth, pairing, and transport before their contracts are
  ready.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/001-foundation-and-research.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
