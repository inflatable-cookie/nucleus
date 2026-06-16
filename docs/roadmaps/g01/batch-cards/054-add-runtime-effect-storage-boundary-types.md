# 054 Add Runtime Effect Storage Boundary Types

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Add runtime effect storage boundary types.

## Scope

- Add compile-only Rust vocabulary for retained runtime effect event records.
- Represent event storage refs, evidence refs, observation refs, artifact refs,
  replay checkpoints, ordering-token query posture, latest-state lookup, retry
  lineage, and recovery-required lookup.
- Keep types value-shaped and provider-neutral.
- Keep storage refs separate from database choice, serialization, replay APIs,
  event transport, artifact stores, and runtime execution.

## Out Of Scope

- Persistence implementation.
- Database or file-format selection.
- Migration implementation.
- Replay implementation.
- Event transport or subscriptions.
- Artifact store implementation.
- Runtime execution.

## Evidence Questions

- Should storage boundary types live in `nucleus-server`, `nucleus-core`, or be
  split between shared ids and server-owned runtime records?
- Which symbolic refs from replay retention policy should get typed wrappers
  now?
- Which query shapes need descriptive request/response types before storage is
  implemented?
- Should replay checkpoint vocabulary be summary-only until replay APIs exist?

## Stop Conditions

- Types imply a concrete database, file format, transaction model, or replay
  API.
- Types retain raw command output or provider payloads by default.
- Types make clients authoritative for stored state.
- Types depend on dev-only fixture crates.

## Promotion Targets

- `crates/nucleus-server`
- `crates/nucleus-core`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/architecture/system-inventory.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
