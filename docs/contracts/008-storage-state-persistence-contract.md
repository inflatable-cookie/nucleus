# 008 Storage State Persistence Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Purpose

Define the persistence boundary for durable nucleus state.

The server owns durable state. Storage is a server concern, not a desktop
client concern. This contract names what must persist before a backend is
chosen.

Some durable project-management state may also be projected into a Git-backed
management repository for portability and collaboration. That projection is a
sync surface, not a replacement for the active server state store.

Persistent storage must not assume it owns secret material. Durable records may
store secret references and non-secret credential audit records; raw secrets
belong to a future secret store, host credential provider, provider-native auth
state, or external secret manager.

## Persistence Domains

Initial persisted domains:

- projects
- tasks
- task history
- workspaces
- agent sessions
- model routes
- server config
- event journal

These domains must be recoverable after server restart.

## Record Identity

Persisted records must carry:

- stable record id
- persistence domain
- record kind
- revision id

Domain ids and provider ids are not interchangeable. A persisted record id
identifies nucleus state. Provider-native ids remain attached as metadata on
the domain record that needs them.

## Revision Rule

State changes must be revisioned.

The first model only names revision ids, snapshots, and journal entries. It
does not define conflict resolution, transactions, migration, or replay
semantics yet.

## Journal Rule

The server should preserve enough journal information to support:

- restart recovery
- client reconciliation
- future event replay
- debugging state changes

The event journal is not a UI log. It is state recovery and reconciliation
evidence.

Task history is also not a UI log. It is durable task audit state and should
link to runtime events, artifacts, validation evidence, and session records
rather than copying high-volume streams.

Journal entries must not contain raw secret values, tokens, Authorization
headers, cookie values, or provider-native auth file contents. Credential
events may retain reference ids, source kind, resolution boundary, status, and
sanitized failure reason.

## Storage Backend Boundary

Backend selection is deliberately open.

Allowed backend families:

- embedded database
- filesystem
- remote database
- custom

Nucleus must not expose backend-specific assumptions through the public control
plane contract before the storage backend is selected.

Git-backed management files are a projection backend for shared project intent,
not the only storage backend. Server-local storage remains required for active
state, runtime state, indexes, and caches.

## Storage Location

Initial storage locations:

- server data root
- project local path
- remote endpoint
- custom

Project-local storage may be useful for portable project metadata later, but
the server remains the authority for active state.

## Current Rust Surface

`nucleus-core` now contains the first draft of:

- `PersistenceRecordId`
- `PersistenceDomain`
- `PersistenceRecordKind`
- `StorageBackendKind`
- `StorageLocation`
- `PersistenceRecord`
- `RevisionId`
- `StateSnapshot`
- `ChangeJournalEntry`
- `ChangeOperation`

These are descriptive shared types only. They do not implement a database,
serialization format, migration system, transactions, replay, or sync.

## Research Gaps

- Embedded database choice.
- Serialization format for durable records.
- Migration strategy.
- Snapshot and journal replay rules.
- Backup/export/import strategy.
- Whether project-local metadata should mirror any server state.
- Secret-store backend and host credential-provider integration.
- Git-backed management projection format and sync policy.

## Next Task

Draft management projection file model.
