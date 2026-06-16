# 073 Add SQLite Project Task Workspace Storage

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add SQLite-backed storage for project, task, and workspace records.

## Scope

- Add initial SQLite schema for projects, tasks, and workspace layouts.
- Add repository implementations behind storage traits and backend adapter
  selection.
- Add restart-recovery tests.

## Out Of Scope

- Adapter registry/session storage.
- Runtime event storage.
- Projection file sync.
- Control API.
- PostgreSQL or remote database implementation.

## Validation

```sh
cargo test --workspace
```

## Decisions

- SQLite is the first local single-player backend adapter, not the storage
  assumption for team deployments.
- Storage remains backend-adapter based so future PostgreSQL, remote SQL, or
  managed database backends can expose the same domain repository traits.
- The first SQLite schema stores opaque generic records in separate `projects`,
  `tasks`, and `workspace_layouts` tables.
- Backend transactions remain deferred; SQLite repository operations currently
  accept autocommit only.

## Closeout

`nucleus-local-store` now has a SQLite backend adapter and SQLite repositories
for project, task, and workspace records. Tests prove restart recovery,
revision expectation enforcement, unsupported-domain rejection, and backend
adapter repository opening.

No adapter registry/session storage, runtime event storage, projection file
sync, control API, PostgreSQL backend, remote database backend, or backend
transaction implementation was introduced.
