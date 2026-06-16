# 049 Draft Runtime Effect Event Vocabulary

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft runtime effect event vocabulary.

## Scope

- Draft the minimum server event vocabulary for adapter and command effect
  state changes.
- Define which ids, state fields, retry classifications, evidence refs,
  observation refs, and summaries may appear in events.
- Keep raw provider payloads, raw command output, credentials, and
  machine-local paths out by default.
- Keep event vocabulary separate from persistence and replay.

## Out Of Scope

- Rust implementation.
- Event bus.
- Replay store.
- Persistence schema.
- Client subscriptions.
- Async runtime.
- Provider-specific payloads.

## Evidence Questions

- Should adapter and command effect events share a common envelope?
- Which event payload fields are required for client reconciliation?
- Should retry-scheduled events point to the prior effect request id?
- How should observation batch refs and sanitized evidence refs be named before
  storage exists?

## Stop Conditions

- The draft starts implementing event transport or replay.
- Events include raw provider payloads, raw command output, credentials, or
  machine-local paths.
- Events imply clients own effect state.
- Events require a persistence schema before the contract is ready.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Adapter and command effect events should share a common server-owned
  envelope.
- Adapter and command event payloads stay separate.
- Retry-scheduled events point to both prior and new effect request ids.
- Observation refs and sanitized evidence refs may be symbolic before storage
  exists.
- Effect events are client reconciliation signals, not persistence, replay,
  transport, scheduler, or authority surfaces.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
