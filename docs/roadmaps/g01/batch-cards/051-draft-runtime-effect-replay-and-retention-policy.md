# 051 Draft Runtime Effect Replay And Retention Policy

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft runtime effect replay and retention policy.

## Scope

- Draft which runtime effect events and refs need replay.
- Draft which runtime effect events are transient reconciliation signals only.
- Define retention posture for sanitized evidence refs, artifact refs,
  observation refs, retry linkage, and summaries.
- Keep replay and retention separate from transport and implementation.

## Out Of Scope

- Rust implementation.
- Persistence schema.
- Event bus.
- Client subscriptions.
- Artifact store.
- Scheduler.
- Runtime execution.

## Evidence Questions

- Which event kinds must survive server restart?
- Which events can be summarized or compacted?
- How long should symbolic refs remain resolvable?
- Does replay policy need to distinguish local-only and remote deployments?

## Stop Conditions

- The draft starts implementing storage or replay.
- The draft retains raw command output or provider payloads by default.
- The draft makes clients authoritative for server state.
- The draft forces a specific database or transport.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Runtime effect events split into durable replay events and transient
  reconciliation events.
- Transient progress may be compacted only after a durable successor exists.
- Sanitized evidence refs, artifact refs, observation refs, retry linkage, and
  terminal outcomes must remain resolvable while retained events point to them.
- Raw command output and raw provider payloads are not retained in event replay
  by default.
- Replay policy may vary by deployment profile.
- No database, replay API, event bus, transport, artifact store, or
  subscription model was selected.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
