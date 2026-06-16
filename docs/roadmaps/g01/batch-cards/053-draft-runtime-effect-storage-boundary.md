# 053 Draft Runtime Effect Storage Boundary

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft runtime effect storage boundary.

## Scope

- Draft storage responsibilities for retained runtime effect events and refs.
- Separate event storage, artifact storage, observation storage, and command
  evidence storage.
- Define what storage must preserve before replay can be implemented.
- Keep storage boundary separate from database choice and implementation.

## Out Of Scope

- Rust implementation.
- Database choice.
- Migrations.
- Replay API.
- Event bus.
- Artifact store implementation.
- Runtime execution.

## Evidence Questions

- Which retained refs need their own storage domains?
- Which refs can remain symbolic until broader storage contracts mature?
- How should storage handle deployment profile variance?
- What must be queryable for client reconciliation?

## Stop Conditions

- The draft chooses a database or file format.
- The draft implements persistence.
- The draft retains raw command output or provider payloads by default.
- The draft makes clients authoritative for stored state.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Runtime effect storage is server-owned.
- Storage is split into normalized event records, command evidence refs,
  adapter observation refs, artifact refs, and replay checkpoints.
- Symbolic refs remain valid until a later implementation contract promotes
  storage-backed refs.
- Replay requires query support for effect events, ordering-token
  reconciliation, ref resolution, latest effect state, retry lineage, and
  recovery-required effects.
- Raw command output, terminal byte streams, raw provider payloads, raw webhook
  payloads, credentials, and large validation output stay out of event records
  by default.
- No database, file format, persistence implementation, replay API, event bus,
  artifact store, scheduler, command runner, or adapter runtime was selected.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
