# 008 Storage State Persistence Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Purpose

Define the persistence boundary for durable nucleus state.

The server owns durable state. Storage is a server concern, not a desktop
client concern. This contract names what must persist before a backend is
chosen.

## Persistence Domains

Initial persisted domains:

- projects
- tasks
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

## Storage Backend Boundary

Backend selection is deliberately open.

Allowed backend families:

- embedded database
- filesystem
- remote database
- custom

Nucleus must not expose backend-specific assumptions through the public control
plane contract before the storage backend is selected.

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

## Next Task

Draft adapter runtime ownership and stream semantics.
