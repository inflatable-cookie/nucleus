# 076 Add Storage Restart Recovery Tests

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add restart-recovery tests across the first persisted domains.

## Scope

- Prove persisted records can be reopened after store restart.
- Prove missing secret material, artifact payloads, command execution, and live
  adapter state are not required for recovery.
- Prove projection files are not treated as active server state.

## Out Of Scope

- Backup/export/import.
- Live replay subscriptions.
- Tauri client recovery.

## Validation

```sh
cargo test --workspace
```

## Decisions

- Restart recovery is tested through the backend adapter and repository traits.
- One SQLite database now proves recovery across all first SQLite-backed
  domains.
- Metadata refs can recover without resolving secret material, artifact
  payloads, command execution, or live runtime state.
- Projection files are not imported as active server state.

## Closeout

`nucleus-local-store` now has restart-recovery coverage across all first
SQLite-backed domains. Tests prove project/task/workspace, adapter/session/
route, and runtime metadata records survive restart from a single database.

No backup/export/import, live replay subscription, Tauri client recovery,
projection import, command execution, artifact payload storage, secret lookup,
or runtime scheduler was introduced.
