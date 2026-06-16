# 055 Draft Runtime Effect Replay Query Boundary

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Draft runtime effect replay query boundary.

## Scope

- Draft how clients ask the server for retained runtime effect events after
  reconnect.
- Define replay query inputs, ordering-token semantics, ref-resolution
  posture, latest-state lookup, retry-lineage lookup, and recovery-required
  lookup.
- Keep replay queries separate from event subscriptions, storage backend
  choice, artifact storage, and runtime execution.
- Define what clients may cache without becoming authoritative.

## Out Of Scope

- Rust implementation.
- Replay API implementation.
- Event transport or subscriptions.
- Database or file-format selection.
- Artifact store implementation.
- Runtime execution.

## Evidence Questions

- Should replay query vocabulary sit in the server boundary, client boundary,
  or both?
- Which query responses need explicit partial-result and missing-ref states?
- How should reconnecting clients handle compacted events and checkpoints?
- What does a client ordering token prove, and what does it not prove?

## Stop Conditions

- The draft chooses HTTP, WebSocket, local socket, or another transport.
- The draft implements replay or subscriptions.
- The draft makes clients authoritative for event ordering or stored state.
- The draft copies raw command output or provider payloads into replay
  responses by default.

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
