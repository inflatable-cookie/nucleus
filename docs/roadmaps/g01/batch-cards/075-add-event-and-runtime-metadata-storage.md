# 075 Add Event And Runtime Metadata Storage

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add server-local event and runtime metadata storage.

## Scope

- Persist server event journal records.
- Persist command evidence metadata and artifact metadata.
- Persist runtime effect refs and latest-state records needed for restart
  recovery.

## Out Of Scope

- Live subscriptions.
- Replay API implementation.
- Artifact payload storage.
- Command execution.

## Validation

```sh
cargo test --workspace
```

## Decisions

- Event journal, command evidence metadata, artifact metadata, and runtime
  effect refs use the same backend-adapter repository boundary.
- SQLite gets separate generic tables for each runtime metadata domain.
- Artifact payloads, replay APIs, live subscriptions, and command execution
  remain outside this storage slice.

## Closeout

`nucleus-local-store` now persists generic event journal, command evidence
metadata, artifact metadata, and runtime effect records through SQLite and the
`LocalStoreBackend` / `LocalStoreRepository` boundary.

No replay API, live subscription, artifact payload storage, command execution,
runtime scheduler, backend transaction support, or team-server database backend
was introduced.
