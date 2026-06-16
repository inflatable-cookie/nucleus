# 056 Add Runtime Effect Replay Query Types

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add runtime effect replay query types.

## Scope

- Add compile-only Rust vocabulary for replay query requests and responses.
- Represent client ordering tokens, storage generation posture, retained event
  responses, checkpoint responses, latest-state responses, retry-lineage
  responses, recovery-required responses, ref-resolution responses, and
  partial-result notices.
- Keep types value-shaped and provider-neutral.
- Keep replay query types separate from transport, subscriptions, persistence
  implementation, artifact storage, and runtime execution.

## Out Of Scope

- Replay API implementation.
- Event transport or subscriptions.
- Database or file-format selection.
- Artifact store implementation.
- Client cache implementation.
- Runtime execution.

## Evidence Questions

- Should replay query types live beside runtime effect storage types in
  `nucleus-server`?
- Which missing-ref and expired-ref states need named variants now?
- Should storage generation posture be represented as a typed value or a
  symbolic string until migration policy exists?
- Which response shapes need partial-result metadata?

## Stop Conditions

- Types imply HTTP, WebSocket, local socket, or another transport.
- Types implement replay or subscriptions.
- Types make clients authoritative for event ordering or stored state.
- Types copy raw command output or provider payloads into replay responses by
  default.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Replay query types live in a separate `nucleus-server` module beside runtime
  effect storage types.
- Client ordering tokens are typed with storage generation posture.
- Query requests wrap existing storage query vocabulary and remain
  transport-neutral.
- Query responses can be complete, partial, or unsupported.
- Result items represent stored events, checkpoints, latest state, retry
  lineage, recovery-required lookup, and ref resolution.
- Missing, expired, unsupported, and resolved refs are explicit result states.
- No replay API, event transport, subscription model, persistence
  implementation, artifact store, client cache, scheduler, command execution,
  or adapter execution was added.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
