# 052 Add Runtime Effect Replay Retention Policy Types

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add runtime effect replay retention policy types.

## Scope

- Add compile-only Rust vocabulary for replay durability and retention posture.
- Represent durable replay events, transient reconciliation events, symbolic
  ref retention, compaction posture, and deployment profile variance.
- Keep types value-shaped and provider-neutral.
- Keep policy types separate from storage, replay APIs, event buses, and
  subscriptions.

## Out Of Scope

- Persistence implementation.
- Replay implementation.
- Event transport.
- Artifact store.
- Scheduler.
- Client subscriptions.
- Runtime execution.

## Evidence Questions

- Should replay policy types live in `nucleus-server` only?
- Should adapter and command crates expose only domain-specific retention refs?
- Does deployment profile variance belong in server policy or deployment
  config later?
- Which symbolic refs need typed wrappers now?

## Stop Conditions

- Types imply a database, replay API, event bus, or artifact store.
- Types retain raw command output or provider payloads by default.
- Types make clients authoritative for replay state.
- Types depend on dev-only fixture crates.

## Promotion Targets

- `crates/nucleus-server`
- `crates/nucleus-scm-forge`
- `crates/nucleus-command-policy`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Replay and retention policy types live in `nucleus-server`.
- Adapter and command crates continue to expose domain-specific symbolic refs.
- Deployment profile variance is represented as server policy vocabulary for
  now.
- Ref retention remains symbolic until storage and replay contracts exist.
- No storage, replay API, event bus, transport, artifact store, subscription,
  scheduler, or runtime execution was added.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
